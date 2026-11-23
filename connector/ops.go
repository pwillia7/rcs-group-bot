package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

// ---- state, heartbeat, alerts ----------------------------------------------

type connectorState struct {
	State  string `json:"state"` // ok | need-cookies | need-pair | verifying | pairing
	Reason string `json:"reason,omitempty"`
	At     int64  `json:"at"`
}

func (b *Bridge) setState(ctx context.Context, state, reason string) {
	b.state.Store(state)
	data, _ := json.Marshal(connectorState{State: state, Reason: reason, At: time.Now().Unix()})
	if err := b.store.SetKey(ctx, "state", data, 0); err != nil {
		b.log.Warn().Err(err).Msg("save state")
	}
}

func (b *Bridge) previousState(ctx context.Context) string {
	data, err := b.store.GetKey(ctx, "state")
	if err != nil || data == nil {
		return ""
	}
	var st connectorState
	_ = json.Unmarshal(data, &st)
	return st.State
}

// markNeedsCookies puts the connector in degraded mode. If we just restarted
// after a cookie refresh and still can't connect, the pairing itself is gone,
// so the next cookies trigger a full (emoji) re-pair.
func (b *Bridge) markNeedsCookies(ctx context.Context, reason string) {
	state := "need-cookies"
	if prev := b.previousState(ctx); prev == "verifying" || prev == "need-pair" {
		state = "need-pair"
	}
	b.log.Error().Str("state", state).Str("reason", reason).Msg("connector degraded")
	b.setState(ctx, state, reason)
	alert := func() {
		b.notify(ctx, "degraded:"+state, time.Hour, 4, "bot is offline: "+state,
			reason+"\nThe desktop gm-cookies helper normally fixes this on its own within a few minutes."+
				map[bool]string{true: " A re-pair needs you to tap an emoji on your phone — watch for the next alert.", false: " It hasn't yet: is the desktop on? Run gm-cookies.exe -force there."}[state == "need-pair"])
	}
	if state == "need-pair" {
		alert() // needs a human (emoji tap) either way
		return
	}
	// Cookie expiry is routine (Google rotates them a few times a day) and the
	// desktop helper fixes it within ~2 min. Only page if it didn't.
	go func() {
		select {
		case <-ctx.Done():
		case <-time.After(degradedAlertDelay):
			if s, _ := b.state.Load().(string); s == state {
				alert()
			}
		}
	}()
}

const degradedAlertDelay = 10 * time.Minute

func (b *Bridge) heartbeat(ctx context.Context) {
	_ = b.store.SetKey(ctx, "heartbeat", []byte(strconv.FormatInt(time.Now().Unix(), 10)), 0)
	if since := b.phoneDown.Load(); since != 0 && time.Since(time.Unix(since, 0)) > 30*time.Minute {
		b.notify(ctx, "phone-down", 2*time.Hour, 3, "bot: phone not responding",
			"The Pixel hasn't responded for 30+ minutes (off, no signal, or battery saver). The bot can't send or receive until it's back.")
	}
}

// nudgePhone asks an unresponsive phone for updates on every beat. libgm's own
// retries back off to 64 minutes, so a phone that was charged and switched back
// on could otherwise go unnoticed for an hour. Any answer clears phoneDown.
func (b *Bridge) nudgePhone(ctx context.Context) {
	if s, _ := b.state.Load().(string); s != "ok" || b.cli == nil || b.phoneDown.Load() == 0 {
		return
	}
	if err := b.cli.SetActiveSession(ctx); err != nil {
		b.log.Warn().Err(err).Msg("nudge phone")
	}
}

// notify posts to ntfy. dedupKey "" always sends; otherwise at most once per `every`.
func (b *Bridge) notify(ctx context.Context, dedupKey string, every time.Duration, priority int, title, message string) {
	if dedupKey != "" {
		// Remember locally too: without Redis the shared dedup can't work, and
		// asking it on every beat costs commands.
		if next, ok := b.alerted.Load(dedupKey); ok && time.Now().Before(next.(time.Time)) {
			return
		}
		b.alerted.Store(dedupKey, time.Now().Add(every))
		if first, err := b.store.FirstSeen(ctx, "alert", dedupKey, every); err == nil && !first {
			return
		}
	}
	b.log.Warn().Str("title", title).Msg("alert")
	if b.cfg.NtfyURL == "" {
		return
	}
	u, err := url.Parse(b.cfg.NtfyURL)
	if err != nil {
		return
	}
	topic := strings.Trim(u.Path, "/")
	u.Path = "/"
	body, _ := json.Marshal(map[string]any{
		"topic": topic, "title": title, "message": message, "priority": priority, "tags": []string{"robot"},
	})
	// Synchronous (bounded): alerts are often sent right before a restart, and a
	// background goroutine would die with the process.
	sendCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(sendCtx, http.MethodPost, u.String(), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := b.http.Do(req)
	if err != nil {
		b.log.Warn().Err(err).Msg("ntfy")
		return
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		b.log.Warn().Int("status", resp.StatusCode).Msg("ntfy rejected alert")
	}
}

// ---- cookie refresh / re-pair ------------------------------------------------

func (b *Bridge) applyCookies(ctx context.Context, item OutboxItem) error {
	state, _ := b.state.Load().(string)
	if state == "ok" && !item.Force {
		b.log.Info().Msg("cookies received while healthy; ignoring (use force to apply)")
		return nil
	}
	if state == "pairing" {
		return errors.New("pairing already in progress")
	}
	cookies, err := requireCookies(item.Cookies)
	if err != nil {
		return err
	}

	// 1. Same pairing, new cookies: no emoji needed.
	if state != "need-pair" && b.cli != nil && b.cli.AuthData != nil && b.cli.AuthData.Mobile != nil {
		b.cli.AuthData.SetCookies(cookies)
		if err := b.cli.FetchConfig(ctx); err != nil {
			b.log.Warn().Err(err).Msg("cookie refresh: fetch config failed; falling back to re-pair")
		} else if email := b.cli.Config.GetDeviceInfo().GetEmail(); email != b.cli.AuthData.Mobile.GetSourceID() {
			return fmt.Errorf("cookies belong to a different Google account than the paired phone")
		} else {
			b.saveSession(ctx)
			b.setState(ctx, "verifying", "cookies refreshed; reconnecting")
			b.log.Info().Msg("cookies refreshed; reconnecting with the existing pairing")
			b.requestRestart("cookies refreshed")
			return nil
		}
	}

	// 2. Full re-pair: the phone must confirm an emoji.
	b.setState(ctx, "pairing", "waiting for emoji confirmation")
	ad := libgm.NewAuthData()
	ad.SetCookies(cookies)
	cli := newClient(ad, b.log)
	cli.SetEventHandler(func(evt any) {})
	if err := cli.FetchConfig(ctx); err != nil {
		b.setState(ctx, "need-pair", "cookies rejected: "+err.Error())
		return fmt.Errorf("re-pair fetch config: %w", err)
	}
	emoji, sess, err := cli.StartGaiaPairing(ctx, ctx)
	if err != nil {
		b.setState(ctx, "need-pair", "start pairing failed: "+err.Error())
		return fmt.Errorf("start pairing: %w", err)
	}
	b.notify(ctx, "", 0, 5, "bot: tap "+emoji+" on your phone",
		"Open Google Messages on your Pixel and tap "+emoji+" to re-pair the bot.")
	if _, err := cli.FinishGaiaPairing(ctx, sess); err != nil {
		cli.Disconnect()
		b.setState(ctx, "need-pair", "pairing not confirmed: "+err.Error())
		b.notify(ctx, "", 0, 4, "bot: re-pair failed", err.Error()+"\nThe helper will retry on its next check.")
		return fmt.Errorf("finish pairing: %w", err)
	}
	cli.Disconnect()
	data, err := json.Marshal(ad)
	if err != nil {
		return err
	}
	if err := b.store.SaveSession(ctx, data); err != nil {
		return err
	}
	b.setState(ctx, "verifying", "re-paired; reconnecting")
	b.notify(ctx, "", 0, 3, "bot re-paired", "Pairing confirmed. The bot is reconnecting.")
	b.requestRestart("re-paired")
	return nil
}

func (b *Bridge) requestRestart(reason string) {
	select {
	case b.restart <- reason:
	default:
	}
}

// ---- read_history ------------------------------------------------------------

type historyLine struct {
	TS     int64  `json:"ts"` // unix ms
	Sender string `json:"sender"`
	Text   string `json:"text"`
}

type historyResult struct {
	Messages   []historyLine `json:"messages"`
	NextCursor string        `json:"nextCursor,omitempty"`
	Scanned    int           `json:"scanned"`
	Error      string        `json:"error,omitempty"`
}

const (
	historyDefault    = 30
	historyMaxReturn  = 100
	historyMaxScan    = 600 // search mode: how far back we're willing to page
	historyPageSize   = 50
	historyMaxTextLen = 400
)

func (b *Bridge) handleHistory(ctx context.Context, conv *gmproto.Conversation, item OutboxItem) error {
	if !strings.HasPrefix(item.ReplyKey, "rpc:") {
		return errors.New("history request without rpc reply key")
	}
	res := b.fetchHistory(ctx, conv, item)
	if res.Messages == nil {
		res.Messages = []historyLine{} // "[]", not "null": the agent maps over it
	}
	data, _ := json.Marshal(res)
	return b.store.SetKey(ctx, item.ReplyKey, data, 2*time.Minute)
}

func (b *Bridge) fetchHistory(ctx context.Context, conv *gmproto.Conversation, item OutboxItem) historyResult {
	limit := item.Count
	if limit <= 0 {
		limit = historyDefault
	}
	limit = min(limit, historyMaxReturn)
	search := strings.ToLower(strings.TrimSpace(item.Search))
	maxScan := limit
	if search != "" {
		maxScan = historyMaxScan
	}

	names := map[string]string{}
	for _, p := range conv.GetParticipants() {
		name := p.GetFullName()
		if name == "" {
			name = p.GetFormattedNumber()
		}
		if p.GetIsMe() {
			name += " (owner)"
		}
		names[p.GetID().GetParticipantID()] = name
	}

	var cursor *gmproto.Cursor
	if id, ts, ok := strings.Cut(item.Cursor, "|"); ok {
		t, _ := strconv.ParseInt(ts, 10, 64)
		cursor = &gmproto.Cursor{LastItemID: id, LastItemTimestamp: t}
	}

	var res historyResult
	for res.Scanned < maxScan && len(res.Messages) < limit {
		page := min(historyPageSize, maxScan-res.Scanned)
		resp, err := b.cli.FetchMessages(ctx, conv.GetConversationID(), int64(page), cursor)
		if err != nil {
			res.Error = err.Error()
			break
		}
		msgs := resp.GetMessages()
		res.Scanned += len(msgs)
		for _, m := range msgs {
			var parts []string
			for _, info := range m.GetMessageInfo() {
				if c := info.GetMessageContent().GetContent(); c != "" {
					parts = append(parts, c)
				} else if media := info.GetMediaContent(); media != nil {
					parts = append(parts, "["+media.GetMimeType()+"]")
				}
			}
			text := strings.Join(parts, " ")
			if text == "" {
				continue
			}
			sender := names[m.GetParticipantID()]
			if sender == "" {
				sender = "Unknown"
			}
			if b.cfg.BotMarker != "" && strings.HasPrefix(text, b.cfg.BotMarker) {
				sender, text = "Bot (you)", strings.TrimSpace(strings.TrimPrefix(text, b.cfg.BotMarker))
			}
			if search != "" && !strings.Contains(strings.ToLower(text), search) && !strings.Contains(strings.ToLower(sender), search) {
				continue
			}
			if utf8.RuneCountInString(text) > historyMaxTextLen {
				text = string([]rune(text)[:historyMaxTextLen]) + "…"
			}
			res.Messages = append(res.Messages, historyLine{TS: m.GetTimestamp() / 1000, Sender: sender, Text: text})
		}
		next := resp.GetCursor()
		if next == nil || len(msgs) == 0 || next.GetLastItemID() == "" {
			cursor = nil
			break
		}
		cursor = next
	}
	sort.Slice(res.Messages, func(i, j int) bool { return res.Messages[i].TS < res.Messages[j].TS })
	if len(res.Messages) > limit {
		// keep the most recent `limit` matches
		res.Messages = res.Messages[len(res.Messages)-limit:]
	}
	if cursor != nil {
		res.NextCursor = cursor.GetLastItemID() + "|" + strconv.FormatInt(cursor.GetLastItemTimestamp(), 10)
	}
	return res
}
