#!/bin/sh
# Persistent ComfyUI launcher — lives in workspace (survives /tmp wipes).
# Usage: sh scripts/launch_comfy_bg.sh  (starts server detached, logs to logs/)
WS="$(dirname "$(dirname "$0")")"
WS="$(cd "$WS" && pwd)"
export HF_HOME="$WS/.cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$WS/.cache/huggingface"
export PIP_CACHE_DIR="$WS/.cache/pip"
export TRITON_CACHE_DIR="$WS/.cache/triton"
export TORCH_HOME="$WS/.cache/torch"
export XDG_CACHE_HOME="$WS/.cache"
mkdir -p "$WS/logs" "$WS/.cache/huggingface"
LOG="$WS/logs/comfyui_server.log"
# Kill stale server on same port (idle-stop leftovers), then start detached.
if command -v fuser >/dev/null 2>&1; then
  fuser -k 8188/tcp 2>/dev/null
fi
echo "=== launch $(date -u +%FT%TZ) WS=$WS ===" >> "$LOG"
# setsid + nohup: survives shell exit; full venv path as argv[0] so pyvenv.cfg applies.
setsid nohup "$WS/comfy-venv/bin/python" "$WS/ComfyUI/main.py" \
  --listen 127.0.0.1 --port 8188 --reserve-vram 5 >> "$LOG" 2>&1 < /dev/null &
echo "started pid $! log=$LOG"
