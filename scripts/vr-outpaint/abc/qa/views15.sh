#!/bin/bash
# Render headset-style perspective views (90° FOV) of the 15 s A15/B15 outputs, as videos.
set -e
IN="$1"; OUT="$2"; mkdir -p "$OUT/views"
cd "$IN"
VIEWS="front:0:0 left:-50:0 right:50:0 up:0:50 down:0:-50"
for n in A15 B15; do
  for v in $VIEWS; do IFS=: read vn yaw pitch <<<"$v"
    for kind in comp raw; do
      ffmpeg -nostdin -v error -y -i "${n}_${kind}_00001.mp4" -vf "v360=input=hequirect:output=flat:h_fov=90:v_fov=90:yaw=$yaw:pitch=$pitch:w=960:h=960:interp=lanczos" \
        -c:v libx264 -crf 12 -pix_fmt yuv420p "$OUT/views/${n}_${kind}_${vn}.mp4" &
    done
  done
  wait; echo done $n
done
