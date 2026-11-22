#!/usr/bin/env python3
"""Max concurrent players, loopback on the VPS (no Cloudflare). Read-only GETs, 20 s per step.

Targets:
  player_inline  the SPA's player route alone
  player_open    a cold open of /reels as a first-time visitor: the shell, the boot API calls,
                 player-inline, the first reels page and the ten player scripts (no browser cache)
Each worker is one player opening back to back (closed loop). Steps go past the 11-12 run's 50.
Stops a target when p95 per request passes 3 s or any non-200 shows up.
PORT=8080 is the proxy (what visitors get), 8000 the writer alone.
"""
import http.client, json, os, re, sys, threading, time

ORIGIN, HOST = ("127.0.0.1", int(os.environ.get("PORT", 8080))), "echomultiverse.com"
STEP_S, STEPS = 20, [1, 2, 5, 10, 15, 25, 50, 75, 100, 150]
STOP_P95_MS = 3000
BASE_H = {"Host": HOST, "X-Forwarded-Proto": "https", "Accept-Encoding": "gzip", "User-Agent": "echo-loadprobe/player"}
PLAYER = "/api/reels/player-inline?folder=ALL+FOLDERS&codec=hevc&search=&sort=for_you&start=0"


def fetch(path):
    c = http.client.HTTPConnection(*ORIGIN, timeout=30)
    c.request("GET", path, headers={**BASE_H, "CF-Connecting-IP": "10.250.0.1"})
    body = c.getresponse().read().decode(errors="replace")
    c.close()
    return body


scripts = sorted(set(re.findall(r"/api/reels/player-script/[A-Za-z0-9_.-]+\?v=[0-9a-f]+", fetch(PLAYER))))
TARGETS = {
    "player_inline": [PLAYER],
    "player_open": ["/reels", "/api/config", "/api/health", "/api/messages/capabilities", "/api/billing/catalog",
                    "/api/auth/me", PLAYER,
                    "/api/reels?folder=ALL+FOLDERS&codec=hevc&search=&sort=for_you&limit=60&refresh=false"] + scripts,
}


def pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))]) if xs else None


def step(paths, conc):
    rows, opens, lock = [], [], threading.Lock()
    stop_at = time.perf_counter() + STEP_S

    def worker(i):
        headers = dict(BASE_H)
        c = http.client.HTTPConnection(*ORIGIN, timeout=60)
        k = 0
        while time.perf_counter() < stop_at:
            s0, ok = time.perf_counter(), True
            for path in paths:
                k += 1
                headers["CF-Connecting-IP"] = f"10.{conc % 250}.{i % 250 + 1}.{k % 250 + 1}"
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
                ok = ok and status == 200
                with lock:
                    rows.append((status, (time.perf_counter() - t0) * 1e3))
            with lock:
                opens.append(((time.perf_counter() - s0) * 1e3, ok))
        c.close()

    t0 = time.perf_counter()
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(conc)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    wall = time.perf_counter() - t0
    good = [ms for status, ms in rows if status == 200]
    statuses = {}
    for status, _ in rows:
        statuses[str(status)] = statuses.get(str(status), 0) + 1
    od = [d for d, ok in opens if ok]
    return dict(conc=conc, n=len(rows), statuses=statuses, good_rps=round(len(good) / wall, 2),
                p50=pct(good, .5), p95=pct(good, .95), p99=pct(good, .99), max=pct(good, 1),
                open=dict(per_min=round(len(od) / wall * 60, 1), n=len(opens), p50=pct(od, .5), p95=pct(od, .95),
                          p99=pct(od, .99), max=pct(od, 1)))


print("scripts", len(scripts), flush=True)
for name, paths in TARGETS.items():
    if sys.argv[1:] and name not in sys.argv[1:]:
        continue
    for conc in STEPS:
        s = step(paths, conc)
        print(name, json.dumps(s), flush=True)
        if not s["p95"] or s["p95"] > STOP_P95_MS or list(s["statuses"]) != ["200"]:
            break
        time.sleep(3)
