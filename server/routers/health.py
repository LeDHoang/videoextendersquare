"""Health router — system probe results as JSON.

Reuses detection logic from ui/health.py but returns structured JSON
instead of Streamlit widgets.
"""

import os
import shutil

from fastapi import APIRouter

from ui.health import (
    HEVC_CANDIDATES,
    ensure_ffmpeg_on_path,
    fal_key_probe,
    probe_environment,
    smoke_encode,
)

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
        ensure_ffmpeg_on_path()
        # Build probes without Streamlit dependency
        probes = _build_probes()
        _cached_probes = probes

    fal = fal_key_probe()

    return {
        "probes": _cached_probes,
        "fal_key": _probe_to_dict(fal),
    }


def _build_probes() -> dict[str, dict]:
    """Build probe dict without touching Streamlit's cache decorators."""
    import subprocess

    _NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    out: dict[str, dict] = {}

    def _run(args, timeout=20):
        try:
            return subprocess.run(
                args, capture_output=True, text=True, timeout=timeout,
                creationflags=_NO_WINDOW,
            )
        except (OSError, subprocess.SubprocessError):
            return None

    # ffmpeg
    ff = shutil.which("ffmpeg")
    ver = ""
    if ff:
        p = _run(["ffmpeg", "-hide_banner", "-version"])
        if p and p.stdout:
            first = p.stdout.splitlines()[0]
            parts = first.split()
            ver = parts[2] if len(parts) > 2 else ""
    out["ffmpeg"] = {
        "id": "ffmpeg", "label": "FFMPEG", "ok": bool(ff),
        "severity": "block", "detail": ver or (ff or "not found"),
        "fix": "Install ffmpeg, or set FFMPEG_DIR in .env.",
    }

    # ffprobe
    fp = shutil.which("ffprobe")
    out["ffprobe"] = {
        "id": "ffprobe", "label": "FFPROBE", "ok": bool(fp),
        "severity": "block", "detail": "ok" if fp else "not found",
        "fix": "ffprobe ships with ffmpeg.",
    }

    # filters & encoders
    filters = ""
    encoders = ""
    if ff:
        p = _run(["ffmpeg", "-hide_banner", "-filters"])
        filters = (p.stdout if p else "") or ""
        p = _run(["ffmpeg", "-hide_banner", "-encoders"])
        encoders = (p.stdout if p else "") or ""

    has_cas = " cas " in filters
    out["cas"] = {
        "id": "cas", "label": "CAS", "ok": has_cas,
        "severity": "degrade", "detail": "available" if has_cas else "unavailable",
        "fix": "Sharpening is skipped. A newer ffmpeg includes the cas filter.",
    }

    enc_name = ""
    if ff:
        for name, opts in HEVC_CANDIDATES:
            if name in encoders and smoke_encode(name, opts):
                enc_name = name
                break
    out["encoder"] = {
        "id": "encoder", "label": "ENCODER", "ok": bool(enc_name),
        "severity": "block", "detail": enc_name or "none working",
        "fix": "No HEVC encoder passed a smoke test.",
    }

    has_264 = "libx264" in encoders and bool(ff)
    out["libx264"] = {
        "id": "libx264", "label": "H.264", "ok": has_264,
        "severity": "degrade", "detail": "available" if has_264 else "unavailable",
        "fix": "Needed for browser-playable previews.",
    }

    # vapoursynth
    from importlib.util import find_spec
    has_vs = find_spec("vapoursynth") is not None
    out["vapoursynth"] = {
        "id": "vapoursynth", "label": "STUDIO", "ok": has_vs,
        "severity": "degrade", "detail": "available" if has_vs else "unavailable",
        "fix": "Studio engine needs VapourSynth.",
    }

    return out
