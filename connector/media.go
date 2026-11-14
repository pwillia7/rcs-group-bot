package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"strings"
	"time"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

// MediaRef points the agent at an image the connector stashed in Redis.
type MediaRef struct {
	Key      string `json:"key"` // <prefix>:<key> holds base64 JPEG
	MimeType string `json:"mimeType"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

const (
	mediaMaxDownload = 20 << 20 // 20 MiB raw
	mediaMaxSide     = 1568     // long side after downscale (good for Claude and Qwen)
	mediaTTL         = 72 * time.Hour
)

const (
	// How long to hold a photo message waiting for its full-size upload before
	// forwarding whatever we have (thumbnail, or nothing).
	mediaWaitMax = 20 * time.Second
	// Agent-visible marker: "a photo is on its way in this conversation".
	photoPendingTTL = 45 * time.Second
)

// imageState reports whether every image part is ready for a full-size download.
// Outgoing photos first arrive with no media ID at all (still uploading from the
// phone); incoming RCS photos can arrive with only a thumbnail or a tiny inline
// preview until the full image is requested. Both get a later update for the same message ID.
func imageState(infos []*gmproto.MessageInfo) (hasImage, complete bool, thumbOnly []string) {
	complete = true
	for _, info := range infos {
		m := info.GetMediaContent()
		if m == nil || !strings.HasPrefix(m.GetMimeType(), "image/") {
			continue
		}
		hasImage = true
		switch {
		case m.GetMediaID() != "":
		case m.GetThumbnailMediaID() != "" || len(m.GetMediaData()) > 0:
			// A thumbnail ID or inline bytes are only a tiny preview (~50px):
			// ask the phone for the full-size image and wait for the update.
			complete = false
			thumbOnly = append(thumbOnly, info.GetActionMessageID())
		default:
			complete = false
		}
	}
	return
}

func (b *Bridge) setPhotoPending(ctx context.Context, convID string, pending bool) {
	if pending {
		_ = b.store.SetKey(ctx, "photo-pending:"+convID, []byte("1"), photoPendingTTL)
	} else {
		_ = b.store.SetKey(ctx, "photo-pending:"+convID, []byte("0"), 5*time.Second)
	}
}

// stashImages downloads the images in a message, downsizes them to JPEG and
// stores them in Redis for the agent. Non-image media is ignored here.
func (b *Bridge) stashImages(ctx context.Context, messageID string, infos []*gmproto.MessageInfo) []MediaRef {
	var refs []MediaRef
	for i, info := range infos {
		media := info.GetMediaContent()
		if media == nil || !strings.HasPrefix(media.GetMimeType(), "image/") {
			continue
		}
		raw, err := b.downloadMedia(ctx, media)
		if err != nil {
			b.log.Warn().Err(err).Str("message_id", messageID).Msg("media download failed")
			continue
		}
		jpg, w, h, err := toJPEG(raw)
		b.log.Info().Str("message_id", messageID).Str("mime", media.GetMimeType()).
			Bool("has_media_id", media.GetMediaID() != "").Bool("has_thumb_id", media.GetThumbnailMediaID() != "").
			Int("inline_bytes", len(media.GetMediaData())).Int64("size", media.GetSize()).
			Int64("dim_w", media.GetDimensions().GetWidth()).Int64("dim_h", media.GetDimensions().GetHeight()).
			Int("raw_bytes", len(raw)).Int("out_w", w).Int("out_h", h).Msg("media fetched")
		if err != nil {
			// e.g. HEIC: Go can't decode it; the agent just sees "[sent image/heic]".
			b.log.Warn().Err(err).Str("mime", media.GetMimeType()).Msg("media decode failed")
			continue
		}
		key := fmt.Sprintf("media:%s:%d", messageID, i)
		if err := b.store.SetKey(ctx, key, []byte(base64.StdEncoding.EncodeToString(jpg)), mediaTTL); err != nil {
			b.log.Warn().Err(err).Msg("media stash failed")
			continue
		}
		refs = append(refs, MediaRef{Key: key, MimeType: "image/jpeg", Width: w, Height: h})
	}
	return refs
}

func (b *Bridge) downloadMedia(ctx context.Context, m *gmproto.MediaContent) ([]byte, error) {
	var r io.ReadCloser
	var err error
	switch {
	case m.GetMediaID() != "":
		r, err = b.cli.DownloadMedia(ctx, m.GetMediaID(), m.GetDecryptionKey())
	case m.GetThumbnailMediaID() != "":
		r, err = b.cli.DownloadMedia(ctx, m.GetThumbnailMediaID(), m.GetThumbnailDecryptionKey())
	case len(m.GetMediaData()) > 0:
		return m.GetMediaData(), nil
	default:
		return nil, fmt.Errorf("no media id")
	}
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(io.LimitReader(r, mediaMaxDownload))
}

func toJPEG(raw []byte) ([]byte, int, int, error) {
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, 0, 0, err
	}
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if long := max(w, h); long > mediaMaxSide {
		scale := float64(mediaMaxSide) / float64(long)
		nw, nh := max(1, int(float64(w)*scale)), max(1, int(float64(h)*scale))
		dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, bounds, draw.Over, nil)
		img, w, h = dst, nw, nh
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85}); err != nil {
		return nil, 0, 0, err
	}
	return buf.Bytes(), w, h, nil
}
