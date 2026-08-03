"""Upload staging, metadata, result persistence, and preview proxies.

Two problems this module exists to solve:

1. Both pipeline workers write to a FIXED shared temp path
   (%TEMP%/delivery_4k_square.{png,mp4}) and unlink it at the start of every
   run. So run B blanked run A's still-displayed result, and two browser tabs
   destroyed each other. persist_result() moves the output into a per-session
   directory the instant the worker returns.

2. The pipeline encodes HEVC, which does not decode in st.video()/HTML5 — the
   player renders black, which reads as "the pipeline produced garbage."
   make_web_preview() transcodes a small H.264 proxy for display only; the
   HEVC master is offered for download untouched.
"""

import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

import streamlit as st

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

IMAGE_EXTS = {"png", "jpg", "jpeg", "webp"}
VIDEO_EXTS = {"mp4", "mov", "avi", "webm"}

DURATION_SOFT_LIMIT = 10.0


def session_id() -> str:
    """Stable per-session id. The scriptrunner path has moved between
    Streamlit versions, so fall back to a uuid kept in session_state."""
    try:
        from streamlit.runtime.scriptrunner import get_script_run_ctx

        ctx = get_script_run_ctx()
        if ctx and ctx.session_id:
            return str(ctx.session_id)
    except Exception:
        pass
    if "sx.session_id" not in st.session_state:
        st.session_state["sx.session_id"] = uuid.uuid4().hex
    return st.session_state["sx.session_id"]


def session_dir() -> Path:
    d = Path(tempfile.gettempdir()) / "square_extender" / session_id()
    d.mkdir(parents=True, exist_ok=True)
    return d


def human_bytes(n: int | None) -> str:
    if not n:
        return "—"
    step = 1024.0
    for unit in ("B", "KB", "MB", "GB"):
        if n < step or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= step
    return f"{n:.1f} GB"


def ext_of(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def orientation(w: int, h: int) -> str:
    if w > h:
        return "LANDSCAPE"
    if h > w:
        return "PORTRAIT"
    return "SQUARE"


# --------------------------------------------------------------------------
# Upload staging
# --------------------------------------------------------------------------

def read_upload_bytes(uploaded) -> bytes:
    """Read an UploadedFile's bytes.

    Always seek(0) first: UploadedFile is a BytesIO, and the old code read it
    without rewinding, so a second read in the same run silently yielded b""
    and surfaced as "cannot identify image file".
    """
    uploaded.seek(0)
    return uploaded.read()


def stage_video(uploaded) -> str:
    """Write an uploaded video to a per-session temp file and return its path.

    Videos are staged to disk rather than held in session_state — a 25 MB
    source plus a ~100 MB result in memory per session is not worth it, and
    ffprobe/ffmpeg need a real path anyway.
    """
    suffix = "." + (ext_of(uploaded.name) or "mp4")
    dest = session_dir() / f"src-{uuid.uuid4().hex[:8]}{suffix}"
    dest.write_bytes(read_upload_bytes(uploaded))
    return str(dest)


def discard_staged(path: str | list[str] | None) -> None:
    if not path:
        return
    paths = path if isinstance(path, list) else [path]
    for p in paths:
        if p and isinstance(p, str):
            try:
                os.unlink(p)
            except OSError:
                pass


def batch_sig(uploaded_files: list | None) -> str | None:
    if not uploaded_files:
        return None
    return ";".join(f"{f.name}|{f.size}" for f in uploaded_files)


# --------------------------------------------------------------------------
# Metadata
# --------------------------------------------------------------------------

def image_meta(data: bytes) -> dict:
    from pipeline.utils import calculate_square_padding, get_image_dimensions

    w, h = get_image_dimensions(data)
    return {
        "w": w,
        "h": h,
        "pad": calculate_square_padding(w, h),
        "bytes": len(data),
        "orientation": orientation(w, h),
    }


def video_meta(path: str) -> dict:
    from pipeline.utils import (
        calculate_square_padding,
        get_video_dimensions_and_duration,
    )

    w, h, dur = get_video_dimensions_and_duration(path)
    return {
        "w": w,
        "h": h,
        "dur": dur,
        "pad": calculate_square_padding(w, h),
        "bytes": os.path.getsize(path),
        "orientation": orientation(w, h),
    }


# --------------------------------------------------------------------------
# Result persistence
# --------------------------------------------------------------------------

def persist_result(worker_path: str, kind: str, params: dict) -> dict:
    """Move a worker's output out of its fixed shared path into this session's
    directory, and return the result record stored in session_state.

    Must run immediately on worker return, before anything else can start a
    second run and unlink the shared path.
    """
    src = Path(worker_path)
    ext = src.suffix or (".png" if kind == "image" else ".mp4")
    dest = session_dir() / f"{kind}-{uuid.uuid4().hex[:8]}{ext}"
    try:
        shutil.move(str(src), str(dest))
    except OSError:
        shutil.copy2(str(src), str(dest))
    return {
        "path": str(dest),
        "preview": None,
        "kind": kind,
        "bytes": dest.stat().st_size,
        "params": params,
    }


def discard_result(result: dict | list[dict] | None) -> None:
    if not result:
        return
    items = result if isinstance(result, list) else [result]
    for res in items:
        if isinstance(res, dict):
            for key in ("path", "preview"):
                p = res.get(key)
                if p:
                    try:
                        os.unlink(p)
                    except OSError:
                        pass


@st.cache_data(show_spinner=False)
def file_bytes(path: str, mtime: float, size: int) -> bytes:
    """Read a file for st.download_button.

    Cached on (path, mtime, size): passing an open handle made Streamlit
    re-read ~100 MB on every rerun to compute its hash.
    """
    return Path(path).read_bytes()


def download_bytes(path: str) -> bytes:
    stat = os.stat(path)
    return file_bytes(path, stat.st_mtime, stat.st_size)


# --------------------------------------------------------------------------
# Browser-playable proxy
# --------------------------------------------------------------------------

@st.cache_data(show_spinner=False)
def get_video_codec(src: str) -> str:
    """Return the video stream codec name (e.g. 'hevc', 'h264') via ffprobe."""
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name", "-of", "csv=p=0", src
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=5, creationflags=_NO_WINDOW)
        return p.stdout.strip().lower()
    except Exception:
        return "unknown"


def has_web_preview(src: str) -> bool:
    """Check if an H.264 preview proxy or native H.264 source exists for web playback."""
    if get_video_codec(src) in {"h264", "avc1"}:
        return True
    dest = Path(src).with_name(Path(src).stem + "-preview.mp4")
    return dest.exists() and dest.stat().st_size > 0


def make_web_preview(src: str, height: int | None = 3840) -> str | None:
    """Transcode an H.264 proxy for in-browser playback.

    If source is already H.264, returns source untouched.
    Otherwise transcodes a high-quality H.264 proxy (default 4K 3840p).
    """

    if get_video_codec(src) in {"h264", "avc1"}:
        return src

    dest = Path(src).with_name(Path(src).stem + "-preview.mp4")
    if dest.exists() and dest.stat().st_size > 0:
        return str(dest)

    target_h = min(height or 2160, 2160)
    vf_args = ["-vf", f"scale=-2:{target_h}"] if target_h > 0 else []

    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-v", "error",
        "-i", src,
        *vf_args,
        "-c:v", "libx264", "-crf", "20", "-preset", "superfast",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "192k",
        str(dest),
    ]
    try:
        p = subprocess.run(
            cmd, capture_output=True, timeout=300, creationflags=_NO_WINDOW
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        return None
    return str(dest)



# --------------------------------------------------------------------------
# Output Directory Video Discovery
# --------------------------------------------------------------------------

@st.cache_data(show_spinner=False)
def scan_output_videos(root: str = "output", nonce: int = 0) -> list[dict]:
    """Recursively scan root directory for video files, excluding preview proxies."""
    base = Path(root)
    if not base.exists():
        return []

    videos = []
    for file in base.rglob("*"):
        if not file.is_file():
            continue
        if file.name.startswith(".") or file.name.endswith("-preview.mp4"):
            continue
        ext = file.suffix.lstrip(".").lower()
        if ext not in VIDEO_EXTS:
            continue

        try:
            rel = file.relative_to(base)
            folder = str(rel.parent) if rel.parent != Path(".") else "root"
            stat = file.stat()
            videos.append({
                "path": str(file.resolve()),
                "rel_path": rel.as_posix(),
                "filename": file.name,
                "folder": folder,
                "size_bytes": stat.st_size,
                "size_human": human_bytes(stat.st_size),
                "mtime": stat.st_mtime,
            })
        except OSError:
            continue

    # Default sort by modification time descending (newest first)
    videos.sort(key=lambda x: x["mtime"], reverse=True)
    return videos

