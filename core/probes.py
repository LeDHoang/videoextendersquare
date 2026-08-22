"""Environment health probes, shared by the FastAPI server and the Streamlit
fallback.

These were duplicated (and had started to drift) between `ui/health.py`
(Streamlit) and `server/routers/health.py` (FastAPI). This module is the
single source of truth for the Probe dataclass and the probe-building logic;
each caller wraps the result with its own caching layer (st.cache_resource /
an in-process dict).
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass

from core import tooling


@dataclass(frozen=True)
class Probe:
    id: str
    label: str
    ok: bool
    severity: str  # "block" | "degrade" | "info"
    detail: str
    fix: str


def build_probes() -> dict[str, Probe]:
    """Probe the environment once. Excludes FAL_KEY (read live by
    fal_key_probe() since the user can type it into the sidebar mid-session)."""
    out: dict[str, Probe] = {}

    ff = shutil.which("ffmpeg")
    ver = ""
    if ff:
        p = tooling.run(["ffmpeg", "-hide_banner", "-version"])
        if p and p.stdout:
            first = p.stdout.splitlines()[0]
            parts = first.split()
            ver = parts[2] if len(parts) > 2 else ""
    out["ffmpeg"] = Probe(
        "ffmpeg", "FFMPEG", bool(ff), "block",
        ver or (ff or "not found"),
        "Install ffmpeg, or set FFMPEG_DIR in .env to the folder containing ffmpeg.exe.",
    )

    fp = shutil.which("ffprobe")
    out["ffprobe"] = Probe(
        "ffprobe", "FFPROBE", bool(fp), "block",
        "ok" if fp else "not found",
        "ffprobe ships with ffmpeg — it should sit in the same folder.",
    )

    filters = ""
    encoders = ""
    if ff:
        p = tooling.run(["ffmpeg", "-hide_banner", "-filters"])
        filters = (p.stdout if p else "") or ""
        p = tooling.run(["ffmpeg", "-hide_banner", "-encoders"])
        encoders = (p.stdout if p else "") or ""

    has_cas = " cas " in filters
    out["cas"] = Probe(
        "cas", "CAS", has_cas, "degrade",
        "available" if has_cas else "unavailable",
        "Sharpening is skipped. A newer ffmpeg build includes the cas filter.",
    )

    enc_name = ""
    if ff:
        for name, opts in tooling.HEVC_CANDIDATES:
            if name in encoders and tooling.smoke_encode(name, opts):
                enc_name = name
                break
    out["encoder"] = Probe(
        "encoder", "ENCODER", bool(enc_name), "block",
        enc_name or "none working",
        "No HEVC encoder passed a smoke test. libx265 is the software fallback.",
    )

    has_264 = "libx264" in encoders and bool(ff)
    out["libx264"] = Probe(
        "libx264", "H.264", has_264, "degrade",
        "available" if has_264 else "unavailable",
        "Needed for browser-playable previews. HEVC will not play in the player.",
    )

    has_vs = tooling.vapoursynth_available()
    out["vapoursynth"] = Probe(
        "vapoursynth", "STUDIO", has_vs, "degrade",
        "available" if has_vs else "unavailable",
        "Studio engine needs VapourSynth + vspipe on PATH. Fast engine is unaffected.",
    )

    plugin = tooling.find_znedi3_plugin()
    has_znedi3 = bool(plugin and (plugin == "pip:vapoursynth" or os.path.isfile(plugin)))
    out["znedi3"] = Probe(
        "znedi3", "ZNEDI3", has_znedi3, "degrade",
        "available" if has_znedi3 else "not found",
        f"Studio engine needs the znedi3 plugin."
        + (f" Found at: {plugin}" if plugin else
           " Install VapourSynth via winget or pip install vapoursynth."),
    )

    return out


def fal_key_probe() -> Probe:
    """Read FAL_KEY live — not cached, since the sidebar can set it mid-session."""
    key = os.environ.get("FAL_KEY", "")
    masked = f"****{key[-4:]}" if len(key) >= 4 else ("set" if key else "not set")
    return Probe(
        "fal_key", "FAL KEY", bool(key), "block",
        masked,
        "Cloud outpainting needs a key from https://fal.ai/dashboard/keys. "
        "Upscale-only mode works without one.",
    )


def studio_available(probes: dict[str, Probe]) -> bool:
    return probes["vapoursynth"].ok and probes["znedi3"].ok


def blockers(probes: dict[str, Probe], *, need_video: bool = False) -> list[Probe]:
    """Probes that must pass before rendering. Excludes FAL_KEY (mode-dependent)."""
    ids = ["ffmpeg", "ffprobe"]
    if need_video:
        ids.append("encoder")
    return [probes[i] for i in ids if i in probes and not probes[i].ok]
