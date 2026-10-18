"""Detect full side-by-side (SBS) and full top-bottom (TB) stereoscopic media.

A stereo post keeps one square image per eye:

* ``sbs`` — width == 2 * height, left eye in the left half.
* ``tb``  — height == 2 * width, left eye in the top half.

Detection runs in two passes:

1. Container metadata: the ffprobe "Stereo 3D" stream side data (MP4 ``st3d``)
   or the Matroska/WebM ``stereo_mode`` tag. Inverted layouts (right eye
   first) are not supported: they never count as detected and skip the
   content pass. Spherical files (360 / VR180: "Spherical Mapping" side
   data, a projection tag, or GPano XMP on stills) are rejected outright,
   since their 2:1 frames are panoramas, not a pair of flat eyes.
2. Content: the two eye halves of a stereo pair show the same scene with a
   small horizontal disparity, while the halves of an ordinary 2:1 / 1:2 frame
   show different parts of it. Each half is reduced to a small high-passed
   grayscale patch and compared under a few horizontal shifts.

Only Pillow + ffmpeg/ffprobe are needed.
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
from statistics import median

from PIL import Image, ImageChops, ImageFilter, ImageOps, ImageStat

STEREO_LAYOUTS = ("mono", "sbs", "tb")

# Edge length of each eye patch the content check compares.
PATCH = 128
# Horizontal shifts (in patch pixels) tried when aligning the two eyes.
MAX_SHIFT = 12
# Content score at or above which a candidate counts as stereo. Calibrated
# on real 7680x3840 SBS reels (0.81-0.98) against ordinary 2:1 / 1:2 crops
# and stretches (0.00-0.33) and a synthetic test pattern (0.64).
CONTENT_THRESHOLD = 0.72
# A high-passed patch flatter than this (stddev) carries no usable detail.
MIN_DETAIL = 2.0

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

_METADATA_TYPES = {
    "side by side": "sbs",
    "sidebyside": "sbs",
    "top and bottom": "tb",
    "topbottom": "tb",
    "top_bottom": "tb",
}
_MKV_STEREO_MODES = {
    "left_right": "sbs",
    "1": "sbs",
    "top_bottom": "tb",
    "3": "tb",
}
# Matroska right-eye-first modes (by name and StereoMode number).
_MKV_INVERTED_MODES = {"right_left", "11", "bottom_top", "2"}


def candidate_layout(width: int | None, height: int | None) -> str | None:
    """Return the stereo layout an exact 2:1 / 1:2 frame could be, else None."""
    try:
        w, h = int(width or 0), int(height or 0)
    except (TypeError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None
    if w == 2 * h:
        return "sbs"
    if h == 2 * w:
        return "tb"
    return None


def layout_matches(layout: str, width: int | None, height: int | None) -> bool:
    """True when a frame of width x height can hold the given stereo layout."""
    if layout == "mono":
        return True
    return candidate_layout(width, height) == layout


def eye_size(layout: str, width: int, height: int) -> tuple[int, int]:
    """Pixel size of one eye for a stereo layout (the full frame for mono)."""
    if layout == "sbs":
        return width // 2, height
    if layout == "tb":
        return width, height // 2
    return width, height


def probe_metadata(src: str) -> dict:
    """Stereo/projection facts the container declares for its first video stream.

    Returns ``{"layout", "inverted", "spherical"}``: layout is "sbs" / "tb"
    (or None), inverted is True when a right-eye-first layout is declared,
    spherical is True for 360 / VR180 projection metadata. Unreadable files
    report nothing.
    """
    found = {"layout": None, "inverted": False, "spherical": False}
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_streams", "-show_format", "-of", "json", src,
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=15,
                           creationflags=_NO_WINDOW)
        if p.returncode != 0:
            return found
        data = json.loads(p.stdout or "{}")
    except (OSError, subprocess.SubprocessError, ValueError):
        return found
    streams = data.get("streams") or []
    if not streams:
        return found
    stream = streams[0]

    for side in stream.get("side_data_list") or []:
        side_type = str(side.get("side_data_type", "")).strip().lower()
        if side_type == "spherical mapping":
            found["spherical"] = True
            continue
        if side_type != "stereo 3d":
            continue
        layout = _METADATA_TYPES.get(str(side.get("type", "")).strip().lower())
        if _truthy(side.get("inverted")):
            found["inverted"] = True
        elif layout and not found["layout"]:
            found["layout"] = layout

    tags = {}
    for source in ((data.get("format") or {}).get("tags") or {}, stream.get("tags") or {}):
        tags.update({str(k).strip().lower(): str(v).strip().lower() for k, v in source.items()})
    if any(_is_projection_tag(k, v) for k, v in tags.items()):
        found["spherical"] = True
    mode = tags.get("stereo_mode", "")
    if mode in _MKV_INVERTED_MODES:
        found["inverted"] = True
    elif not found["layout"]:
        found["layout"] = _MKV_STEREO_MODES.get(mode)
    if found["inverted"]:
        found["layout"] = None
    return found


def _is_projection_tag(key: str, value: str) -> bool:
    """True for container tags declaring a 360 / VR180 projection."""
    if not value or value in {"0", "false", "no", "none", "flat", "rectangular"}:
        return False
    return "projection" in key or "spherical" in key


def metadata_layout(src: str) -> str | None:
    """Read the stereo layout declared by the container, if any.

    Returns "sbs" / "tb", or None when nothing (or an inverted layout) is
    declared or ffprobe cannot read the file.
    """
    return probe_metadata(src)["layout"]


def image_is_spherical(src: str) -> bool:
    """True when a still carries photo-sphere / VR180 (GPano) XMP."""
    try:
        with Image.open(src) as img:
            xmp = img.info.get("xmp") or img.info.get("XML:com.adobe.xmp") or b""
    except (OSError, ValueError):
        return False
    if isinstance(xmp, str):
        xmp = xmp.encode("utf-8", "ignore")
    return b"GPano:ProjectionType" in xmp or b"GPano:UsePanoramaViewer" in xmp


def _truthy(value) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes"}


def eye_halves(image: Image.Image, layout: str) -> tuple[Image.Image, Image.Image]:
    """Split a stereo frame into (left eye, right eye)."""
    w, h = image.size
    if layout == "sbs":
        half = w // 2
        return image.crop((0, 0, half, h)), image.crop((half, 0, half * 2, h))
    if layout == "tb":
        half = h // 2
        return image.crop((0, 0, w, half)), image.crop((0, half, w, half * 2))
    raise ValueError(f"not a stereo layout: {layout!r}")


def _detail_patch(eye: Image.Image) -> Image.Image:
    """Small grayscale patch with the low frequencies removed.

    Removing the blur keeps edges/texture (what two eyes share) and drops
    broad gradients (sky above ground), which the two halves of an ordinary
    wide frame also share.
    """
    gray = ImageOps.grayscale(eye).resize((PATCH, PATCH), Image.BILINEAR)
    blur = gray.filter(ImageFilter.GaussianBlur(4))
    detail = ImageChops.subtract(gray, blur, scale=1.0, offset=128)
    # A light blur on top tolerates sub-pixel disparity between the eyes.
    return detail.filter(ImageFilter.GaussianBlur(1.2))


def _shift_diff(a: Image.Image, b: Image.Image, shift: int) -> float:
    """Mean absolute difference of a vs b moved `shift` pixels to the right."""
    if shift >= 0:
        a_box = (shift, 0, PATCH, PATCH)
        b_box = (0, 0, PATCH - shift, PATCH)
    else:
        a_box = (0, 0, PATCH + shift, PATCH)
        b_box = (-shift, 0, PATCH, PATCH)
    diff = ImageChops.difference(a.crop(a_box), b.crop(b_box))
    return ImageStat.Stat(diff).mean[0]


def pair_score(left: Image.Image, right: Image.Image) -> float | None:
    """Similarity of two eye images in [0, 1]; None when too flat to judge.

    1.0 means the right eye is the left eye shifted horizontally; ~0 means
    the two halves are unrelated.
    """
    a = _detail_patch(left)
    b = _detail_patch(right)
    spread = min(ImageStat.Stat(a).stddev[0], ImageStat.Stat(b).stddev[0])
    if spread < MIN_DETAIL:
        return None
    best = min(_shift_diff(a, b, s) for s in range(-MAX_SHIFT, MAX_SHIFT + 1))
    # E|X - Y| of two independent equal-spread signals is ~1.13 * stddev.
    unrelated = 1.128 * spread
    return max(0.0, min(1.0, 1.0 - best / unrelated))


def image_score(image: Image.Image, layout: str) -> float | None:
    left, right = eye_halves(image.convert("RGB"), layout)
    return pair_score(left, right)


def _video_frames(src: str, duration: float | None, layout: str) -> list[Image.Image]:
    """Grab up to three small frames (15/50/85% through the clip)."""
    points = [0.15, 0.5, 0.85] if duration and duration > 0 else [None]
    # Keep 2 * PATCH * 2 on the long axis so each eye still has >= PATCH px.
    scale = f"scale={PATCH * 4}:{PATCH * 2}" if layout == "sbs" else f"scale={PATCH * 2}:{PATCH * 4}"
    frames: list[Image.Image] = []
    for point in points:
        seek = ["-ss", f"{duration * point:.3f}"] if point is not None else []
        cmd = [
            "ffmpeg", "-v", "error", *seek, "-i", src,
            "-frames:v", "1", "-vf", scale, "-f", "image2pipe", "-vcodec", "png", "-",
        ]
        try:
            p = subprocess.run(cmd, capture_output=True, timeout=30, creationflags=_NO_WINDOW)
        except (OSError, subprocess.SubprocessError):
            continue
        if p.returncode != 0 or not p.stdout:
            continue
        try:
            frames.append(Image.open(io.BytesIO(p.stdout)).convert("RGB"))
        except OSError:
            continue
    return frames


def detect_stereo(
    src: str,
    width: int | None,
    height: int | None,
    *,
    kind: str,
    duration: float | None = None,
) -> dict:
    """Classify a staged upload.

    Returns ``{"candidate", "detected", "method", "score"}``:

    * candidate — "sbs" / "tb" when the frame is exactly 2:1 / 1:2, else None.
    * detected  — True when metadata or content says the file is stereo.
    * method    — "metadata" / "content" when detected; "spherical" or
      "inverted" when metadata rules stereo out (no content pass); else None.
    * score     — content similarity (median over frames), or None.
    """
    candidate = candidate_layout(width, height)
    result = {"candidate": candidate, "detected": False, "method": None, "score": None}
    if candidate is None:
        return result

    if kind == "video":
        meta = probe_metadata(src)
        if meta["spherical"]:
            result["method"] = "spherical"
            return result
        if meta["inverted"]:
            result["method"] = "inverted"
            return result
        if meta["layout"] == candidate:
            result.update(detected=True, method="metadata")
            return result
    elif image_is_spherical(src):
        result["method"] = "spherical"
        return result

    scores: list[float] = []
    try:
        if kind == "video":
            frames = _video_frames(src, duration, candidate)
        else:
            with Image.open(src) as img:
                img.draft("RGB", (PATCH * 4, PATCH * 4))
                # Split the still as shown, like the left-eye crop does.
                frames = [ImageOps.exif_transpose(img).convert("RGB")]
        for frame in frames:
            score = image_score(frame, candidate)
            if score is not None:
                scores.append(score)
    except (OSError, ValueError):
        scores = []

    if scores:
        score = round(median(scores), 3)
        result["score"] = score
        if score >= CONTENT_THRESHOLD:
            result.update(detected=True, method="content")
    return result
