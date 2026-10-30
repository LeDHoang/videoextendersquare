"""Bitrate caps on every encode/copy path that produces a VR-played file.

Playback buffering assumes a bounded bitrate: stream-copied masters keep the
source bitrate, so they are copied only at or under the HEVC cap; the libx265
fallback and the H.264 preview/stereo proxies carry VBV caps. ffmpeg/ffprobe
are never run here.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from core import tooling
from pipeline import video_worker
from server import media


def test_every_hevc_candidate_is_capped_at_26_mbps():
    args = dict(tooling.HEVC_CANDIDATES)
    for name in ("hevc_videotoolbox", "hevc_nvenc", "hevc_qsv"):
        assert args[name][args[name].index("-maxrate") + 1] == "26M"
    x265 = args["libx265"]
    assert x265[x265.index("-crf") + 1] == "20"
    assert x265[x265.index("-x265-params") + 1] == "vbv-maxrate=26000:vbv-bufsize=48000"


@pytest.fixture
def square_hevc(monkeypatch):
    monkeypatch.setattr(video_worker, "_is_already_square", lambda path, target=3840: True)
    monkeypatch.setattr(video_worker, "get_video_codec", lambda path: "hevc")
    state = {"bitrate": 20_000_000}
    monkeypatch.setattr(video_worker, "get_video_bitrate", lambda path: state["bitrate"])
    return state


def test_master_under_the_cap_is_stream_copied(square_hevc):
    assert video_worker._master_can_stream_copy("m.mp4", 0.0) is True
    square_hevc["bitrate"] = video_worker.STREAM_COPY_MAX_BITRATE
    assert video_worker._master_can_stream_copy("m.mp4", 0.0) is True


def test_master_over_the_cap_is_re_encoded(square_hevc):
    square_hevc["bitrate"] = 28_800_000
    assert video_worker._master_can_stream_copy("m.mp4", 0.0) is False


def test_master_with_unknown_bitrate_is_re_encoded(square_hevc):
    square_hevc["bitrate"] = None
    assert video_worker._master_can_stream_copy("m.mp4", 0.0) is False


def test_sharpening_still_forces_a_re_encode(square_hevc):
    assert video_worker._master_can_stream_copy("m.mp4", 0.5) is False


@pytest.fixture
def preview_cmds(monkeypatch, tmp_path):
    cmds = []

    def fake_run(cmd, **_kwargs):
        cmds.append(list(cmd))
        Path(cmd[-1]).write_bytes(b"x")

        class Done:
            returncode = 0
        return Done()

    monkeypatch.setattr(media, "get_video_codec", lambda src: "hevc")
    monkeypatch.setattr(media.subprocess, "run", fake_run)
    monkeypatch.setattr(media, "_commit_part", lambda part, dest: str(dest))
    return cmds


def _rate(cmd):
    return cmd[cmd.index("-maxrate") + 1], cmd[cmd.index("-bufsize") + 1]


def test_mono_preview_is_capped_at_12_mbps(preview_cmds, tmp_path):
    src = tmp_path / "reel.mp4"
    src.write_bytes(b"x")
    assert media.make_web_preview(str(src)).endswith("reel-preview.mp4")
    assert _rate(preview_cmds[0]) == ("12M", "24M")
    assert preview_cmds[0][preview_cmds[0].index("-crf") + 1] == "20"


def test_stereo_proxy_is_capped_at_20_mbps(preview_cmds, tmp_path):
    src = tmp_path / "reel-sbs.mp4"
    src.write_bytes(b"x")
    assert media.make_web_preview(str(src), stereo="sbs")
    assert _rate(preview_cmds[0]) == ("20M", "40M")
