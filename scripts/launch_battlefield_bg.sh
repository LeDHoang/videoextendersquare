#!/bin/sh
# Battlefield clip: 1726x970 landscape -> 1728x1728 square (bigger dim, x64-snapped).
WS="$(cd "$(dirname "$0")/.." && pwd)"
export HF_HOME="$WS/.cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$WS/.cache/huggingface"
export PIP_CACHE_DIR="$WS/.cache/pip"
export TRITON_CACHE_DIR="$WS/.cache/triton"
export TORCH_HOME="$WS/.cache/torch"
export XDG_CACHE_HOME="$WS/.cache"
mkdir -p "$WS/output" "$WS/logs"
LOG="$WS/logs/comfy_battlefield.log"
echo "=== battlefield launch $(date -u +%FT%TZ) ===" >> "$LOG"
setsid nohup "$WS/comfy-venv/bin/python" -u "$WS/scripts/comfy_ltx_outpaint.py" \
  --input "$WS/input/testcomfyui/Battlefield-2042-Trailer-but-with-the-full-song-(Kickstart-my-He-clip-3m00s-3m05s.mp4" \
  --trim-start 0 --trim-duration 5 \
  --target-width 1728 --target-height 1728 \
  --prompt "smoky battlefield sky with distant mountains above, dusty war-torn combat ground below, cinematic live action" \
  --seed 7 --prefix battlefield_sq \
  --output "$WS/output/battlefield_sq.mp4" \
  --timeout 5400 >> "$LOG" 2>&1 < /dev/null &
echo "battlefield pid $!"
