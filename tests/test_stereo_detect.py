from __future__ import annotations

import random
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFilter

from pipeline import stereo_detect as sd

needs_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="ffmpeg/ffprobe are required to build and probe sample media",
)


def scene(width: int, height: int, seed: int) -> Image.Image:
    """A deterministic textured scene: random shapes on a soft gradient."""
    rng = random.Random(seed)
    img = Image.linear_gradient("L").resize((width, height)).convert("RGB")
    draw = ImageDraw.Draw(img)
    for _ in range(120):
        x, y = rng.randrange(width), rng.randrange(height)
        r = rng.randrange(4, max(5, width // 10))
        color = tuple(rng.randrange(256) for _ in range(3))
        if rng.random() < 0.5:
            draw.ellipse((x - r, y - r, x + r, y + r), fill=color)
        else:
            draw.rectangle((x - r, y - r // 2, x + r, y + r // 2), fill=color)
    return img.filter(ImageFilter.GaussianBlur(0.6))


def stereo_pair(eye: int, disparity: int, seed: int = 7) -> tuple[Image.Image, Image.Image]:
    wide = scene(eye + disparity, eye, seed)
    return wide.crop((0, 0, eye, eye)), wide.crop((disparity, 0, disparity + eye, eye))


def pack(layout: str, left: Image.Image, right: Image.Image) -> Image.Image:
    w, h = left.size
    out = Image.new("RGB", (w * 2, h) if layout == "sbs" else (w, h * 2))
    out.paste(left, (0, 0))
    out.paste(right, (w, 0) if layout == "sbs" else (0, h))
    return out


def test_candidate_layout_is_exact_ratio_only():
    assert sd.candidate_layout(3840, 1920) == "sbs"
    assert sd.candidate_layout(1920, 3840) == "tb"
    assert sd.candidate_layout(1920, 1920) is None
    assert sd.candidate_layout(3842, 1920) is None
    assert sd.candidate_layout(1920, 1080) is None
    assert sd.candidate_layout(None, 10) is None
    assert sd.layout_matches("mono", 1920, 1080)
    assert sd.layout_matches("sbs", 200, 100)
    assert not sd.layout_matches("tb", 200, 100)
    assert sd.eye_size("sbs", 4096, 2048) == (2048, 2048)
    assert sd.eye_size("tb", 2048, 4096) == (2048, 2048)


def test_eye_halves_split_left_eye_first():
    left = Image.new("RGB", (8, 8), "red")
    right = Image.new("RGB", (8, 8), "blue")
    for layout in ("sbs", "tb"):
        a, b = sd.eye_halves(pack(layout, left, right), layout)
        assert a.getpixel((1, 1)) == (255, 0, 0)
        assert b.getpixel((1, 1)) == (0, 0, 255)


@pytest.mark.parametrize("layout", ["sbs", "tb"])
def test_shifted_pair_is_detected_by_content(tmp_path, layout):
    left, right = stereo_pair(480, 18)
    path = tmp_path / f"pair.{layout}.png"
    pack(layout, left, right).save(path)
    w, h = Image.open(path).size
    result = sd.detect_stereo(str(path), w, h, kind="image")
    assert result["candidate"] == layout
    assert result["detected"] is True
    assert result["method"] == "content"
    assert result["score"] >= sd.CONTENT_THRESHOLD


@pytest.mark.parametrize("layout", ["sbs", "tb"])
def test_ordinary_wide_or_tall_frame_is_not_stereo(tmp_path, layout):
    # One continuous scene split in two: the halves show different content.
    size = (960, 480) if layout == "sbs" else (480, 960)
    path = tmp_path / f"mono.{layout}.png"
    scene(*size, seed=3).save(path)
    result = sd.detect_stereo(str(path), *size, kind="image")
    assert result["candidate"] == layout
    assert result["detected"] is False
    assert result["score"] is not None and result["score"] < sd.CONTENT_THRESHOLD


def test_unrelated_halves_score_low():
    a = scene(256, 256, seed=1)
    b = scene(256, 256, seed=2)
    assert sd.pair_score(a, b) < 0.4


def test_flat_frame_is_inconclusive(tmp_path):
    path = tmp_path / "black.png"
    Image.new("RGB", (400, 200), "black").save(path)
    result = sd.detect_stereo(str(path), 400, 200, kind="image")
    assert result == {"candidate": "sbs", "detected": False, "method": None, "score": None}


def test_non_candidate_skips_all_work(tmp_path):
    result = sd.detect_stereo(str(tmp_path / "missing.mp4"), 1920, 1080, kind="video", duration=3)
    assert result == {"candidate": None, "detected": False, "method": None, "score": None}


@needs_ffmpeg
def test_video_content_detection(tmp_path):
    left, right = stereo_pair(256, 10)
    frame = tmp_path / "frame.png"
    pack("sbs", left, right).save(frame)
    video = tmp_path / "sbs.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-loop", "1", "-i", str(frame), "-t", "1",
         "-r", "10", "-pix_fmt", "yuv420p", str(video)],
        check=True,
    )
    result = sd.detect_stereo(str(video), 512, 256, kind="video", duration=1.0)
    assert result["detected"] is True and result["method"] == "content"


@needs_ffmpeg
@pytest.mark.parametrize("mode,expected", [("left_right", "sbs"), ("top_bottom", "tb"), ("right_left", None)])
def test_matroska_stereo_mode_tag(tmp_path, mode, expected):
    video = tmp_path / f"{mode}.mkv"
    size = "128x64" if mode != "top_bottom" else "64x128"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c=gray:s={size}:d=0.5",
         "-metadata:s:v:0", f"stereo_mode={mode}", "-c:v", "libx264", str(video)],
        check=True,
    )
    assert sd.metadata_layout(str(video)) == expected


def test_metadata_side_data_parsing(monkeypatch):
    payloads = {
        "sbs": {"side_data_type": "Stereo 3D", "type": "side by side", "inverted": 0},
        "tb": {"side_data_type": "Stereo 3D", "type": "top and bottom", "inverted": 0},
        None: {"side_data_type": "Stereo 3D", "type": "side by side", "inverted": 1},
    }

    for expected, side in payloads.items():
        def fake_run(cmd, **kwargs):
            import json

            class Done:
                returncode = 0
                stdout = json.dumps({"streams": [{"side_data_list": [side]}]})
            return Done()

        monkeypatch.setattr(sd.subprocess, "run", fake_run)
        assert sd.metadata_layout("x.mp4") == expected


def fake_ffprobe(monkeypatch, payload):
    import json

    class Done:
        returncode = 0
        stdout = json.dumps(payload)

    monkeypatch.setattr(sd.subprocess, "run", lambda cmd, **kwargs: Done())


def meta(layout=None, inverted=False, spherical=False):
    return {"layout": layout, "inverted": inverted, "spherical": spherical}


def test_metadata_wins_for_matching_candidate(monkeypatch):
    monkeypatch.setattr(sd, "probe_metadata", lambda src: meta("sbs"))
    result = sd.detect_stereo("x.mp4", 200, 100, kind="video", duration=1.0)
    assert result == {"candidate": "sbs", "detected": True, "method": "metadata", "score": None}


@pytest.mark.parametrize("payload", [
    {"streams": [{"side_data_list": [{"side_data_type": "Spherical Mapping", "projection": "equirectangular"}]}]},
    # VR180: stereo side data plus a spherical mapping still is not flat 3D.
    {"streams": [{"side_data_list": [
        {"side_data_type": "Stereo 3D", "type": "side by side", "inverted": 0},
        {"side_data_type": "Spherical Mapping", "projection": "equirectangular"},
    ]}]},
    {"streams": [{"tags": {"projection": "equirectangular"}}]},
    {"streams": [{}], "format": {"tags": {"spherical-video": "true"}}},
])
def test_spherical_metadata_is_never_stereo(monkeypatch, payload):
    fake_ffprobe(monkeypatch, payload)
    assert sd.probe_metadata("x.mp4")["spherical"] is True
    monkeypatch.setattr(sd, "_video_frames", lambda *a, **k: pytest.fail("content pass ran"))
    result = sd.detect_stereo("x.mp4", 200, 100, kind="video", duration=1.0)
    assert result == {"candidate": "sbs", "detected": False, "method": "spherical", "score": None}


def test_flat_projection_tag_is_not_spherical(monkeypatch):
    fake_ffprobe(monkeypatch, {"streams": [{"tags": {"projection": "rectangular"}}]})
    assert sd.probe_metadata("x.mp4")["spherical"] is False


@pytest.mark.parametrize("payload", [
    {"streams": [{"side_data_list": [{"side_data_type": "Stereo 3D", "type": "side by side", "inverted": 1}]}]},
    {"streams": [{"tags": {"stereo_mode": "right_left"}}]},
    {"streams": [{"tags": {"STEREO_MODE": "bottom_top"}}]},
])
def test_inverted_layout_skips_the_content_pass(monkeypatch, payload):
    fake_ffprobe(monkeypatch, payload)
    assert sd.probe_metadata("x.mp4") == meta(inverted=True)
    assert sd.metadata_layout("x.mp4") is None
    monkeypatch.setattr(sd, "_video_frames", lambda *a, **k: pytest.fail("content pass ran"))
    result = sd.detect_stereo("x.mp4", 200, 100, kind="video", duration=1.0)
    assert result == {"candidate": "sbs", "detected": False, "method": "inverted", "score": None}


def test_photo_sphere_still_is_rejected(tmp_path):
    left, right = stereo_pair(240, 12)
    path = tmp_path / "pano.jpg"
    xmp = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
           b'<rdf:Description xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" '
           b'GPano:ProjectionType="equirectangular"/></rdf:RDF></x:xmpmeta>')
    pack("sbs", left, right).save(path, xmp=xmp)
    assert sd.image_is_spherical(str(path)) is True
    result = sd.detect_stereo(str(path), 480, 240, kind="image")
    assert result == {"candidate": "sbs", "detected": False, "method": "spherical", "score": None}
