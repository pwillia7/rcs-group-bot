package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestToJPEGDownscales(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 4000, 2000))
	for x := 0; x < 4000; x++ {
		src.Set(x, 1000, color.RGBA{255, 0, 0, 255})
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, src)
	out, w, h, err := toJPEG(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if w != 1568 || h != 784 || len(out) == 0 || out[0] != 0xFF || out[1] != 0xD8 {
		t.Fatalf("got %dx%d len=%d", w, h, len(out))
	}
}
