#!/bin/sh
# Detached on the VPS: player concurrency through the proxy, then the 11-12 loopback set through the
# proxy and against the writer alone, sampling container CPU and load the whole time.
D=/tmp/probe-20261122
mkdir -p $D
rm -f $D/done
( while [ ! -f $D/done ]; do
    t=$(date -u +%H:%M:%S)
    echo "$t load $(cut -d' ' -f1-3 /proc/loadavg)"
    docker stats --no-stream --format "{{.Name}} {{.CPUPerc}} {{.MemUsage}}" | sed "s/^/$t /"
    sleep 8
  done ) >> $D/cpu.log 2>&1 &
echo "--- player start $(date -u +%H:%M:%S)" >> $D/cpu.log
PORT=8080 python3 -u $D/player_probe.py > $D/player-proxy.log 2>&1
echo "--- player done, proxy loopback start $(date -u +%H:%M:%S)" >> $D/cpu.log
sleep 20
PORT=8080 python3 -u $D/loopback.py > $D/loopback-proxy.log 2>&1
echo "--- proxy loopback done, writer start $(date -u +%H:%M:%S)" >> $D/cpu.log
sleep 20
PORT=8000 python3 -u $D/loopback.py > $D/loopback-writer.log 2>&1
echo "--- writer done $(date -u +%H:%M:%S)" >> $D/cpu.log
touch $D/done
