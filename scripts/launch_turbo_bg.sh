#!/bin/sh
# Reel2 TW-turbo A/B run (local GPU, background).
WS="$(cd "$(dirname "$0")/.." && pwd)"
export HF_HOME="$WS/.cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$WS/.cache/huggingface"
export PIP_CACHE_DIR="$WS/.cache/pip"
export TRITON_CACHE_DIR="$WS/.cache/triton"
export TORCH_HOME="$WS/.cache/torch"
export XDG_CACHE_HOME="$WS/.cache"
setsid nohup "$WS/comfy-venv/bin/python" -u "$WS/scripts/run_reel2_turbo.py" >> "$WS/logs/comfy_reel2_turbo.log" 2>&1 < /dev/null &
echo "turbo pid $!"
