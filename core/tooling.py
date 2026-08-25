"""Subprocess tool discovery and HEVC encoder probing, shared by the FastAPI
server, the Streamlit fallback, and the pipeline workers.

These were duplicated (and had started to drift) between
`pipeline/video_worker.py`, `ui/health.py`, and `server/routers/health.py`.
This module is the single source of truth; callers import from here instead
of each re-implementing PATH probing or encoder candidates.
"""

from __future__ import annotations

import glob
import os
import platform
import shutil
import subprocess
import threading
from importlib.util import find_spec

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

# HEVC encoder candidates, best-first. Single source of truth — the pipeline
# (video_worker) encodes with the winner, and the health probes smoke-test the
# same list so the reported encoder always matches what a render will use.
# Bitrate raised to 24 Mbps for VR-grade crispness on a ~4m Quest 3S screen —
# the previous 14 Mbps target left 4K masters (e.g. Travis 5.8, Tron 11.4)
# visibly soft/banded when viewed up-close in immersive WebXR. Quest 3S panel
# is ~1832px/eye so 4K is ~2× oversampled; the gains here are bitrate, not px.
# NOTE: libx265 uses CRF rate-control; pairing a bitrate cap with -crf gives
# ffmpeg contradictory instructions (CRF wins), so none is set here.
HEVC_CANDIDATES: list[tuple[str, list[str]]] = [
    ("hevc_videotoolbox", ["-b:v", "24M", "-maxrate", "26M", "-bufsize", "48M", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-movflags", "+faststart"]),
    ("hevc_nvenc", ["-preset", "slow", "-rc", "vbr", "-b:v", "24M", "-maxrate", "26M", "-bufsize", "48M", "-movflags", "+faststart"]),
    ("hevc_qsv", ["-b:v", "24M", "-maxrate", "26M", "-bufsize", "48M", "-movflags", "+faststart"]),
    ("libx265", ["-crf", "20", "-preset", "medium", "-tag:v", "hvc1", "-movflags", "+faststart"]),
]


def _candidate_dirs() -> list[str]:
    """Directories that might contain ffmpeg/ffprobe, in priority order."""
    cands: list[str] = []

    for var in ("SX_FFMPEG_DIR", "FFMPEG_DIR"):
        val = os.environ.get(var)
        if val:
            cands.append(val)

    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA", "")
        if local:
            pattern = os.path.join(
                local, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "**", "bin"
            )
            cands.extend(sorted(glob.glob(pattern, recursive=True), reverse=True))
        cands += [r"C:\ffmpeg\bin", r"C:\Program Files\ffmpeg\bin"]
    else:
        cands += ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]

    return [c for c in cands if c and os.path.isdir(c)]


def ensure_ffmpeg_on_path() -> str | None:
    """Prepend a directory containing both ffmpeg and ffprobe to PATH.

    Also sets VSSCRIPT_PATH if the pip vapoursynth package is installed, so
    vspipe can find vsscript.dll without a system-wide VapourSynth install.
    Returns the ffmpeg directory added, or None. Idempotent.
    """
    if not os.environ.get("VSSCRIPT_PATH"):
        try:
            import vapoursynth as _vs
            vsscript = os.path.join(os.path.dirname(_vs.__file__), "vsscript.dll")
            if os.path.isfile(vsscript):
                os.environ["VSSCRIPT_PATH"] = vsscript
        except Exception:
            pass

    try:
        subprocess.run(
            [shutil.which("python") or "python", "-m", "vapoursynth", "config"],
            capture_output=True, timeout=5,
        )
    except Exception:
        pass

    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return None

    exe = ".exe" if os.name == "nt" else ""
    for d in _candidate_dirs():
        if os.path.isfile(os.path.join(d, f"ffmpeg{exe}")) and os.path.isfile(
            os.path.join(d, f"ffprobe{exe}")
        ):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            return d
    return None


def run(args: list[str], timeout: int = 20) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(
            args, capture_output=True, text=True, timeout=timeout,
            creationflags=_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def smoke_encode(name: str, opts: list[str]) -> bool:
    """Encode one frame to /dev/null. Presence in -encoders is NOT enough:
    hevc_nvenc lists fine but dies on 'Cannot load nvcuda.dll' with no NVIDIA GPU.
    """
    p = run([
        "ffmpeg", "-hide_banner", "-v", "error",
        "-f", "lavfi", "-i", "testsrc=d=0.1:s=64x64",
        "-c:v", name, *opts, "-frames:v", "1", "-f", "null", "-",
    ], timeout=40)
    return bool(p and p.returncode == 0)


# Cached per-process, guarded by a lock so concurrent jobs can't all spawn the
# same 4-way ffmpeg smoke-test at once. Pre-warmed once at startup by the
# FastAPI lifespan (see server/app.py).
_ENCODER_CACHE: tuple[str, list[str]] | None = None
_ENCODER_LOCK = threading.Lock()


def pick_encoder() -> tuple[str, list[str]]:
    """Return (name, opts) for a working HEVC encoder, cached per process."""
    global _ENCODER_CACHE
    if _ENCODER_CACHE:
        return _ENCODER_CACHE

    with _ENCODER_LOCK:
        if _ENCODER_CACHE:
            return _ENCODER_CACHE

        listed = run(["ffmpeg", "-hide_banner", "-encoders"]).stdout or ""

        for name, opts in HEVC_CANDIDATES:
            if name not in listed:
                continue
            if smoke_encode(name, opts):
                _ENCODER_CACHE = (name, opts)
                return _ENCODER_CACHE

        raise RuntimeError(
            "No working HEVC encoder found (tried: "
            + ", ".join(n for n, _ in HEVC_CANDIDATES) + ")"
        )


def _find_plugin(substr: str, explicit: list[str], builtin_attr: str) -> str | None:
    """Return explicit path to a VapourSynth plugin, or None if auto-loaded.

    Returns None when the plugin is already available on core (so the caller
    doesn't emit a LoadPlugin line); otherwise the first existing explicit path.
    """
    try:
        import vapoursynth as _vs
        if hasattr(_vs.core, builtin_attr):
            return None
    except Exception:
        pass
    candidates: list[str] = []
    try:
        import vapoursynth as _vs, os as _os
        venv_plugins = _os.path.join(_os.path.dirname(_vs.__file__), "plugins")
        for root, _, files in _os.walk(venv_plugins):
            for f in files:
                if substr in f.lower():
                    candidates.append(_os.path.join(root, f))
    except Exception:
        pass
    candidates.extend(explicit)
    return next((p for p in candidates if os.path.isfile(p)), None)


def find_ffms2_plugin() -> str | None:
    explicit: list[str] = []
    sysname = platform.system()
    if sysname == "Darwin":
        explicit = [
            "/opt/homebrew/lib/libffms2.dylib",
            "/opt/homebrew/lib/python3.14/site-packages/vapoursynth/plugins/libffms2.dylib",
            "/opt/homebrew/lib/vapoursynth/libffms2.dylib",
            "/usr/local/lib/libffms2.dylib",
        ]
    elif sysname == "Windows":
        explicit = [
            r"C:\Program Files\VapourSynth\plugins64\ffms2.dll",
            r"C:\Program Files (x86)\VapourSynth\plugins32\ffms2.dll",
        ]
    else:
        explicit = [
            "/usr/lib/x86_64-linux-gnu/vapoursynth/libffms2.so",
            "/usr/lib/vapoursynth/libffms2.so",
            "/usr/local/lib/vapoursynth/libffms2.so",
        ]
    return _find_plugin("ffms2", explicit, "ffms2")


def find_znedi3_plugin() -> str | None:
    """Return a znedi3 plugin path, or the sentinel 'pip:vapoursynth' when it
    is auto-loaded into core (distinct from ffms2: here the caller must know
    whether to report the plugin as available without a file on disk)."""
    try:
        import vapoursynth as _vs
        if hasattr(_vs.core, "znedi3"):
            return "pip:vapoursynth"
    except Exception:
        pass
    explicit: list[str] = []
    sysname = platform.system()
    if sysname == "Darwin":
        explicit = ["/opt/homebrew/lib/vapoursynth/vsznedi3.so", "/opt/homebrew/lib/vapoursynth/vsznedi3.dylib"]
    elif sysname == "Windows":
        explicit = [r"C:\Program Files\VapourSynth\plugins64\vsznedi3.dll"]
    else:
        explicit = ["/usr/lib/vapoursynth/vsznedi3.so"]
    candidates: list[str] = []
    try:
        import vapoursynth as _vs, os as _os
        venv_plugins = _os.path.join(_os.path.dirname(_vs.__file__), "plugins")
        for root, _, files in _os.walk(venv_plugins):
            for f in files:
                if "znedi3" in f.lower():
                    candidates.append(_os.path.join(root, f))
    except Exception:
        pass
    candidates.extend(explicit)
    return next((p for p in candidates if os.path.isfile(p)), None)


def find_vspipe() -> str:
    """Locate vspipe, checking active venv's bin/ or Scripts/ before PATH."""
    import pathlib as _pl
    import sys as _sys
    try:
        import vapoursynth as _vs
        prefix = _pl.Path(_sys.prefix)
        candidates = [
            prefix / "bin" / "vspipe",
            prefix / "Scripts" / "vspipe.exe",
            prefix / "Scripts" / "vspipe",
            prefix / "bin" / "vspipe.exe",
            _pl.Path(_vs.__file__).parent.parent.parent.parent / "Scripts" / "vspipe.exe",
            _pl.Path(_vs.__file__).parent.parent.parent.parent / "bin" / "vspipe",
        ]
        for cand in candidates:
            if cand.exists():
                return str(cand)
    except Exception:
        pass
    found = shutil.which("vspipe")
    if found:
        return found
    raise RuntimeError("vspipe not found. Install VapourSynth or add it to PATH.")


def vapoursynth_available() -> bool:
    """True if vapoursynth is installed and vspipe is discoverable."""
    return find_spec("vapoursynth") is not None and _vspipe_quietly() is not None


def _vspipe_quietly() -> str | None:
    try:
        return find_vspipe()
    except Exception:
        return None
