"""Rendition sizes per shape: pixel budgets keep a square's size, other shapes keep their aspect."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from pipeline.utils import budget_size
from server import media

needs_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="ffmpeg/ffprobe are required to build and probe sample media",
)


def _size(path) -> tuple[int, int]:
    info = media.probe_media_info(str(path))
    return info["width"], info["height"]


def _clip(path: Path, size: str, codec: str = "libx264") -> Path:
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc=s={size}:d=0.4:r=10",
         "-c:v", codec, "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )
    return path


# ─── Pure sizes ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("side", [2048, 2160, 3840])
def test_budget_size_keeps_every_square_exact_and_never_overshoots(side):
    pixels = side * side
    for s in range(side + 1, 8200):
        assert budget_size(s, s, pixels) == (side, side)
        for w, h in ((s * 16 // 9, s), (s, s * 16 // 9), (2 * s, s)):
            bw, bh = budget_size(w, h, pixels)
            assert bw * bh <= pixels and bw % 2 == 0 and bh % 2 == 0


@pytest.mark.parametrize("size, tile", [
    ((2048, 2048), (720, 720)),
    ((512, 512), (720, 720)),  # scaled up, as scale=-2:720 did
    ((1920, 1080), (1280, 720)),
    ((1920, 1088), (1270, 720)),
    ((1080, 1920), (720, 1280)),
    ((3640, 2048), (1280, 720)),
    ((2048, 3640), (720, 1280)),
    ((2520, 1080), (1280, 548)),  # 21:9: the long side caps at 1280
    ((4000, 3000), (960, 720)),
])
def test_tile_size(size, tile):
    assert media.tile_size(*size) == tile


@pytest.mark.parametrize("size, stereo, out", [
    ((4096, 4096), None, (2048, 2048)),
    ((2048, 2048), None, (2048, 2048)),
    ((3840, 2160), None, (2730, 1536)),
    ((2160, 3840), None, (1536, 2730)),
    ((3640, 2048), None, (2730, 1536)),
    ((8192, 4096), "sbs", (4096, 2048)),
    ((4096, 8192), "tb", (2048, 4096)),
    ((7680, 2160), "sbs", (5460, 1536)),
    ((2160, 7680), "tb", (1536, 5460)),
])
def test_vr2k_size_budgets_each_eye(size, stereo, out):
    assert media.vr2k_size(*size, stereo) == out


@pytest.mark.parametrize("size, scale", [
    ((3840, 3840), "scale=2160:2160,setsar=1"),
    # A 2048² master stays 2048² (the old scale=-2:2160 scaled it up to 2160²).
    ((2048, 2048), "scale=2048:2048,setsar=1"),
    ((3840, 2160), "scale=2880:1620,setsar=1"),
    ((2160, 3840), "scale=1620:2880,setsar=1"),
    ((1920, 1080), "scale=1920:1080,setsar=1"),
])
def test_web_preview_scale_per_shape(tmp_path, monkeypatch, size, scale):
    cmds = []

    def run(cmd, **_kwargs):
        cmds.append(cmd)
        Path(cmd[-1]).write_bytes(b"x")
        return subprocess.CompletedProcess(cmd, 0)

    src = tmp_path / "reel.mp4"
    src.write_bytes(b"x")
    monkeypatch.setattr(media, "get_video_codec", lambda path: "hevc")
    monkeypatch.setattr(media, "probe_media_info", lambda path: {"duration_ms": 1000, "width": size[0], "height": size[1]})
    monkeypatch.setattr(media.subprocess, "run", run)
    monkeypatch.setattr(media, "_commit_part", lambda part, dest: str(dest))
    assert media.make_web_preview(str(src))
    assert cmds[0][cmds[0].index("-vf") + 1] == scale


# ─── Encodes ────────────────────────────────────────────────────────────────


@needs_ffmpeg
@pytest.mark.parametrize("size, height, out", [
    ("400x400", 200, (200, 200)),
    ("640x360", 200, (266, 150)),
    ("360x640", 200, (150, 266)),
    ("640x360", None, (640, 360)),  # within 2160²: never scaled up
])
def test_web_preview_fits_the_pixel_budget(tmp_path, size, height, out):
    # A non-H.264 source gets a proxy.
    src = _clip(tmp_path / "clip.mp4", size, codec="mpeg4")
    proxy = media.make_web_preview(str(src), height=height)
    assert proxy and proxy.endswith("clip-preview.mp4")
    assert _size(proxy) == out


@needs_ffmpeg
@pytest.mark.parametrize("size, out", [
    ("96x96", (72, 72)),
    ("320x180", (128, 72)),
    ("180x320", (72, 128)),
    ("420x180", (128, 54)),
])
def test_explore_tiles_keep_the_shape(tmp_path, size, out):
    src = _clip(tmp_path / "clip.mp4", size)
    assert _size(media.make_explore_preview(str(src), height=72)) == out
    assert _size(media.make_explore_poster(str(src), height=72)) == out


@needs_ffmpeg
@pytest.mark.parametrize("size, out", [
    ((96, 96), (72, 72)),
    ((320, 180), (128, 72)),
    ((180, 320), (72, 128)),
])
def test_image_poster_keeps_the_shape(tmp_path, size, out):
    src = tmp_path / "still.png"
    Image.new("RGB", size, (200, 40, 40)).save(src)
    with Image.open(media.make_image_poster(str(src), height=72)) as img:
        assert img.size == out


@needs_ffmpeg
def test_a_cached_tile_of_another_shape_rebuilds(tmp_path):
    src = _clip(tmp_path / "clip.mp4", "180x320")
    poster = Path(media.make_explore_poster(str(src), height=72))
    before = poster.stat().st_mtime_ns
    assert media.make_explore_poster(str(src), height=72) == str(poster)
    assert poster.stat().st_mtime_ns == before
    # An older square-only or height-only tile (the 9:16 frame at 41x72) is stale.
    Image.new("RGB", (41, 72)).save(poster, "JPEG")
    os.utime(poster, ns=(before + 10**9, before + 10**9))
    assert _size(media.make_explore_poster(str(src), height=72)) == (72, 128)


@needs_ffmpeg
def test_a_left_eye_tile_matches_the_eye_aspect(tmp_path):
    src = _clip(tmp_path / "pair.mp4", "640x180")
    crop = media.left_eye_crop("sbs")
    poster = Path(media.make_explore_poster(str(src), height=72, crop=crop))
    assert _size(poster) == (128, 72)
    before = poster.stat().st_mtime_ns
    assert media.make_explore_poster(str(src), height=72, crop=crop) == str(poster)
    assert poster.stat().st_mtime_ns == before
    # A cached tile of the full 32:9 frame is not the 16:9 eye: it rebuilds.
    Image.new("RGB", (256, 72)).save(poster, "JPEG")
    os.utime(poster, ns=(before + 10**9, before + 10**9))
    assert _size(media.make_explore_poster(str(src), height=72, crop=crop)) == (128, 72)


@needs_ffmpeg
@pytest.mark.parametrize("layout, size, eye", [
    ("sbs", "256x128", (128, 128)),
    ("sbs", "640x180", (320, 180)),
    ("tb", "180x640", (180, 320)),
])
def test_left_eye_video_keeps_the_eye_aspect(tmp_path, layout, size, eye):
    src = _clip(tmp_path / "pair.mp4", size)
    mono = media.make_left_eye_rendition(str(src), layout)
    assert mono and _size(mono) == eye


@pytest.mark.parametrize("layout, size, eye", [
    ("sbs", (256, 128), (128, 128)),
    ("sbs", (640, 180), (320, 180)),
    ("tb", (180, 640), (180, 320)),
])
def test_left_eye_still_keeps_the_eye_aspect(tmp_path, layout, size, eye):
    src = tmp_path / "pair.png"
    Image.new("RGB", size, (30, 30, 220)).save(src)
    mono = media.make_left_eye_rendition(str(src), layout)
    with Image.open(mono) as img:
        assert img.size == eye


def test_a_left_eye_still_over_budget_shrinks_to_its_aspect(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "MONO_IMAGE_MAX_SIDE", 100)
    src = tmp_path / "pair.png"
    Image.new("RGB", (640, 180), (30, 30, 220)).save(src)
    with Image.open(media.make_left_eye_rendition(str(src), "sbs")) as img:
        assert img.size == budget_size(320, 180, 100 * 100) == (132, 74)
