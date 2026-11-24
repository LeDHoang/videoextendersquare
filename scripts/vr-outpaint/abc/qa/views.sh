#!/bin/bash
# Render headset-style perspective views (90° FOV) of each option, as videos.
set -e
IN="$1"; OUT="$2"; mkdir -p "$OUT/eq" "$OUT/views"
cd "$IN"
# Equirect inputs per option: name|comp|raw|projection
ffmpeg -nostdin -v error -y -i C_raw_00001.mp4 -vf crop=1088:1088:544:0 -c:v libx264 -crf 12 "$OUT/eq/C_raw_front180.mp4"
ROWS="A|A_comp_00001.mp4|A_raw_00001.mp4|hequirect
B|B_comp_00001.mp4|B_raw_00001.mp4|hequirect
C|C_front180_00001.mp4|$OUT/eq/C_raw_front180.mp4|hequirect
orig360|orig360_comp_00001.mp4|orig360_raw_00001.mp4|e"
VIEWS="front:0:0 left:-50:0 right:50:0 up:0:50 down:0:-50"
echo "$ROWS" | while IFS='|' read n comp raw proj; do
  for v in $VIEWS; do IFS=: read vn yaw pitch <<<"$v"
    for kind in comp raw; do src=$([ $kind = comp ] && echo $comp || echo $raw)
      ffmpeg -nostdin -v error -y -i "$src" -vf "v360=input=$proj:output=flat:h_fov=90:v_fov=90:yaw=$yaw:pitch=$pitch:w=960:h=960:interp=lanczos" \
        -c:v libx264 -crf 12 -pix_fmt yuv420p "$OUT/views/${n}_${kind}_${vn}.mp4"
    done
  done
  echo done $n
done
