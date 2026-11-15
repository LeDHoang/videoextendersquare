#!/bin/sh
# Runs loopback.py on the VPS through the proxy (:8080), then against the writer alone (:8000),
# sampling container CPU the whole time. Start it detached so a dropped SSH session cannot stop it:
#   scp loopback.py run-loopback.sh <user>@<vps>:/tmp/
#   ssh -n <user>@<vps> 'setsid nohup sh /tmp/run-loopback.sh > /dev/null 2>&1 < /dev/null &'
# Done when /tmp/probe.done exists (about 50 minutes). Logs: /tmp/probe-{proxy,writer,cpu}.log
rm -f /tmp/probe.done /tmp/probe-cpu.log
( while [ ! -f /tmp/probe.done ]; do
    t=$(date -u +%H:%M:%S)
    docker stats --no-stream --format "{{.Name}} {{.CPUPerc}} {{.MemUsage}}" | grep -v staging | sed "s/^/$t /"
    sleep 8
  done ) >> /tmp/probe-cpu.log 2>&1 &
PORT=8080 python3 -u /tmp/loopback.py > /tmp/probe-proxy.log 2>&1
echo "--- proxy done $(date -u +%H:%M:%S)" >> /tmp/probe-cpu.log
sleep 20
PORT=8000 python3 -u /tmp/loopback.py > /tmp/probe-writer.log 2>&1
touch /tmp/probe.done
