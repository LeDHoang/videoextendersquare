"""Local fast-path 2D -> stereoscopic SBS video converter ("spatialize").

Pipeline per clip:
  1. Decode frames at depth working resolution via an ffmpeg rawvideo pipe.
  2. Run Video-Depth-Anything-Small for temporally consistent relative depth
     (lazy torch import; auto device cuda > mps > cpu; checkpoint pulled from
     Hugging Face on first use and cached).
  3. Re-decode at full resolution and, per frame, synthesize the right-eye
     view with disparity backward-warping (DIBR), detect disocclusion holes
     via forward-splat coverage counting, and fill them with a blurred
     background estimate.
  4. hstack(left, right) -> pipe into the hardware HEVC encoder
     (core.tooling.pick_encoder) as a faststart hvc1 master with audio copied.

No cloud calls, no temp frame files — everything streams through pipes.
"""

import os
import shutil
import subprocess
import time

import numpy as np

from core.tooling import pick_encoder
from pipeline.utils import get_video_dimensions_and_duration, get_video_codec

MODEL_DIR = os.path.join(".models")
DEPTH_ENCODER = "vits"  # Video-Depth-Anything-Small: fastest, best speed/quality tradeoff


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


def _load_depth_model(status_callback=None):
    """Lazy-import torch + video_depth_anything and load the small checkpoint."""
    def log(msg):
        if status_callback:
            status_callback(msg)

    try:
        import torch
    except ImportError as ex:
        raise SpatializeError(
            "PyTorch is required for local spatialization. Install with:\n"
            "  pip install torch torchvision\n"
            "  pip install git+https://github.com/DepthAnything/Video-Depth-Anything.git"
        ) from ex

    try:
        from video_depth_anything.video_depth import VideoDepthAnything
    except ImportError as ex:
        raise SpatializeError(
            "video_depth_anything package missing. Install with:\n"
            "  pip install git+https://github.com/DepthAnything/Video-Depth-Anything.git"
        ) from ex

    repo_variants = {"vits": "Small", "vitb": "Base", "vitl": "Large"}
    repo_name = repo_variants.get(DEPTH_ENCODER, DEPTH_ENCODER.capitalize())
    ckpt_name = f"video_depth_anything_{DEPTH_ENCODER}.pth"
    ckpt_path = os.path.join(MODEL_DIR, ckpt_name)
    if not os.path.exists(ckpt_path):
        log(f"Downloading depth model checkpoint ({ckpt_name})...")
        os.makedirs(MODEL_DIR, exist_ok=True)
        try:
            from huggingface_hub import hf_hub_download
            downloaded = hf_hub_download(
                repo_id=f"depth-anything/Video-Depth-Anything-{repo_name}",
                filename=ckpt_name,
                local_dir=MODEL_DIR,
            )
            if os.path.abspath(downloaded) != os.path.abspath(ckpt_path):
                shutil.copyfile(downloaded, ckpt_path)
        except Exception:
            # Direct fallback URL (same layout as the HF resolve endpoint).
            import urllib.request
            url = (
                "https://huggingface.co/depth-anything/"
                f"Video-Depth-Anything-{repo_name}/resolve/main/{ckpt_name}"
            )
            urllib.request.urlretrieve(url, ckpt_path)

    log("Loading depth model...")
    configs = {
        "vits": {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]},
        "vitb": {"encoder": "vitb", "features": 128, "out_channels": [96, 192, 384, 768]},
        "vitl": {"encoder": "vitl", "features": 256, "out_channels": [256, 512, 1024, 1024]},
    }
    model = VideoDepthAnything(**configs[DEPTH_ENCODER])
    import torch
    state = torch.load(ckpt_path, map_location="cpu")
    model.load_state_dict(state, strict=True)
    device = _pick_device()
    model = model.to(device).eval()
    log(f"Depth model ready on {device}.")
    return model, device


# ─── FFmpeg pipe helpers ──────────────────────────────────────────────────

def _decode_pipe(video_path: str, width: int, height: int, fps_scale: str | None = None):
    """Yield raw rgb24 frames (H,W,3 uint8) from an ffmpeg stdout pipe."""
    cmd = ["ffmpeg", "-v", "error", "-i", video_path]
    if fps_scale:
        cmd += ["-vf", f"fps={fps_scale}"]
    cmd += [
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}", "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = width * height * 3
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            yield np.frombuffer(buf, dtype=np.uint8).reshape(height, width, 3)
    finally:
        proc.stdout.close()
        proc.stderr.close()
        if proc.poll() is None:
            proc.kill()


def _scaled_size(width: int, height: int, max_dim: int) -> tuple[int, int]:
    scale = max_dim / max(width, height)
    if scale >= 1.0:
        return width, height
    return max(2, int(round(width * scale / 2)) * 2), max(2, int(round(height * scale / 2)) * 2)


# ─── DIBR warp + hole fill ────────────────────────────────────────────────

def warp_right_view(left_rgb: np.ndarray, disp: np.ndarray) -> np.ndarray:
    """Synthesize the right-eye view from the left frame and a disparity map.

    disp is float32 in [0, 1]; it is scaled to pixels internally. Right-view
    pixel x samples left at x + disparity (near content shifts left)."""
    import cv2

    h, w = left_rgb.shape[:2]
    max_disp_px = float(np.percentile(disp, 99)) * w * 0.03  # ≤3% of width shift
    if max_disp_px < 1.0:
        max_disp_px = min(w * 0.01, 24.0)
    dmap = cv2.GaussianBlur(disp.astype(np.float32), (5, 5), 0) * (max_disp_px / max(float(np.percentile(disp, 99)), 1e-6))

    xs = np.tile(np.arange(w, dtype=np.float32), (h, 1))
    ys = np.repeat(np.arange(h, dtype=np.float32)[:, None], w, axis=1)

    # Backward map: right pixel samples left at x + d
    mx = np.clip(xs + dmap, 0, w - 1)
    right = cv2.remap(left_rgb, mx, ys, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    # Forward coverage count to find true disocclusion holes: source s lands
    # at target round(s - d[s]); targets never hit are occluded background.
    src_x = np.clip(np.round(xs - dmap).astype(np.int32), 0, w - 1)
    flat = (np.arange(h, dtype=np.int32)[:, None] * w + src_x).ravel()
    cover = np.bincount(flat, minlength=h * w).reshape(h, w)
    holes = cover == 0
    if holes.any():
        right = right.copy()
        known = (~holes).astype(np.float32)
        fill_img = right.astype(np.float32) * known[..., None]
        hole_mask = holes.copy()
        for radius in (3, 7, 15, 31, 63):
            if not hole_mask.any():
                break
            k = radius + 1 - radius % 2
            denom = cv2.blur(known, (k, k))
            vals = cv2.blur(fill_img, (k, k))
            ok = denom > 1e-4
            take = hole_mask & ok
            right[take] = (vals[take] / denom[take][..., None]).astype(np.uint8)
            known[take] = 1.0
            fill_img[take] = right[take].astype(np.float32)
            hole_mask &= ~ok
        hole_mask &= ~ok  # anything still unfilled: leave last blur result
    return right


def _upsample_disp(disp_small, out_w, out_h, depth_w, depth_h):
    import cv2
    d = cv2.resize(disp_small, (out_w, out_h), interpolation=cv2.INTER_CUBIC)
    return np.clip(d, 0.0, 1.0)


# ─── Main entry ───────────────────────────────────────────────────────────

def _video_fps(video_path: str) -> float:
    """Average frame rate via ffprobe (fallback 30)."""
    import json as _json
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=avg_frame_rate", "-of", "json", video_path],
            capture_output=True, text=True, timeout=10,
        ).stdout
        num, _, den = _json.loads(out)["streams"][0]["avg_frame_rate"].partition("/")
        fps = float(num) / float(den or 1)
        return fps if fps > 1 else 30.0
    except Exception:
        return 30.0


def process_video_spatial(
    video_path: str,
    output_path: str,
    status_callback=None,
    strength: float = 1.0,
    half_sbs: bool = False,
    depth_max_dim: int = 518,
) -> tuple[str, dict]:
    """Convert one monocular video to side-by-side stereoscopic HEVC.

    Returns (output_path, metrics). Streams decode/warp/encode through pipes;
    only the depth maps are held in memory (fp16 at depth resolution)."""
    def log(msg):
        if status_callback:
            status_callback(msg)

    t0 = time.time()
    codec = get_video_codec(video_path)
    if codec not in ("hevc", "h265"):
        raise SpatializeError(f"{os.path.basename(video_path)} is {codec}, not HEVC — spatialize expects HEVC masters")

    width, height, duration = get_video_dimensions_and_duration(video_path)
    fps = _video_fps(video_path)
    dw, dh = _scaled_size(width, height, depth_max_dim)

    log(f"Spatializing {os.path.basename(video_path)} ({width}x{height}, {duration:.1f}s)...")

    model, device = _load_depth_model(log)

    # Pass 1: depth inference at reduced resolution.
    log("Pass 1/2: estimating temporal-consistent depth...")
    frames = []
    for f in _decode_pipe(video_path, dw, dh):
        frames.append(f)
    if not frames:
        raise SpatializeError("Decoder produced no frames")
    use_fp32 = (device != "cuda")
    depths, _fps = model.infer_video_depth(frames, fps, input_size=depth_max_dim, device=device, fp32=use_fp32)
    del frames
    # Normalize each map to [0,1] (VDA returns unnormalized-ish floats).
    norm = []
    for d in depths:
        d = np.nan_to_num(d, nan=0.0, posinf=1.0, neginf=0.0)
        dmin, dmax = float(d.min()), float(d.max())
        norm.append(((d - dmin) / max(dmax - dmin, 1e-6)).astype(np.float32))
    del depths

    # Pass 2: full-res warp + encode.
    log("Pass 2/2: warping stereo views and encoding SBS master...")
    eye_w, eye_h = (width // 2, height) if half_sbs else (width, height)
    out_w, out_h = eye_w * 2, eye_h

    encoder, encoder_opts = pick_encoder()
    # Scale the 14M bitrate ceiling up for double-width SBS output.
    enc_opts = []
    for opt in encoder_opts:
        if opt.isdigit() and int(opt) == 14:
            enc_opts.append("28")
        elif opt.endswith("M") and opt[:-1].isdigit() and int(opt[:-1]) == 16:
            enc_opts.append("32M")
        elif opt.endswith("M") and opt[:-1].isdigit() and int(opt[:-1]) == 32:
            enc_opts.append("64M")
        else:
            enc_opts.append(opt)

    has_audio = _has_audio(video_path)
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{out_w}x{out_h}", "-r", str(fps),
           "-i", "-", "-i", video_path]
    cmd += ["-map", "0:v:0"]
    if has_audio:
        cmd += ["-map", "1:a:0?", "-c:a", "copy"]
    cmd += ["-c:v", encoder] + enc_opts + ["-shortest", output_path]

    import cv2
    n_frames = len(norm)
    encoded = 0
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for i, frame in enumerate(_decode_pipe(video_path, width, height)):
            disp = norm[i].astype(np.float32) if i < n_frames else norm[-1].astype(np.float32)
            if strength != 1.0:
                disp = np.clip(disp * strength, 0.0, 1.0)
            if half_sbs:
                frame = cv2.resize(frame, (eye_w, eye_h), interpolation=cv2.INTER_AREA)
                disp = cv2.resize(disp, (eye_w, eye_h), interpolation=cv2.INTER_LINEAR)
            else:
                disp = _upsample_disp(disp, width, height, *(dw, dh))
            right = warp_right_view(frame, disp)
            sbs = np.concatenate([frame, right], axis=1)
            proc.stdin.write(sbs.tobytes())
            encoded += 1
            if encoded % 60 == 0:
                log(f"Encoded {encoded}/{n_frames} frames...")
        proc.stdin.close()
        rc = proc.wait(timeout=600)
        stderr_tail = b""
        try:
            stderr_tail = proc.stderr.read()[-2000:]
        except Exception:
            pass
        if rc != 0:
            raise SpatializeError(f"HEVC encode failed (rc={rc}): {stderr_tail!r}")
    except BrokenPipeError:
        rc = proc.wait(timeout=60)
        raise SpatializeError(f"Encoder died early (rc={rc}): {proc.stderr.read()[-500:]!r}")
    finally:
        proc.stderr.close()

    metrics = {
        "total_time": round(time.time() - t0, 2),
        "frames": encoded,
        "resolution": f"{out_w}x{out_h}",
        "format": "half-SBS" if half_sbs else "full-SBS",
        "engine": f"local DIBR ({DEPTH_ENCODER}, {device})",
    }
    log(f"Done: {output_path} ({metrics['total_time']}s)")
    return output_path, metrics


def _has_audio(path: str) -> bool:
    from pipeline.utils import has_audio_stream
    return has_audio_stream(path)


def discover_hevc_sources(src_dir: str = os.path.join("output", "testpipeline")) -> list[str]:
    """All non-preview videos in *src_dir* whose stream is HEVC."""
    from pathlib import Path
    root = Path(src_dir)
    if not root.is_dir():
        return []
    out = []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.name.endswith("-preview.mp4") or p.name.startswith("."):
            continue
        if p.suffix.lower() not in (".mp4", ".mov", ".m4v"):
            continue
        if get_video_codec(str(p)) in ("hevc", "h265"):
            out.append(str(p))
    return out
