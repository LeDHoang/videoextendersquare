#!/bin/bash
# usage: render.sh OUTDIR REF name=raw.mp4 ...   -> feather comp + 5 headset views (comp, raw) per name
set -e
S=$(cd "$(dirname "$0")" && pwd)
PY=${PY:-python}; MASK=${MASK:?set MASK to the source mask png}
D=$1; REF=$2; shift 2; mkdir -p $D/views
for kv in "$@"; do
  n=${kv%%=*}; raw=${kv#*=}
  "$PY" -I $S/feather.py "$raw" $REF "$MASK" $D/$n
  ffmpeg -nostdin -v error -y -i $D/$n.tmp.mp4 -c:v libx264 -crf 12 -pix_fmt yuv420p $D/${n}_comp.mp4; rm $D/$n.tmp.mp4
  for v in front:0:0 left:-50:0 right:50:0 up:0:50 down:0:-50; do
    IFS=: read vn yaw pitch <<<"$v"
    for k in comp raw; do
      in=$D/${n}_comp.mp4; [ $k = raw ] && in=$raw
      ffmpeg -nostdin -v error -y -i "$in" -vf "v360=input=hequirect:output=flat:h_fov=90:v_fov=90:yaw=$yaw:pitch=$pitch:w=960:h=960:interp=lanczos" -c:v libx264 -crf 12 -pix_fmt yuv420p $D/views/${n}_${k}_${vn}.mp4 &
    done
  done; wait
  echo "rendered $n"
done
