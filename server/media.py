"""Server-side media helpers.

Plain equivalents of the ui/media utilities with NO Streamlit dependency —
the FastAPI layer must stay usable without the Streamlit fallback installed.
"""

import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

IMAGE_EXTS = {"png", "jpg", "jpeg", "webp"}
VIDEO_EXTS = {"mp4", "mov", "avi", "webm"}

MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_VIDEO_UPLOAD_BYTES = 500 * 1024 * 1024

# Stereoscopic posts (see docs/stereo-3d-reels.md). The original stereo file
# is the VR source; <stem>-mono.<ext> holds the left eye for 2D surfaces.
STEREO_LAYOUTS = ("mono", "sbs", "tb")
MONO_SUFFIX = "-mono"
# Long side of the H.264 stereo proxy: 2048 px per eye, inside the Quest
# H.264 decoder limits.
STEREO_PROXY_LONG_SIDE = 4096
# Left-eye 2D video renditions match the square web preview cap.
MONO_VIDEO_MAX_SIDE = 2160
# Left-eye 2D stills keep up to the square master size.
MONO_IMAGE_MAX_SIDE = 3840


class UploadRejected(Exception):
    """Raised when a staged upload fails an extension or size check."""


def staging_dir() -> Path:
    d = Path(tempfile.gettempdir()) / "square_extender_api" / "uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_ext(filename: str, allowed_exts: set[str]) -> str:
    # Path(...).suffix only ever returns the last dotted segment, so a
    # filename crafted with path separators or multiple dots can't smuggle
    # anything but a single lowercase extension into the staged filename.
    ext = Path(filename or "").suffix.lstrip(".").lower()
    if ext not in allowed_exts:
        raise UploadRejected(f"Unsupported file extension: {ext or '(none)'}")
    return ext


def stage_upload_stream(
    filename: str,
    fileobj,
    allowed_exts: set[str],
    max_bytes: int,
    chunk_size: int = 1 << 20,
) -> tuple[str, int]:
    """Stream *fileobj* to a new staged file in chunks.

    Never buffers the whole upload in memory, enforces an extension
    allowlist up front, and aborts (deleting the partial file) as soon as
    *max_bytes* is exceeded rather than after the whole body has arrived.
    """
    ext = _safe_ext(filename, allowed_exts)
    dest = staging_dir() / f"{uuid.uuid4().hex[:10]}.{ext}"
    total = 0
    try:
        with open(dest, "wb") as out:
            while True:
                chunk = fileobj.read(chunk_size)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise UploadRejected(
                        f"File exceeds the {max_bytes // (1024 * 1024)}MB upload limit"
                    )
                out.write(chunk)
    except Exception:
        dest.unlink(missing_ok=True)
        raise
    return str(dest), total


def human_bytes(n: int | None) -> str:
    if not n:
        return "—"
    step = 1024.0
    for unit in ("B", "KB", "MB", "GB"):
        if n < step or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= step
    return f"{n:.1f} GB"


# (path, mtime, size) -> codec name. Keyed on mtime/size so a replaced file
# at the same path (e.g. a re-rendered output) naturally invalidates the
# entry instead of serving a stale codec.
_codec_cache: dict[tuple[str, float, int], str] = {}


def get_video_codec(src: str) -> str:
    """Return the video stream codec name (e.g. 'hevc', 'h264') via ffprobe.

    Cached per (path, mtime, size) — /api/reels probes every video's codec on
    every request (twice, for master + preview), and ffprobe is a subprocess
    spawn each time, so an unbounded probe storm on every page load.
    """
    try:
        stat = os.stat(src)
        key = (src, stat.st_mtime, stat.st_size)
    except OSError:
        key = None

    if key is not None and key in _codec_cache:
        return _codec_cache[key]

    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name", "-of", "csv=p=0", src,
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=5,
                           creationflags=_NO_WINDOW)
        codec = p.stdout.strip().lower()
    except Exception:
        codec = "unknown"

    if key is not None:
        _codec_cache[key] = codec
    return codec


def probe_media_info(src: str) -> dict | None:
    """Read duration and pixel size of a media file with one ffprobe call.

    Returns {"duration_ms", "width", "height"} (each None when unknown), or
    None when the file cannot be probed at all. Width/height are the size as
    shown: a video's display-matrix rotation and a still's EXIF orientation
    are applied, matching the frames ffmpeg decodes and the stereo layout
    a viewer sees (missing file, no ffprobe,
    unreadable media). Duration is only meaningful for video; the caller
    decides whether to keep it.
    """
    from pipeline.utils import display_size, exif_quarter_turn, stream_rotation

    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_streams", "-show_entries", "format=duration",
        "-of", "json", src,
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=15,
                           creationflags=_NO_WINDOW)
        if p.returncode != 0:
            return None
        data = json.loads(p.stdout or "{}")
    except (OSError, subprocess.SubprocessError, ValueError):
        return None

    streams = data.get("streams") or []
    stream = streams[0] if streams else {}

    def positive_int(value) -> int | None:
        try:
            number = int(value)
        except (TypeError, ValueError):
            return None
        return number if number > 0 else None

    duration_ms = None
    for raw in (stream.get("duration"), (data.get("format") or {}).get("duration")):
        try:
            seconds = float(raw)
        except (TypeError, ValueError):
            continue
        if seconds > 0:
            duration_ms = int(round(seconds * 1000))
            break
    if not streams and duration_ms is None:
        return None
    width, height = positive_int(stream.get("width")), positive_int(stream.get("height"))
    if Path(src).suffix.lstrip(".").lower() in IMAGE_EXTS:
        try:
            from PIL import Image

            with Image.open(src) as img:
                turned = exif_quarter_turn(img)
        except (OSError, ValueError):
            turned = False
        if turned:
            width, height = height, width
    else:
        width, height = display_size(width, height, stream_rotation(stream))
    return {
        "duration_ms": duration_ms,
        "width": width,
        "height": height,
    }


def has_web_preview(src: str) -> bool:
    if get_video_codec(src) in {"h264", "avc1"}:
        return True
    dest = Path(src).with_name(Path(src).stem + "-preview.mp4")
    return dest.exists() and dest.stat().st_size > 0


def make_web_preview(src: str, height: int | None = 3840, stereo: str | None = None) -> str | None:
    """Transcode an H.264 proxy for in-browser playback (mirrors ui/media).

    With a stereo layout ("sbs" / "tb") the proxy keeps the full stereo frame
    and caps its long side at STEREO_PROXY_LONG_SIDE (2048 px per eye); an
    H.264 source larger than that also gets a proxy, since Quest cannot
    decode H.264 past ~4096 px.
    """
    stereo = stereo if stereo in ("sbs", "tb") else None
    if get_video_codec(src) in {"h264", "avc1"}:
        if not stereo:
            return src
        info = probe_media_info(src) or {}
        if max(info.get("width") or 0, info.get("height") or 0) <= STEREO_PROXY_LONG_SIDE:
            return src

    dest = Path(src).with_name(Path(src).stem + "-preview.mp4")
    if dest.exists() and dest.stat().st_size > 0:
        if not stereo:
            return str(dest)
        # A proxy cached before the stereo cap existed may be too large.
        cached = probe_media_info(str(dest)) or {}
        if max(cached.get("width") or 0, cached.get("height") or 0) <= STEREO_PROXY_LONG_SIDE:
            return str(dest)

    if stereo == "sbs":
        vf_args = ["-vf", f"scale='2*trunc(min(iw,{STEREO_PROXY_LONG_SIDE})/2)':-2"]
    elif stereo == "tb":
        vf_args = ["-vf", f"scale=-2:'2*trunc(min(ih,{STEREO_PROXY_LONG_SIDE})/2)'"]
    else:
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


def explore_preview_path(src: str) -> Path:
    """Sibling path for the lightweight Explore-grid preview (<stem>-explore.mp4)."""
    return Path(src).with_name(Path(src).stem + "-explore.mp4")


def explore_poster_path(src: str) -> Path:
    """Sibling path for the Explore-grid poster thumbnail (<stem>-poster.jpg)."""
    return Path(src).with_name(Path(src).stem + "-poster.jpg")


def mono_sibling_path(src: str) -> Path:
    """Sibling path for the left-eye 2D rendition of a stereo original.

    Videos always become <stem>-mono.mp4 (H.264); stills keep their format.
    """
    path = Path(src)
    ext = path.suffix.lower()
    if ext.lstrip(".") in VIDEO_EXTS:
        ext = ".mp4"
    return path.with_name(path.stem + MONO_SUFFIX + ext)


# Folders whose loose files predate stored stereo metadata and are known to
# hold full SBS (admin spatialize output). Only consulted for media without a
# post row, and by the 20261015_0013 backfill.
LEGACY_SBS_FOLDERS = ("testpipeline-3d",)


def legacy_stereo_layout(rel_path: str) -> str:
    """Stereo layout implied by where a loose output/ file lives."""
    first = Path(rel_path).parts[0] if Path(rel_path).parts else ""
    return "sbs" if first in LEGACY_SBS_FOLDERS else "mono"


def is_derived_media(name: str) -> bool:
    """True for generated siblings that must never surface as their own tile."""
    if name.endswith(("-preview.mp4", "-explore.mp4", "-poster.jpg")):
        return True
    return Path(name).stem.endswith(MONO_SUFFIX)


def stereo_paths(src: str) -> tuple[Path | None, Path]:
    """(left-eye mono rendition or None, best stereo playback file) of an original."""
    path = Path(src)
    mono = mono_sibling_path(src)
    try:
        has_mono = mono.is_file() and mono.stat().st_size > 0
    except OSError:
        has_mono = False
    stereo = path
    if path.suffix.lstrip(".").lower() in VIDEO_EXTS:
        proxy = path.with_name(path.stem + "-preview.mp4")
        try:
            if proxy.is_file() and proxy.stat().st_size > 0:
                stereo = proxy
        except OSError:
            pass
    return (mono if has_mono else None), stereo


def _left_eye_crop(layout: str) -> str:
    if layout == "sbs":
        return "crop=iw/2:ih:0:0"
    if layout == "tb":
        return "crop=iw:ih/2:0:0"
    raise ValueError(f"not a stereo layout: {layout!r}")


def make_left_eye_rendition(src: str, layout: str) -> str | None:
    """Write the square left eye of a stereo original next to it.

    Video: H.264 + AAC, faststart, at most MONO_VIDEO_MAX_SIDE square.
    Image: same format as the source, at most MONO_IMAGE_MAX_SIDE square.
    Returns the rendition path, or None when it could not be produced.
    """
    crop = _left_eye_crop(layout)
    dest = mono_sibling_path(src)
    try:
        if dest.exists() and dest.stat().st_size > 0 and _sibling_is_fresh(dest, src):
            return str(dest)
    except OSError:
        return None

    if Path(src).suffix.lstrip(".").lower() in IMAGE_EXTS:
        return _make_left_eye_still(src, layout, dest)

    side = MONO_VIDEO_MAX_SIDE
    vf = f"{crop},scale='2*trunc(min(iw,{side})/2)':'2*trunc(min(iw,{side})/2)'"
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-v", "error",
        "-i", src,
        "-vf", vf,
        "-c:v", "libx264", "-crf", "20", "-preset", "superfast",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "192k",
        str(dest),
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=600,
                           creationflags=_NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        dest.unlink(missing_ok=True)
        return None
    if p.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        dest.unlink(missing_ok=True)
        return None
    return str(dest)


def _make_left_eye_still(src: str, layout: str, dest: Path) -> str | None:
    from PIL import Image, ImageOps

    try:
        with Image.open(src) as img:
            img = ImageOps.exif_transpose(img)
            w, h = img.size
            box = (0, 0, w // 2, h) if layout == "sbs" else (0, 0, w, h // 2)
            eye = img.crop(box)
            if max(eye.size) > MONO_IMAGE_MAX_SIDE:
                eye = eye.resize((MONO_IMAGE_MAX_SIDE, MONO_IMAGE_MAX_SIDE), Image.LANCZOS)
            fmt = (img.format or "").upper()
            ext = dest.suffix.lower()
            if ext in (".jpg", ".jpeg"):
                eye.convert("RGB").save(dest, "JPEG", quality=92)
            elif ext == ".webp":
                eye.save(dest, "WEBP", quality=92)
            else:
                eye.save(dest, fmt or "PNG")
    except (OSError, ValueError):
        dest.unlink(missing_ok=True)
        return None
    if not dest.exists() or dest.stat().st_size == 0:
        return None
    return str(dest)


def _sibling_is_fresh(sibling: Path, src: str) -> bool:
    try:
        return sibling.stat().st_mtime >= Path(src).stat().st_mtime
    except OSError:
        return True


def _sibling_matches_height(sibling: Path, height: int) -> bool:
    """Check a cached sibling asset matches the target height (ffprobe).

    Guarantees stale assets from an older resolution setting regenerate
    instead of being served forever.
    """
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=height", "-of", "csv=p=0", str(sibling),
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=10,
                           creationflags=_NO_WINDOW)
        return int(p.stdout.strip()) == height
    except (OSError, subprocess.SubprocessError, ValueError):
        return True  # unreadable — let the normal flow decide


def make_explore_preview(src: str, height: int = 720) -> str | None:
    """Transcode a tiny muted H.264 preview for the Explore gallery grid.

    720p, no audio, faststart — cheap enough to autoplay several tiles at
    once. Cached on disk next to the source; regenerates when the source is
    newer than the cached preview or the height setting changed.
    """
    try:
        dest = explore_preview_path(src)
        if dest.exists() and dest.stat().st_size > 0:
            if _sibling_is_fresh(dest, src) and _sibling_matches_height(dest, height):
                return str(dest)
    except OSError:
        return None

    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-v", "error",
        "-i", src,
        "-vf", f"scale=-2:{height}",
        "-c:v", "libx264", "-crf", "28", "-preset", "veryfast",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-an",
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


def make_explore_poster(src: str, height: int = 720) -> str | None:
    """Extract a single-frame JPEG poster for the Explore gallery grid.

    Tens of KB and ~10x faster to produce than a preview transcode (one
    decoded frame, no full re-encode), so the grid can paint instantly while
    preview videos generate in the background. Cached on disk next to the
    source; regenerates when the source is newer than the cached poster or
    the height setting changed.
    """
    try:
        dest = explore_poster_path(src)
        if dest.exists() and dest.stat().st_size > 0:
            if _sibling_is_fresh(dest, src) and _sibling_matches_height(dest, height):
                return str(dest)
    except OSError:
        return None

    vf = f"scale=-2:{height}"
    # Keyframe-only fast path first (input seek + nokey ≈ 1 core, so parallel
    # batches don't oversubscribe the CPU), then accurate seeks as fallback
    # for very short clips where the seek point lands past EOF.
    variants = [
        ["ffmpeg", "-y", "-hide_banner", "-v", "error",
         "-ss", "1", "-skip_frame", "nokey", "-i", src,
         "-vframes", "1", "-vf", vf, "-q:v", "5", str(dest)],
        ["ffmpeg", "-y", "-hide_banner", "-v", "error",
         "-ss", "1", "-i", src,
         "-vframes", "1", "-vf", vf, "-q:v", "5", str(dest)],
        ["ffmpeg", "-y", "-hide_banner", "-v", "error",
         "-i", src,
         "-vframes", "1", "-vf", vf, "-q:v", "5", str(dest)],
    ]
    for cmd in variants:
        try:
            p = subprocess.run(cmd, capture_output=True, timeout=120,
                               creationflags=_NO_WINDOW)
        except (OSError, subprocess.SubprocessError):
            return None
        if p.returncode == 0 and dest.exists() and dest.stat().st_size > 0:
            return str(dest)
    return None


def scan_output_videos(root: str = "output") -> list[dict]:
    """Recursively scan root directory for video files, excluding preview proxies."""
    base = Path(root)
    if not base.exists():
        return []

    videos = []
    for file in base.rglob("*"):
        if not file.is_file():
            continue
        if file.name.startswith(".") or is_derived_media(file.name):
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
                "media_type": "video",
            })
        except OSError:
            continue

    videos.sort(key=lambda x: x["mtime"], reverse=True)
    return videos


def scan_output_images(root: str = "output") -> list[dict]:
    """Recursively scan root directory for image files (single image tiles).

    Mirrors scan_output_videos: excludes generated poster thumbs
    (<stem>-poster.jpg) and left-eye stereo renditions (<stem>-mono.<ext>)
    so derived assets never appear as their own tiles.
    """
    base = Path(root)
    if not base.exists():
        return []

    images = []
    for file in base.rglob("*"):
        if not file.is_file():
            continue
        if file.name.startswith(".") or is_derived_media(file.name):
            continue
        ext = file.suffix.lstrip(".").lower()
        if ext not in IMAGE_EXTS:
            continue

        try:
            rel = file.relative_to(base)
            folder = str(rel.parent) if rel.parent != Path(".") else "root"
            stat = file.stat()
            images.append({
                "path": str(file.resolve()),
                "rel_path": rel.as_posix(),
                "filename": file.name,
                "folder": folder,
                "size_bytes": stat.st_size,
                "size_human": human_bytes(stat.st_size),
                "mtime": stat.st_mtime,
                "media_type": "image",
            })
        except OSError:
            continue

    images.sort(key=lambda x: x["mtime"], reverse=True)
    return images


def scan_output_media(root: str = "output") -> list[dict]:
    """Combined video + image scan, newest first (backing the reels feed)."""
    items = scan_output_videos(root) + scan_output_images(root)
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items


def make_image_poster(src: str, height: int = 720) -> str | None:
    """Generate a lightweight JPEG thumb next to an image (<stem>-poster.jpg).

    Lets Explore tiles paint a tens-of-KB poster instantly while the full
    image loads. Cached on disk; regenerates when the source is newer.
    """
    try:
        dest = Path(src).with_name(Path(src).stem + "-poster.jpg")
        if dest.exists() and dest.stat().st_size > 0 and _sibling_is_fresh(dest, src):
            return str(dest)
    except OSError:
        return None

    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-v", "error",
        "-i", src,
        "-vf", f"scale=-2:{height}",
        "-q:v", "5",
        str(dest),
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=120,
                           creationflags=_NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        return None
    return str(dest)


def scan_pairs(root: str = "output/pairs") -> list[dict]:
    """Find *_fast.mp4 files strictly within output/ directory."""
    out = []
    seen = set()
    output_root = Path("output").resolve()
    dirs_to_scan = [Path(root), Path("output"), Path("output/FAL Playground test 4K")]

    Path(root).mkdir(parents=True, exist_ok=True)

    for base in dirs_to_scan:
        if not base.is_dir():
            continue
        try:
            if not base.resolve().is_relative_to(output_root):
                continue
        except (OSError, ValueError):
            continue

        fast_files = sorted(list(base.glob("*_fast.mp4")) + list(base.glob("*_fast_4k.mp4")))
        for fast in fast_files:
            if is_derived_media(fast.name):
                continue
            fast_suffix = "_fast_4k.mp4" if fast.name.endswith("_fast_4k.mp4") else "_fast.mp4"
            stem = fast.name[: -len(fast_suffix)]
            if stem in seen:
                continue

            try:
                if not fast.resolve().is_relative_to(output_root):
                    continue
            except (OSError, ValueError):
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