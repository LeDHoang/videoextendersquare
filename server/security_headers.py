"""Security response headers and the Content-Security-Policy.

``SecurityHeadersMiddleware`` is pure ASGI (not ``BaseHTTPMiddleware``), so
SSE streams pass through unbuffered. It adds the static hardening headers to
every response and, depending on ``SX_CSP_MODE``, a CSP built around a
per-request nonce:

- ``off``: no CSP header (the dev default: Vite HMR injects inline scripts).
- ``report``: ``Content-Security-Policy-Report-Only`` (the production default
  for the invite-only beta). Violations are POSTed to ``/api/csp-report``.
- ``enforce``: ``Content-Security-Policy`` with the same policy and nonces, so
  switching from report to enforce is a one-variable change.

The nonce lives in ``scope["state"]["csp_nonce"]`` (``request.state.csp_nonce``).
Every HTML document the server renders passes through :func:`nonce_html`,
which stamps it on each ``<script>`` tag. Scripts those tags create at runtime
(the Vite chunk loader, the Reels player scripts that ``ReelsPlayer.jsx``
injects via ``textContent``) are trusted through ``'strict-dynamic'``.

No HSTS here: Cloudflare sets it at the edge (docs/deploy-runbook.md).
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import threading
import time
from collections import deque
from urllib.parse import urlsplit

from fastapi import APIRouter, FastAPI, Request, Response
from starlette.datastructures import MutableHeaders

from server.settings import is_production

logger = logging.getLogger("server.csp")

CSP_MODES = ("off", "report", "enforce")
CSP_NONCE_KEY = "csp_nonce"
CSP_REPORT_PATH = "/api/csp-report"
CSP_REPORT_MAX_BYTES = 8 * 1024
CSP_REPORT_RATE = 20  # reports per IP per window
CSP_REPORT_WINDOW_S = 60.0

# Same-origin iframe embeds (ComparePage renders /api/compare/player in an
# iframe). Everything else may not be framed at all.
_SAME_ORIGIN_FRAMEABLE = ("/api/compare/player",)
# FastAPI's Swagger/ReDoc pages load their bundles from cdn.jsdelivr.net with
# un-nonced tags; they get the static headers but no CSP.
_CSP_EXEMPT = ("/docs", "/redoc")

NOSNIFF = "nosniff"
REFERRER_POLICY = "strict-origin-when-cross-origin"
COOP = "same-origin"
# No navigator.geolocation use anywhere (locations are typed and resolved via
# Nominatim), so geolocation is off too. xr-spatial-tracking stays on for the
# WebXR player.
PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), xr-spatial-tracking=(self)"

GOOGLE_FONTS_CSS = "https://fonts.googleapis.com"
GOOGLE_FONTS_FILES = "https://fonts.gstatic.com"
NOMINATIM = "https://nominatim.openstreetmap.org"  # LocationField.jsx search


def csp_mode() -> str:
    """``SX_CSP_MODE``, read at call time. Unknown values fall back to the default."""
    value = os.environ.get("SX_CSP_MODE", "").strip().casefold()
    if value in CSP_MODES:
        return value
    return "report" if is_production() else "off"


def _origin(url: str) -> str | None:
    parts = urlsplit((url or "").strip())
    if parts.scheme in ("http", "https") and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return None


def media_origin() -> str | None:
    """Origin of ``SX_MEDIA_BASE_URL`` (R2 public bucket), if configured."""
    return _origin(os.environ.get("SX_MEDIA_BASE_URL", ""))


def gif_origins() -> list[str]:
    """Tenor GIF hosts the DM composer may render (``SX_TENOR_ALLOWED_HOSTS``)."""
    from server.routers.messages import allowed_gif_hosts

    return sorted(f"https://{host}" for host in allowed_gif_hosts())


def build_policy(nonce: str, mode: str | None = None) -> str:
    mode = mode or csp_mode()
    media = [origin] if (origin := media_origin()) else []
    directives = [
        ("default-src", ["'self'"]),
        ("script-src", [f"'nonce-{nonce}'", "'strict-dynamic'"]),
        ("style-src", ["'self'", "'unsafe-inline'", GOOGLE_FONTS_CSS]),
        ("font-src", ["'self'", "data:", GOOGLE_FONTS_FILES]),
        ("img-src", ["'self'", "data:", "blob:", *media, *gif_origins()]),
        ("media-src", ["'self'", "blob:", *media]),
        ("connect-src", ["'self'", *media, NOMINATIM]),
        ("frame-ancestors", ["'none'"]),
        ("object-src", ["'none'"]),
        ("base-uri", ["'none'"]),
    ]
    if mode != "off":
        # Enforce mode keeps reporting so blocked loads still show up in logs.
        directives.append(("report-uri", [CSP_REPORT_PATH]))
        directives.append(("report-to", ["csp"]))
    return "; ".join(f"{name} {' '.join(values)}" for name, values in directives)


def new_nonce() -> str:
    return secrets.token_urlsafe(18)


def request_nonce(request: Request) -> str | None:
    return getattr(request.state, CSP_NONCE_KEY, None)


# `<script` not already carrying a nonce. Applied to templates before any
# vendored JS (three.min.js etc.) is substituted in, so only real tags match.
_SCRIPT_OPEN = re.compile(r"<script\b(?![^>]*\snonce=)", re.IGNORECASE)
_MODULEPRELOAD_OPEN = re.compile(r"<link\b(?=[^>]*\brel=[\"']?modulepreload)(?![^>]*\snonce=)", re.IGNORECASE)
_HEAD_OPEN = re.compile(r"<head\b[^>]*>", re.IGNORECASE)


def nonce_html(html: str, nonce: str | None) -> str:
    """Stamp ``nonce`` on every ``<script>`` and ``<link rel=modulepreload>`` tag.

    Also adds ``<meta property="csp-nonce">`` to ``<head>``: Vite's preload
    helper reads it for the modulepreload links it creates at runtime.
    """
    if not nonce:
        return html
    html = _SCRIPT_OPEN.sub(f'<script nonce="{nonce}"', html)
    html = _MODULEPRELOAD_OPEN.sub(f'<link nonce="{nonce}"', html)
    return _HEAD_OPEN.sub(lambda m: f'{m.group(0)}\n<meta property="csp-nonce" nonce="{nonce}">', html, count=1)


def nonce_request_html(request: Request, html: str) -> str:
    return nonce_html(html, request_nonce(request))


class SecurityHeadersMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        nonce = new_nonce()
        scope.setdefault("state", {})[CSP_NONCE_KEY] = nonce
        path = scope.get("path", "")
        frameable = path in _SAME_ORIGIN_FRAMEABLE
        mode = csp_mode()
        policy = None
        if mode != "off" and not path.startswith(_CSP_EXEMPT):
            policy = build_policy(nonce, mode)
            if frameable:
                policy = policy.replace("frame-ancestors 'none'", "frame-ancestors 'self'")

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.setdefault("X-Content-Type-Options", NOSNIFF)
                headers.setdefault("Referrer-Policy", REFERRER_POLICY)
                headers.setdefault("X-Frame-Options", "SAMEORIGIN" if frameable else "DENY")
                headers.setdefault("Cross-Origin-Opener-Policy", COOP)
                headers.setdefault("Permissions-Policy", PERMISSIONS_POLICY)
                if policy:
                    name = "Content-Security-Policy" if mode == "enforce" else "Content-Security-Policy-Report-Only"
                    headers[name] = policy
                    headers["Reporting-Endpoints"] = f'csp="{CSP_REPORT_PATH}"'
            await send(message)

        await self.app(scope, receive, send_with_headers)


# ── /api/csp-report ─────────────────────────────────────────────────────────

router = APIRouter(tags=["security"])

_REPORT_TYPES = ("application/csp-report", "application/reports+json", "application/json")
_rate_lock = threading.Lock()
_rate_hits: dict[str, deque] = {}


def _rate_allowed(key: str) -> bool:
    now = time.monotonic()
    with _rate_lock:
        hits = _rate_hits.setdefault(key, deque())
        while hits and now - hits[0] > CSP_REPORT_WINDOW_S:
            hits.popleft()
        if len(hits) >= CSP_REPORT_RATE:
            return False
        hits.append(now)
        if len(_rate_hits) > 10_000:
            # Bound memory: drop IPs whose window has fully expired.
            for stale in [k for k, v in _rate_hits.items() if not v or now - v[-1] > CSP_REPORT_WINDOW_S]:
                _rate_hits.pop(stale, None)
        return True


def _clean(value, limit: int = 200) -> str:
    text = str(value or "")
    if "://" in text:
        # Query strings may carry signed URLs or tokens; the origin + path is enough.
        parts = urlsplit(text)
        text = f"{parts.scheme}://{parts.netloc}{parts.path}"
    text = re.sub(r"[\x00-\x1f\x7f]", " ", text)
    return text[:limit]


def _doc_path(value) -> str:
    return _clean(urlsplit(str(value or "")).path or "-")


def _violations(payload) -> list[dict]:
    """Normalize both report formats to {directive, blocked, document}."""
    out = []
    if isinstance(payload, dict) and isinstance(payload.get("csp-report"), dict):
        body = payload["csp-report"]
        out.append({
            "directive": body.get("effective-directive") or body.get("violated-directive"),
            "blocked": body.get("blocked-uri"),
            "document": body.get("document-uri"),
        })
    elif isinstance(payload, list):
        for item in payload[:10]:
            if not isinstance(item, dict) or item.get("type") != "csp-violation":
                continue
            body = item.get("body") if isinstance(item.get("body"), dict) else {}
            out.append({
                "directive": body.get("effectiveDirective") or body.get("violatedDirective"),
                "blocked": body.get("blockedURL"),
                "document": body.get("documentURL") or item.get("url"),
            })
    return out


@router.post(CSP_REPORT_PATH, include_in_schema=False)
async def csp_report(request: Request):
    from server.social.auth import request_identity

    content_type = request.headers.get("content-type", "").split(";")[0].strip().casefold()
    if content_type not in _REPORT_TYPES:
        return Response(status_code=415)
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    if declared > CSP_REPORT_MAX_BYTES:
        return Response(status_code=413)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > CSP_REPORT_MAX_BYTES:
            return Response(status_code=413)
    if not _rate_allowed(request_identity(request)):
        return Response(status_code=429)
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return Response(status_code=400)
    for violation in _violations(payload):
        logger.warning(
            "csp violation directive=%s blocked=%s document=%s",
            _clean(violation["directive"], 80) or "-",
            _clean(violation["blocked"]) or "-",
            _doc_path(violation["document"]),
        )
    return Response(status_code=204)


def install_security_headers(app: FastAPI) -> None:
    """Add the headers middleware and the report endpoint.

    Add any middleware that must see the final headers (request IDs) after
    this call, so it wraps this one.
    """
    app.add_middleware(SecurityHeadersMiddleware)
    app.include_router(router)
