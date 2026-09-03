#!/bin/sh
# Launch stock smoke test detached (survives shell/idle-stop of the session).
WS="$(cd "$(dirname "$0")/.." && pwd)"
export HF_HOME="$WS/.cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$WS/.cache/huggingface"
export PIP_CACHE_DIR="$WS/.cache/pip"
export TRITON_CACHE_DIR="$WS/.cache/triton"
export TORCH_HOME="$WS/.cache/torch"
export XDG_CACHE_HOME="$WS/.cache"
mkdir -p "$WS/output" "$WS/logs"
LOG="$WS/logs/comfy_smoke.log"
echo "=== smoke launch $(date -u +%FT%TZ) ===" >> "$LOG"
setsid nohup "$WS/comfy-venv/bin/python" -u "$WS/scripts/comfy_ltx_outpaint.py" \
  --stock --prefix smoke_stock --output "$WS/output/smoke_stock.mp4" \
  --timeout 5400 >> "$LOG" 2>&1 < /dev/null &
echo "smoke pid $!"
