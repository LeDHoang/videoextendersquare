#!/bin/sh
# TwoAbove H3 outpaint battlefield v8: MASK-FEATHER TEST. nodes.py
# _spatial_generation_mask feathers 2 latent rows on the generate side
# of both horizontal edges (keep side exact). Same empty prompt / seed 7
# / 14 steps / 2s window as v7 — v7-vs-v8 delta is pure mask physics.
WS="$(cd "$(dirname "$0")/.." && pwd)"
export HF_HOME="$WS/.cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$WS/.cache/huggingface"
export PIP_CACHE_DIR="$WS/.cache/pip"
export TRITON_CACHE_DIR="$WS/.cache/triton"
export TORCH_HOME="$WS/.cache/torch"
export XDG_CACHE_HOME="$WS/.cache"
mkdir -p "$WS/output" "$WS/logs"
LOG="$WS/logs/comfy_h3tw.log"
PY="$WS/comfy-venv/bin/python -u $WS/scripts/comfy_h3tw_outpaint.py"
SRC="$WS/input/testcomfyui/Battlefield-2042-Trailer-but-with-the-full-song-(Kickstart-my-He-clip-3m00s-3m05s.mp4"
PROMPT="cinematic live-action battlefield: smoky cloudy sky with sun glow above, dusty war-torn combat ground below, matching the overcast light and motion of the source frame. Only empty sky and empty ground, no new people, objects or text."
echo "=== h3tw launch $(date -u +%FT%TZ) ===" >> "$LOG"
setsid nohup sh -c "\
$PY --input '$SRC' --trim-start 1 --trim-duration 2 --aspect '1:1 square' \
  --min-src-mp 0.5 --seed 7 --steps 14 --frame-cap 120 --prefix bf_h3tw8 \
  --output '$WS/output/bf_h3tw8.mp4' --timeout 7200; \
echo ALLDONE" >> "$LOG" 2>&1 < /dev/null &
echo "h3tw pid $!"
