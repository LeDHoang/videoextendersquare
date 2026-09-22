"""Map tile proxy for the VR earth zoom map (docs/earth-zoom-map-plan.md, Phase Z0).

Serves slippy-map raster tiles same-origin so the WebXR globe can drape real
basemap geography on the sphere past the holographic crossfade band. Upstream
defaults to the OpenStreetMap tile CDN; every tile is fetched upstream at most
once (disk cache), then served immutable — Cloudflare edge caching (topology in
docs/to-beta.md) absorbs repeat traffic.

Hard contracts:
- Never 500 for tile content: disabled → 404, upstream failure → 502 with a
  short Retry-After. The globe must always render (client falls back to the
  holographic canvas, same contract as /api/reels/earth-texture).
- OSM tile-usage policy: compliant User-Agent upstream, per-IP fetch guard
  against planetary enumeration through the proxy.
- Attribution is a license requirement: every tile response carries the
  X-Map-Attribution header and /attribution exposes it as JSON for the UI.
"""

from __future__ import annotations

import os
import threading
import time
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response

router = APIRouter(prefix="/api/reels/map-tiles", tags=["reels"])

MAX_ZOOM = 17
DEFAULT_UPSTREAM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
DEFAULT_CACHE_DIR = "data/map_tiles"
USER_AGENT = "EchoVR-MapTiles/1.0 (https://github.com/LeDHoang/videoextendersquare)"
FETCH_TIMEOUT_S = 5.0
MAX_TILE_BYTES = 1 << 20  # 1 MB — a legit 256px raster tile is ~10-60 KB
OSM_ATTRIBUTION = "© OpenStreetMap contributors"
OSM_ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright"
CACHE_HEADERS = {"Cache-Control": "public, max-age=604800, immutable"}
# Header-safe copy of the attribution: HTTP headers are latin-1/ASCII tooling
# territory, so the © glyph stays in the JSON route (UTF-8) and headers use (C).
OSM_ATTRIBUTION_HEADER = "(C) OpenStreetMap contributors"

# Per-IP sliding-window guard counted on upstream fetches only (cache hits are
# free). A heavy VR zoom session pulls bursts of ≤ ~200 tiles; the cap blocks
# whole-planet enumeration through the proxy without touching legit play.
RATE_LIMIT_COUNT = 360
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


def _upstream_template() -> str:
    return os.environ.get("SX_MAP_TILES_URL", DEFAULT_UPSTREAM).strip() or DEFAULT_UPSTREAM


def _cache_dir() -> Path:
    return Path(os.environ.get("SX_MAP_TILES_CACHE_DIR", DEFAULT_CACHE_DIR))


def _fetch_upstream(url: str) -> tuple[bytes, str]:
    """Fetch one tile upstream. Blocking is fine: sync routes run in the pool."""
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "image/png,image/*;q=0.8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_S) as resp:
            status = getattr(resp, "status", 200) or 200
            if status != 200:
                raise UpstreamTileError(f"upstream status {status}")
            content_type = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            data = resp.read(MAX_TILE_BYTES + 1)
    except UpstreamTileError:
        raise
    except Exception as exc:  # urllib raises a zoo of URLError/TimeoutError/OSError
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


def _tile_cache_path(z: int, x: int, y: int) -> Path:
    return _cache_dir() / str(z) / str(x) / f"{y}.png"


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
    return {**CACHE_HEADERS, "X-Map-Attribution": OSM_ATTRIBUTION_HEADER}


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
        "attribution": OSM_ATTRIBUTION,
        "url": OSM_ATTRIBUTION_URL,
        "enabled": _tiles_enabled(),
        "max_zoom": MAX_ZOOM,
    }


@router.get("/{z}/{x}/{y}.png")
def get_map_tile(z: int, x: int, y: int, request: Request):
    """Serve one slippy-map raster tile, disk-cached and upstream-guarded."""
    if not _tiles_enabled():
        raise HTTPException(
            status_code=404,
            detail={"code": "MAP_TILES_DISABLED", "message": "Map tiles are disabled on this server."},
        )
    _validate_tile_coords(z, x, y)

    cache_file = _tile_cache_path(z, x, y)
    if cache_file.is_file():
        return FileResponse(str(cache_file), media_type="image/png", headers=_tile_headers())

    identity = request.client.host if request.client else "unknown"
    if not _check_fetch_rate(identity):
        raise HTTPException(
            status_code=429,
            detail={"code": "MAP_TILE_RATE_LIMITED", "message": "Tile fetch budget exhausted; cached tiles still serve."},
            headers={"Retry-After": str(int(RATE_LIMIT_WINDOW_S))},
        )

    url = _upstream_template().format(z=z, x=x, y=y)
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

