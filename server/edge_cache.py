"""Cache headers that let the Cloudflare edge serve anonymous list responses.

The origin is in Oregon and a request from Asia spends 200 ms or more on the
round trip (docs/perf-probes/2026-11-11/bottlenecks.md, fix 5). These four
routes answer an anonymous visitor with the same body for the same URL: no
viewer fields, nothing read from headers, no cookie set. So the edge may keep
an anonymous 200 for EDGE_TTL_S seconds. The Cache Rule in
docs/deploy-runbook.md caches them only for requests without the session
cookie, and only when the response carries ``s-maxage``.

"Anonymous" means the request has no ``echo_session`` cookie at all. The edge
can only see whether the cookie is present, so an expired or forged session
cookie is treated as signed in here too, and gets ``private, no-store``.
"""

from __future__ import annotations

from starlette.datastructures import MutableHeaders
from starlette.requests import Request

from server.social.auth import SESSION_COOKIE

EDGE_CACHEABLE_PATHS = frozenset({"/api/reels", "/api/reels/tags", "/api/reels/locations", "/api/config"})
EDGE_TTL_S = 30
# max-age=0: a browser keeps no copy of its own, so after sign-in it never
# shows the anonymous list (its cache is not keyed by the cookie).
PUBLIC_CACHE_CONTROL = f"public, max-age=0, s-maxage={EDGE_TTL_S}"
PRIVATE_CACHE_CONTROL = "private, no-store"


class EdgeCacheMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] not in EDGE_CACHEABLE_PATHS or scope["method"] not in ("GET", "HEAD"):
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        # refresh=true forces a re-scan; a cached copy would defeat it.
        anonymous = SESSION_COOKIE not in request.cookies and "refresh" not in request.query_params

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                public = anonymous and message["status"] == 200 and "set-cookie" not in headers
                headers["Cache-Control"] = PUBLIC_CACHE_CONTROL if public else PRIVATE_CACHE_CONTROL
                headers.add_vary_header("Cookie")
            await send(message)

        await self.app(scope, receive, send_with_headers)
