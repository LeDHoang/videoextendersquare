"""Map tile proxy for the VR earth zoom map (docs/earth-zoom-map-plan.md, Phase Z0).

Serves slippy-map raster tiles same-origin so the WebXR globe can drape real
basemap geography on the sphere past the holographic crossfade band. Two layers
(Earth Zoom v2): ``base`` (geography) and ``labels`` (text-only, transparent)
so the client can tint geography toward the holographic palette without
touching glyphs. Upstream defaults to keyless OSM standard raster (labels baked
in; labels layer disabled by default → client renders base-only); CARTO dark
@2x split layers are opt-in via SX_MAP_TILES_URL / SX_MAP_LABELS_URL with a
keyed template (anonymous CARTO returns key-wall placeholders). Every tile is
fetched upstream at most once (disk cache keyed per layer and per upstream
template), then served immutable — Cloudflare edge caching (topology in
docs/to-beta.md) absorbs repeat traffic.

Hard contracts:
- Never 500 for tile content: disabled → 404, upstream failure → 502 with a
  short Retry-After. The globe must always render (client falls back to the
  holographic canvas, same contract as /api/reels/earth-texture).
- Provider usage policy: compliant User-Agent upstream, per-IP fetch guard
  against planetary enumeration through the proxy.
- Attribution is a license requirement: every tile response carries the
  X-Map-Attribution header and /attribution exposes it as JSON for the UI.
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
import urllib.request
import urllib3
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse

router = APIRouter(prefix="/api/reels/map-tiles", tags=["reels"])

MAX_ZOOM = 17
# Keyless default that works TODAY: OSM standard raster (labels baked in, light
# theme — the client GPU-tints it toward holo cyan). CARTO's anonymous
# basemaps now return "API KEY REQUIRED" placeholders for every tile (verified
# 2026-10-03), so CARTO is opt-in via SX_MAP_TILES_URL / SX_MAP_LABELS_URL with
# a keyed template, not the default. An empty labels template disables the
# labels layer (404 fast-path; the client renders base-only, non-fatal).
DEFAULT_UPSTREAM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
DEFAULT_LABELS_UPSTREAM = ""
UPSTREAM_SUBDOMAINS = ("a", "b", "c", "d")
LAYERS = ("base", "labels")
DEFAULT_CACHE_DIR = "data/map_tiles"
USER_AGENT = "EchoVR-MapTiles/1.0 (https://github.com/LeDHoang/videoextendersquare)"
FETCH_TIMEOUT_S = 10.0
MAX_TILE_BYTES = 1 << 20  # 1 MB — a legit 256px raster tile is ~10-60 KB
OSM_ATTRIBUTION_BASE = "© OpenStreetMap contributors"
OSM_ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright"

_pool: urllib3.PoolManager | None = None
_pool_lock = threading.Lock()


def _get_http_pool() -> urllib3.PoolManager:
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = urllib3.PoolManager(
                    num_pools=10,
                    maxsize=32,
                    timeout=urllib3.Timeout(connect=3.0, read=FETCH_TIMEOUT_S),
                    headers={"User-Agent": USER_AGENT, "Accept": "image/png,image/*;q=0.8"},
                )
    return _pool


def _attribution_text() -> str:
    """Credit data actually served: OSM always (base default), plus CARTO only
    when a CARTO template is configured (keyed opt-in)."""
    text = OSM_ATTRIBUTION_BASE
    try:
        configured = (_upstream_template("base"), _upstream_template("labels"))
    except Exception:
        configured = ()
    if any("carto" in (t or "").lower() for t in configured):
        text += " © CARTO"
    return text


def _attribution_header() -> str:
    return _attribution_text().replace("©", "(C)")
CACHE_HEADERS = {"Cache-Control": "public, max-age=604800, immutable"}
# Header-safe copy of the attribution: HTTP headers are latin-1/ASCII tooling
# territory, so the © glyph stays in the JSON route (UTF-8) and headers use (C).

# Per-IP sliding-window guard counted on upstream fetches only (cache hits are
# free). A heavy VR zoom session pulls bursts of ≤ ~200 tile slots × 2 layers;
# the cap blocks whole-planet enumeration without touching legit play.
RATE_LIMIT_COUNT = 720
RATE_LIMIT_WINDOW_S = 60.0
_rate_lock = threading.Lock()
_rate_hits: dict[str, list[float]] = {}


class UpstreamTileError(Exception):
    """Upstream fetch failed; the route turns this into a 502, never a 500."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _tiles_enabled() -> bool:
    return os.environ.get("SX_MAP_TILES_ENABLED", "1").strip().lower() not in {"0", "false", "no"}


def _upstream_template(layer: str = "base") -> str:
    if layer == "labels":
        return os.environ.get("SX_MAP_LABELS_URL", DEFAULT_LABELS_UPSTREAM).strip() or DEFAULT_LABELS_UPSTREAM
    return os.environ.get("SX_MAP_TILES_URL", DEFAULT_UPSTREAM).strip() or DEFAULT_UPSTREAM


def _upstream_url(layer: str, z: int, x: int, y: int) -> str:
    """Expand {z}/{x}/{y} plus an optional {s} subdomain (deterministic per tile
    so the browser/edge cache and our disk cache agree on one URL)."""
    template = _upstream_template(layer)
    sub = UPSTREAM_SUBDOMAINS[(x + y) % len(UPSTREAM_SUBDOMAINS)]
    return template.replace("{s}", sub).format(z=z, x=x, y=y)


def _cache_dir() -> Path:
    return Path(os.environ.get("SX_MAP_TILES_CACHE_DIR", DEFAULT_CACHE_DIR))


def _fetch_upstream(url: str) -> tuple[bytes, str]:
    """Fetch one tile upstream using connection-pooled HTTP keep-alive."""
    pool = _get_http_pool()
    try:
        resp = pool.request(
            "GET",
            url,
            retries=urllib3.util.Retry(total=1, connect=1, read=1, status=1, backoff_factor=0.2),
        )
        status = getattr(resp, "status", 200) or 200
        if status != 200:
            raise UpstreamTileError(f"upstream status {status}")
        content_type = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        data = resp.data
    except UpstreamTileError:
        raise
    except Exception as exc:
        raise UpstreamTileError(f"upstream unreachable: {exc}") from exc
    return data, content_type


def _validate_tile_payload(data: bytes, content_type: str) -> None:
    """Reject HTML error pages / oversized payloads from any fetch path (route-level,
    so a stubbed fetch in tests exercises the same guard)."""
    ctype = (content_type or "").split(";")[0].strip().lower()
    if not ctype.startswith("image/"):
        raise UpstreamTileError(f"upstream content-type {ctype or 'unknown'}")
    if not data or len(data) > MAX_TILE_BYTES:
        raise UpstreamTileError(f"upstream payload {len(data)} bytes out of bounds")


def _check_fetch_rate(identity: str) -> bool:
    """Sliding-window per-IP cap on upstream fetches (cache hits never count)."""
    now = time.monotonic()
    cutoff = now - RATE_LIMIT_WINDOW_S
    with _rate_lock:
        hits = [t for t in _rate_hits.get(identity, []) if t > cutoff]
        if len(hits) >= RATE_LIMIT_COUNT:
            _rate_hits[identity] = hits
            return False
        hits.append(now)
        _rate_hits[identity] = hits
    return True


def _tile_cache_path(z: int, x: int, y: int, layer: str = "base") -> Path:
    # Keyed by a short hash of the upstream template: swapping provider (e.g.
    # the legacy light OSM raster → CARTO dark) never serves stale-style tiles.
    tag = hashlib.sha1(_upstream_template(layer).encode("utf-8"), usedforsecurity=False).hexdigest()[:10]
    return _cache_dir() / layer / tag / str(z) / str(x) / f"{y}.png"


def _store_tile(cache_file: Path, data: bytes) -> None:
    """Atomic write: temp sibling + rename so concurrent readers never see halves."""
    try:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache_file.with_name(cache_file.name + f".tmp-{threading.get_ident()}")
        tmp.write_bytes(data)
        os.replace(tmp, cache_file)
    except OSError:
        pass  # caching is an optimization; serving the bytes still succeeded


def _tile_headers() -> dict[str, str]:
    return {**CACHE_HEADERS, "X-Map-Attribution": _attribution_header()}


def _validate_tile_coords(z: int, x: int, y: int) -> None:
    if z < 0 or z > MAX_ZOOM:
        raise HTTPException(
            status_code=400,
            detail={"code": "MAP_TILE_ZOOM_INVALID", "message": f"Zoom must be 0-{MAX_ZOOM}."},
        )
    span = 1 << z
    if x < 0 or x >= span or y < 0 or y >= span:
        raise HTTPException(
            status_code=400,
            detail={"code": "MAP_TILE_COORD_INVALID", "message": f"Tile x/y must be 0-{span - 1} at zoom {z}."},
        )


@router.get("/attribution")
def map_tile_attribution():
    """Attribution metadata for the VR globe UI (license requirement)."""
    return {
        "attribution": _attribution_text(),
        "url": OSM_ATTRIBUTION_URL,
        "enabled": _tiles_enabled(),
        "max_zoom": MAX_ZOOM,
        "layers": list(LAYERS),
    }


@router.get("/{z}/{x}/{y}.png")
def get_map_tile(z: int, x: int, y: int, request: Request):
    """Legacy single-layer route: alias for the ``base`` layer."""
    return _serve_tile("base", z, x, y, request)


@router.get("/{layer}/{z}/{x}/{y}.png")
def get_map_layer_tile(layer: str, z: int, x: int, y: int, request: Request):
    """Serve one tile of a named layer (``base`` geography or ``labels`` text)."""
    if layer not in LAYERS:
        raise HTTPException(
            status_code=400,
            detail={"code": "MAP_TILE_LAYER_INVALID", "message": f"Layer must be one of {', '.join(LAYERS)}."},
        )
    return _serve_tile(layer, z, x, y, request)


def _serve_tile(layer: str, z: int, x: int, y: int, request: Request):
    """Serve one slippy-map raster tile, disk-cached and upstream-guarded."""
    if not _tiles_enabled():
        raise HTTPException(
            status_code=404,
            detail={"code": "MAP_TILES_DISABLED", "message": "Map tiles are disabled on this server."},
        )
    if layer == "labels" and not _upstream_template("labels"):
        # Labels opt-in: no labels upstream configured (default) → fast 404.
        # The client treats labels failure as non-fatal and renders base-only.
        raise HTTPException(
            status_code=404,
            detail={"code": "MAP_TILE_LAYER_DISABLED", "message": "Labels layer has no upstream configured."},
        )
    _validate_tile_coords(z, x, y)

    cache_file = _tile_cache_path(z, x, y, layer)
    if cache_file.is_file():
        return FileResponse(str(cache_file), media_type="image/png", headers=_tile_headers())

    identity = request.client.host if request.client else "unknown"
    if not _check_fetch_rate(identity):
        raise HTTPException(
            status_code=429,
            detail={"code": "MAP_TILE_RATE_LIMITED", "message": "Tile fetch budget exhausted; cached tiles still serve."},
            headers={"Retry-After": str(int(RATE_LIMIT_WINDOW_S))},
        )

    url = _upstream_url(layer, z, x, y)
    try:
        data, content_type = _fetch_upstream(url)
        _validate_tile_payload(data, content_type)
    except UpstreamTileError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "MAP_TILE_UPSTREAM_FAILED", "message": exc.reason},
            headers={"Retry-After": "5"},
        ) from exc

    _store_tile(cache_file, data)
    return Response(content=data, media_type="image/png", headers=_tile_headers())

