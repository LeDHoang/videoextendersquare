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
import tempfile
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
# libx265 keeps CRF quality control under a VBV ceiling (capped CRF): x265's
# vbv-maxrate/vbv-bufsize (kbps) bound the peaks at the hardware encoders'
# 26 Mbps, so playback buffering can rely on a bounded bitrate.
HEVC_CANDIDATES: list[tuple[str, list[str]]] = [
    ("hevc_videotoolbox", ["-b:v", "24M", "-maxrate", "26M", "-bufsize", "48M", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-movflags", "+faststart"]),
    ("hevc_nvenc", ["-preset", "slow", "-rc", "vbr", "-b:v", "24M", "-maxrate", "26M", "-bufsize", "48M", "-movflags", "+faststart"]),
    ("hevc_qsv", ["-b:v", "24M", "-maxrate", "26M", "-bufsize", "48M", "-movflags", "+faststart"]),
    ("libx265", ["-crf", "20", "-preset", "medium", "-x265-params", "vbv-maxrate=26000:vbv-bufsize=48000", "-tag:v", "hvc1", "-movflags", "+faststart"]),
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


# Every 4K-square master (fast, fal and studio paths) is encoded at this size.
SMOKE_ENCODE_SIZE = "3840x3840"


def smoke_encode(name: str, opts: list[str], size: str = SMOKE_ENCODE_SIZE) -> bool:
    """Encode one frame at the real master size to /dev/null. Presence in
    -encoders is NOT enough: hevc_nvenc lists fine but dies on 'Cannot load
    nvcuda.dll' with no NVIDIA GPU. A tiny frame is not enough either:
    hardware encoders have per-chip resolution/level limits that 64x64 never
    reaches. One 3840x3840 frame costs ~0.4s on VideoToolbox, ~1s on libx265.
    """
    p = run([
        "ffmpeg", "-hide_banner", "-v", "error",
        "-f", "lavfi", "-i", f"testsrc=d=0.1:s={size}",
        "-c:v", name, *opts, "-frames:v", "1", "-f", "null", "-",
    ], timeout=40)
    return bool(p and p.returncode == 0)


# Cached per-process, guarded by a lock so concurrent jobs can't all spawn the
# same 4-way ffmpeg smoke-test at once. Pre-warmed once at startup by the
# FastAPI lifespan (see server/app.py).
_ENCODER_CACHE: tuple[str, list[str]] | None = None
_ENCODER_LOCK = threading.Lock()


def _thread_opts(name: str) -> list[str]:
    """Encoder thread cap from SX_FFMPEG_THREADS (unset: ffmpeg's default).

    libx265 sizes its own thread pools, so it also needs ``pools=N``.
    """
    try:
        threads = int(os.environ.get("SX_FFMPEG_THREADS", ""))
    except ValueError:
        return []
    if threads < 1:
        return []
    opts = ["-threads", str(threads)]
    if name == "libx265":
        opts += ["-x265-params", f"pools={threads}"]
    return opts


def pick_encoder() -> tuple[str, list[str]]:
    """Return (name, opts) for a working HEVC encoder, cached per process."""
    global _ENCODER_CACHE
    if _ENCODER_CACHE:
        name, opts = _ENCODER_CACHE
        return name, opts + _thread_opts(name)

    with _ENCODER_LOCK:
        if _ENCODER_CACHE:
            name, opts = _ENCODER_CACHE
            return name, opts + _thread_opts(name)

        listed = run(["ffmpeg", "-hide_banner", "-encoders"]).stdout or ""

        for name, opts in HEVC_CANDIDATES:
            if name not in listed:
                continue
            if smoke_encode(name, opts):
                _ENCODER_CACHE = (name, opts)
                return name, opts + _thread_opts(name)

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


def _guarded_load_lines(namespace: str, plugin: str | None) -> str:
    """VapourSynth script lines that LoadPlugin `plugin` for `core.<namespace>`.

    None or the 'pip:vapoursynth' sentinel emits nothing (autoload). An
    explicit path is loaded only while the namespace is still missing: vspipe
    may run a different VapourSynth than this process (the pip wheel
    autoloads nothing, a system install autoloads plugins64), and LoadPlugin
    on an already-loaded plugin raises.
    """
    if not plugin or plugin == "pip:vapoursynth":
        return ""
    return (
        f"if not hasattr(core, {namespace!r}):\n"
        f"    core.std.LoadPlugin({os.path.abspath(plugin)!r})\n"
    )


def ffms2_load_lines(plugin: str | None) -> str:
    """VapourSynth script lines that make `core.ffms2` available.

    Single source of truth for the studio worker's .vpy and smoke_ffms2(),
    so the health probe exercises exactly what a render does.
    """
    return _guarded_load_lines("ffms2", plugin)


def znedi3_load_lines(plugin: str | None) -> str:
    """VapourSynth script lines that make `core.znedi3` available.

    Single source of truth for the studio worker's .vpy and smoke_znedi3(),
    so the health probe exercises exactly what a render does.
    """
    return _guarded_load_lines("znedi3", plugin)


# One blank frame through the same nnedi3 call the studio worker makes.
_ZNEDI3_SMOKE_VPY = """import vapoursynth as vs
core = vs.core
{load}clip = core.std.BlankClip(width=16, height=16, length=1, format=vs.YUV420P8)
clip = core.znedi3.nnedi3(clip, field=1, dh=True, nsize=0, nns=3, qual=2, pscrn=2)
clip.set_output()
"""

# Resolves core.ffms2 inside vspipe and calls into the plugin. A real
# Source() would need a sample video; the missing namespace is what bites.
_FFMS2_SMOKE_VPY = """import vapoursynth as vs
core = vs.core
{load}core.ffms2.Version()
core.std.BlankClip(width=16, height=16, length=1, format=vs.YUV420P8).set_output()
"""


def _smoke_vpy(script: str, name: str, timeout: int) -> tuple[bool, str]:
    """Run `script` through vspipe for frame 0 with no output.
    Returns (ok, last error line).

    A plugin file on disk (or the namespace in *this* process) is NOT enough:
    renders go through vspipe, which only sees what its script loads or its
    own VapourSynth autoloads. The old file-exists check reported znedi3 ok
    while every studio render died on 'No attribute with the name znedi3'.
    """
    vspipe = _vspipe_quietly()
    if not vspipe:
        return False, "vspipe not found"
    fd, vpy_path = tempfile.mkstemp(prefix=f"{name}_probe_", suffix=".vpy")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(script)
        # "--" = request the frame but write no output (vspipe R63+).
        p = run([vspipe, "--end", "0", vpy_path, "--"], timeout=timeout)
    finally:
        try:
            os.unlink(vpy_path)
        except OSError:
            pass
    if p is None:
        return False, f"vspipe failed to start or exceeded {timeout}s"
    if p.returncode == 0:
        return True, ""
    lines = [ln.strip() for ln in (p.stderr or "").splitlines() if ln.strip()]
    return False, lines[-1] if lines else f"vspipe exited with code {p.returncode}"


def smoke_ffms2(plugin: str | None, timeout: int = 20) -> tuple[bool, str]:
    """Check core.ffms2 loads in vspipe the way the studio worker loads it."""
    return _smoke_vpy(_FFMS2_SMOKE_VPY.format(load=ffms2_load_lines(plugin)), "ffms2", timeout)


def smoke_znedi3(plugin: str | None, timeout: int = 20) -> tuple[bool, str]:
    """Render one frame through core.znedi3 with vspipe, loading the plugin
    the same way the studio worker does."""
    return _smoke_vpy(_ZNEDI3_SMOKE_VPY.format(load=znedi3_load_lines(plugin)), "znedi3", timeout)


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
