#!/usr/bin/env bash
# Email-size copy of the vision cut: the master is ~80 MB (grain and SSAA
# detail), so this re-encodes it with two-pass x264 at 6 Mbps (~24 MB).
# Usage (from video/): npm run share:vision
set -euo pipefail
cd "$(dirname "$0")/../../reports/video"
src=echo-vision-30s.mp4
out=echo-vision-30s-share.mp4
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
x264=(-c:v libx264 -preset slow -b:v 6M -maxrate 9M -bufsize 12M -pix_fmt yuv420p -passlogfile "$tmp/x264")
ffmpeg -v error -y -i "$src" "${x264[@]}" -pass 1 -an -f null -
# Audio is copied, not re-encoded: a second AAC pass overshoots 0 dBTP.
ffmpeg -v error -y -i "$src" "${x264[@]}" -pass 2 -c:a copy -movflags +faststart "$out"
ls -la "$out"
