"""Local 2D -> stereoscopic SBS converter ("spatialize", user-facing "Make 3D").

W8T recipe (validated against Owl3D in the owdl3d-reword study, ledger §4.14):
  1. Decode frames at depth working resolution (rawvideo pipe, one output
     frame per coded frame) and find scene cuts: ffmpeg's scene score, plus
     colour-histogram jumps for cuts between dark shots.
  2. Per shot, re-decode at depth resolution and run Video-Depth-Anything-Small,
     so its temporal window never spans a cut (vendored in pipeline/third_party;
     lazy torch import; device cuda > mps > cpu; checkpoint from Hugging Face on
     first use). Each shot is normalized to nearness in [0, 1] by its
     2nd..98th percentile.
  3. Decode the same shot at render size and, per frame: grow near depth with a 5x5
     dilate at depth resolution, upsample bilinearly, forward-splat the left
     view into the right eye (softmax weights favour near pixels), fill
     disocclusions with the nearest valid pixel. Far content shifts right by
     MAX_SHIFT of the width (behind the screen) and the nearest content left
     by POP_OUT (slightly in front of it).
  4. Crop the parallax edge strip from all four sides of both eyes, hstack and
     pipe into libx264 (bt709, faststart), with the source audio and timing.

The render steps are numpy + OpenCV only (no torch), so they run on any CPU
and in CI. No cloud calls, no temp frame files: frames stream through pipes.
"""

import itertools
import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
import time
from functools import lru_cache

import numpy as np

from pipeline.utils import display_size, get_video_codec, stream_rotation

MODEL_DIR = os.path.join(".models")
DEPTH_ENCODER = "vits"  # Video-Depth-Anything-Small: Apache-2.0 code and weights (vitb/vitl are not)

MAX_SHIFT = 0.013867        # far-plane parallax as a fraction of the eye width (W8T)
POP_OUT = 0.006             # crossed parallax of the nearest content (chosen over W8T's 0 in a Quest A/B)
NEAR_IMPORTANCE = 20.0      # softmax splat weight exp(20 * nearness): nearer pixels win overlaps
EYE_CAP = 2048              # px per eye; the VR player's stereo canvas (VR_STEREO_EYE_CAP)
MAX_VIDEO_SECONDS = 60      # a whole shot's depth is held in memory
SCENE_THRESHOLD = 0.4       # ffmpeg scene score that starts a new shot
HIST_CUT = 0.5              # colour-histogram jump that also starts one (dark cuts ffmpeg rates low)...
HIST_CUT_RATIO = 3.0        # ...when it is this many times the local median jump (strobing stays high)
HIST_CUT_WINDOW = 15        # frames either side for that median
MIN_SHOT_FRAMES = 12        # shorter shots merge into a neighbour (flashes, false cuts)
RENDER_REPORT_EVERY = 30    # frames between progress reports (cancel checks)

_INFER_LOCK = threading.Lock()  # one depth pass at a time per process (MPS / VRAM)


class SpatializeError(RuntimeError):
    pass


# ─── Depth model ──────────────────────────────────────────────────────────

def _pick_device():
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


@lru_cache(maxsize=1)
def _depth_model():
    """Load the small checkpoint once per process: (model, device)."""
    try:
        import torch
        from pipeline.third_party.video_depth_anything.video_depth import VideoDepthAnything
    except ImportError as ex:
        raise SpatializeError(
            "3D conversion needs PyTorch and OpenCV. Install with:\n"
            "  pip install -r requirements-3d.txt"
        ) from ex

    ckpt_name = f"video_depth_anything_{DEPTH_ENCODER}.pth"
    ckpt_path = os.path.join(MODEL_DIR, ckpt_name)
    if not os.path.exists(ckpt_path):
        os.makedirs(MODEL_DIR, exist_ok=True)
        try:
            from huggingface_hub import hf_hub_download
            downloaded = hf_hub_download(
                repo_id="depth-anything/Video-Depth-Anything-Small",
                filename=ckpt_name,
                local_dir=MODEL_DIR,
            )
            if os.path.abspath(downloaded) != os.path.abspath(ckpt_path):
                shutil.copyfile(downloaded, ckpt_path)
        except Exception:
            # Direct fallback URL (same layout as the HF resolve endpoint).
            import urllib.request
            url = ("https://huggingface.co/depth-anything/"
                   f"Video-Depth-Anything-Small/resolve/main/{ckpt_name}")
            part = ckpt_path + ".part"
            urllib.request.urlretrieve(url, part)
            os.replace(part, ckpt_path)

    model = VideoDepthAnything(encoder="vits", features=64, out_channels=[48, 96, 192, 384])
    state = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    model.load_state_dict(state, strict=True)
    device = _pick_device()
    return model.to(device).eval(), device


def _depth_video(frames: list, fps: float):
    """(raw depth (n, h, w) float32, device) for one shot; higher = nearer.

    The tests replace this and _depth_image with stubs."""
    with _INFER_LOCK:
        model, device = _depth_model()
        # fp16 autocast gives all-NaN depth on MPS; only CUDA gets it.
        depth, _ = model.infer_video_depth(frames, fps, input_size=518, device=device, fp32=device != "cuda")
    return depth, device


def _depth_image(rgb: np.ndarray):
    """(raw depth (h, w) float32, device) for one still: a single T=1 forward
    pass with the preprocessing infer_video_depth applies to video frames."""
    import cv2
    import torch
    import torch.nn.functional as F
    from torchvision.transforms import Compose
    from pipeline.third_party.video_depth_anything.util.transform import NormalizeImage, PrepareForNet, Resize

    h, w = rgb.shape[:2]
    input_size = 518
    ratio = max(h, w) / min(h, w)
    if ratio > 1.78:  # mirrors infer_video_depth
        input_size = round(int(input_size * 1.777 / ratio) / 14) * 14
    transform = Compose([
        Resize(width=input_size, height=input_size, resize_target=False, keep_aspect_ratio=True,
               ensure_multiple_of=14, resize_method="lower_bound", image_interpolation_method=cv2.INTER_CUBIC),
        NormalizeImage(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        PrepareForNet(),
    ])
    x = torch.from_numpy(transform({"image": rgb.astype(np.float32) / 255.0})["image"])[None, None]
    with _INFER_LOCK:
        model, device = _depth_model()
        with torch.no_grad():
            depth = model.forward(x.to(device))
        depth = F.interpolate(depth.float().flatten(0, 1).unsqueeze(1), size=(h, w),
                              mode="bilinear", align_corners=True)
    return depth[0, 0].cpu().numpy(), device


# ─── Depth conditioning ───────────────────────────────────────────────────

def shot_range(raw: np.ndarray) -> tuple[float, float]:
    """2nd/98th percentile of a shot's raw depth (n, h, w), every 4th pixel."""
    sample = np.nan_to_num(raw[:, ::4, ::4], nan=0.0, posinf=0.0, neginf=0.0)
    lo, hi = np.percentile(sample, (2, 98))
    return float(lo), float(hi)


def normalize_depth(raw: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """Raw depth -> nearness in [0, 1] (1 = nearest), fp16 to halve memory."""
    raw = np.nan_to_num(raw, nan=0.0, posinf=0.0, neginf=0.0)
    return np.clip((raw - lo) / max(hi - lo, 1e-6), 0.0, 1.0).astype(np.float16)


@lru_cache(maxsize=8)
def _bilinear_taps(n_in: int, n_out: int):
    """Source indices and weights for 1-D bilinear resampling with
    align_corners=True (the end samples map onto the end samples)."""
    pos = np.arange(n_out, dtype=np.float64) * ((n_in - 1) / max(n_out - 1, 1))
    i0 = np.clip(np.floor(pos).astype(np.intp), 0, max(n_in - 2, 0))
    i1 = np.minimum(i0 + 1, n_in - 1)
    return i0, i1, (pos - i0).astype(np.float32)


def condition_depth(near: np.ndarray, width: int, height: int) -> np.ndarray:
    """Grow near depth with a 5x5 dilate at depth resolution (silhouette edge
    pixels stay with the foreground), then upsample bilinearly to (height, width)."""
    import cv2
    d = cv2.dilate(near.astype(np.float32), np.ones((5, 5), np.uint8))
    y0, y1, ay = _bilinear_taps(d.shape[0], height)
    x0, x1, ax = _bilinear_taps(d.shape[1], width)
    rows = d[y0] * (1 - ay)[:, None] + d[y1] * ay[:, None]
    return np.clip(rows[:, x0] * (1 - ax) + rows[:, x1] * ax, 0.0, 1.0)


# ─── Right-eye render ─────────────────────────────────────────────────────

def softsplat(img: np.ndarray, fx: np.ndarray, importance: np.ndarray):
    """Forward softmax splat with horizontal flow: each source pixel lands at
    x + fx, split linearly between its two neighbours and weighted by
    exp(importance - max). Returns (out (H,W,3) float32, NaN at holes; den)."""
    H, W = fx.shape
    x = np.arange(W, dtype=np.float32)[None, :] + fx.astype(np.float32)
    x0 = np.floor(x)
    a = (x - x0).ravel()
    x0 = x0.astype(np.intp).ravel()
    w = np.exp(importance - importance.max()).astype(np.float32).ravel()
    rows = np.repeat(np.arange(H, dtype=np.intp) * W, W)
    src = img.reshape(-1, 3).astype(np.float32)
    idx, wt, col = [], [], []
    for xi, wi in ((x0, 1 - a), (x0 + 1, a)):
        ok = (xi >= 0) & (xi < W)
        idx.append(rows[ok] + xi[ok])
        wt.append((w * wi)[ok])
        col.append(src[ok])
    idx, wt, col = np.concatenate(idx), np.concatenate(wt), np.concatenate(col)
    den = np.bincount(idx, weights=wt, minlength=H * W)
    out = np.empty((H * W, 3), np.float32)
    for c in range(3):
        out[:, c] = np.bincount(idx, weights=wt * col[:, c], minlength=H * W)
    hole = den <= 0
    out[~hole] /= den[~hole, None]
    out[hole] = np.nan
    return out.reshape(H, W, 3), den.reshape(H, W)


def nearest_fill(out: np.ndarray) -> np.ndarray:
    """Fill NaN pixels with the nearest valid pixel (Euclidean)."""
    import cv2
    hole = np.isnan(out[..., 0])
    if not hole.any():
        return out
    _, lab = cv2.distanceTransformWithLabels(hole.astype(np.uint8), cv2.DIST_L2, 5,
                                             labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(~hole)
    hy, hx = np.nonzero(hole)
    k = lab[hy, hx] - 1
    res = out.copy()
    res[hy, hx] = out[ys[k], xs[k]]
    return res


def render_right_eye(left: np.ndarray, near: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """Right-eye view of *left* (H,W,3 uint8) given nearness (H,W) in [0, 1].

    Far content (0) shifts right by MAX_SHIFT * W * strength, behind the
    screen. The nearest (1) shifts left by POP_OUT * W * strength, in front
    of it. The screen plane sits at nearness MAX_SHIFT / (MAX_SHIFT + POP_OUT)."""
    W = left.shape[1]
    fx = (W * strength) * (MAX_SHIFT - (MAX_SHIFT + POP_OUT) * near)
    out, _ = softsplat(left, fx, NEAR_IMPORTANCE * near)
    return np.clip(np.round(nearest_fill(out)), 0, 255).astype(np.uint8)


def _even(x: float) -> int:
    return max(2, int(x) // 2 * 2)


def eye_geometry(width: int, height: int, strength: float = 1.0) -> tuple[int, int, int]:
    """(render_w, render_h, crop) for a source of this display size.

    Frames render at render size, then *crop* px come off all four sides of
    both eyes: the right eye's left edge has no source pixels for up to
    MAX_SHIFT * width, and cropping every side keeps a square eye square. That
    crop also covers its right edge, empty for up to POP_OUT * width.
    The crop is even so the eyes keep the source's 4:2:0 chroma grid (an odd
    crop resamples chroma by half a sample: ~15 dB worse on saturated edges).
    Each output eye is render - 2 * crop: even and at most EYE_CAP."""
    f = MAX_SHIFT * strength
    scale = min(1.0, EYE_CAP / ((1 - 2 * f) * max(width, height)))
    rw, rh = _even(width * scale), _even(height * scale)
    crop = math.ceil(f * max(rw, rh))
    return rw, rh, crop + crop % 2


def colour_histogram(rgb: np.ndarray) -> np.ndarray:
    """16x8x8 HSV histogram of an RGB frame, normalized, for histogram_cuts."""
    import cv2

    hist = cv2.calcHist([cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)], [0, 1, 2], None,
                        [16, 8, 8], [0, 180, 0, 256, 0, 256])
    return cv2.normalize(hist, hist).flatten()


def histogram_cuts(hists: list) -> list[int]:
    """Frames that start a new shot by colour: the histogram distance to the
    previous frame reaches HIST_CUT and HIST_CUT_RATIO x the median distance
    within HIST_CUT_WINDOW frames, the new colours are still there two frames
    on, and they were not there three frames back (so neither a 1-2 frame
    flash nor its end counts). Catches cuts between dark shots, which
    ffmpeg's scene score rates well under SCENE_THRESHOLD."""
    import cv2

    def dist(a, b):
        return cv2.compareHist(hists[a], hists[b], cv2.HISTCMP_BHATTACHARYYA)

    n = len(hists)
    d = np.zeros(n)
    for i in range(1, n):
        d[i] = dist(i - 1, i)
    cuts = []
    for i in range(1, n):
        around = np.concatenate([d[max(1, i - HIST_CUT_WINDOW):i], d[i + 1:i + 1 + HIST_CUT_WINDOW]])
        if (d[i] >= HIST_CUT and around.size and d[i] > HIST_CUT_RATIO * np.median(around)
                and dist(i - 1, min(i + 2, n - 1)) >= HIST_CUT
                and dist(max(i - 3, 0), i) >= HIST_CUT / 2):
            cuts.append(i)
    return cuts


def split_shots(scores: dict[int, float], n_frames: int,
                threshold: float = SCENE_THRESHOLD, min_frames: int = MIN_SHOT_FRAMES,
                extra_cuts=()) -> list[tuple[int, int]]:
    """[start, end) frame ranges, cut where the scene score reaches
    *threshold* or at *extra_cuts* (histogram_cuts). A shot shorter than
    *min_frames* merges into the one before it (the first shot into the next)."""
    cuts = {i for i in range(1, n_frames) if scores.get(i, 0.0) >= threshold}
    cuts.update(i for i in extra_cuts if 0 < i < n_frames)
    bounds = [0] + sorted(cuts) + [n_frames]
    merged: list[list[int]] = []
    for a, b in zip(bounds, bounds[1:]):
        if merged and (b - a < min_frames or merged[-1][1] - merged[-1][0] < min_frames):
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


# ─── FFmpeg helpers ───────────────────────────────────────────────────────

def _probe(video_path: str) -> dict:
    """Display size, exact frame rate, start offset, colour matrix, duration
    and audio codec of a video."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", video_path],
            capture_output=True, text=True, check=True, timeout=15,
        ).stdout
        data = json.loads(out)
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError) as ex:
        raise SpatializeError(f"Could not read {os.path.basename(video_path)}: {ex}") from ex
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not video or not video.get("width") or not video.get("height"):
        raise SpatializeError(f"{os.path.basename(video_path)} has no video stream")
    fmt = data.get("format") or {}

    def _num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0

    width, height = display_size(int(video["width"]), int(video["height"]), stream_rotation(video))
    rate = video.get("avg_frame_rate") or ""
    num, _, den = rate.partition("/")
    if not (num.isdigit() and den.isdigit() and int(num) > 0 and int(den) > 0):
        rate = video.get("r_frame_rate") or "30/1"
        num, _, den = rate.partition("/")
    # The video stream can start after the container (audio pre-roll); the
    # output video gets the same offset so A/V sync survives.
    offset = max(0.0, _num(video.get("start_time")) - _num(fmt.get("start_time")))
    matrix = {"smpte170m": "bt601", "bt470bg": "bt601", "fcc": "fcc", "smpte240m": "smpte240m",
              "bt2020nc": "bt2020", "bt2020c": "bt2020"}.get(video.get("color_space"), "bt709")  # untagged: HD
    return {
        "width": width, "height": height, "rate": rate, "fps": float(num) / float(den or 1),
        "offset": offset, "matrix": matrix,
        "duration": _num(video.get("duration")) or _num(fmt.get("duration")),
        "audio": audio.get("codec_name") if audio else None,
    }


def _decode(video_path: str, width: int, height: int, matrix: str, extra_filters: str = ""):
    """Yield rgb24 frames (H,W,3 uint8), exactly one per coded frame. (The
    default constant-rate output repeats frame 0 when the video stream starts
    after the container, which put every right eye a few frames late.)"""
    vf = f"scale={width}:{height}:in_color_matrix={matrix},format=rgb24{extra_filters}"
    with tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(
            ["ffmpeg", "-v", "error", "-nostdin", "-i", video_path, "-map", "0:v:0",
             "-fps_mode", "passthrough", "-vf", vf, "-f", "rawvideo", "-"],
            stdout=subprocess.PIPE, stderr=err,
        )
        frame_bytes = width * height * 3
        try:
            while True:
                buf = proc.stdout.read(frame_bytes)
                if len(buf) < frame_bytes:
                    break
                yield np.frombuffer(buf, dtype=np.uint8).reshape(height, width, 3)
            rc = proc.wait(timeout=60)
            if rc != 0:
                err.seek(0)
                raise SpatializeError(f"Decode failed (rc={rc}): {err.read()[-500:].decode(errors='replace')}")
        finally:
            proc.stdout.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait()


def _read_scene_scores(path: str) -> dict[int, float]:
    """Parse ffmpeg `metadata=print` output: a frame:N line, then that
    frame's lavfi.scene_score=X line."""
    scores, frame = {}, None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("frame:"):
                frame = int(line.split()[0].partition(":")[2])
            elif line.startswith("lavfi.scene_score=") and frame is not None:
                scores[frame] = float(line.partition("=")[2])
    return scores


def _scaled_size(width: int, height: int, max_dim: int) -> tuple[int, int]:
    scale = max_dim / max(width, height)
    if scale >= 1.0:
        return width, height
    return max(2, int(round(width * scale / 2)) * 2), max(2, int(round(height * scale / 2)) * 2)


# ─── Main entries ─────────────────────────────────────────────────────────

def process_video_spatial(
    video_path: str,
    output_path: str,
    status_callback=None,
    strength: float = 1.0,
    half_sbs: bool = False,
    depth_max_dim: int = 518,
    max_seconds: float | None = MAX_VIDEO_SECONDS,
) -> tuple[str, dict]:
    """Convert one monocular video to a side-by-side stereo H.264 MP4.

    Returns (output_path, metrics). Depth and render go one shot at a time,
    so memory holds one shot's depth-resolution frames (about 0.8 MB each at
    518 px) and fp16 nearness maps; full-size frames stream through pipes."""
    import cv2

    def log(msg):
        if status_callback:
            status_callback(msg)

    t0 = time.time()
    info = _probe(video_path)
    width, height = info["width"], info["height"]
    if max_seconds is not None and not info["duration"] > 0:
        raise SpatializeError("Video duration is unknown; 3D conversion needs a duration")
    if max_seconds is not None and info["duration"] > max_seconds:
        raise SpatializeError(f"Video is {info['duration']:.0f}s; 3D conversion takes up to {max_seconds:.0f}s")
    log(f"Analyzing source: {os.path.basename(video_path)} ({width}x{height}, {info['duration']:.1f}s)...")

    # Pass 1: scene scores and colour histograms at depth resolution -> shots.
    dw, dh = _scaled_size(width, height, depth_max_dim)
    tmp_dir = tempfile.mkdtemp(prefix="spatial-")
    try:
        scene_file = os.path.join(tmp_dir, "scenes.txt")
        hists = [colour_histogram(f) for f in _decode(
            video_path, dw, dh, info["matrix"],
            f",select='gte(scene\\,0)',metadata=print:key=lavfi.scene_score:file='{scene_file}'")]
        scores = _read_scene_scores(scene_file) if os.path.exists(scene_file) else {}
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    if not hists:
        raise SpatializeError("Decoder produced no frames")
    n_frames = len(hists)
    shots = split_shots(scores, n_frames, extra_cuts=histogram_cuts(hists))
    del hists

    # Pass 2, per shot: depth-size frames -> depth; render-size frames ->
    # right eye -> crop -> hstack -> encode.
    rw, rh, crop = eye_geometry(width, height, strength)
    eye_w, eye_h = rw - 2 * crop, rh - 2 * crop
    if half_sbs:
        eye_w = _even(eye_w // 2)
    out_w, out_h = eye_w * 2, eye_h

    # setpts restores a late video start (-itsoffset is ignored on a raw pipe).
    vf = f"setpts=PTS+{info['offset']:.6f}/TB," if info["offset"] > 0 else ""
    vf += ("scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,"
           "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv")
    cmd = ["ffmpeg", "-y", "-v", "error", "-nostdin",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{out_w}x{out_h}", "-r", info["rate"],
           "-i", "-", "-i", video_path, "-map", "0:v:0"]
    if info["audio"]:
        audio = ["copy"] if info["audio"] in ("aac", "mp3") else ["aac", "-b:a", "192k"]
        cmd += ["-map", "1:a:0", "-c:a", *audio]
    cmd += ["-vf", vf, "-fps_mode", "passthrough",
            "-c:v", "libx264", "-crf", "20", "-preset", "superfast",
            "-movflags", "+faststart", output_path]

    encoded = 0
    device = "?"
    ok = False
    depth_frames = _decode(video_path, dw, dh, info["matrix"])
    render_frames = _decode(video_path, rw, rh, info["matrix"])
    with tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=err)
        try:
            for k, (a, b) in enumerate(shots, 1):
                log(f"Estimating depth (shot {k}/{len(shots)}, {b - a} frames)...")
                shot = list(itertools.islice(depth_frames, b - a))
                if len(shot) != b - a:
                    raise SpatializeError("Decoder returned fewer frames on the second pass")
                raw, device = _depth_video(shot, info["fps"])
                del shot
                near = normalize_depth(raw, *shot_range(raw)).astype(np.float16)
                del raw
                log(f"Rendering 3D: {encoded}/{n_frames} frames...")
                # A short last read keeps the source's own frame count.
                for i, frame in enumerate(itertools.islice(render_frames, b - a)):
                    d = condition_depth(near[i], rw, rh)
                    right = render_right_eye(frame, d, strength)[crop:rh - crop, crop:rw - crop]
                    left = frame[crop:rh - crop, crop:rw - crop]
                    if half_sbs:
                        left = cv2.resize(left, (eye_w, eye_h), interpolation=cv2.INTER_AREA)
                        right = cv2.resize(right, (eye_w, eye_h), interpolation=cv2.INTER_AREA)
                    proc.stdin.write(np.concatenate([left, right], axis=1).tobytes())
                    encoded += 1
                    if encoded % RENDER_REPORT_EVERY == 0:
                        log(f"Rendering 3D: {encoded}/{n_frames} frames...")
                del near
            proc.stdin.close()
            rc = proc.wait(timeout=600)
            if rc != 0:
                err.seek(0)
                raise SpatializeError(f"Encode failed (rc={rc}): {err.read()[-500:].decode(errors='replace')}")
            ok = True
        except BrokenPipeError:
            proc.wait(timeout=60)
            err.seek(0)
            raise SpatializeError(f"Encoder died early: {err.read()[-500:].decode(errors='replace')}")
        finally:
            depth_frames.close()
            render_frames.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            if not ok and os.path.exists(output_path):
                os.remove(output_path)

    metrics = {
        "total_time": round(time.time() - t0, 2),
        "frames": encoded,
        "shots": len(shots),
        "resolution": f"{out_w}x{out_h}",
        "format": "half-SBS" if half_sbs else "full-SBS",
        "engine": f"W8T ({DEPTH_ENCODER}, {device})",
    }
    log(f"Done: {output_path} ({metrics['total_time']}s)")
    return output_path, metrics


def process_image_spatial(
    image_path: str,
    output_path: str,
    status_callback=None,
    strength: float = 1.0,
) -> tuple[str, dict]:
    """Convert one still to a side-by-side stereo JPEG. Returns (output_path, metrics)."""
    import cv2
    from PIL import Image, ImageOps

    def log(msg):
        if status_callback:
            status_callback(msg)

    t0 = time.time()
    try:
        with Image.open(image_path) as img:
            rgb = np.asarray(ImageOps.exif_transpose(img).convert("RGB"))
    except (OSError, ValueError) as ex:
        raise SpatializeError(f"Could not read {os.path.basename(image_path)}: {ex}") from ex
    height, width = rgb.shape[:2]
    log(f"Analyzing source: {os.path.basename(image_path)} ({width}x{height})...")

    log("Estimating depth...")
    dw, dh = _scaled_size(width, height, 518)
    small = rgb if (dw, dh) == (width, height) else cv2.resize(rgb, (dw, dh), interpolation=cv2.INTER_AREA)
    raw, device = _depth_image(small)
    near = normalize_depth(raw[None], *shot_range(raw[None]))[0]

    log("Rendering 3D...")
    rw, rh, crop = eye_geometry(width, height, strength)
    frame = rgb if (rw, rh) == (width, height) else cv2.resize(rgb, (rw, rh), interpolation=cv2.INTER_AREA)
    right = render_right_eye(frame, condition_depth(near, rw, rh), strength)
    sbs = np.concatenate([frame[crop:rh - crop, crop:rw - crop], right[crop:rh - crop, crop:rw - crop]], axis=1)
    Image.fromarray(sbs).save(output_path, "JPEG", quality=95)

    metrics = {
        "total_time": round(time.time() - t0, 2),
        "frames": 1,
        "resolution": f"{sbs.shape[1]}x{sbs.shape[0]}",
        "format": "full-SBS",
        "engine": f"W8T ({DEPTH_ENCODER}, {device})",
    }
    log(f"Done: {output_path} ({metrics['total_time']}s)")
    return output_path, metrics


def discover_hevc_sources(src_dir: str = os.path.join("output", "testpipeline")) -> list[str]:
    """All non-preview videos in *src_dir* whose stream is HEVC."""
    from pathlib import Path
    root = Path(src_dir)
    if not root.is_dir():
        return []
    out = []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.name.endswith("-preview.mp4") or p.stem.endswith("-mono") or p.name.startswith("."):
            continue
        if p.suffix.lower() not in (".mp4", ".mov", ".m4v"):
            continue
        if get_video_codec(str(p)) in ("hevc", "h265"):
            out.append(str(p))
    return out
