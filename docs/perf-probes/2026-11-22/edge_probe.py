#!/usr/bin/env python3
"""Read-only edge probe of echomultiverse.com: one anonymous GET per route, plus headers, media Range/CORS."""
import json, re, ssl, sys, time, urllib.parse, urllib.request, http.client

HOST = "echomultiverse.com"
BASE = f"https://{HOST}"
UA = "echo-probe/2026-11-22"
CTX = ssl.create_default_context()
fails = []


def get(url, headers=None, method="GET"):
    u = urllib.parse.urlsplit(url)
    c = http.client.HTTPSConnection(u.netloc, timeout=30, context=CTX)
    t = time.perf_counter()
    c.request(method, (u.path or "/") + ("?" + u.query if u.query else ""), headers={"User-Agent": UA, **(headers or {})})
    r = c.getresponse()
    body = r.read()
    ms = (time.perf_counter() - t) * 1e3
    h = {k.lower(): v for k, v in r.getheaders()}
    c.close()
    return r.status, h, body, ms


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")
    if not ok:
        fails.append(name)


s, h, index, _ = get(BASE + "/")
index = index.decode()
js = re.search(r"/assets/index-[\w-]+\.js", index).group(0)
css = re.search(r"/assets/index-[\w-]+\.css", index).group(0)
feed = json.loads(get(BASE + "/api/reels/feed")[2])
item = next(i for i in feed["items"] if i.get("poster_url") and i.get("url"))
user = urllib.parse.quote((item.get("creator") or {}).get("username") or item["author_name"])
post = item["post_id"]
tag = json.loads(get(BASE + "/api/reels/tags")[2])["tags"][0]["slug"]
loc = json.loads(get(BASE + "/api/reels/locations")[2])["locations"][0]["slug"]

routes = {
    "healthz": "/api/healthz", "readyz": "/api/readyz", "health": "/api/health", "config": "/api/config",
    "auth_me": "/api/auth/me", "reels": "/api/reels", "reels_feed": "/api/reels/feed", "player": "/api/reels/player",
    "player_inline": "/api/reels/player-inline", "player_script": "/api/reels/player-script/webxr_vr.js",
    "tags": "/api/reels/tags", "tag_detail": f"/api/reels/tags/{tag}", "locations": "/api/reels/locations",
    "locations_activity": "/api/reels/locations/activity", "location_detail": f"/api/reels/locations/{loc}",
    "map_attribution": "/api/reels/map-tiles/attribution", "earth_texture": "/api/reels/earth-texture",
    "social_feed": "/api/feed", "creators": "/api/recommendations/creators", "search_suggest": "/api/search/suggestions?q=a",
    "packs": "/api/packs", "billing_catalog": "/api/billing/catalog", "msg_capabilities": "/api/messages/capabilities",
    "user": f"/api/users/{user}", "user_posts": f"/api/users/{user}/posts", "post": f"/api/posts/{post}",
    "post_comments": f"/api/posts/{post}/comments", "spa_index": "/", "spa_reels": "/reels", "spa_explore": "/explore",
    "spa_js": js, "spa_css": css,
}
# auth_me answers 401 signed out; anything else must be 200.
expect = {"auth_me": (200, 401)}
for name, path in routes.items():
    s, h, body, ms = get(BASE + path)
    ok = s in expect.get(name, (200,))
    check(f"GET {name}", ok, f"{s} {ms:.0f}ms {len(body)}B cache={h.get('cf-cache-status','-')} cc={h.get('cache-control','-')[:40]}")
    if name in ("readyz", "health") and s == 200:
        print("      ", body[:300].decode(errors="replace"))

# Security headers on the SPA document.
s, h, _, _ = get(BASE + "/")
csp = h.get("content-security-policy")
check("CSP enforced on /", bool(csp), (csp or "missing")[:160])
check("CSP-Report-Only gone or alongside", True, "report-only=" + ("yes" if "content-security-policy-report-only" in h else "no"))
check("HSTS", "max-age=15552000" in (h.get("strict-transport-security") or ""), h.get("strict-transport-security", "missing"))
for k in ("x-content-type-options", "referrer-policy", "x-frame-options", "permissions-policy", "cross-origin-opener-policy"):
    print(f"INFO  {k}: {h.get(k, '-')}")
check("CSP has no unsafe-eval", "unsafe-eval" not in (csp or ""))

# API error shape and 404 fallbacks.
s, h, body, _ = get(BASE + "/api/definitely-not-a-route")
check("unknown API route is 404 JSON", s == 404 and "json" in h.get("content-type", ""), f"{s} {h.get('content-type')}")
s, h, body, _ = get(BASE + "/some/spa/deep/link")
check("SPA deep link serves index", s == 200 and b"/assets/index-" in body, str(s))

# Writes without a session are refused (no data written).
s, h, body, _ = get(BASE + "/api/rewards/reels/claim", method="POST", headers={"Origin": BASE, "Content-Type": "application/json"})
check("anon POST rewards/claim refused (4xx)", 400 <= s < 500, f"{s} {body[:120]!r}")

# HTTP to HTTPS.
c = http.client.HTTPConnection(HOST, timeout=15)
c.request("GET", "/", headers={"User-Agent": UA})
r = c.getresponse()
check("http redirects to https", r.status in (301, 308) and (r.getheader("location") or "").startswith("https://"), f"{r.status} {r.getheader('location')}")

# Media origin: Range + CORS (WebXR loads with crossOrigin=anonymous).
mp4 = item["url"]
s, h, body, ms = get(mp4, headers={"Range": "bytes=0-1023", "Origin": BASE})
check("media mp4 Range 206", s == 206 and len(body) == 1024, f"{s} {h.get('content-range')} {ms:.0f}ms")
check("media ACAO", h.get("access-control-allow-origin") in ("*", BASE), h.get("access-control-allow-origin", "missing"))
s, h, body, ms = get(item["poster_url"], headers={"Origin": BASE})
check("media poster 200 + ACAO", s == 200 and h.get("access-control-allow-origin") in ("*", BASE), f"{s} {h.get('access-control-allow-origin')} {ms:.0f}ms")

# SIT stays behind Access.
s, h, _, _ = get("https://sit.echomultiverse.com/")
check("sit behind Cloudflare Access", s in (302, 403) or "cloudflareaccess" in (h.get("location") or ""), f"{s} {h.get('location','')[:60]}")

print(f"\n{len(fails)} failed: {fails}" if fails else "\nall passed")
sys.exit(1 if fails else 0)
