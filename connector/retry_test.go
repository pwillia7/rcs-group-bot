package main

import (
	"testing"
	"time"
)

func TestAuthWatchFiresOn401(t *testing.T) {
	w := &authWatch{}
	hit := make(chan struct{}, 4)
	fn := func() { hit <- struct{}{} }
	w.fn.Store(&fn)
	_, _ = w.Write([]byte(`{"level":"error","error":"HTTP 401: 16: Request had invalid authentication credentials.","message":"Error sending ping"}`))
	select {
	case <-hit:
	case <-time.After(time.Second):
		t.Fatal("401 line did not trigger callback")
	}
	_, _ = w.Write([]byte(`{"level":"info","message":"forwarding message"}`))
	select {
	case <-hit:
		t.Fatal("non-401 line triggered callback")
	case <-time.After(100 * time.Millisecond):
	}
}
