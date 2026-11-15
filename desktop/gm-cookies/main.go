// gm-cookies: keeps the bot connector's Google session alive.
//
// It keeps a dedicated Chrome profile signed into messages.google.com and, when
// the connector reports it needs cookies (state need-cookies / need-pair), reads
// that profile's cookies over the DevTools protocol and hands them to the bot's
// admin route. The connector then refreshes its existing pairing (no emoji) or,
// if the pairing is gone, starts a re-pair and sends the emoji to ntfy.
//
//	gm-cookies.exe -login     one-time: sign into Google in the dedicated profile
//	gm-cookies.exe            check state; push cookies only if needed (scheduled)
//	gm-cookies.exe -force     push cookies now, even if the connector is healthy
//
// Built as a GUI-subsystem exe (-ldflags -H=windowsgui) so the scheduled run never
// opens a console window. Scheduled runs log with -log; -login attaches to the
// terminal it was started from so its instructions still print.
package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
)

var required = []string{"SID", "HSID", "SSID", "OSID", "APISID", "SAPISID"}

func main() {
	exeDir := func() string { p, _ := os.Executable(); return filepath.Dir(p) }()
	var (
		login      = flag.Bool("login", false, "open the dedicated Chrome profile to sign in (one-time)")
		force      = flag.Bool("force", false, "push cookies even if the connector is healthy")
		api        = flag.String("api", readFirstLine(filepath.Join(exeDir, "api-url.txt")), "bot base URL, e.g. https://your-bot.vercel.app (default: api-url.txt next to the exe)")
		profile    = flag.String("profile", filepath.Join(os.Getenv("LOCALAPPDATA"), "rcs-group-bot-chrome"), "dedicated Chrome user-data-dir")
		secretFile = flag.String("secret-file", filepath.Join(exeDir, "admin-secret.txt"), "file with GM_ADMIN_SECRET")
		chrome     = flag.String("chrome", `C:\Program Files\Google\Chrome\Application\chrome.exe`, "Chrome executable")
		logFile    = flag.String("log", "", "append log output to this file (scheduled runs)")
	)
	flag.Parse()
	log.SetFlags(log.LstdFlags)
	if *logFile != "" {
		f, err := os.OpenFile(*logFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err == nil {
			defer f.Close()
			log.SetOutput(f)
		}
	} else {
		attachConsole()
	}

	if *login {
		if err := doLogin(*chrome, *profile); err != nil {
			log.Fatal(err)
		}
		return
	}

	if *api == "" {
		log.Fatal("set the bot URL: put it in api-url.txt next to gm-cookies.exe, or pass -api https://your-bot.vercel.app")
	}
	secretBytes, err := os.ReadFile(*secretFile)
	if err != nil {
		log.Fatalf("read secret: %v", err)
	}
	secret := strings.TrimSpace(string(secretBytes))

	var state struct {
		State     string `json:"state"`
		Reason    string `json:"reason"`
		Heartbeat int64  `json:"heartbeat"`
	}
	if err := signedPost(*api+"/gm/admin/state", secret, map[string]any{}, &state); err != nil {
		log.Fatalf("get state: %v", err)
	}
	log.Printf("connector state=%s heartbeat=%ds ago %s", state.State, time.Now().Unix()-state.Heartbeat, state.Reason)
	needed := state.State == "need-cookies" || state.State == "need-pair"
	if !needed && !*force {
		return
	}

	cookies, err := readCookies(*chrome, *profile)
	if err != nil {
		log.Fatalf("read cookies: %v", err)
	}
	if err := signedPost(*api+"/gm/admin/cookies", secret, map[string]any{"cookies": cookies, "force": *force}, nil); err != nil {
		log.Fatalf("push cookies: %v", err)
	}
	log.Printf("pushed %d cookies; the connector will refresh or re-pair (watch ntfy for an emoji)", len(cookies))
}

func doLogin(chrome, profile string) error {
	fmt.Println("A Chrome window will open with the dedicated bot profile.")
	fmt.Println("1) Sign in with the Google account your phone's Messages uses.")
	fmt.Println("2) Make sure messages.google.com loads (if it offers to pair, you can ignore it).")
	fmt.Println("3) Close that Chrome window. Do NOT sign out.")
	cmd := exec.Command(chrome, "--user-data-dir="+profile, "--no-first-run", "--no-default-browser-check",
		"https://accounts.google.com/AccountChooser?continue=https://messages.google.com/web/")
	if err := cmd.Run(); err != nil {
		return err
	}
	cookies, err := readCookies(chrome, profile)
	if err != nil {
		return fmt.Errorf("sign-in check failed: %w", err)
	}
	fmt.Printf("OK: profile is signed in (%d cookies available). Scheduled checks can now refresh the bot.\n", len(cookies))
	return nil
}

// readCookies launches headless Chrome on the dedicated profile, visits Messages
// so Google refreshes the session cookies (incl. OSID), and reads them via CDP.
func readCookies(chrome, profile string) (map[string]string, error) {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(chrome),
		chromedp.UserDataDir(profile),
		chromedp.Flag("headless", "new"),
	)
	actx, cancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancel()
	ctx, cancel := chromedp.NewContext(actx)
	defer cancel()
	ctx, cancel = context.WithTimeout(ctx, 90*time.Second)
	defer cancel()

	if err := chromedp.Do(ctx,
		chromedp.Navigate("https://messages.google.com/web/conversations"),
		chromedp.Sleep(8*time.Second),
	); err != nil {
		return nil, err
	}
	res, err := chromedp.Call(ctx, network.GetCookies, network.GetCookiesParams{URLs: []string{
		"https://messages.google.com/web/", "https://www.google.com/", "https://accounts.google.com/",
	}})
	if err != nil {
		return nil, err
	}
	cks := res.Cookies
	out := map[string]string{}
	for _, c := range cks {
		if strings.HasSuffix(c.Domain, "google.com") {
			out[c.Name] = c.Value
		}
	}
	var missing []string
	for _, n := range required {
		if out[n] == "" {
			missing = append(missing, n)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("profile is missing %v; run gm-cookies.exe -login", missing)
	}
	return out, nil
}

func readFirstLine(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(data)), "\n")
	return strings.TrimRight(strings.TrimSpace(line), "/")
}

func signedPost(url, secret string, payload any, into any) error {
	body, _ := json.Marshal(payload)
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "." + string(body)))
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-gm-timestamp", ts)
	req.Header.Set("x-gm-signature", hex.EncodeToString(mac.Sum(nil)))
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return errors.New(resp.Status + ": " + string(data))
	}
	if into != nil {
		return json.Unmarshal(data, into)
	}
	return nil
}
