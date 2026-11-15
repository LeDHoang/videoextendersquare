"""Stretch to fit must make the picture square, not just the pixel grid.

ffmpeg's scale filter keeps the frame's displayed shape by writing the old
ratio into the sample aspect ratio (SAR). Without setsar=1 a 720x1280 source
becomes 3840x3840 pixels tagged 9:16, and players still show it portrait.
"""

from __future__ import annotations

import shutil
import subprocess

import pytest

from pipeline import image_worker, video_worker

needs_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="ffmpeg/ffprobe not on PATH",
)


def _probe(path) -> str:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,sample_aspect_ratio", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    )
    return out.stdout.strip()


def test_image_worker_uses_the_shared_square_filter():
    assert image_worker.SQUARE_UPSCALE_VF is video_worker.SQUARE_UPSCALE_VF


@needs_ffmpeg
@pytest.mark.parametrize("ext", ["png", "mp4"])
def test_portrait_source_comes_out_square_with_square_pixels(tmp_path, ext):
    src = tmp_path / "in.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=72x128",
                    "-frames:v", "1", str(src)], check=True)
    out = tmp_path / f"out.{ext}"
    vf = video_worker.SQUARE_UPSCALE_VF.replace("3840:3840", "384:384")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", vf,
                    "-frames:v", "1", str(out)], check=True)
    assert _probe(out) == "384,384,1:1"
