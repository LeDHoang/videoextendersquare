"""scripts/batch_vr2k.py: which published videos get a 2k rendition, and the build itself."""

from __future__ import annotations

import importlib.util
from pathlib import Path

from server.routers import reels, uploads
from server.social.models import Post
from server.social.services import post_media_items
from test_publish_background import publish_video, setup, stored_path  # noqa: F401  (setup is a fixture)

_SPEC = importlib.util.spec_from_file_location(
    "batch_vr2k", Path(__file__).resolve().parents[1] / "scripts" / "batch_vr2k.py")
batch_vr2k = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(batch_vr2k)


def test_plan_sorts_videos_by_what_they_have(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(uploads, "OUTPUT_DIR", Path("output"))
    (tmp_path / "output" / "uploads").mkdir(parents=True)
    (tmp_path / "output" / "uploads" / "local.mp4").write_bytes(b"x")
    (tmp_path / "output" / "uploads" / "local-2k.mp4").write_bytes(b"x")
    rows = [
        ("uploads/done.mp4", "mono", {"uploads/done.mp4": {}, "uploads/done-2k.mp4": {}}),
        # Recorded, original only in R2: the job fetches it.
        ("uploads/r2only.mp4", "sbs", {"uploads/r2only.mp4": {}}),
        ("uploads/tb.mp4", "tb", {"uploads/tb.mp4": {}}),
        ("uploads/odd.mp4", "unknown", {"uploads/odd.mp4": {}}),
        # Unrecorded: judged from this disk.
        ("uploads/local.mp4", None, None),
        ("uploads/gone.mp4", None, None),
        ("../elsewhere.mp4", None, {"../elsewhere.mp4": {}}),
    ]
    todo, complete, skipped = batch_vr2k.plan(rows)
    assert complete == ["uploads/done.mp4", "uploads/local.mp4"]
    assert todo == [("uploads/r2only.mp4", "sbs"), ("uploads/tb.mp4", "tb"), ("uploads/odd.mp4", None)]
    assert skipped == [
        ("uploads/gone.mp4", "not recorded and not on this disk"),
        ("../elsewhere.mp4", "outside output/"),
    ]


def test_backfill_builds_the_missing_rendition_from_r2(setup, tmp_path, capsys):
    client, Session, s3, ffmpeg, futures = setup
    ffmpeg.fail = {"-2k.mp4"}
    body = publish_video(client, tmp_path)
    stored = stored_path(body)
    ffmpeg.gate.set()
    futures[0].result(timeout=10)
    # The publish left no 2k file and no local original.
    assert not stored.exists()
    with Session() as db:
        assert f"uploads/{stored.stem}-2k.mp4" not in db.query(Post).one().media_files

    encodes = len(ffmpeg.encodes)
    assert batch_vr2k.main(["--dry-run"]) == 0
    assert len(ffmpeg.encodes) == encodes
    assert "1 published video(s): 0 complete, 1 to build, 0 skipped." in capsys.readouterr().out

    ffmpeg.fail = set()
    assert batch_vr2k.main([]) == 0
    assert ffmpeg.encodes[encodes:] == [f".{stored.stem}-2k.mp4.part"]
    assert f"uploads/{stored.stem}-2k.mp4" in s3.objects
    assert not stored.exists() and not stored.with_name(f"{stored.stem}-2k.mp4").exists()
    with Session() as db:
        payload = reels._build_payload(post_media_items(db), "h264", db=db)
    assert [item["vr2k_url"] for item in payload] == [f"https://media.example.com/uploads/{stored.stem}-2k.mp4"]

    # Done once: a second run selects nothing.
    assert batch_vr2k.main([]) == 0
    assert len(ffmpeg.encodes) == encodes + 1
    assert "0 to build" in capsys.readouterr().out


def test_a_failed_build_exits_nonzero(setup, tmp_path, capsys):
    client, Session, s3, ffmpeg, futures = setup
    ffmpeg.fail = {"-2k.mp4"}
    publish_video(client, tmp_path)
    ffmpeg.gate.set()
    futures[0].result(timeout=10)
    assert batch_vr2k.main([]) == 1
    assert "Built 0, failed 1." in capsys.readouterr().out
