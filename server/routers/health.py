"""Health router — system probe results as JSON.

Uses the shared probe logic from `core.probes`/`core.tooling` (single source
of truth with the Streamlit fallback) but returns structured JSON instead of
Streamlit widgets.
"""

import os

from fastapi import APIRouter

from core import probes as _probes
from core import tooling as _tooling

router = APIRouter(prefix="/api/health", tags=["health"])

# Cache probes in-process (same idea as st.cache_resource)
_cached_probes: dict | None = None


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

    Pass ?refresh=true to force re-probe (e.g. after installing ffmpeg).
    """
    global _cached_probes

    if refresh or _cached_probes is None:
        _tooling.ensure_ffmpeg_on_path()
        # Build probes without Streamlit dependency
        probes = _probes.build_probes()
        _cached_probes = {k: _probe_to_dict(v) for k, v in probes.items()}

    fal = _probes.fal_key_probe()

    return {
        "probes": _cached_probes,
        "fal_key": _probe_to_dict(fal),
    }
