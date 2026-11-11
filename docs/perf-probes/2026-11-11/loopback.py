#!/usr/bin/env python3
"""Loopback load probe, to run on the VPS: it skips Cloudflare and the tunnel.

Each request sends its own CF-Connecting-IP, so the 60/min per-IP limit on the feed and the
creators route does not cap the run. Read-only GETs, 20 s per step. Prints one JSON line per step.

usage (from a laptop):  ssh <user>@<vps> python3 - [name ...] < loopback.py | tee raw/loopback.log
"""
import http.client, json, sys, threading, time

ORIGIN, HOST = ("127.0.0.1", 8000), "echomultiverse.com"
STEP_S, STEPS = 20, [1, 2, 5, 10, 15, 25]
STOP_P95_MS = 3000
PATHS = {
    "reels_feed": ["/api/reels/feed"],
    "creators": ["/api/recommendations/creators"],
    "reels": ["/api/reels"],
    "player": ["/api/reels/player"],
    # one session start, feed page included
    "session": ["/", "/api/config", "/api/auth/me", "/api/reels", "/api/reels/player", "/api/reels/feed"],
}


def pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))]) if xs else None


def step(paths, conc):
    rows, sessions, lock = [], [], threading.Lock()
    stop_at = time.perf_counter() + STEP_S

    def worker(i):
        headers = {"Host": HOST, "X-Forwarded-Proto": "https",
                   "Accept-Encoding": "gzip", "User-Agent": "echo-loadprobe/loopback"}
        c = http.client.HTTPConnection(*ORIGIN, timeout=60)
        k = 0
        while time.perf_counter() < stop_at:
            s0, ok = time.perf_counter(), True
            for path in paths:
                k += 1
                headers["CF-Connecting-IP"] = f"10.{conc}.{i + 1}.{k % 250 + 1}"   # under 60 per IP per minute
                t0 = time.perf_counter()
                try:
                    c.request("GET", path, headers=headers)
                    r = c.getresponse()
                    r.read()
                    status = r.status
                except Exception:  # noqa: BLE001 - count it and reconnect
                    status = 0
                    c.close()
                    c = http.client.HTTPConnection(*ORIGIN, timeout=60)
                ok = ok and 200 <= status < 300
                with lock:
                    rows.append((status, (time.perf_counter() - t0) * 1e3))
            with lock:
                sessions.append(((time.perf_counter() - s0) * 1e3, ok))
        c.close()

    t0 = time.perf_counter()
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(conc)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    wall = time.perf_counter() - t0
    good = [ms for status, ms in rows if 200 <= status < 300]
    statuses = {}
    for status, _ in rows:
        statuses[str(status)] = statuses.get(str(status), 0) + 1
    out = dict(conc=conc, n=len(rows), statuses=statuses, good_rps=round(len(good) / wall, 2),
               p50=pct(good, .5), p95=pct(good, .95), p99=pct(good, .99), max=pct(good, 1))
    if len(paths) > 1:
        sdur = [d for d, ok in sessions if ok]
        out["session"] = dict(good_per_min=round(len(sdur) / wall * 60, 1), p50=pct(sdur, .5), p95=pct(sdur, .95), p99=pct(sdur, .99))
    return out


for name, paths in PATHS.items():
    if sys.argv[1:] and name not in sys.argv[1:]:
        continue
    for conc in STEPS:
        s = step(paths, conc)
        print(name, json.dumps(s), flush=True)
        if not s["p95"] or s["p95"] > STOP_P95_MS or len(s["statuses"]) > 1 or "200" not in s["statuses"]:
            break
        time.sleep(2)
