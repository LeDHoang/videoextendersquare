"""Health router — system probe results as JSON.

Uses the shared probe logic from `core.probes`/`core.tooling` (single source
of truth with the Streamlit fallback) but returns structured JSON instead of
Streamlit widgets.
"""

import os
import threading
import time

from fastapi import APIRouter

from core import probes as _probes
from core import tooling as _tooling

router = APIRouter(prefix="/api/health", tags=["health"])

# Cache probes in-process (same idea as st.cache_resource) but with a TTL.
# Probes spawn ffmpeg smoke-tests (up to seconds each), so re-probing on every
# 8s frontend poll would hammer the machine. The frontend polls the cheap
# cached snapshot; only ?refresh=true (RECHECK button) or TTL expiry rebuilds.
_CACHE_TTL_S = 60.0
_cached_probes: dict | None = None
_cached_at: float = 0.0
_cache_lock = threading.Lock()


def _probe_to_dict(p) -> dict:
    return {
        "id": p.id,
        "label": p.label,
        "ok": p.ok,
        "severity": p.severity,
        "detail": p.detail,
        "fix": p.fix,
    }


@router.get("")
def get_health(refresh: bool = False):
    """Return system probe results.

    Cached snapshot is served for up to ``_CACHE_TTL_S`` so the 8s frontend
    poller stays cheap. Pass ?refresh=true to force re-probe (e.g. after
    installing ffmpeg) — the sidebar RECHECK button uses this.
    """
    global _cached_probes, _cached_at

    now = time.time()
    from_cache = False
    with _cache_lock:
        expired = _cached_probes is None or (now - _cached_at) > _CACHE_TTL_S
        if refresh or expired:
            _tooling.ensure_ffmpeg_on_path()
            # Build probes without Streamlit dependency
            probes = _probes.build_probes()
            _cached_probes = {k: _probe_to_dict(v) for k, v in probes.items()}
            _cached_at = time.time()
        else:
            from_cache = True

    fal = _probes.fal_key_probe()

    return {
        "probes": _cached_probes,
        "fal_key": _probe_to_dict(fal),
        "from_cache": from_cache,
        "refreshed_at": _cached_at,
    }
