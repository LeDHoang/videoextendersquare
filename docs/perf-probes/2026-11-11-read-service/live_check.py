"""Live checks of the routing split on the local echo-readsvc stack.

usage: python3 live_check.py <env-file>
Writer alone: 127.0.0.1:8011. Proxy: 127.0.0.1:8012.
"""
import http.client, json, subprocess, sys, time, uuid

ENV = sys.argv[1]
WRITER, PROXY = 8011, 8012
HOST = "localhost:8443"
READ = ["/api/reels", "/api/reels/feed", "/api/reels/player", "/api/reels/player-inline", "/api/reels/tags",
        "/api/recommendations/creators"]
failed = []


def req(port, method, path, headers=None, body=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
    h = {"Host": HOST, "X-Forwarded-Proto": "https", "CF-Connecting-IP": "10.9.9.9"}
    h.update(headers or {})
    c.request(method, path, body=body, headers=h)
    r = c.getresponse()
    data = r.read()
    c.close()
    return r.status, dict((k.lower(), v) for k, v in r.getheaders()), data


def logs(service):
    out = subprocess.run(["docker", "compose", "--env-file", ENV, "logs", "--no-log-prefix", "--since", "10m", service],
                         capture_output=True, text=True)
    return out.stdout + out.stderr


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    if not ok:
        failed.append(name)


# 1. Who serves what, by request id in each service's access log.
sent = {}
n = 0
def tagged(expect, method, path, headers=None, body=None):
    global n
    n += 1
    rid = uuid.uuid4().hex
    status, _, _ = req(PROXY, method, path, {**(headers or {}), "X-Request-ID": rid, "CF-Connecting-IP": f"10.8.0.{n}"}, body)
    sent[rid] = (expect, f"{method} {path}{' +session' if headers and 'Cookie' in headers else ''}", status)

for path in READ:
    tagged("app-read", "GET", path)
    tagged("app", "GET", path, {"Cookie": "theme=dark; echo_session=not-a-real-session"})
    tagged("app-read", "GET", path, {"Cookie": "echo_anon=abc; not_echo_session=1"})
tagged("app", "POST", "/api/events", {"Content-Type": "application/json"}, b"{}")
tagged("app", "POST", "/api/reels/like", {"Content-Type": "application/json"}, b"{}")
tagged("app", "GET", "/api/reels/tags/sunset")
tagged("app", "GET", "/api/auth/me")
tagged("app", "GET", "/api/config")
tagged("app", "GET", "/api/messages/events")
tagged("app", "GET", "/api/admin/overview")
tagged("app", "GET", "/")
tagged("app", "HEAD", "/api/reels")
time.sleep(1.5)
seen = {"app": logs("app"), "app-read": logs("app-read")}
for rid, (expect, label, status) in sent.items():
    where = [service for service, text in seen.items() if rid in text]
    check(f"{label} -> {expect}", where == [expect], f"status {status}, logged by {where}")

# 3. Reader and writer answer the list the same.
a = json.loads(req(WRITER, "GET", "/api/reels")[2])
b = json.loads(req(PROXY, "GET", "/api/reels")[2])
check("/api/reels: same body from writer and reader", a == b, f"{a['count']} reels")

# 4. One per-IP limit over every process: 70 feed requests from one IP.
ip = f"10.7.{int(time.time()) % 250}.7"
statuses = [req(PROXY, "GET", "/api/reels/feed", {"CF-Connecting-IP": ip})[0] for _ in range(70)]
check("70 feed requests from one IP through the proxy: 60 pass", (statuses.count(200), statuses.count(429)) == (60, 10),
      f"200 x{statuses.count(200)}, 429 x{statuses.count(429)}")
check("the writer refuses that IP too", req(WRITER, "GET", "/api/reels/feed", {"CF-Connecting-IP": ip})[0] == 429)
check("another IP is not affected", req(PROXY, "GET", "/api/reels/feed", {"CF-Connecting-IP": ip + "7"})[0] == 200)

# 5. Paging the feed while requests land on different reader processes.
cookie, cursor, ids, restarted = "", None, [], False
for page in range(6):
    path = "/api/reels/feed" + (f"?cursor={cursor}" if cursor else "")
    status, headers, data = req(PROXY, "GET", path, {"Cookie": cookie, "CF-Connecting-IP": "10.6.6.6"} if cookie else {"CF-Connecting-IP": "10.6.6.6"})
    body = json.loads(data)
    if "set-cookie" in headers and not cookie:
        cookie = headers["set-cookie"].split(";")[0]
    ids += [item["post_id"] for item in body["items"]]
    restarted = restarted or bool(body.get("restarted"))
    cursor = body.get("next_cursor")
    if not cursor:
        break
check("six feed pages: no duplicates, no restart", len(ids) == len(set(ids)) and not restarted and len(ids) >= 24,
      f"{len(ids)} items, {len(set(ids))} distinct, restarted={restarted}")

print("\nFAILED: " + ", ".join(failed) if failed else "\nall live checks passed")
sys.exit(1 if failed else 0)
