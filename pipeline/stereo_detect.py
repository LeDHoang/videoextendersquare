"""Detect full side-by-side (SBS) and full top-bottom (TB) stereoscopic media.

A stereo post keeps one image per eye, each 1:1, 16:9 or 9:16
(STEREO_FRAME_SHAPES):

* ``sbs`` — left eye in the left half: a 2:1, 32:9 or 9:8 frame.
* ``tb``  — left eye in the top half: a 1:2, 9:32 or 8:9 frame.

Detection only proposes 2:1, 32:9, 1:2 and 9:32. A near-square 9:8 / 8:9
frame is an ordinary photo far more often, so those stay manual-only.

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
   grayscale patch and compared under a few horizontal shifts. A match that
   is only ever best at shift 0 has no parallax: the halves are one picture
   twice (a duplicated or re-graded split screen), not two eyes.

Only Pillow + ffmpeg/ffprobe are needed.
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
from statistics import median

from PIL import Image, ImageChops, ImageFilter, ImageOps, ImageStat

from pipeline.utils import ASPECT_TOLERANCE, parse_aspect

STEREO_LAYOUTS = ("mono", "sbs", "tb")

# (layout, eye shape) -> tolerance on the eye's aspect. Square eyes stay an
# exact 2:1 / 1:2 frame; the other shapes absorb coded sizes such as 1088.
STEREO_FRAME_SHAPES = {
    ("sbs", "1:1"): 0.0,
    ("sbs", "16:9"): ASPECT_TOLERANCE,
    ("sbs", "9:16"): ASPECT_TOLERANCE,  # 9:8 frame: manual only
    ("tb", "1:1"): 0.0,
    ("tb", "16:9"): ASPECT_TOLERANCE,  # 8:9 frame: manual only
    ("tb", "9:16"): ASPECT_TOLERANCE,
}
# The shapes detection may propose on its own.
_AUTO_SHAPES = (("sbs", "1:1"), ("sbs", "16:9"), ("tb", "1:1"), ("tb", "9:16"))

# Edge length of each eye patch the content check compares (the short side
# for 16:9 / 9:16 eyes, whose patch keeps the eye's shape).
PATCH = 128
EYE_PATCHES = {"1:1": (PATCH, PATCH), "16:9": (228, PATCH), "9:16": (PATCH, 228)}
# Horizontal shifts (in patch pixels) tried when aligning the two eyes.
MAX_SHIFT = 12
# Content score at or above which a candidate counts as stereo. Calibrated
# on real 7680x3840 SBS reels (0.81-0.98) against ordinary 2:1 / 1:2 crops
# and stretches (0.00-0.33) and a synthetic test pattern (0.64). Split-screen
# edits (scripts/dev/experiment_stereo_threshold.py, 2026-10-18): two clips
# 0.01-0.17, mirrored 0.27-0.36, zoomed 0.18-0.33, the same clip 0.2-2 s
# apart 0.00-0.71; a duplicate (0.97-0.98) or re-graded copy (0.83-0.89)
# scores like stereo but always aligns at shift 0, which the guard catches.
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


def _frame_holds(layout: str, eye: str, w: int, h: int) -> bool:
    """True when a w x h frame holds two *eye*-shaped eyes in *layout*."""
    tolerance = STEREO_FRAME_SHAPES[(layout, eye)]
    if tolerance == 0.0:
        num, den = (int(n) for n in eye.split(":"))
        return w * den == 2 * h * num if layout == "sbs" else 2 * w * den == h * num
    eye_w, eye_h = (w / 2, h) if layout == "sbs" else (w, h / 2)
    return abs((eye_w / eye_h) / parse_aspect(eye) - 1) <= tolerance


def frame_eye_shape(layout: str, width: int | None, height: int | None) -> str | None:
    """The eye shape ("1:1" / "16:9" / "9:16") a frame holds in *layout*, else None."""
    try:
        w, h = int(width or 0), int(height or 0)
    except (TypeError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None
    for frame_layout, eye in STEREO_FRAME_SHAPES:
        if frame_layout == layout and _frame_holds(layout, eye, w, h):
            return eye
    return None


def candidate_layout(width: int | None, height: int | None) -> str | None:
    """Return the stereo layout a 2:1 / 32:9 / 1:2 / 9:32 frame could be, else None."""
    for layout, eye in _AUTO_SHAPES:
        if frame_eye_shape(layout, width, height) == eye:
            return layout
    return None


def layout_matches(layout: str, width: int | None, height: int | None) -> bool:
    """True when a frame of width x height can hold the given stereo layout."""
    if layout == "mono":
        return True
    return frame_eye_shape(layout, width, height) is not None


def eye_size(layout: str, width: int, height: int) -> tuple[int, int]:
    """Pixel size of one eye for a stereo layout (the full frame for mono)."""
    if layout == "sbs":
        return width // 2, height
    if layout == "tb":
        return width, height // 2
    return width, height


def probe_metadata(src: str) -> dict:
    """Stereo/projection facts the container declares for its first video stream.

    Returns ``{"layout", "inverted", "spherical", "projection"}``: layout is
    "sbs" / "tb" (or None), inverted is True when a right-eye-first layout is
    declared, spherical is True for 360 / VR180 projection metadata, and
    projection is the playable kind the "Spherical Mapping" side data names
    ("equirect360" / "equirect180", see ``_side_data_projection``) or None.
    Unreadable files report nothing.
    """
    found = {"layout": None, "inverted": False, "spherical": False, "projection": None}
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
            found["projection"] = _side_data_projection(side, stream.get("width"))
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


def _side_data_projection(side: dict, width) -> str | None:
    """Playable projection for one ffprobe "Spherical Mapping" entry.

    "equirectangular" is a full 360 x 180 panorama. VR180 files declare
    "tiled equirectangular" with half the horizontal span cropped away
    (ffprobe prints the crop as bound_left / bound_right pixels), or Apple's
    "half equirectangular". Partial panoramas, cubemaps and fisheye frames
    have no player path, so they report None.
    """
    name = str(side.get("projection", "")).strip().lower()
    if name == "equirectangular":
        return "equirect360"
    if name == "half equirectangular":
        return "equirect180"
    if name != "tiled equirectangular":
        return None
    try:
        width = int(width)
        cropped = int(side.get("bound_left", 0)) + int(side.get("bound_right", 0))
    except (TypeError, ValueError):
        return None
    if width <= 0 or cropped < 0:
        return None
    shown = width / (width + cropped)
    if shown >= 0.95:
        return "equirect360"
    if abs(shown - 0.5) <= 0.05:
        return "equirect180"
    return None


def detect_projection(src: str) -> dict:
    """Projection a staged video declares: ``{"projection", "method"}``.

    projection is "equirect360" / "equirect180" from container metadata,
    else "flat". method is "metadata" when the container names a playable
    projection, "unsupported" for spherical metadata the player cannot show
    (cubemap, fisheye, partial panorama, a bare projection tag), else None.
    Outpainted panoramas carry no metadata, so the upload form lets the
    user pick the projection by hand.
    """
    meta = probe_metadata(src)
    if meta["projection"]:
        return {"projection": meta["projection"], "method": "metadata"}
    return {"projection": "flat", "method": "unsupported" if meta["spherical"] else None}


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


def _detail_patch(eye: Image.Image, size: tuple[int, int] = (PATCH, PATCH)) -> Image.Image:
    """Small grayscale patch with the low frequencies removed.

    Removing the blur keeps edges/texture (what two eyes share) and drops
    broad gradients (sky above ground), which the two halves of an ordinary
    wide frame also share.
    """
    gray = ImageOps.grayscale(eye).resize(size, Image.BILINEAR)
    blur = gray.filter(ImageFilter.GaussianBlur(4))
    detail = ImageChops.subtract(gray, blur, scale=1.0, offset=128)
    # A light blur on top tolerates sub-pixel disparity between the eyes.
    return detail.filter(ImageFilter.GaussianBlur(1.2))


def _shift_diff(a: Image.Image, b: Image.Image, shift: int) -> float:
    """Mean absolute difference of a vs b moved `shift` pixels to the right."""
    w, h = a.size
    if shift >= 0:
        a_box = (shift, 0, w, h)
        b_box = (0, 0, w - shift, h)
    else:
        a_box = (0, 0, w + shift, h)
        b_box = (-shift, 0, w, h)
    diff = ImageChops.difference(a.crop(a_box), b.crop(b_box))
    return ImageStat.Stat(diff).mean[0]


def pair_match(left: Image.Image, right: Image.Image, eye: str = "1:1") -> tuple[float, int] | None:
    """(similarity in [0, 1], best shift) of two eye images; None when too flat.

    1.0 means the right eye is the left eye shifted horizontally; ~0 means
    the two halves are unrelated. The shift is in patch pixels. *eye* is
    the eye's shape, which the patch keeps.
    """
    a = _detail_patch(left, EYE_PATCHES[eye])
    b = _detail_patch(right, EYE_PATCHES[eye])
    spread = min(ImageStat.Stat(a).stddev[0], ImageStat.Stat(b).stddev[0])
    if spread < MIN_DETAIL:
        return None
    diffs = {s: _shift_diff(a, b, s) for s in range(-MAX_SHIFT, MAX_SHIFT + 1)}
    shift = min(diffs, key=diffs.get)
    # E|X - Y| of two independent equal-spread signals is ~1.13 * stddev.
    unrelated = 1.128 * spread
    return max(0.0, min(1.0, 1.0 - diffs[shift] / unrelated)), shift


def pair_score(left: Image.Image, right: Image.Image) -> float | None:
    match = pair_match(left, right)
    return None if match is None else match[0]


def image_match(image: Image.Image, layout: str, eye: str = "1:1") -> tuple[float, int] | None:
    left, right = eye_halves(image.convert("RGB"), layout)
    return pair_match(left, right, eye)


def image_score(image: Image.Image, layout: str, eye: str = "1:1") -> float | None:
    match = image_match(image, layout, eye)
    return None if match is None else match[0]


def _video_frames(src: str, duration: float | None, layout: str, eye: str = "1:1") -> list[Image.Image]:
    """Grab up to three small frames (15/50/85% through the clip)."""
    points = [0.15, 0.5, 0.85] if duration and duration > 0 else [None]
    # Keep twice the eye patch per eye, so each eye still has >= its patch in px.
    pw, ph = EYE_PATCHES[eye]
    scale = f"scale={pw * 4}:{ph * 2}" if layout == "sbs" else f"scale={pw * 2}:{ph * 4}"
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

    * candidate — "sbs" for a 2:1 / 32:9 frame, "tb" for 1:2 / 9:32, else None.
    * detected  — True when metadata or content says the file is stereo.
    * method    — "metadata" / "content" when detected; "spherical" or
      "inverted" when metadata rules stereo out (no content pass);
      "no_parallax" when the halves match but never with a horizontal
      offset (one picture twice); else None.
    * score     — content similarity (median over frames), or None.
    """
    candidate = candidate_layout(width, height)
    result = {"candidate": candidate, "detected": False, "method": None, "score": None}
    if candidate is None:
        return result
    # The content compare runs at the eye's own shape.
    eye = frame_eye_shape(candidate, width, height)

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
    shifts: list[int] = []
    try:
        if kind == "video":
            frames = _video_frames(src, duration, candidate, eye)
        else:
            with Image.open(src) as img:
                img.draft("RGB", (PATCH * 4, PATCH * 4))
                # Split the still as shown, like the left-eye crop does.
                frames = [ImageOps.exif_transpose(img).convert("RGB")]
        for frame in frames:
            match = image_match(frame, candidate, eye)
            if match is not None:
                scores.append(match[0])
                shifts.append(match[1])
    except (OSError, ValueError):
        scores, shifts = [], []

    if scores:
        score = round(median(scores), 3)
        result["score"] = score
        if score >= CONTENT_THRESHOLD:
            # Real eyes differ by parallax somewhere; identical alignment in
            # every frame is a duplicated (or re-graded) split screen.
            if any(shifts):
                result.update(detected=True, method="content")
            else:
                result["method"] = "no_parallax"
    return result
