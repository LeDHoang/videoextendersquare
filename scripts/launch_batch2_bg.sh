#!/bin/sh
# Batch: 2x 1280x720 landscape -> 1280x1280 squares (bigger dim, already x64).
# Sequential in one process; ComfyUI server queues prompts anyway.
WS="$(cd "$(dirname "$0")/.." && pwd)"
export HF_HOME="$WS/.cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$WS/.cache/huggingface"
export PIP_CACHE_DIR="$WS/.cache/pip"
export TRITON_CACHE_DIR="$WS/.cache/triton"
export TORCH_HOME="$WS/.cache/torch"
export XDG_CACHE_HOME="$WS/.cache"
mkdir -p "$WS/output" "$WS/logs"
LOG="$WS/logs/comfy_batch2.log"
PY="$WS/comfy-venv/bin/python -u $WS/scripts/comfy_ltx_outpaint.py"
echo "=== batch2 launch $(date -u +%FT%TZ) ===" >> "$LOG"
setsid nohup sh -c "\
$PY --input '$WS/input/testcomfyui/0_Cinematic_Title_1280x720.mp4' \
  --trim-start 0 --trim-duration 5 \
  --target-width 1280 --target-height 1280 \
  --prompt 'cinematic dark gradient background with soft glow above and below, elegant, film grain' \
  --seed 11 --prefix title_sq \
  --output '$WS/output/title_sq.mp4' --timeout 5400; \
$PY --input '$WS/input/testcomfyui/0_Tech_Conference_1280x720.mp4' \
  --trim-start 0 --trim-duration 5 \
  --target-width 1280 --target-height 1280 \
  --prompt 'modern tech conference stage hall, ceiling lights above, audience silhouettes below, photorealistic' \
  --seed 12 --prefix conf_sq \
  --output '$WS/output/conf_sq.mp4' --timeout 5400" >> "$LOG" 2>&1 < /dev/null &
echo "batch2 pid $!"
