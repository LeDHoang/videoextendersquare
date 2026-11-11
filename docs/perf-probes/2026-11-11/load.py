#!/usr/bin/env python3
"""Closed-loop load probe through the public edge (stdlib only).

Each worker thread keeps one HTTPS connection open and sends requests back to back.
Per request it records the status, TTFB (send -> response headers) and total (-> body read).
Percentiles cover 2xx responses only, so fast 429s or edge blocks cannot improve them.

usage:
  load.py latency          c=1 on every anonymous GET path
  load.py ramp             concurrency steps per path, with a stop rule
  load.py mixed            concurrency steps of a session-start sequence
Results go to raw/<mode>.json next to this file; a line per step is printed while it runs.
"""
import http.client, json, os, re, ssl, sys, threading, time, urllib.parse

HOST = "echomultiverse.com"
BASE = f"https://{HOST}"
UA = "echo-loadprobe/2026-11-11"
HERE = os.path.dirname(os.path.abspath(__file__))
CTX = ssl.create_default_context()

LAT_SAMPLES, LAT_CAP_S = 250, 120      # latency mode: stop at 250 good samples or 120 s
STEP_S = 25                            # ramp and mixed: seconds per step
STEPS = [1, 2, 5, 10, 15, 25, 50]
STOP_P95_MS, STOP_ERR = 3000, 0.02     # stop a path when p95 TTFB or the non-2xx share passes these


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))])


class Conn:
    def __init__(self, host):
        self.host, self.c, self.connect_ms = host, None, []

    def get(self, path, headers=None):
        """Returns (status, ttfb_ms, total_ms, bytes, edge_note)."""
        for attempt in (0, 1):
            try:
                if self.c is None:
                    t = time.perf_counter()
                    self.c = http.client.HTTPSConnection(self.host, timeout=60, context=CTX)
                    self.c.connect()
                    self.connect_ms.append((time.perf_counter() - t) * 1e3)
                t0 = time.perf_counter()
                self.c.request("GET", path, headers={"User-Agent": UA, "Accept-Encoding": "gzip", **(headers or {})})
                r = self.c.getresponse()
                t1 = time.perf_counter()
                body = r.read()
                t2 = time.perf_counter()
                note = r.getheader("cf-mitigated") or ""
                if r.status >= 400 and "json" not in (r.getheader("content-type") or ""):
                    note = note or "non-json-error"   # an edge page, not the app
                return r.status, (t1 - t0) * 1e3, (t2 - t0) * 1e3, len(body), note
            except Exception as e:  # noqa: BLE001 - a dropped keep-alive gets one retry on a new connection
                self.close()
                if attempt:
                    return 0, 0.0, 0.0, 0, type(e).__name__

    def close(self):
        try:
            if self.c:
                self.c.close()
        finally:
            self.c = None


def run_step(targets, conc, seconds, max_good=None, per_min=None):
    """targets: list of (host, path, headers). Each worker loops over the whole list (one 'session')."""
    rows, sessions, lock = [], [], threading.Lock()
    stop_at = time.perf_counter() + seconds
    done = threading.Event()
    gap = 60.0 / per_min if per_min else 0.0

    def worker():
        conns = {}
        while time.perf_counter() < stop_at and not done.is_set():
            s0, ok = time.perf_counter(), True
            for i, (host, path, headers) in enumerate(targets):
                r = conns.setdefault(host, Conn(host)).get(path, headers)
                ok = ok and 200 <= r[0] < 300
                with lock:
                    rows.append((i, *r))
                    if max_good and sum(1 for x in rows if 200 <= x[1] < 300) >= max_good:
                        done.set()
            with lock:
                sessions.append(((time.perf_counter() - s0) * 1e3, ok))
            if gap:
                time.sleep(max(0.0, gap - (time.perf_counter() - s0)))
        with lock:
            connects.extend(ms for c in conns.values() for ms in c.connect_ms)
        for c in conns.values():
            c.close()

    connects = []
    t0 = time.perf_counter()
    threads = [threading.Thread(target=worker, daemon=True) for _ in range(conc)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.perf_counter() - t0

    def summarize(rs):
        good = [x for x in rs if 200 <= x[1] < 300]
        statuses = {}
        for x in rs:
            key = str(x[1]) + (f":{x[5]}" if x[5] else "")
            statuses[key] = statuses.get(key, 0) + 1
        ttfb, total = [x[2] for x in good], [x[3] for x in good]
        return dict(
            n=len(rs), good=len(good), err_share=round(1 - len(good) / len(rs), 4) if rs else None,
            statuses=statuses, good_rps=round(len(good) / wall, 2),
            ttfb_p50=pct(ttfb, .5), ttfb_p95=pct(ttfb, .95), ttfb_p99=pct(ttfb, .99), ttfb_max=pct(ttfb, 1),
            total_p50=pct(total, .5), total_p95=pct(total, .95), total_p99=pct(total, .99), total_max=pct(total, 1),
            bytes=good[0][4] if good else None,
        )

    out = dict(conc=conc, wall_s=round(wall, 1), connect_p50=pct(connects, .5), **summarize(rows))
    if len(targets) > 1:
        sdur = [d for d, ok in sessions if ok]
        out["per_target"] = [summarize([x for x in rows if x[0] == i]) for i in range(len(targets))]
        out["session"] = dict(n=len(sessions), good=len(sdur), good_per_min=round(len(sdur) / wall * 60, 1),
                              p50=pct(sdur, .5), p95=pct(sdur, .95), p99=pct(sdur, .99))
    return out


def fetch(url):
    u = urllib.parse.urlsplit(url)
    c = http.client.HTTPSConnection(u.netloc, timeout=60, context=CTX)
    c.request("GET", u.path + ("?" + u.query if u.query else ""), headers={"User-Agent": UA})
    return c.getresponse().read().decode("utf-8", "replace")


def discover():
    """Path names -> (host, path, headers, per_min). per_min is set for routes with a 60/min per-IP limit."""
    index = fetch(BASE + "/")
    js = re.search(r"/assets/index-[\w-]+\.js", index).group(0)
    css = re.search(r"/assets/index-[\w-]+\.css", index).group(0)
    feed = json.loads(fetch(BASE + "/api/reels/feed"))
    item = next(i for i in feed["items"] if i.get("poster_url") and i.get("url"))
    user = urllib.parse.quote((item.get("creator") or {}).get("username") or item["author_name"])
    post = item["post_id"]
    tag = json.loads(fetch(BASE + "/api/reels/tags"))["tags"][0]["slug"]
    loc = json.loads(fetch(BASE + "/api/reels/locations"))["locations"][0]["slug"]
    media = lambda url: urllib.parse.urlsplit(url)
    poster, mp4 = media(item["poster_url"]), media(item["url"])
    A = lambda path, per_min=None: (HOST, path, None, per_min)
    return {
        "healthz": A("/api/healthz"), "readyz": A("/api/readyz"), "health": A("/api/health"),
        "config": A("/api/config"), "auth_me": A("/api/auth/me"),
        "reels": A("/api/reels"), "reels_feed": A("/api/reels/feed", 50), "player": A("/api/reels/player"),
        "player_script": A("/api/reels/player-script/webxr_vr.js"),
        "tags": A("/api/reels/tags"), "tag_detail": A(f"/api/reels/tags/{tag}"),
        "locations": A("/api/reels/locations"), "locations_activity": A("/api/reels/locations/activity"),
        "location_detail": A(f"/api/reels/locations/{loc}"),
        "map_attribution": A("/api/reels/map-tiles/attribution"), "earth_texture": A("/api/reels/earth-texture"),
        "social_feed": A("/api/feed"), "creators": A("/api/recommendations/creators", 50),
        "search_suggest": A("/api/search/suggestions?q=a"), "packs": A("/api/packs"),
        "billing_catalog": A("/api/billing/catalog"), "msg_capabilities": A("/api/messages/capabilities"),
        "user": A(f"/api/users/{user}"), "user_posts": A(f"/api/users/{user}/posts"),
        "post": A(f"/api/posts/{post}"), "post_comments": A(f"/api/posts/{post}/comments"),
        "spa_index": A("/"), "spa_reels": A("/reels"), "spa_js": A(js), "spa_css": A(css),
        "media_poster": (poster.netloc, urllib.parse.quote(poster.path), None, None),
        "media_mp4_1MB": (mp4.netloc, urllib.parse.quote(mp4.path), {"Range": "bytes=0-1048575"}, None),
    }


RAMP = ["healthz", "spa_index", "config", "auth_me", "reels", "player", "tags", "locations_activity",
        "social_feed", "search_suggest", "packs", "user_posts", "post_comments"]
SESSION = ["spa_index", "config", "auth_me", "reels", "player"]   # one session start; the feed is rate limited per IP


def main(mode):
    paths = discover()
    trace = dict(l.split("=", 1) for l in fetch(BASE + "/cdn-cgi/trace").splitlines() if "=" in l)
    res = dict(mode=mode, when=time.strftime("%Y-%m-%d %H:%M:%S %z"), colo=trace.get("colo"), loc=trace.get("loc"),
               paths={k: v[0] + v[1] for k, v in paths.items()}, results={})

    def save():
        os.makedirs(os.path.join(HERE, "raw"), exist_ok=True)
        with open(os.path.join(HERE, "raw", f"{mode}.json"), "w") as f:
            json.dump(res, f, indent=1)

    def stop(s):
        return s["good"] == 0 or s["err_share"] > STOP_ERR or s["ttfb_p95"] > STOP_P95_MS

    if mode == "latency":
        for name, (host, path, headers, per_min) in paths.items():
            cap = 300 if per_min else LAT_CAP_S   # a 60/min route needs longer for the same sample count
            s = run_step([(host, path, headers)], 1, cap, max_good=LAT_SAMPLES, per_min=per_min)
            res["results"][name] = s
            print(name, json.dumps(s), flush=True)
            save()
    elif mode == "ramp":
        for name in RAMP:
            host, path, headers, _ = paths[name]
            res["results"][name] = []
            for conc in STEPS:
                s = run_step([(host, path, headers)], conc, STEP_S)
                res["results"][name].append(s)
                print(name, json.dumps(s), flush=True)
                save()
                if stop(s):
                    break
                time.sleep(3)
    elif mode == "mixed":
        targets = [paths[n][:3] for n in SESSION]
        res["session_targets"], res["results"]["session"] = SESSION, []
        for conc in STEPS:
            s = run_step(targets, conc, STEP_S * 2)
            res["results"]["session"].append(s)
            print("session", json.dumps(s), flush=True)
            save()
            if stop(s) or (s["session"]["p95"] or 0) > 4 * STOP_P95_MS:
                break
            time.sleep(3)
    save()


if __name__ == "__main__":
    main(sys.argv[1])
