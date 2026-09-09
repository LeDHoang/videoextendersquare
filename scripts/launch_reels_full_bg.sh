#!/bin/sh
# Full-length reels compare (chunked, sequential, single GPU).
WS="$(cd "$(dirname "$0")/.." && pwd)"
export HF_HOME="$WS/.cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$WS/.cache/huggingface"
export PIP_CACHE_DIR="$WS/.cache/pip"
export TRITON_CACHE_DIR="$WS/.cache/triton"
export TORCH_HOME="$WS/.cache/torch"
export XDG_CACHE_HOME="$WS/.cache"
setsid nohup "$WS/comfy-venv/bin/python" -u "$WS/scripts/full_reels.py" >> "$WS/logs/comfy_reels_full.log" 2>&1 < /dev/null &
echo "reelsfull pid $!"
