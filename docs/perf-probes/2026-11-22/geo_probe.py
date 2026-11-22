#!/usr/bin/env python3
"""Short edge probe of echomultiverse.com from wherever the laptop's traffic leaves (VPN location).

Read-only anonymous GETs through Cloudflare and the tunnel:
  where     cdn-cgi/trace: the Cloudflare colo and the country Cloudflare sees (the IP is not printed)
  latency   one warm keep-alive connection per route, SAMPLES sequential GETs, time to first byte
            and total; the first request (DNS + TCP + TLS) is reported apart as cold
  media     one 4 MB Range read of a reel mp4 from the media origin, as MB/s
  player    a cold /reels open (shell, boot calls, player-inline, first reels page, the ten player
            scripts) by 1 and 5 concurrent players, 15 s each
Usage: python3 -u geo_probe.py <label>   (writes one JSON line to stdout)
"""
import gzip, http.client, json, re, ssl, sys, threading, time, urllib.parse

HOST, UA = "echomultiverse.com", "echo-probe/geo-2026-11-22"
CTX = ssl.create_default_context()
SAMPLES, PLAYER_S = 20, 15
PLAYER = "/api/reels/player-inline?folder=ALL+FOLDERS&codec=hevc&search=&sort=for_you&start=0"
REELS = "/api/reels?folder=ALL+FOLDERS&codec=hevc&search=&sort=for_you&limit=60&refresh=false"


def conn(host=HOST):
    return http.client.HTTPSConnection(host, timeout=30, context=CTX)


def timed(c, path, headers=None):
    t0 = time.perf_counter()
    c.request("GET", path, headers={"User-Agent": UA, "Accept-Encoding": "gzip", **(headers or {})})
    r = c.getresponse()
    ttfb = (time.perf_counter() - t0) * 1e3
    body = r.read()
    return r.status, ttfb, (time.perf_counter() - t0) * 1e3, body, {k.lower(): v for k, v in r.getheaders()}


def pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))]) if xs else None


def get(path):
    c = conn()
    s, _, _, body, h = timed(c, path)
    c.close()
    return s, gzip.decompress(body) if h.get("content-encoding") == "gzip" else body, h


trace = dict(l.split("=", 1) for l in get("/cdn-cgi/trace")[1].decode().splitlines() if "=" in l)
index = get("/")[1].decode()
js = re.search(r"/assets/index-[\w-]+\.js", index).group(0)
scripts = sorted(set(re.findall(r"/api/reels/player-script/[A-Za-z0-9_.-]+\?v=[0-9a-f]+", get(PLAYER)[1].decode(errors="replace"))))
feed = json.loads(get("/api/reels/feed")[1])
mp4 = next(i["url"] for i in feed["items"] if i.get("url"))

routes = {"trace": "/cdn-cgi/trace", "healthz": "/api/healthz", "spa_index": "/", "spa_js": js, "config": "/api/config",
          "reels": REELS, "tags": "/api/reels/tags", "feed": "/api/reels/feed", "player_inline": PLAYER}
out = {"label": sys.argv[1] if sys.argv[1:] else "here", "colo": trace.get("colo"), "loc": trace.get("loc"),
       "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "latency": {}}

for name, path in routes.items():
    c = conn()
    cold, ttfbs, totals, statuses, cache = None, [], [], {}, None
    for i in range(SAMPLES + 1):
        try:
            s, ttfb, total, _, h = timed(c, path)
        except Exception:  # noqa: BLE001 - count it and reconnect
            s, ttfb, total, h = 0, None, None, {}
            c.close()
            c = conn()
        statuses[str(s)] = statuses.get(str(s), 0) + 1
        if i == 0:
            cold = round(total) if total else None
            cache = h.get("cf-cache-status", "-")
        elif s == 200:
            ttfbs.append(ttfb)
            totals.append(total)
    c.close()
    out["latency"][name] = {"cold_ms": cold, "ttfb_p50": pct(ttfbs, .5), "ttfb_p95": pct(ttfbs, .95),
                            "total_p50": pct(totals, .5), "cache": cache, "statuses": statuses}
    print(name, json.dumps(out["latency"][name]), file=sys.stderr, flush=True)

u = urllib.parse.urlsplit(mp4)
c = http.client.HTTPSConnection(u.netloc, timeout=60, context=CTX)
try:
    s, ttfb, total, body, _ = timed(c, u.path + ("?" + u.query if u.query else ""), {"Range": "bytes=0-4194303", "Origin": f"https://{HOST}"})
    out["media"] = {"status": s, "bytes": len(body), "ttfb_ms": round(ttfb), "mb_per_s": round(len(body) / 1e6 / (total / 1e3), 2)}
except Exception as e:  # noqa: BLE001 - a slow VPN leg can time out; record it
    out["media"] = {"error": type(e).__name__}
c.close()
print("media", json.dumps(out["media"]), file=sys.stderr, flush=True)

OPEN = ["/reels", "/api/config", "/api/health", "/api/messages/capabilities", "/api/billing/catalog", "/api/auth/me",
        PLAYER, REELS] + scripts
out["player"] = {}
for n in (1, 5):
    opens, lock, stop_at = [], threading.Lock(), time.perf_counter() + PLAYER_S

    def worker():
        c = conn()
        while time.perf_counter() < stop_at:
            s0, ok = time.perf_counter(), True
            for path in OPEN:
                try:
                    s, _, _, _, _ = timed(c, path)
                except Exception:  # noqa: BLE001
                    s = 0
                    c.close()
                    c = conn()
                ok = ok and s in (200, 401)
            with lock:
                opens.append(((time.perf_counter() - s0) * 1e3, ok))
        c.close()

    ts = [threading.Thread(target=worker) for _ in range(n)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    good = [d for d, ok in opens if ok]
    out["player"][str(n)] = {"opens": len(opens), "ok": len(good), "p50": pct(good, .5), "p95": pct(good, .95), "max": pct(good, 1)}
    print("player", n, json.dumps(out["player"][str(n)]), file=sys.stderr, flush=True)

print(json.dumps(out), flush=True)
