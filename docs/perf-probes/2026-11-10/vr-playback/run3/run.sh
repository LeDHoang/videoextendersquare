#!/bin/zsh
# usage: run.sh <name>   (env passes through to verify.mjs)
# Captures VrApi + ABMARK lines, warnings and errors from every tag, and a
# screen recording of the headset view, around one verify.mjs pass.
S=${0:a:h}; N=$1; O=${S:h:h:h:h:h}/output/vr-playback-2026-11-10/run3/$N; mkdir -p $O
adb shell am broadcast -a com.oculus.vrpowermanager.prox_close >/dev/null
adb logcat -c
adb logcat -v epoch -s VrApi ABMARK > $O/logcat.txt & LP=$!
adb logcat -v epoch '*:W' > $O/warn.txt & LW=$!
adb shell rm -f /sdcard/run3.mp4
adb shell screenrecord --time-limit 180 /sdcard/run3.mp4 & RP=$!; date +%s.%N > $O/rec_start_wall.txt
node $S/verify.mjs $O/capture.json 2>&1 | tee $O/driver.log
kill -INT $RP 2>/dev/null; adb shell pkill -INT screenrecord; sleep 2
adb pull /sdcard/run3.mp4 $O/rec.mp4 >/dev/null 2>&1
kill $LP $LW
[ -n "$KEEP_AWAKE" ] || adb shell am broadcast -a com.oculus.vrpowermanager.automation_disable >/dev/null
