"""Server-side media helpers.

Plain equivalents of the ui/media utilities with NO Streamlit dependency —
the FastAPI layer must stay usable without the Streamlit fallback installed.
"""

import os
import subprocess
import tempfile
import uuid
from pathlib import Path

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

IMAGE_EXTS = {"png", "jpg", "jpeg", "webp"}
VIDEO_EXTS = {"mp4", "mov", "avi", "webm"}


def staging_dir() -> Path:
    d = Path(tempfile.gettempdir()) / "square_extender_api" / "uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def stage_upload(filename: str, content: bytes) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    dest = staging_dir() / f"{uuid.uuid4().hex[:10]}.{ext}"
    dest.write_bytes(content)
    return str(dest)


def human_bytes(n: int | None) -> str:
    if not n:
        return "—"
    step = 1024.0
    for unit in ("B", "KB", "MB", "GB"):
        if n < step or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= step
    return f"{n:.1f} GB"


def get_video_codec(src: str) -> str:
    """Return the video stream codec name (e.g. 'hevc', 'h264') via ffprobe."""
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name", "-of", "csv=p=0", src,
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=5,
                           creationflags=_NO_WINDOW)
        return p.stdout.strip().lower()
    except Exception:
        return "unknown"


def has_web_preview(src: str) -> bool:
    if get_video_codec(src) in {"h264", "avc1"}:
        return True
    dest = Path(src).with_name(Path(src).stem + "-preview.mp4")
    return dest.exists() and dest.stat().st_size > 0


def make_web_preview(src: str, height: int | None = 3840) -> str | None:
    """Transcode an H.264 proxy for in-browser playback (mirrors ui/media)."""
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
        p = subprocess.run(cmd, capture_output=True, timeout=300,
                           creationflags=_NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        return None
    return str(dest)


def scan_output_videos(root: str = "output") -> list[dict]:
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

    videos.sort(key=lambda x: x["mtime"], reverse=True)
    return videos


def scan_pairs(root: str = "output/pairs") -> list[dict]:
    """Find *_fast.mp4 files and note whether the _studio sibling exists."""
    out = []
    seen = set()
    dirs_to_scan = [Path(root), Path("input/1:1"), Path("input"),
                    Path("output"), Path("output/FAL Playground test 4K")]

    Path(root).mkdir(parents=True, exist_ok=True)

    for base in dirs_to_scan:
        if not base.is_dir():
            continue
        fast_files = sorted(list(base.glob("*_fast.mp4")) + list(base.glob("*_fast_4k.mp4")))
        for fast in fast_files:
            fast_suffix = "_fast_4k.mp4" if fast.name.endswith("_fast_4k.mp4") else "_fast.mp4"
            stem = fast.name[: -len(fast_suffix)]
            if stem in seen:
                continue

            studio_candidates = [
                base / f"{stem}_studio.mp4",
                base / f"{stem}_studio_4k.mp4",
            ]
            studio = next((s for s in studio_candidates if s.is_file()), studio_candidates[0])

            seen.add(stem)
            out.append({
                "name": stem,
                "fast": str(fast),
                "studio": str(studio),
                "complete": studio.is_file(),
            })
    return out


def video_aspect(path: str) -> str:
    try:
        from pipeline.utils import get_video_dimensions_and_duration
        w, h, _ = get_video_dimensions_and_duration(path)
        if w and h:
            return f"{w}/{h}"
    except Exception:
        pass
    return "1/1"