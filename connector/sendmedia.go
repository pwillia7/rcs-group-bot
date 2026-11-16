package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"syscall"
	"time"

	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

// Outbound attachments: the agent sends a public https URL (a GIF, image or
// short video); the connector downloads it and sends it as a real RCS
// attachment, so it shows up inline instead of as a link.

const sendMediaMax = 25 << 20 // 25 MiB; RCS allows more, but GIFs past this are unwieldy

// publicOnly refuses connections to loopback/private/link-local addresses, so
// a media URL can't be used to reach anything internal (checked after DNS
// resolution, at dial time, which also covers redirects).
func publicOnly(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast() {
		return fmt.Errorf("refusing non-public address %s", host)
	}
	return nil
}

var mediaClient = &http.Client{
	Timeout: 45 * time.Second,
	Transport: &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, Control: publicOnly}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		if req.URL.Scheme != "https" {
			return errors.New("redirect to non-https URL")
		}
		return nil
	},
}

// fetchMedia downloads a public https URL and returns its bytes, MIME type and a file name.
func fetchMedia(ctx context.Context, raw string) ([]byte, string, string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, "", "", fmt.Errorf("media URL must be https: %q", raw)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "", "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; rcs-group-bot)")
	req.Header.Set("Accept", "image/gif,image/*,video/*;q=0.8")
	resp, err := mediaClient.Do(req)
	if err != nil {
		return nil, "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", "", fmt.Errorf("media download: HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, sendMediaMax+1))
	if err != nil {
		return nil, "", "", err
	}
	if len(data) > sendMediaMax {
		return nil, "", "", fmt.Errorf("media is over %d MiB", sendMediaMax>>20)
	}
	// Trust the bytes over the header (CDNs often say octet-stream or webp-negotiate).
	mimeType := http.DetectContentType(data)
	if mimeType == "application/octet-stream" || mimeType == "text/plain; charset=utf-8" {
		mimeType, _, _ = mime.ParseMediaType(resp.Header.Get("Content-Type"))
	}
	if i := strings.IndexByte(mimeType, ';'); i >= 0 {
		mimeType = strings.TrimSpace(mimeType[:i])
	}
	if !strings.HasPrefix(mimeType, "image/") && !strings.HasPrefix(mimeType, "video/") {
		return nil, "", "", fmt.Errorf("not an image or video (%s)", mimeType)
	}
	name := path.Base(resp.Request.URL.Path)
	if name == "" || name == "/" || name == "." || !strings.Contains(name, ".") {
		ext := strings.TrimPrefix(mimeType[strings.IndexByte(mimeType, '/')+1:], "x-")
		name = "media." + ext
	}
	return data, mimeType, name, nil
}

// mediaInfo downloads and uploads item.MediaURL to Google, returning the
// MessageInfo to send in place of (or alongside) text.
func (b *Bridge) mediaInfo(ctx context.Context, mediaURL string) (*gmproto.MessageInfo, error) {
	data, mimeType, name, err := fetchMedia(ctx, mediaURL)
	if err != nil {
		return nil, err
	}
	content, err := b.cli.UploadMedia(ctx, data, name, mimeType)
	if err != nil {
		return nil, fmt.Errorf("upload media: %w", err)
	}
	b.log.Info().Str("mime", mimeType).Int("bytes", len(data)).Msg("uploaded outbound media")
	return &gmproto.MessageInfo{Data: &gmproto.MessageInfo_MediaContent{MediaContent: content}}, nil
}
