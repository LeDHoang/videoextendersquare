#!/bin/zsh
# usage: abrun.sh <name> <query>
S=${0:a:h}; N=$1; mkdir -p $S/ab/$N
adb shell am broadcast -a com.oculus.vrpowermanager.prox_close >/dev/null
adb logcat -c
adb logcat -v epoch -s VrApi ABMARK > $S/ab/$N/logcat.txt & LP=$!
AB_QUERY="$2" node $S/ab.mjs $S/ab/$N/capture.json 2>&1 | tee $S/ab/$N/driver.log
sleep 1; kill $LP
adb shell am broadcast -a com.oculus.vrpowermanager.automation_disable >/dev/null
