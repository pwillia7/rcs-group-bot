// gm-connector: bridges one Google Messages account (via libgm, the
// Messages-for-web protocol from mautrix-gmessages) to an HTTP webhook, and
// sends replies popped from an outbox. See ../README.md.
//
// Licensed AGPL-3.0-or-later because it links libgm (AGPL).
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
	"go.mau.fi/util/exhttp"
)

type Config struct {
	RedisURL             string
	RedisPrefix          string
	DataDir              string
	SessionKey           string
	WebhookURL           string
	WebhookSecret        string
	WebhookBypass        string
	AllowedConversations map[string]struct{}
	LineMode             string // self | sim | device
	LineSIMParticipant   string
	BotPrefix            string // prepended to every send in self/sim mode
	BotMarker            string // inbound messages starting with this are ignored
	HTTPAddr             string
	DevAPI               bool
	NtfyURL              string // e.g. https://ntfy.sh/<secret-topic>; alerts go here
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func loadConfig() Config {
	cfg := Config{
		RedisURL:             os.Getenv("REDIS_URL"),
		RedisPrefix:          env("REDIS_PREFIX", "gm"),
		DataDir:              env("DATA_DIR", ".data"),
		SessionKey:           os.Getenv("SESSION_KEY"),
		WebhookURL:           os.Getenv("WEBHOOK_URL"),
		WebhookSecret:        os.Getenv("WEBHOOK_SECRET"),
		WebhookBypass:        os.Getenv("VERCEL_PROTECTION_BYPASS"),
		LineMode:             env("LINE_MODE", "self"),
		LineSIMParticipant:   os.Getenv("LINE_SIM_PARTICIPANT"),
		BotPrefix:            env("BOT_PREFIX", "🤖 "),
		HTTPAddr:             env("HTTP_ADDR", "127.0.0.1:8081"),
		DevAPI:               os.Getenv("DEV_API") == "1",
		NtfyURL:              os.Getenv("NTFY_URL"),
		AllowedConversations: map[string]struct{}{},
	}
	for _, id := range strings.Split(os.Getenv("ALLOWED_CONVERSATIONS"), ",") {
		if id = strings.TrimSpace(id); id != "" {
			cfg.AllowedConversations[id] = struct{}{}
		}
	}
	if cfg.LineMode == "device" {
		cfg.BotPrefix = env("BOT_PREFIX", "")
	}
	cfg.BotMarker = strings.TrimSpace(cfg.BotPrefix)
	return cfg
}

func openStore(cfg Config) (Store, error) {
	seal, err := newSealer(cfg.SessionKey)
	if err != nil {
		return nil, err
	}
	if cfg.RedisURL != "" {
		return newRedisStore(cfg.RedisURL, cfg.RedisPrefix, seal)
	}
	return newLocalStore(cfg.DataDir, seal)
}

func main() {
	// authWatcher sees every log line (raw JSON) to catch libgm's HTTP 401s early.
	var out io.Writer = zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.Kitchen}
	if os.Getenv("LOG_JSON") == "1" {
		out = os.Stderr
	}
	log := zerolog.New(io.MultiWriter(out, authWatcher)).With().Timestamp().Logger()
	if lvl, err := zerolog.ParseLevel(env("LOG_LEVEL", "info")); err == nil {
		log = log.Level(lvl)
	}
	cfg := loadConfig()
	store, err := openStore(cfg)
	if err != nil {
		log.Fatal().Err(err).Msg("open store")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "pair":
		err = cmdPair(ctx, store, log)
	case "list":
		err = cmdList(ctx, cfg, store, log)
	case "serve":
		err = cmdServe(ctx, cfg, store, log)
	default:
		err = fmt.Errorf("unknown command %q (pair | list | serve)", cmd)
	}
	if err != nil {
		log.Fatal().Err(err).Msg(cmd)
	}
}

func newClient(ad *libgm.AuthData, log zerolog.Logger) *libgm.Client {
	return libgm.NewClient(ad, nil, log.With().Str("component", "libgm").Logger().Level(zerolog.WarnLevel),
		exhttp.SensibleClientSettings)
}

// pair: read cookies (JSON or cURL) from stdin, show the emoji, wait for the
// phone confirmation, save the session.
func cmdPair(ctx context.Context, store Store, log zerolog.Logger) error {
	fmt.Fprintln(os.Stderr, "Paste your messages.google.com cookies (JSON object or 'Copy as cURL (bash)'), then press Ctrl-D:")
	input, err := io.ReadAll(bufio.NewReader(os.Stdin))
	if err != nil {
		return err
	}
	cookies, err := parseCookies(string(input))
	if err != nil {
		return err
	}
	ad := libgm.NewAuthData()
	ad.SetCookies(cookies)
	cli := newClient(ad, log)
	cli.SetEventHandler(func(evt any) { log.Debug().Type("event", evt).Msg("pre-pair event") })
	if err := cli.FetchConfig(ctx); err != nil {
		return fmt.Errorf("fetch config (are the cookies fresh?): %w", err)
	}
	emoji, sess, err := cli.StartGaiaPairing(ctx, ctx)
	if err != nil {
		return fmt.Errorf("start pairing: %w", err)
	}
	fmt.Fprintf(os.Stderr, "\n   >>>  On your phone, tap this emoji in Google Messages:  %s  <<<\n\n", emoji)
	phoneID, err := cli.FinishGaiaPairing(ctx, sess)
	if err != nil {
		return fmt.Errorf("finish pairing: %w", err)
	}
	cli.Disconnect()
	data, err := json.Marshal(cli.AuthData)
	if err != nil {
		return err
	}
	if err := store.SaveSession(ctx, data); err != nil {
		return err
	}
	log.Info().Str("phone_id", phoneID).Msg("paired and session saved")
	return nil
}

func loadClient(ctx context.Context, store Store, log zerolog.Logger) (*libgm.Client, error) {
	data, err := store.LoadSession(ctx)
	if err != nil {
		return nil, err
	} else if data == nil {
		return nil, fmt.Errorf("no session stored; run `gm-connector pair` first")
	}
	ad := libgm.NewAuthData()
	if err := json.Unmarshal(data, ad); err != nil {
		return nil, fmt.Errorf("decode session: %w", err)
	}
	return newClient(ad, log), nil
}

// list: connect briefly and print conversations so you can pick the
// ALLOWED_CONVERSATIONS ids. Stop `serve` first (one session at a time).
func cmdList(ctx context.Context, cfg Config, store Store, log zerolog.Logger) error {
	cli, err := loadClient(ctx, store, log)
	if err != nil {
		return err
	}
	b := NewBridge(cfg, store, log)
	b.cli = cli
	cli.SetEventHandler(func(evt any) {
		if _, ok := evt.(*libgm.WrappedMessage); ok {
			return // never forward from `list`
		}
		b.handleEvent(ctx, evt)
	})
	if err := cli.FetchConfig(ctx); err != nil {
		return err
	}
	if err := cli.Connect(ctx); err != nil {
		return err
	}
	defer cli.Disconnect()
	time.Sleep(4 * time.Second)
	resp, err := cli.ListConversations(ctx, &gmproto.ListConversationsRequest{Count: 50, Folder: gmproto.ListConversationsRequest_INBOX})
	if err != nil {
		return err
	}
	b.saveSession(ctx)
	convs := resp.GetConversations()
	sort.SliceStable(convs, func(i, j int) bool { return convs[i].GetIsGroupChat() && !convs[j].GetIsGroupChat() })
	fmt.Printf("%-14s %-6s %-5s %-4s %s\n", "CONVERSATION", "TYPE", "GROUP", "PPL", "NAME")
	for _, c := range convs {
		fmt.Printf("%-14s %-6s %-5v %-4d %s\n", c.GetConversationID(),
			strings.TrimPrefix(c.GetType().String(), "SMS_"), c.GetIsGroupChat(), len(c.GetParticipants()), c.GetName())
	}
	return nil
}

func cmdServe(ctx context.Context, cfg Config, store Store, log zerolog.Logger) error {
	if len(cfg.AllowedConversations) == 0 {
		log.Warn().Msg("ALLOWED_CONVERSATIONS is empty: nothing will be forwarded or sent")
	}
	if cfg.WebhookURL != "" && cfg.WebhookSecret == "" {
		return fmt.Errorf("WEBHOOK_SECRET is required when WEBHOOK_URL is set")
	}

	b := NewBridge(cfg, store, log)
	// Serve /healthz before taking the lease: a standby instance waiting on the
	// lease must still pass the liveness probe or Vercel keeps restarting it.
	go serveHTTP(ctx, cfg, b, store, log)

	// Single-instance lease. vercel.json runs two instances: one leader holds the
	// Google Messages session, the other waits here as a hot standby. Vercel can
	// stop an instance at any time (e.g. recycling it after ~24h), and a replacement
	// can take minutes to start, so the standby takes over within seconds instead.
	// The leader releases the lease on SIGTERM; if it dies hard, the TTL expires.
	owner := randomID()
	const leaseTTL = 30 * time.Second
	b.state.Store("standby")
	for waited := false; ; waited = true {
		got, err := store.AcquireLease(ctx, owner, leaseTTL)
		if err != nil {
			return fmt.Errorf("acquire lease: %w", err)
		}
		if got {
			if waited {
				log.Info().Msg("took over the lease from the previous connector")
			}
			break
		}
		if !waited {
			log.Info().Msg("another connector holds the lease; standing by")
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(2 * time.Second):
		}
	}
	defer store.ReleaseLease(context.Background(), owner)
	b.state.Store("starting")

	onAuth := func() { b.onAuthRejected(ctx) }
	authWatcher.fn.Store(&onAuth)

	// Connect. If the session is missing or Google rejects it, stay up in
	// degraded mode: keep heartbeating and processing the outbox so fresh
	// cookies (from the desktop gm-cookies helper) can repair it.
	if cli, err := loadClient(ctx, store, log); err != nil {
		b.markNeedsCookies(ctx, "no usable session: "+err.Error())
	} else {
		b.cli = cli
		cli.SetEventHandler(func(evt any) { b.handleEvent(ctx, evt) })
		if err := cli.FetchConfig(ctx); err != nil {
			log.Warn().Err(err).Msg("fetch config")
		}
		if err := cli.Connect(ctx); err != nil {
			b.markNeedsCookies(ctx, "connect failed: "+err.Error())
		} else {
			defer cli.Disconnect()
			b.saveSession(ctx)
			b.setState(ctx, "ok", "")
			log.Info().Str("line_mode", cfg.LineMode).Int("allowed_conversations", len(cfg.AllowedConversations)).Msg("connected")
		}
	}

	go b.runOutbox(ctx)

	renew := time.NewTicker(10 * time.Second)
	save := time.NewTicker(10 * time.Minute)
	beat := time.NewTicker(time.Minute)
	defer renew.Stop()
	defer save.Stop()
	defer beat.Stop()
	b.heartbeat(ctx)
	for {
		select {
		case <-ctx.Done():
			b.saveSession(context.Background())
			log.Info().Msg("shutting down")
			return nil
		case reason := <-b.restart:
			// Session replaced (cookie refresh or re-pair): exit cleanly and let the
			// daemon supervisor start a fresh process with the new session.
			log.Info().Str("reason", reason).Msg("restarting")
			return nil
		case <-renew.C:
			ok, err := store.RenewLease(ctx, owner, leaseTTL)
			if err == nil && !ok {
				return fmt.Errorf("lost lease to another instance")
			}
		case <-save.C:
			b.saveSession(ctx)
		case <-beat.C:
			b.heartbeat(ctx)
			go b.retryPending(ctx)
		}
	}
}

func serveHTTP(ctx context.Context, cfg Config, b *Bridge, store Store, log zerolog.Logger) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		// Logged-out is not fixed by a restart, so stay "healthy" and alert instead.
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ready": b.ready.Load(), "loggedOut": b.loggedOut.Load(), "lastEvent": b.lastEvent.Load(),
			"state": b.state.Load(),
		})
	})
	if cfg.DevAPI {
		// Local-only helpers for development (daemons accept no inbound traffic anyway).
		mux.HandleFunc("POST /send", func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(io.LimitReader(r.Body, 64<<10))
			if err := store.PushOutbox(r.Context(), body); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			w.WriteHeader(http.StatusAccepted)
		})
	}
	srv := &http.Server{Addr: cfg.HTTPAddr, Handler: mux}
	go func() { <-ctx.Done(); _ = srv.Close() }()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Err(err).Msg("http server")
	}
}

func randomID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
