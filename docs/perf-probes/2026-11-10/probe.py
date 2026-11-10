#!/usr/bin/env python3
"""Curl-based latency probe, rebuilt from docs/performance-latency-profile-2026-10-29.md section 1.
cold: N fresh curl processes (DNS+TCP+TLS each). warm: M requests on one connection, first dropped.
usage: probe.py <label> [host]"""
import json, os, re, statistics as st, subprocess, sys, time, urllib.parse

label = sys.argv[1]
host = sys.argv[2] if len(sys.argv) > 2 else "echomultiverse.com"
BASE = f"https://{host}"
FMT = "%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{size_download} %{remote_ip}\n"
COLD_N, WARM_N = 12, 15


def curl(urls, extra=()):
    cmd = ["curl", "-s", "--compressed", "-w", FMT, *extra]
    for u in urls:
        cmd += ["-o", "/dev/null", u]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=300).stdout.strip().splitlines()
    rows = []
    for l in out:
        p = l.split()
        rows.append(dict(code=int(p[0]), dns=float(p[1]) * 1e3, tcp=float(p[2]) * 1e3, tls=float(p[3]) * 1e3,
                         ttfb=float(p[4]) * 1e3, total=float(p[5]) * 1e3, size=int(p[6]), ip=p[7]))
    return rows


def text(url):
    return subprocess.run(["curl", "-s", "--compressed", url], capture_output=True, text=True).stdout


def p50(xs):
    return round(st.median(xs)) if xs else None


def p95(xs):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * 0.95))]) if xs else None


q = lambda u: urllib.parse.quote(u, safe=":/?=&%")
index = text(BASE + "/")
js = re.search(r'/assets/index-[\w-]+\.js', index)
feed = json.loads(text(BASE + "/api/reels/feed"))
items = [i for i in feed["items"] if i.get("poster_url") and i.get("url")][:5]

targets = {
    "healthz": (BASE + "/api/healthz", ()),
    "feed": (BASE + "/api/reels/feed", ()),
    "reels": (BASE + "/api/reels", ()),
    "player": (BASE + "/api/reels/player", ()),
    "spa_index": (BASE + "/", ()),
    "spa_js": (BASE + js.group(0), ()),
    "r2_poster": (q(items[0]["poster_url"]), ()),
    "r2_mp4_1MB": (q(items[0]["url"]), ("-r", "0-1048575")),
}

trace = dict(l.split("=", 1) for l in text(BASE + "/cdn-cgi/trace").splitlines() if "=" in l)
res = {"label": label, "host": host, "when": time.strftime("%Y-%m-%d %H:%M:%S %z"),
       "colo": trace.get("colo"), "loc": trace.get("loc"), "targets": {}}

for name, (url, extra) in targets.items():
    cold = [curl([url], extra)[0] for _ in range(COLD_N)]
    warm = curl([url] * (WARM_N + 1), extra)[1:]
    res["targets"][name] = dict(
        codes=sorted({r["code"] for r in cold + warm}),
        size=cold[0]["size"],
        cold_dns=p50([r["dns"] for r in cold]),
        cold_tcp=p50([r["tcp"] - r["dns"] for r in cold]),
        cold_tls=p50([r["tls"] - r["tcp"] for r in cold]),
        cold_ttfb=p50([r["ttfb"] for r in cold]), cold_ttfb_p95=p95([r["ttfb"] for r in cold]),
        cold_total=p50([r["total"] for r in cold]),
        warm_ttfb=p50([r["ttfb"] for r in warm]), warm_ttfb_p95=p95([r["ttfb"] for r in warm]),
        warm_total=p50([r["total"] for r in warm]),
    )
    print(name, json.dumps(res["targets"][name]), flush=True)

# R2: p50 of 5 runs per key, 5 keys (2026-11-01 baseline method)
keys = []
for it in items:
    rows = [curl([q(it["url"])], ("-r", "0-1048575"))[0] for _ in range(5)]
    keys.append(dict(key=it["path"][:40], ttfb=p50([r["ttfb"] for r in rows]), total=p50([r["total"] for r in rows])))
res["r2_keys"] = keys
print("r2_keys", json.dumps(keys), flush=True)

os.makedirs("results", exist_ok=True)
json.dump(res, open(f"results/{label}.json", "w"), indent=1)
