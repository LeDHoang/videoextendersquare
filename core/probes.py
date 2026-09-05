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
import platform
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


def system_memory() -> dict:
    """Live GPU/system memory snapshot for the header telemetry (stdlib only).

    Returns {"label", "gpu", "total_gb", "used_gb"} with None where unknown.
    Deliberately NOT a Probe: informational telemetry must never flip the
    ENG ok-count. Detection order: NVIDIA (discrete VRAM) -> torch.cuda ->
    platform RAM (macOS sysctl/vm_stat, Linux /proc/meminfo, Windows ctypes).
    Every source is a fast local call, safe to run on each /api/health poll.
    """
    snap: dict = {"label": "", "gpu": "", "total_gb": None, "used_gb": None}

    # 1. NVIDIA discrete GPU — true VRAM.
    try:
        p = tooling.run([
            "nvidia-smi", "--query-gpu=name,memory.total,memory.used",
            "--format=csv,noheader,nounits",
        ], timeout=10)
        if p and p.returncode == 0 and p.stdout.strip():
            name, total, used = [s.strip() for s in p.stdout.strip().splitlines()[0].split(",")]
            snap.update(label="VRAM", gpu=name,
                        total_gb=round(float(total) / 1024, 1),
                        used_gb=round(float(used) / 1024, 1))
            return snap
    except Exception:
        pass

    # 2. torch CUDA device (torch is already a dependency via fal-client work).
    try:
        import torch
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            total = float(props.total_memory) / (1024 ** 3)
            used = float(torch.cuda.memory_allocated(0)) / (1024 ** 3)
            snap.update(label="VRAM", gpu=str(props.name),
                        total_gb=round(total, 1), used_gb=round(used, 1))
            return snap
    except Exception:
        pass

    # 3. Platform system memory (unified on Apple Silicon — labelled RAM).
    try:
        if os.name == "nt":
            import ctypes

            class _MemStatus(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong),
                            ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong),
                            ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong),
                            ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            st = _MemStatus()
            st.dwLength = ctypes.sizeof(_MemStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))
            total = float(st.ullTotalPhys) / (1024 ** 3)
            snap.update(label="RAM", total_gb=round(total, 1),
                        used_gb=round(total - float(st.ullAvailPhys) / (1024 ** 3), 1))
            return snap

        if platform.system() == "Darwin":
            p = tooling.run(["sysctl", "-n", "hw.memsize"], timeout=5)
            total = float((p.stdout if p else "").strip()) / (1024 ** 3) if p else 0.0
            used = None
            v = tooling.run(["vm_stat"], timeout=5)
            if v and v.stdout:
                page = 16384
                pages: dict[str, int] = {}
                for line in v.stdout.splitlines():
                    if "page size of" in line:
                        try:
                            page = int(line.split("page size of")[1].split()[0])
                        except (ValueError, IndexError):
                            pass
                    elif ":" in line:
                        k, _, val = line.partition(":")
                        try:
                            pages[k.strip().lower().replace(" ", "_")] = int(val.strip().strip("."))
                        except ValueError:
                            pass
                held = sum(pages.get(k, 0) for k in ("pages_wired_down", "pages_active", "pages_compressed"))
                if held:
                    used = held * page / (1024 ** 3)
            if total:
                snap.update(label="RAM", total_gb=round(total, 1),
                            used_gb=round(used, 1) if used is not None else None)
                return snap

        with open("/proc/meminfo", encoding="utf-8") as f:
            mem = f.read()
        vals: dict[str, float] = {}
        for line in mem.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0].endswith(":"):
                try:
                    vals[parts[0][:-1]] = float(parts[1]) * (1024 if "kB" in line else 1)
                except ValueError:
                    pass
        if "MemTotal" in vals:
            total = vals["MemTotal"] / (1024 ** 3)
            avail = vals.get("MemAvailable", vals.get("MemFree", 0.0)) / (1024 ** 3)
            snap.update(label="RAM", total_gb=round(total, 1),
                        used_gb=round(total - avail, 1))
            return snap
    except Exception:
        pass

    return snap
