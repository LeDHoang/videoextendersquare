"""The routes the read-only processes serve (SX_ROLE=reader).

The app keeps jobs, staged uploads, the encode queue and its periodic tasks in
process memory, so it stays one writer process. The reader processes are more
copies of the same image that answer only the anonymous GET routes below, on
the CPU cores the writer cannot use. deploy/Caddyfile sends a request to them
when it is a GET of one of these paths without a session cookie; everything
else goes to the writer. tests/test_read_service.py keeps the two lists equal.

What a reader shares with the writer is the database. What it does not share:
- Caches. A reader never hears the writer's invalidate_scan_cache() or
  invalidate_reel_records(), so a new or edited post, a comment or a like count
  can be up to 10 s old there (_SCAN_TTL in server/routers/reels.py,
  _REEL_RECORDS_TTL in server/social/services.py). Deleted, unpublished and
  blocked posts are filtered by a query on every request, so a takedown
  applies at once. Signed-in requests stay on the writer, so nobody waits to
  see their own write.
- Rate-limit memory. The two limits these routes check are counted in the
  database instead (RateLimiter.check(shared=True) in server/social/auth.py).
- Metrics. /admin Overview and the alert watchdog see the writer's requests.
"""

from __future__ import annotations

import json

READ_PATHS = (
    "/api/reels",
    "/api/reels/feed",
    "/api/reels/player",
    "/api/reels/player-inline",
    "/api/reels/tags",
    "/api/recommendations/creators",
)
# Liveness for the image HEALTHCHECK; never sent here by the proxy.
_ALLOWED = frozenset(READ_PATHS) | {"/api/healthz"}
_REFUSAL = json.dumps(
    {"detail": {"code": "NOT_ON_READER", "message": "This process serves read-only routes."}}
).encode()


class ReaderOnlyMiddleware:
    """Refuse everything but the read routes, whatever the proxy sends."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or (scope["method"] == "GET" and scope["path"] in _ALLOWED):
            await self.app(scope, receive, send)
            return
        await send({
            "type": "http.response.start",
            "status": 404,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(_REFUSAL)).encode())],
        })
        await send({"type": "http.response.body", "body": _REFUSAL})
