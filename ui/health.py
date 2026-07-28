"""Environment health probing and PATH self-heal.

The pipeline shells out with bare "ffmpeg"/"ffprobe" and subprocess inherits
os.environ, so prepending a directory to os.environ["PATH"] in-process makes
every existing pipeline call work with zero changes to pipeline/.

Call ensure_ffmpeg_on_path() from app.py BEFORE anything imports pipeline.
"""

import os
import glob
import shutil
import platform
import subprocess
from dataclasses import dataclass
from importlib.util import find_spec

import streamlit as st

# Hide console windows for subprocesses on Windows
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def _candidate_dirs() -> list[str]:
    """Directories that might contain ffmpeg/ffprobe, in priority order."""
    cands: list[str] = []

    # Explicit overrides win
    for var in ("SX_FFMPEG_DIR", "FFMPEG_DIR"):
        val = os.environ.get(var)
        if val:
            cands.append(val)

    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA", "")
        if local:
            # winget installs Gyan.FFmpeg under a versioned subdir
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

    Returns the directory used, or None if ffmpeg was already resolvable or
    no candidate worked. Idempotent — safe to call on every rerun.
    """
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


@dataclass(frozen=True)
class Probe:
    id: str
    label: str
    ok: bool
    severity: str  # "block" | "degrade" | "info"
    detail: str
    fix: str


def _run(args: list[str], timeout: int = 20) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(
            args, capture_output=True, text=True, timeout=timeout,
            creationflags=_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return None


# HEVC encoder candidates, best-first. Mirrors pipeline/video_worker.py.
HEVC_CANDIDATES: list[tuple[str, list[str]]] = [
    ("hevc_videotoolbox", ["-q:v", "65", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"]),
    ("hevc_nvenc", ["-preset", "slow", "-rc", "vbr", "-cq", "28"]),
    ("hevc_qsv", ["-global_quality", "28"]),
    ("libx265", ["-crf", "28", "-preset", "slow", "-tag:v", "hvc1"]),
]


def smoke_encode(name: str, opts: list[str]) -> bool:
    """Encode one frame to /dev/null. Presence in -encoders is NOT enough:
    hevc_nvenc lists fine but dies on 'Cannot load nvcuda.dll' with no NVIDIA GPU.
    """
    p = _run([
        "ffmpeg", "-hide_banner", "-v", "error",
        "-f", "lavfi", "-i", "testsrc=d=0.1:s=64x64",
        "-c:v", name, *opts, "-frames:v", "1", "-f", "null", "-",
    ], timeout=40)
    return bool(p and p.returncode == 0)


def _znedi3_plugin_path() -> str:
    sysname = platform.system()
    if sysname == "Darwin":
        return "/opt/homebrew/lib/vapoursynth/vsznedi3.so"
    if sysname == "Windows":
        return r"C:\Program Files\VapourSynth\plugins64\vsznedi3.dll"
    return "/usr/lib/vapoursynth/vsznedi3.so"


@st.cache_resource(show_spinner=False)
def probe_environment(nonce: int = 0) -> dict[str, Probe]:
    """Probe the environment once per process. Bump nonce to invalidate.

    Excludes FAL_KEY, which is read live by fal_key_probe() since the user can
    type it into the sidebar mid-session.
    """
    out: dict[str, Probe] = {}

    ff = shutil.which("ffmpeg")
    ver = ""
    if ff:
        p = _run(["ffmpeg", "-hide_banner", "-version"])
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
        p = _run(["ffmpeg", "-hide_banner", "-filters"])
        filters = (p.stdout if p else "") or ""
        p = _run(["ffmpeg", "-hide_banner", "-encoders"])
        encoders = (p.stdout if p else "") or ""

    has_cas = " cas " in filters
    out["cas"] = Probe(
        "cas", "CAS", has_cas, "degrade",
        "available" if has_cas else "unavailable",
        "Sharpening is skipped. A newer ffmpeg build includes the cas filter.",
    )

    enc_name = ""
    if ff:
        for name, opts in HEVC_CANDIDATES:
            if name in encoders and smoke_encode(name, opts):
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

    has_vs = find_spec("vapoursynth") is not None and shutil.which("vspipe") is not None
    out["vapoursynth"] = Probe(
        "vapoursynth", "STUDIO", has_vs, "degrade",
        "available" if has_vs else "unavailable",
        "Studio engine needs VapourSynth + vspipe on PATH. Fast engine is unaffected.",
    )

    plugin = _znedi3_plugin_path()
    has_znedi3 = os.path.isfile(plugin)
    out["znedi3"] = Probe(
        "znedi3", "ZNEDI3", has_znedi3, "degrade",
        "available" if has_znedi3 else "not at expected path",
        f"Studio engine needs the znedi3 plugin at {plugin}",
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
