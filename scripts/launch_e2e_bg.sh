#!/bin/sh
# E2E: real-clip path (trim + ref extract + pad/prompt/seed overrides) -> square.
# Uses the stock mp4 as stand-in input until a real clip is supplied.
WS="$(cd "$(dirname "$0")/.." && pwd)"
export HF_HOME="$WS/.cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$WS/.cache/huggingface"
export PIP_CACHE_DIR="$WS/.cache/pip"
export TRITON_CACHE_DIR="$WS/.cache/triton"
export TORCH_HOME="$WS/.cache/torch"
export XDG_CACHE_HOME="$WS/.cache"
mkdir -p "$WS/output" "$WS/logs"
LOG="$WS/logs/comfy_e2e.log"
echo "=== e2e launch $(date -u +%FT%TZ) ===" >> "$LOG"
setsid nohup "$WS/comfy-venv/bin/python" -u "$WS/scripts/comfy_ltx_outpaint.py" \
  --input "$WS/ComfyUI/input/outpainting_input.mp4" \
  --trim-start 0 --trim-duration 4 \
  --target-width 1280 --target-height 1280 \
  --prompt "city rooftop terrace at dusk, surrounding buildings" \
  --seed 42 --prefix e2e_square \
  --output "$WS/output/e2e_square.mp4" \
  --timeout 5400 >> "$LOG" 2>&1 < /dev/null &
echo "e2e pid $!"
