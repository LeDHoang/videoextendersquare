#!/usr/bin/env bash
# Builds video/public/media (gitignored) from repo assets: H.264 proxies of the
# ECHO 4K outputs plus logo, earth texture, controller graphic and UI stills.
#   cd video && npm run media
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/../public/media"
mkdir -p "$OUT/ui"

proxy() { # src dst size
  [ -f "$2" ] && [ "$2" -nt "$1" ] && return
  echo "proxy $(basename "$1") -> $(basename "$2")"
  ffmpeg -v error -y -i "$1" -vf "scale=$3:$3:flags=lanczos,fps=30" -an \
    -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -movflags +faststart "$2"
}

# Interim Pexels-based ECHO outputs (replace before public promo use).
proxy "$REPO/output/12492094_3840_3840.mp4" "$OUT/reel-van.mp4" 1080
proxy "$REPO/output/12827489_3840_3840.mp4" "$OUT/reel-volley.mp4" 1080
proxy "$REPO/input/1:1/12827489_720_720_30fps.mp4" "$OUT/reel-volley-src.mp4" 720

cp "$REPO/web/public/logo.svg" "$OUT/logo.svg"
cp "$REPO/web/public/assets/earth-natural-4096x2048.jpg" "$OUT/earth.jpg"
cp "$REPO/docs/images/Quest Controller Graphic .png" "$OUT/controller.png"
for f in reel_packs messages_chat compare_slider reels_vr_mode; do
  cp "$REPO/docs/images/$f.png" "$OUT/ui/$f.png"
done
# Vision cut score: first 30 s of the founder's own track (VR Tiktok/Media).
AUDIO="$HERE/../public/audio"
mkdir -p "$AUDIO"
if [ -f "$REPO/../Media/testaudiotrack.mp3" ] && [ ! -f "$AUDIO/vision.mp3" ]; then
  ffmpeg -v error -y -i "$REPO/../Media/testaudiotrack.mp3" -t 30 -c:a libmp3lame -q:a 2 "$AUDIO/vision.mp3"
fi
echo "media ready in $OUT"
