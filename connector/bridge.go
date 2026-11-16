package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/util"
)

// ---- wire types (connector <-> agent) -------------------------------------

type Sender struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Number string `json:"number,omitempty"`
	IsMe   bool   `json:"isMe"`
}

type InboundEvent struct {
	Type             string     `json:"type"` // "message" | "alert"
	ConversationID   string     `json:"conversationId,omitempty"`
	ConversationName string     `json:"conversationName,omitempty"`
	IsGroup          bool       `json:"isGroup,omitempty"`
	MessageID        string     `json:"messageId,omitempty"`
	Sender           *Sender    `json:"sender,omitempty"`
	Text             string     `json:"text,omitempty"`
	Attachments      []string   `json:"attachments,omitempty"` // mime types of all media in the message
	Media            []MediaRef `json:"media,omitempty"`       // images stashed in Redis for the agent
	ReplyToMessageID string     `json:"replyToMessageId,omitempty"`
	Participants     []string   `json:"participants,omitempty"`
	Timestamp        int64      `json:"timestamp,omitempty"` // unix ms
	Alert            string     `json:"alert,omitempty"`
}

type OutboxItem struct {
	ID               string `json:"id"`
	Kind             string `json:"kind"` // "text" (default) | "typing" | "history" | "cookies"
	ConversationID   string `json:"conversationId"`
	Text             string `json:"text,omitempty"`
	ReplyToMessageID string `json:"replyToMessageId,omitempty"`
	MediaURL         string `json:"mediaUrl,omitempty"` // public https image/GIF/video to send as an attachment (Text becomes its caption)

	// history
	Count    int    `json:"count,omitempty"`
	Search   string `json:"search,omitempty"`
	Cursor   string `json:"cursor,omitempty"`
	ReplyKey string `json:"replyKey,omitempty"` // "rpc:<uuid>"; result is written to <prefix>:<replyKey>

	// cookies (from the desktop gm-cookies helper, via the agent's admin route)
	Cookies map[string]string `json:"cookies,omitempty"`
	Force   bool              `json:"force,omitempty"`
}

// ---- bridge ---------------------------------------------------------------

type Bridge struct {
	cfg   Config
	store Store
	log   zerolog.Logger
	cli   *libgm.Client
	http  *http.Client

	convs      sync.Map // conversationID -> *gmproto.Conversation
	mediaWaits sync.Map // messageID -> *libgm.WrappedMessage (latest version, waiting for full-size media)
	sims       atomic.Pointer[[]*gmproto.SIMCard]
	ready      atomic.Bool
	loggedOut  atomic.Bool
	lastEvent  atomic.Int64
	state      atomic.Value // string: ok | need-cookies | pairing
	phoneDown  atomic.Int64 // unix seconds when the phone stopped responding; 0 = fine
	authTrip   atomic.Bool  // a 401 already put us in need-cookies this process
	draining   atomic.Bool  // retryPending is running
	restart    chan string
}

func NewBridge(cfg Config, store Store, log zerolog.Logger) *Bridge {
	b := &Bridge{cfg: cfg, store: store, log: log, http: &http.Client{Timeout: 60 * time.Second}, restart: make(chan string, 1)}
	b.state.Store("starting")
	return b
}

func (b *Bridge) saveSession(ctx context.Context) {
	if b.cli == nil || b.cli.AuthData == nil {
		return
	}
	data, err := json.Marshal(b.cli.AuthData)
	if err != nil {
		b.log.Err(err).Msg("marshal session")
		return
	}
	if err := b.store.SaveSession(ctx, data); err != nil {
		b.log.Err(err).Msg("save session")
	}
}

func (b *Bridge) handleEvent(ctx context.Context, raw any) {
	b.lastEvent.Store(time.Now().Unix())
	switch evt := raw.(type) {
	case *events.ClientReady:
		for _, c := range evt.Conversations {
			b.convs.Store(c.GetConversationID(), c)
		}
		b.ready.Store(true)
		b.log.Info().Int("conversations", len(evt.Conversations)).Msg("client ready")
		go b.refreshConversations(ctx)
	case *gmproto.Conversation:
		b.convs.Store(evt.GetConversationID(), evt)
	case *libgm.WrappedMessage:
		go b.handleMessage(ctx, evt)
	case *gmproto.Settings:
		sims := evt.GetSIMCards()
		b.sims.Store(&sims)
		for _, s := range sims {
			b.log.Info().
				Str("sim_participant_id", s.GetSIMParticipant().GetID()).
				Str("carrier", s.GetSIMData().GetCarrierName()).
				Bool("rcs", s.GetRCSChats().GetEnabled()).
				Msg("SIM")
		}
	case *events.AuthTokenRefreshed, *events.PairSuccessful:
		go b.saveSession(ctx)
	case *gmproto.UserAlertEvent:
		switch evt.GetAlertType() {
		case gmproto.AlertType_BROWSER_INACTIVE, gmproto.AlertType_BROWSER_INACTIVE_FROM_TIMEOUT,
			gmproto.AlertType_BROWSER_INACTIVE_FROM_INACTIVITY:
			b.log.Warn().Str("alert", evt.GetAlertType().String()).Msg("session became inactive; reclaiming")
			go b.reclaimActive(ctx)
		case gmproto.AlertType_MOBILE_BATTERY_LOW:
			b.notify(ctx, "battery", 6*time.Hour, 3, "bot: phone battery low", "The bot stops working if the phone dies.")
		}
	case *events.PhoneNotResponding:
		b.log.Warn().Msg("phone not responding")
		b.phoneDown.CompareAndSwap(0, time.Now().Unix())
	case *events.PhoneRespondingAgain:
		b.log.Info().Msg("phone responding again")
		b.phoneDown.Store(0)
	case *events.ListenTemporaryError:
		b.log.Warn().Err(evt.Error).Msg("long-poll temporary error")
	case *events.ListenRecovered:
		b.log.Info().Msg("long-poll recovered")
	case *events.ListenFatalError:
		b.loggedOut.Store(true)
		b.markNeedsCookies(ctx, "long-poll fatal error: "+evt.Error.Error())
	case *events.GaiaLoggedOut:
		b.loggedOut.Store(true)
		b.markNeedsCookies(ctx, "Google account session logged out")
	case *gmproto.RevokePairData:
		b.loggedOut.Store(true)
		b.markNeedsCookies(ctx, "pairing revoked from the phone")
	default:
		b.log.Debug().Type("event", raw).Msg("unhandled event")
	}
}

func (b *Bridge) reclaimActive(ctx context.Context) {
	for _, d := range []time.Duration{5 * time.Second, 15 * time.Second, 60 * time.Second} {
		time.Sleep(d)
		if err := b.cli.SetActiveSession(ctx); err != nil {
			b.log.Warn().Err(err).Msg("set active failed")
			continue
		}
		b.log.Info().Msg("reclaimed active session")
		return
	}
}

func (b *Bridge) refreshConversations(ctx context.Context) {
	resp, err := b.cli.ListConversations(ctx, &gmproto.ListConversationsRequest{
		Count:  100,
		Folder: gmproto.ListConversationsRequest_INBOX,
	})
	if err != nil {
		b.log.Warn().Err(err).Msg("list conversations")
		return
	}
	for _, c := range resp.GetConversations() {
		b.convs.Store(c.GetConversationID(), c)
	}
}

func (b *Bridge) conversation(ctx context.Context, id string) (*gmproto.Conversation, error) {
	if v, ok := b.convs.Load(id); ok {
		return v.(*gmproto.Conversation), nil
	}
	c, err := b.cli.GetConversation(ctx, id)
	if err != nil {
		return nil, err
	}
	b.convs.Store(id, c)
	return c, nil
}

func (b *Bridge) allowed(convID string) bool {
	_, ok := b.cfg.AllowedConversations[convID]
	return ok
}

// lineAllows enforces the configured line mode on a conversation.
func (b *Bridge) lineAllows(c *gmproto.Conversation) bool {
	if b.cfg.LineMode != "sim" {
		return true
	}
	return c.GetSimCard().GetSIMParticipant().GetID() == b.cfg.LineSIMParticipant ||
		c.GetDefaultOutgoingID() == b.cfg.LineSIMParticipant
}

func isDelivered(s gmproto.MessageStatusType) (ok bool, outgoing bool) {
	switch s {
	case gmproto.MessageStatusType_INCOMING_COMPLETE, gmproto.MessageStatusType_INCOMING_DELIVERED,
		gmproto.MessageStatusType_INCOMING_DISPLAYED:
		return true, false
	case gmproto.MessageStatusType_OUTGOING_COMPLETE, gmproto.MessageStatusType_OUTGOING_DELIVERED,
		gmproto.MessageStatusType_OUTGOING_DISPLAYED:
		return true, true
	}
	return false, false
}

// waitForMedia parks a photo message whose full-size image isn't available yet.
// The phone sends an update for the same message ID once it is; if none comes
// within mediaWaitMax, the latest version is forwarded anyway.
func (b *Bridge) waitForMedia(ctx context.Context, m *libgm.WrappedMessage, thumbOnly []string) {
	id := m.GetMessageID()
	_, waiting := b.mediaWaits.Swap(id, m)
	for _, part := range thumbOnly {
		if first, _ := b.store.FirstSeen(ctx, "fullsize-req", id+":"+part, time.Hour); first {
			if _, err := b.cli.GetFullSizeImage(ctx, id, part); err != nil {
				b.log.Warn().Err(err).Str("message_id", id).Msg("request full-size image")
			}
		}
	}
	if waiting {
		return
	}
	b.log.Info().Str("message_id", id).Int("thumbnail_only", len(thumbOnly)).Msg("waiting for full-size media")
	time.AfterFunc(mediaWaitMax, func() {
		if latest, ok := b.mediaWaits.LoadAndDelete(id); ok {
			b.log.Warn().Str("message_id", id).Msg("full-size media never arrived; forwarding what we have")
			b.processMessage(ctx, latest.(*libgm.WrappedMessage), true, 0)
		}
	})
}

func (b *Bridge) handleMessage(ctx context.Context, m *libgm.WrappedMessage) {
	b.processMessage(ctx, m, false, 0)
}

// processMessage forwards an allowlisted message. force skips waiting for
// full-size media (used by the waitForMedia fallback).
//
// tries > 0 means this is a retry from the pending queue. If the message
// can't be forwarded (conversation lookup or webhook failed), it's un-marked
// as seen and queued for retry instead of being dropped.
func (b *Bridge) processMessage(ctx context.Context, m *libgm.WrappedMessage, force bool, tries int) {
	if m.IsOld {
		return
	}
	convID := m.GetConversationID()
	// Privacy gate: nothing about non-allowlisted conversations leaves this
	// function — not even to logs beyond the ID.
	if !b.allowed(convID) {
		b.log.Debug().Str("conversation_id", convID).Msg("ignoring message in non-allowlisted conversation")
		return
	}
	// Our own sends: log their status transitions (so a send the phone later
	// fails is visible) and stop here — they're never forwarded.
	if tmp := m.GetTmpID(); tmp != "" {
		if sent, _ := b.store.Has(ctx, "sent", tmp); sent {
			media := 0
			for _, info := range m.GetMessageInfo() {
				if info.GetMediaContent() != nil {
					media++
				}
			}
			b.log.Info().Str("tmp_id", tmp).Str("message_id", m.GetMessageID()).
				Str("status", m.GetMessageStatus().GetStatus().String()).
				Str("status_text", m.GetMessageStatus().GetStatusText()).
				Int("media", media).Msg("own send status")
			return
		}
	}
	// Photos: tell the agent one is on its way as early as possible (it waits
	// briefly for a photo sent together with a "bot ..." text).
	hasImage, mediaComplete, thumbOnly := imageState(m.GetMessageInfo())
	if hasImage {
		if seen, _ := b.store.Has(ctx, "seen", m.GetMessageID()); seen {
			return
		}
		b.setPhotoPending(ctx, convID, true)
	}
	ok, outgoing := isDelivered(m.GetMessageStatus().GetStatus())
	if !ok {
		return
	}
	var text strings.Builder
	var attachments []string
	for _, info := range m.GetMessageInfo() {
		if mc := info.GetMessageContent(); mc != nil && mc.GetContent() != "" {
			if text.Len() > 0 {
				text.WriteString("\n")
			}
			text.WriteString(mc.GetContent())
		}
		if media := info.GetMediaContent(); media != nil {
			attachments = append(attachments, media.GetMimeType())
		}
	}
	body := text.String()

	// Echo suppression: our own sends (by tmp ID) and anything bot-prefixed.
	if tmp := m.GetTmpID(); tmp != "" {
		if sent, _ := b.store.Has(ctx, "sent", tmp); sent {
			return
		}
	}
	if b.cfg.BotMarker != "" && strings.HasPrefix(strings.TrimSpace(body), b.cfg.BotMarker) {
		return
	}
	// Photos: hold the message until its full-size image is available (or we
	// give up waiting), instead of forwarding a thumbnail or nothing and then
	// dropping the later update as a duplicate.
	if hasImage && !mediaComplete && !force {
		b.waitForMedia(ctx, m, thumbOnly)
		return
	}
	if first, err := b.store.FirstSeen(ctx, "seen", m.GetMessageID(), 14*24*time.Hour); err != nil || !first {
		return
	}
	b.mediaWaits.Delete(m.GetMessageID())

	conv, err := b.conversation(ctx, convID)
	if err != nil {
		b.log.Warn().Err(err).Str("conversation_id", convID).Msg("get conversation")
		b.deferMessage(ctx, m, tries, "get conversation: "+err.Error())
		return
	}
	if !b.lineAllows(conv) {
		return
	}
	sender := &Sender{ID: m.GetParticipantID(), IsMe: outgoing}
	var participants []string
	for _, p := range conv.GetParticipants() {
		name := p.GetFullName()
		if name == "" {
			name = p.GetFormattedNumber()
		}
		if p.GetID().GetParticipantID() == m.GetParticipantID() {
			sender.Name, sender.Number = name, p.GetFormattedNumber()
			sender.IsMe = sender.IsMe || p.GetIsMe()
		}
		if p.GetIsMe() {
			name += " (owner)"
		}
		participants = append(participants, name)
	}
	if sender.Name == "" && m.GetSenderParticipant() != nil {
		sender.Name = m.GetSenderParticipant().GetFullName()
	}

	var media []MediaRef
	if len(attachments) > 0 {
		media = b.stashImages(ctx, m.GetMessageID(), m.GetMessageInfo())
		defer b.setPhotoPending(ctx, convID, false) // after the webhook has the photo
	}
	evt := InboundEvent{
		Type:             "message",
		ConversationID:   convID,
		ConversationName: conv.GetName(),
		IsGroup:          conv.GetIsGroupChat(),
		MessageID:        m.GetMessageID(),
		Sender:           sender,
		Text:             body,
		Attachments:      attachments,
		Media:            media,
		ReplyToMessageID: m.GetReplyMessage().GetMessageID(),
		Participants:     participants,
		Timestamp:        m.GetTimestamp() / 1000,
	}
	b.log.Info().Str("conversation_id", convID).Str("message_id", evt.MessageID).Bool("from_me", sender.IsMe).Msg("forwarding message")
	if err := b.postWebhook(ctx, evt); err != nil {
		b.log.Err(err).Str("message_id", evt.MessageID).Msg("webhook delivery failed")
		b.deferMessage(ctx, m, tries, "webhook: "+err.Error())
	}
}

func (b *Bridge) postWebhook(ctx context.Context, evt InboundEvent) error {
	if b.cfg.WebhookURL == "" {
		b.log.Info().Interface("event", evt).Msg("(no WEBHOOK_URL) event")
		return nil
	}
	body, _ := json.Marshal(evt)
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(1<<attempt) * time.Second)
		}
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		mac := hmac.New(sha256.New, []byte(b.cfg.WebhookSecret))
		mac.Write([]byte(ts + "." + string(body)))
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, b.cfg.WebhookURL, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-GM-Timestamp", ts)
		req.Header.Set("X-GM-Signature", hex.EncodeToString(mac.Sum(nil)))
		if b.cfg.WebhookBypass != "" {
			req.Header.Set("x-vercel-protection-bypass", b.cfg.WebhookBypass)
		}
		resp, err := b.http.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		resp.Body.Close()
		if resp.StatusCode < 300 {
			return nil
		}
		lastErr = fmt.Errorf("webhook status %d", resp.StatusCode)
		if resp.StatusCode < 500 && resp.StatusCode != 429 {
			return lastErr
		}
	}
	return lastErr
}

// ---- outbound ---------------------------------------------------------------

func (b *Bridge) runOutbox(ctx context.Context) {
	for ctx.Err() == nil {
		raw, err := b.store.PopOutbox(ctx, 25*time.Second)
		if err != nil {
			if ctx.Err() == nil {
				b.log.Warn().Err(err).Msg("outbox pop")
				time.Sleep(2 * time.Second)
			}
			continue
		}
		if raw == nil {
			continue
		}
		var item OutboxItem
		if err := json.Unmarshal(raw, &item); err != nil {
			b.log.Warn().Err(err).Msg("bad outbox item")
			continue
		}
		if err := b.deliver(ctx, item); err != nil {
			b.log.Err(err).Str("id", item.ID).Str("conversation_id", item.ConversationID).Msg("send failed")
		}
	}
}

func (b *Bridge) deliver(ctx context.Context, item OutboxItem) error {
	if item.Kind == "cookies" {
		return b.applyCookies(ctx, item)
	}
	if b.cli == nil || b.loggedOut.Load() {
		return errors.New("not connected (waiting for fresh cookies); dropping " + item.Kind)
	}
	if !b.allowed(item.ConversationID) {
		return errors.New("refusing to send to non-allowlisted conversation")
	}
	if item.ID != "" {
		if first, _ := b.store.FirstSeen(ctx, "outbox-done", item.ID, 24*time.Hour); !first {
			return nil // duplicate delivery of the same outbox item
		}
	}
	conv, err := b.conversation(ctx, item.ConversationID)
	if err != nil {
		return err
	}
	if !b.lineAllows(conv) {
		return errors.New("conversation is not on the configured line")
	}
	if item.Kind == "history" {
		return b.handleHistory(ctx, conv, item)
	}
	simPayload := conv.GetSimCard().GetSIMData().GetSIMPayload()
	if item.Kind == "typing" {
		return b.cli.SetTyping(ctx, item.ConversationID, simPayload)
	}
	text := strings.TrimSpace(item.Text)
	var media *gmproto.MessageInfo
	if item.MediaURL != "" {
		// Download/upload first so a bad URL doesn't leave a lone marker in the chat.
		if media, err = b.mediaInfo(ctx, item.MediaURL); err != nil {
			return err
		}
		if text == "" {
			// A bare attachment would look like the owner sent it; mark it first.
			text = b.cfg.BotMarker
		}
	}
	if text != "" {
		if b.cfg.BotPrefix != "" && !strings.HasPrefix(text, b.cfg.BotMarker) {
			text = b.cfg.BotPrefix + text
		}
		if err := b.send(ctx, conv, simPayload, item.ConversationID, item.ReplyToMessageID, &gmproto.MessageInfo{
			Data: &gmproto.MessageInfo_MessageContent{MessageContent: &gmproto.MessageContent{Content: text}},
		}); err != nil {
			return err
		}
	}
	if media != nil {
		// The attachment goes in its own message, like Messages for Web / mautrix
		// send it. Sharing a payload with text, the phone dropped the GIF.
		if err := b.send(ctx, conv, simPayload, item.ConversationID, "", media); err != nil {
			return fmt.Errorf("send media: %w", err)
		}
	}
	return nil
}

// send posts one message (one MessageInfo) and records its tmp ID for echo suppression.
func (b *Bridge) send(ctx context.Context, conv *gmproto.Conversation, simPayload *gmproto.SIMPayload, convID, replyTo string, info *gmproto.MessageInfo) error {
	tmpID := util.GenerateTmpID()
	_, _ = b.store.FirstSeen(ctx, "sent", tmpID, 24*time.Hour)
	req := &gmproto.SendMessageRequest{
		ConversationID: convID,
		MessagePayload: &gmproto.MessagePayload{
			TmpID:          tmpID,
			ConversationID: convID,
			ParticipantID:  conv.GetDefaultOutgoingID(),
			TmpID2:         tmpID,
			MessageInfo:    []*gmproto.MessageInfo{info},
		},
		SIMPayload: simPayload,
		TmpID:      tmpID,
	}
	if replyTo != "" {
		req.Reply = &gmproto.ReplyPayload{MessageID: replyTo}
	}
	resp, err := b.cli.SendMessage(ctx, req)
	if err != nil {
		return err
	}
	if resp.GetStatus() != gmproto.SendMessageResponse_SUCCESS {
		return fmt.Errorf("send status %s", resp.GetStatus())
	}
	b.log.Info().Str("conversation_id", convID).Str("tmp_id", tmpID).Bool("media", info.GetMediaContent() != nil).Msg("sent")
	return nil
}
