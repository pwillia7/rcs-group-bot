package main

import (
	"context"
	"os"
	"testing"
)

func TestFetchMediaRejects(t *testing.T) {
	for _, u := range []string{
		"http://example.com/a.gif",       // not https
		"https://127.0.0.1/a.gif",        // loopback
		"https://169.254.169.254/latest", // link-local metadata
		"https://10.0.0.1/a.gif",         // private
		"file:///etc/passwd",
	} {
		if _, _, _, err := fetchMedia(context.Background(), u); err == nil {
			t.Errorf("%s: expected error", u)
		}
	}
}

func TestFetchMediaLive(t *testing.T) {
	u := os.Getenv("LIVE_MEDIA_URL")
	if u == "" {
		t.Skip("set LIVE_MEDIA_URL")
	}
	data, mimeType, name, err := fetchMedia(context.Background(), u)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%s %s %d bytes", name, mimeType, len(data))
}
