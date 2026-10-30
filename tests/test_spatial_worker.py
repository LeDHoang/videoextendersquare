"""Make 3D converter end to end (pipeline/spatial_worker.py) with the depth
model stubbed out: decode, shot split, render, encode, timing, colour tags and
the image path. Needs ffmpeg and OpenCV, not torch."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from pipeline import spatial_worker as sw

needs_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="ffmpeg/ffprobe are required to build and probe sample media",
)
pytestmark = needs_ffmpeg

FPS = 30


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin", *args], check=True)


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format",
                          "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    data["video"] = next(s for s in data["streams"] if s["codec_type"] == "video")
    data["audio"] = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
    return data


def frames_of(path: Path) -> np.ndarray:
    v = probe(path)["video"]
    w, h = int(v["width"]), int(v["height"])
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-fps_mode", "passthrough",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def luma(rgb: np.ndarray) -> np.ndarray:
    return rgb.astype(np.float64) @ np.array([0.2126, 0.7152, 0.0722])


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    return 99.0 if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)


@pytest.fixture
def depth_calls(monkeypatch):
    """Stub depth: a left-to-right ramp (nearer on the right), recording each shot's length."""
    calls: list[int] = []

    def video(frames, fps):
        calls.append(len(frames))
        n, (h, w) = len(frames), frames[0].shape[:2]
        return np.broadcast_to(np.linspace(0, 1, w, dtype=np.float32), (n, h, w)).copy(), "stub"

    def image(rgb):
        h, w = rgb.shape[:2]
        return np.broadcast_to(np.linspace(0, 1, w, dtype=np.float32), (h, w)).copy(), "stub"

    monkeypatch.setattr(sw, "_depth_video", video)
    monkeypatch.setattr(sw, "_depth_image", image)
    return calls


@pytest.fixture(scope="module")
def indexed_clip(tmp_path_factory) -> Path:
    """96x96, 30 fps, 60 frames whose colour encodes the frame number
    (red = N mod 8, green = N div 8, steps of 32), lossless H.264. The video
    stream starts 0.1 s after the container, against 2.2 s of AAC audio."""
    d = tmp_path_factory.mktemp("indexed")
    ffmpeg("-f", "lavfi", "-i", f"nullsrc=s=96x96:r={FPS}:d=2,geq=r='mod(N\\,8)*32':g='floor(N/8)*32':b=128,"
           "scale=out_color_matrix=bt709:out_range=tv,format=yuv444p",
           "-f", "lavfi", "-i", "sine=d=2.2", "-map", "0:v", "-map", "1:a",
           "-c:v", "libx264", "-qp", "0", "-colorspace", "bt709", "-c:a", "aac", str(d / "a.mp4"))
    ffmpeg("-itsoffset", "0.1", "-i", str(d / "a.mp4"), "-i", str(d / "a.mp4"),
           "-map", "0:v", "-map", "1:a", "-c", "copy", str(d / "src.mp4"))
    src = probe(d / "src.mp4")
    assert abs(float(src["video"]["start_time"]) - 0.1) < 0.01  # the fixture is what it claims
    return d / "src.mp4"


@pytest.fixture(scope="module")
def textured_clip(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("textured")
    ffmpeg("-f", "lavfi", "-i", f"testsrc2=s=160x160:r={FPS}:d=1,format=rgb24,"
           "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
           "-c:v", "libx264", "-crf", "12", "-colorspace", "bt709", str(d / "src.mp4"))
    return d / "src.mp4"


def frame_index(rgb: np.ndarray) -> int:
    r, g = rgb[8:-8, 8:-8, 0].mean(), rgb[8:-8, 8:-8, 1].mean()
    return int(round(g / 32)) * 8 + int(round(r / 32))


def test_video_keeps_every_frame_in_order_with_timing_audio_and_colour(indexed_clip, depth_calls, tmp_path):
    out = tmp_path / "out.mp4"
    statuses: list[str] = []
    path, metrics = sw.process_video_spatial(str(indexed_clip), str(out), status_callback=statuses.append)
    assert path == str(out)

    info = probe(out)
    v, a = info["video"], info["audio"]
    w, h = int(v["width"]), int(v["height"])
    rw, rh, crop = sw.eye_geometry(96, 96)
    assert (w, h) == (2 * (rw - 2 * crop), rh - 2 * crop) == (184, 92)
    assert v["codec_name"] == "h264" and v["pix_fmt"] == "yuv420p"
    assert (v.get("color_space"), v.get("color_transfer"), v.get("color_primaries")) == ("bt709",) * 3

    # One output frame per source frame, frame i showing source frame i.
    assert int(v["nb_read_frames"]) == 60 == metrics["frames"]
    left = frames_of(out)[:, :, : w // 2]
    assert [frame_index(f) for f in left] == list(range(60))

    # Late video start and the audio track survive; the duration is the source's.
    assert abs(float(v["start_time"]) - 0.1) < 1 / FPS
    assert a is not None and a["codec_name"] == "aac"
    assert abs(float(v["duration"]) - 2.0) <= 1 / FPS

    assert metrics["resolution"] == f"{w}x{h}" and metrics["format"] == "full-SBS"
    assert sum(depth_calls) == 60
    assert any(s.startswith("Estimating depth") for s in statuses)
    assert any(s.startswith("Rendering 3D") for s in statuses)


def test_left_eye_is_the_cropped_source_and_right_eye_differs(textured_clip, depth_calls, tmp_path):
    out = tmp_path / "out.mp4"
    sw.process_video_spatial(str(textured_clip), str(out))
    src = frames_of(textured_clip)
    sbs = frames_of(out)
    rw, rh, crop = sw.eye_geometry(160, 160)
    eye = rw - 2 * crop
    assert sbs.shape[0] == src.shape[0]
    for i in (0, len(src) // 2, len(src) - 1):
        left, right = sbs[i, :, :eye], sbs[i, :, eye:]
        ref = src[i, crop:rh - crop, crop:rw - crop]
        assert psnr(left, ref) > 30  # an odd crop (chroma grid off by half a sample) gives ~20
        assert psnr(luma(left), luma(ref)) > 39
        assert psnr(left, right) < 30  # the ramp depth gives the right eye real parallax


def test_half_sbs_packs_two_half_width_eyes(textured_clip, depth_calls, tmp_path):
    out = tmp_path / "half.mp4"
    _, metrics = sw.process_video_spatial(str(textured_clip), str(out), half_sbs=True)
    v = probe(out)["video"]
    rw, rh, crop = sw.eye_geometry(160, 160)
    assert (int(v["width"]), int(v["height"])) == (2 * sw._even((rw - 2 * crop) // 2), rh - 2 * crop)
    assert metrics["format"] == "half-SBS"


def test_depth_runs_once_per_shot(depth_calls, tmp_path):
    src = tmp_path / "cut.mp4"
    ffmpeg("-f", "lavfi", "-i", f"testsrc2=s=128x128:r={FPS}:d=1",
           "-f", "lavfi", "-i", f"mandelbrot=s=128x128:r={FPS},trim=duration=1",
           "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]",
           "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", str(src))
    _, metrics = sw.process_video_spatial(str(src), str(tmp_path / "out.mp4"))
    assert depth_calls == [30, 30]
    assert metrics["shots"] == 2 and metrics["frames"] == 60


def test_rejects_long_video_and_audio_only_file(depth_calls, tmp_path, monkeypatch):
    clip = tmp_path / "two_seconds.mp4"
    ffmpeg("-f", "lavfi", "-i", f"testsrc2=s=64x64:r={FPS}:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip))
    with pytest.raises(sw.SpatializeError, match="up to 1s"):
        sw.process_video_spatial(str(clip), str(tmp_path / "out.mp4"), max_seconds=1)
    real_probe = sw._probe
    with monkeypatch.context() as m:
        # No duration in the container or the stream: the cap cannot be checked.
        m.setattr(sw, "_probe", lambda path: {**real_probe(path), "duration": 0.0})
        with pytest.raises(sw.SpatializeError, match="duration is unknown"):
            sw.process_video_spatial(str(clip), str(tmp_path / "out.mp4"))
    audio = tmp_path / "audio.m4a"
    ffmpeg("-f", "lavfi", "-i", "sine=d=1", "-c:a", "aac", str(audio))
    with pytest.raises(sw.SpatializeError, match="no video stream"):
        sw.process_video_spatial(str(audio), str(tmp_path / "out2.mp4"))
    assert depth_calls == []
    assert not (tmp_path / "out.mp4").exists() and not (tmp_path / "out2.mp4").exists()


class Stop(BaseException):
    pass


def test_cancel_during_render_removes_the_partial_output(textured_clip, depth_calls, tmp_path):
    out = tmp_path / "out.mp4"
    seen = {}

    def status(msg):
        if msg.startswith(f"Rendering 3D: {sw.RENDER_REPORT_EVERY}/"):
            seen["partial"] = out.exists()  # the encoder is mid-file
            raise Stop

    with pytest.raises(Stop):
        sw.process_video_spatial(str(textured_clip), str(out), status_callback=status)
    assert seen == {"partial": True}
    assert not out.exists()


def test_image_is_exif_upright_and_2_to_1(depth_calls, tmp_path):
    # Stored 120 wide x 80 tall, top-left quadrant red; EXIF 6 = rotate 90 clockwise to view.
    stored = np.full((80, 120, 3), 40, np.uint8)
    stored[:40, :60] = (230, 20, 20)
    src = tmp_path / "photo.jpg"
    exif = Image.Exif()
    exif[0x0112] = 6
    Image.fromarray(stored).save(src, quality=98, exif=exif)

    out = tmp_path / "out.jpg"
    _, metrics = sw.process_image_spatial(str(src), str(out))
    rw, rh, crop = sw.eye_geometry(80, 120)
    eye_w, eye_h = rw - 2 * crop, rh - 2 * crop
    with Image.open(out) as img:
        assert img.format == "JPEG"
        assert img.size == (2 * eye_w, eye_h)
        sbs = np.asarray(img.convert("RGB"))
    assert metrics["resolution"] == f"{2 * eye_w}x{eye_h}" and metrics["frames"] == 1
    # Upright view: the red corner is now top-right of the left eye.
    left = sbs[:, :eye_w]
    assert left[5, eye_w - 5, 0] > 180 and left[5, 5, 0] < 100


def test_square_image_gives_square_eyes(depth_calls, tmp_path):
    src = tmp_path / "sq.png"
    Image.fromarray(np.random.default_rng(0).integers(0, 256, (300, 300, 3), np.uint8)).save(src)
    out = tmp_path / "sq_sbs.jpg"
    sw.process_image_spatial(str(src), str(out))
    with Image.open(out) as img:
        assert img.size == (2 * 288, 288)  # crop ceil(0.013867 * 300) = 5, rounded up to even


def test_unreadable_image_is_a_spatialize_error(depth_calls, tmp_path):
    bad = tmp_path / "bad.jpg"
    bad.write_bytes(b"not an image")
    with pytest.raises(sw.SpatializeError):
        sw.process_image_spatial(str(bad), str(tmp_path / "out.jpg"))
