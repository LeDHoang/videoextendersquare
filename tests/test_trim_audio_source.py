"""A trimmed job keeps the audio of the trimmed segment.

The 4K master used to mux audio from the untrimmed upload, so a trim starting
at 30 s played the picture from 30 s with the sound from 0 s.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess

import pytest

from pipeline import video_worker

pytestmark = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="ffmpeg and ffprobe are required",
)


def _source(path):
    # 6 s, silent for the first 3 s and a loud tone after. Every frame is a
    # keyframe so the stream-copy trim starts exactly at 3 s.
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=320x240:rate=5:duration=6",
            "-f", "lavfi", "-i", "aevalsrc='if(gte(t,3),0.8*sin(2*PI*440*t),0)':s=48000:d=6",
            "-c:v", "libx264", "-g", "1", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", str(path),
        ],
        check=True,
    )


def _mean_volume(path):
    out = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", path, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"],
        check=True, capture_output=True, text=True,
    ).stderr
    return float(re.search(r"mean_volume: (-?[\d.]+) dB", out).group(1))


def test_fast_master_uses_trimmed_audio(tmp_path):
    src = tmp_path / "source.mp4"
    _source(src)
    (_url, output), _metrics = video_worker.process_video(
        str(src), "",
        upscale_only=True,
        upscale_engine="fast",
        trim_enabled=True,
        trim_start=3.0,
        trim_duration=2.0,
    )
    try:
        # The trimmed segment is all tone; the untrimmed start is silence.
        assert _mean_volume(output) > -20.0
    finally:
        if os.path.exists(output):
            os.unlink(output)
