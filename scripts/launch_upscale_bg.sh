#!/bin/sh
# Upscale tests x2. UP1: 2.3 on title_dil15 (1280² -> 2560², trim 3s).
# UP2 (runs after access granted): 2.5 on the same input.
WS="$(cd "$(dirname "$0")/.." && pwd)"
export HF_HOME="$WS/.cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$WS/.cache/huggingface"
export PIP_CACHE_DIR="$WS/.cache/pip"
export TRITON_CACHE_DIR="$WS/.cache/triton"
export TORCH_HOME="$WS/.cache/torch"
export XDG_CACHE_HOME="$WS/.cache"
mkdir -p "$WS/output" "$WS/logs"
LOG="$WS/logs/comfy_upscale.log"
PY="$WS/comfy-venv/bin/python -u $WS/scripts/comfy_ltx_upscale.py"
echo "=== upscale launch $(date -u +%FT%TZ) ===" >> "$LOG"
setsid nohup sh -c "\
echo '--- UP1 2.3 x2 title (3s) ---'; \
$PY --template 2.3 --input '$WS/output/title_dil15.mp4' \
  --trim-start 0 --trim-duration 3 --scale 2 \
  --prompt 'cinematic dark gradient background with soft glow above and below, elegant, film grain' \
  --seed 11 --prefix title_up2_23 \
  --output '$WS/output/title_up2_23.mp4' --timeout 7200; \
echo ALLDONE" >> "$LOG" 2>&1 < /dev/null &
echo "upscale pid $!"
