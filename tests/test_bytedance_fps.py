"""The worker sends Bytedance target_fps as the number fal's schema accepts (24 to 120)."""

from __future__ import annotations

import pytest

from pipeline import video_worker

BYTEDANCE = "fal-ai/bytedance-upscaler/upscale/video"


class _Submitted(Exception):
    pass


@pytest.mark.parametrize(("label", "fps"), [("30fps", 30), ("60fps", 60)])
def test_bytedance_target_fps_is_a_number(tmp_path, monkeypatch, label, fps):
    sent = []

    class _FakeFal:
        def __init__(self, *_a, **_k):
            pass

        def upload_file(self, *_a, **_k):
            return "https://fal.test/source.mp4"

        def submit(self, model, arguments):
            sent.append(arguments)
            raise _Submitted

    monkeypatch.setattr(video_worker, "get_video_dimensions_and_duration", lambda *_a, **_k: (1080, 1080, 2.0))
    monkeypatch.setattr(video_worker.fal_client, "SyncClient", _FakeFal)
    source = tmp_path / "square.mp4"
    source.write_bytes(b"x")
    with pytest.raises(_Submitted):
        video_worker.process_video(
            str(source), "", fal_key="key", upscale_only=True, upscale_engine="fal",
            upscale_model=BYTEDANCE, bytedance_target_fps=label,
        )
    assert sent[0]["target_fps"] == fps
