"""Make 3D with the real depth model (pipeline/spatial_worker.py).

The attention test needs torch only (requirements-3d.txt), so CI skips it. The
model tests download the Video-Depth-Anything-Small checkpoint into .models/
and need a few GB of memory, so they also need SX_TEST_REAL_DEPTH=1:

    SX_TEST_REAL_DEPTH=1 .venv/bin/python -m pytest -q tests/test_spatial_real_depth.py
"""
from __future__ import annotations

import os
import shutil
import subprocess

import numpy as np
import pytest

torch = pytest.importorskip("torch")
pytest.importorskip("cv2")

from PIL import Image, ImageDraw  # noqa: E402

from pipeline import spatial_worker as sw  # noqa: E402

real_depth = pytest.mark.skipif(
    os.environ.get("SX_TEST_REAL_DEPTH") != "1",
    reason="set SX_TEST_REAL_DEPTH=1 to load the depth model",
)


def test_fused_attention_matches_the_upstream_formula():
    # The one local edit to the vendored model (VENDORED.md): SDPA instead of q @ k^T softmax.
    from pipeline.third_party.video_depth_anything.dinov2_layers.attention import Attention

    torch.manual_seed(0)
    att = Attention(384, num_heads=6, qkv_bias=True).eval()
    x = torch.randn(2, 1370, 384)
    with torch.no_grad():
        fused = att(x)
        b, n, c = x.shape
        qkv = att.qkv(x).reshape(b, n, 3, 6, c // 6).permute(2, 0, 3, 1, 4)
        attn = ((qkv[0] * att.scale) @ qkv[1].transpose(-2, -1)).softmax(-1)
        naive = att.proj((attn @ qkv[2]).transpose(1, 2).reshape(b, n, c))
    assert ((fused - naive).abs().max() / naive.abs().max()).item() < 1e-4


def _horizontal_shift(left, right, rows, cols):
    """Pixels the right eye's content sits to the right of the left eye's (best 1-D correlation)."""
    a = left[rows, cols].mean(0)
    b = right[rows, cols].mean(0)
    a, b = a - a.mean(), b - b.mean()
    return max(range(-8, 9), key=lambda s: (a[8:-8] * np.roll(b, -s)[8:-8]).sum())


@real_depth
def test_real_image_depth_puts_a_disc_in_front_of_the_floor(tmp_path):
    # A floor that recedes upwards with a disc standing on it. Both carry random column
    # texture: a plain gradient is the same all along a row, so its shift is invisible.
    rng = np.random.default_rng(0)
    y = np.arange(320)[:, None, None]
    floor = np.concatenate([40 + y // 2, np.full_like(y, 90), 200 - y // 2], axis=2).repeat(320, axis=1)
    floor = floor + rng.integers(-60, 61, size=(1, 80, 1)).repeat(4, axis=1)
    disc = np.array([230, 200, 40]) + rng.integers(-50, 51, size=(1, 40, 1)).repeat(8, axis=1)
    mask = Image.new("L", (320, 320))
    ImageDraw.Draw(mask).ellipse([110, 150, 210, 250], fill=255)
    img = np.clip(np.where(np.asarray(mask)[..., None] > 0, disc, floor), 0, 255).astype(np.uint8)
    src = tmp_path / "scene.png"
    Image.fromarray(img).save(src)

    raw, _device = sw._depth_image(img)
    assert np.isfinite(raw).all() and raw.std() > 0  # fp16 on MPS gave all-NaN depth

    out = tmp_path / "scene_sbs.jpg"
    _, metrics = sw.process_image_spatial(str(src), str(out))
    with Image.open(out) as sbs:
        w, h = sbs.size
        pair = np.asarray(sbs.convert("L")).astype(float)
    assert w == 2 * h and metrics["engine"].startswith("W8T (vits")

    # Rows through the disc: the disc (near) barely moves, the floor beside it (far) does.
    left, right, rows = pair[:, : w // 2], pair[:, w // 2:], slice(175, 225)
    disc_shift = _horizontal_shift(left, right, rows, slice(120, 190))
    floor_shift = min(_horizontal_shift(left, right, rows, slice(0, 96)),
                      _horizontal_shift(left, right, rows, slice(212, 308)))
    assert 0 <= disc_shift and disc_shift + 2 <= floor_shift  # all behind the screen, disc nearest


@real_depth
@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is required")
def test_real_short_clip_converts_end_to_end(tmp_path):
    src = tmp_path / "clip.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-f", "lavfi", "-i", "testsrc2=s=96x96:r=30:d=1",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)], check=True)
    _, metrics = sw.process_video_spatial(str(src), str(tmp_path / "out.mp4"))
    assert metrics["frames"] == 30 and metrics["shots"] == 1 and metrics["format"] == "full-SBS"
