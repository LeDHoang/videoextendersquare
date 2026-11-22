"""scripts/batch_silent_audio.py: which played files of published videos lack an audio track."""

from __future__ import annotations

import importlib.util
from pathlib import Path

from server import media as SM
from server import media_store
from server.routers import uploads
from server.social.models import Post
from test_media_store import FakeS3
from test_publish_background import publish_video, setup, stored_path  # noqa: F401  (setup is a fixture)

_SPEC = importlib.util.spec_from_file_location(
    "batch_silent_audio", Path(__file__).resolve().parents[1] / "scripts" / "batch_silent_audio.py")
batch_silent_audio = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(batch_silent_audio)


def test_plan_lists_the_recorded_mp4s_without_audio(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(uploads, "OUTPUT_DIR", Path("output"))
    monkeypatch.setattr(media_store, "enabled", lambda: False)
    silent = {"quiet.mp4", "quiet-preview.mp4", "mixed-2k.mp4"}
    monkeypatch.setattr(SM, "probe_media_info", lambda src: None if src.endswith("broken.mp4") else {"duration": 1})
    monkeypatch.setattr(SM, "has_audio", lambda src: Path(src).name not in silent)
    rows = [
        ("uploads/quiet.mp4", {"uploads/quiet.mp4": {}, "uploads/quiet-preview.mp4": {}}),
        ("uploads/mixed.mp4", {"uploads/mixed.mp4": {}, "uploads/mixed-2k.mp4": {}, "uploads/mixed-poster.jpg": {}}),
        ("uploads/clip.webm", {"uploads/clip.webm": {}}),
        ("uploads/broken.mp4", {"uploads/broken.mp4": {}}),
        ("../elsewhere.mp4", {"../elsewhere.mp4": {}}),
    ]
    todo, with_audio, skipped = batch_silent_audio.plan(rows)
    assert todo == {
        "uploads/quiet.mp4": [Path("output/uploads/quiet.mp4"), Path("output/uploads/quiet-preview.mp4")],
        "uploads/mixed.mp4": [Path("output/uploads/mixed-2k.mp4")],
    }
    assert with_audio == 1
    assert skipped == [
        ("uploads/clip.webm", "no recorded MP4/MOV file"),
        ("../elsewhere.mp4", "outside output/"),
        ("uploads/broken.mp4", "could not be probed"),
    ]


def test_remux_replaces_the_r2_copy_and_keeps_the_record(setup, tmp_path, monkeypatch, capsys):
    client, Session, s3, ffmpeg, futures = setup
    body = publish_video(client, tmp_path)
    stored = stored_path(body)
    ffmpeg.gate.set()
    futures[0].result(timeout=10)
    rel = body["rel_path"]
    with Session() as db:
        before = dict(db.query(Post).one().media_files)
    assert len(before) > 1 and not stored.exists()

    remuxed = []
    # Only the original lacks audio, until it is remuxed.
    monkeypatch.setattr(SM, "probe_media_info", lambda src: {"duration": 1})
    monkeypatch.setattr(SM, "has_audio", lambda src: bool(remuxed) or not src.endswith(f"/{rel}"))

    def add_silent_audio(path, ext):
        Path(path).write_bytes(b"with audio")
        remuxed.append(Path(path).name)
        return True

    monkeypatch.setattr(SM, "add_silent_audio", add_silent_audio)
    # An overwrite: the old object is in R2 already, so the fetched local copy may exist first.
    monkeypatch.setattr(s3, "upload_file", lambda *a, **k: FakeS3.upload_file(s3, *a, **k))

    assert batch_silent_audio.main(["--dry-run"]) == 0
    assert remuxed == []
    assert "1 file(s) in 1 post(s) to remux" in capsys.readouterr().out

    assert batch_silent_audio.main([]) == 0
    assert remuxed == [f".{stored.name}.part"]
    assert s3.objects[rel]["body"] == b"with audio"
    out = capsys.readouterr().out
    assert f"https://media.example.com/{rel}" in out
    with Session() as db:
        after = db.query(Post).one().media_files
    assert set(after) == set(before)
    assert after[rel]["bytes"] == len(b"with audio")
    assert not stored.exists()

    # Done once: a second run finds nothing to remux.
    assert batch_silent_audio.main([]) == 0
    assert "0 file(s) in 0 post(s) to remux" in capsys.readouterr().out
