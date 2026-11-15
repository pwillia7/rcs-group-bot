package main

import (
	"bytes"
	"context"
	"encoding/json"
	"sync/atomic"
	"time"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
	"google.golang.org/protobuf/proto"
)

// ---- early auth-failure detection -----------------------------------------
//
// When Google rotates the session cookies, libgm's pings and acks start failing
// with HTTP 401 right away, but it only raises ListenFatalError (our cue to ask
// the desktop helper for fresh cookies) when the long-poll itself fails, which
// can be ~8 minutes later. libgm doesn't surface those 401s as events, only as
// log lines, so watch the log stream for them.

type authWatch struct{ fn atomic.Pointer[func()] }

var authWatcher = &authWatch{}

func (w *authWatch) Write(p []byte) (int, error) {
	if bytes.Contains(bytes.ToLower(p), []byte("http 401")) {
		if fn := w.fn.Load(); fn != nil {
			go (*fn)() // not inline: the callback logs, and we're inside a log write
		}
	}
	return len(p), nil
}

// onAuthRejected moves a healthy connector to need-cookies on the first 401,
// so the desktop helper refreshes cookies within a minute or two.
func (b *Bridge) onAuthRejected(ctx context.Context) {
	if s, _ := b.state.Load().(string); s != "ok" {
		return // already degraded, or starting/verifying (handled by the connect path)
	}
	if !b.authTrip.CompareAndSwap(false, true) {
		return
	}
	b.markNeedsCookies(ctx, "Google rejected the session (HTTP 401); cookies likely rotated")
}

// ---- pending (retry) queue ------------------------------------------------

type pendingMessage struct {
	Msg   []byte `json:"msg"` // proto-encoded gmproto.Message
	Tries int    `json:"tries"`
}

const (
	pendingMaxTries = 10
	pendingMaxAge   = 6 * time.Hour
)

// deferMessage un-marks a message as seen and queues it for retry, so a
// failure mid-forward doesn't silently drop it.
func (b *Bridge) deferMessage(ctx context.Context, m *libgm.WrappedMessage, tries int, reason string) {
	id := m.GetMessageID()
	if tries+1 >= pendingMaxTries {
		b.log.Error().Str("message_id", id).Int("tries", tries+1).Str("reason", reason).Msg("giving up on message")
		return
	}
	data, err := proto.Marshal(m.Message)
	if err != nil {
		b.log.Err(err).Str("message_id", id).Msg("encode pending message")
		return
	}
	item, _ := json.Marshal(pendingMessage{Msg: data, Tries: tries + 1})
	_ = b.store.Forget(ctx, "seen", id)
	if err := b.store.PushPending(ctx, item); err != nil {
		b.log.Err(err).Str("message_id", id).Msg("queue pending message")
		return
	}
	b.log.Warn().Str("message_id", id).Int("tries", tries+1).Str("reason", reason).Msg("message queued for retry")
}

// retryPending re-processes queued messages. Called every minute while the
// connector is healthy; items that fail again re-queue themselves.
func (b *Bridge) retryPending(ctx context.Context) {
	if s, _ := b.state.Load().(string); s != "ok" || b.cli == nil {
		return
	}
	if !b.draining.CompareAndSwap(false, true) {
		return
	}
	defer b.draining.Store(false)
	// Bounded: failures push back onto the same list, so don't loop forever.
	for i := 0; i < 50 && ctx.Err() == nil; i++ {
		raw, err := b.store.PopPending(ctx)
		if err != nil {
			b.log.Warn().Err(err).Msg("pop pending")
			return
		}
		if raw == nil {
			return
		}
		var item pendingMessage
		msg := &gmproto.Message{}
		if err := json.Unmarshal(raw, &item); err != nil || proto.Unmarshal(item.Msg, msg) != nil {
			b.log.Warn().Msg("dropping unreadable pending message")
			continue
		}
		// Message timestamps are microseconds. Don't replay old chatter after a long outage.
		if ts := msg.GetTimestamp(); ts > 0 && time.Since(time.UnixMicro(ts)) > pendingMaxAge {
			b.log.Warn().Str("message_id", msg.GetMessageID()).Msg("dropping stale pending message")
			continue
		}
		b.log.Info().Str("message_id", msg.GetMessageID()).Int("tries", item.Tries).Msg("retrying message")
		b.processMessage(ctx, &libgm.WrappedMessage{Message: msg}, true, item.Tries)
	}
}
