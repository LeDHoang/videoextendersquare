from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server import media
from server.social.database import Base
from server.social.models import User
from server.social.services import create_or_update_post, post_card

needs_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="ffmpeg/ffprobe are required to build and probe sample media",
)


def make_video(path: Path, seconds: float = 1.5, size: str = "320x240") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-v", "error",
            "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size={size}:rate=10",
            "-pix_fmt", "yuv420p", str(path),
        ],
        check=True,
    )


def make_image(path: Path, size: str = "64x48") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-v", "error",
            "-f", "lavfi", "-i", f"color=c=red:s={size}", "-frames:v", "1", str(path),
        ],
        check=True,
    )


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    # Services resolve media relative to ./output, like the server does.
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    engine = create_engine("sqlite:///" + str(tmp_path / "media.db"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    owner = User(
        email="owner@example.com", email_norm="owner@example.com",
        username="media_owner", username_norm="media_owner",
        display_name="Owner", password_hash="x",
    )
    session.add(owner)
    session.commit()
    yield tmp_path / "output", session, owner
    session.close()
    engine.dispose()


@needs_ffmpeg
def test_probe_reads_duration_and_pixel_size(tmp_path):
    video = tmp_path / "clip.mp4"
    make_video(video, seconds=1.5, size="320x240")
    info = media.probe_media_info(str(video))
    assert info["width"] == 320
    assert info["height"] == 240
    assert 1400 <= info["duration_ms"] <= 1600


@needs_ffmpeg
def test_probe_gives_size_for_stills_and_none_for_unreadable_files(tmp_path):
    image = tmp_path / "still.png"
    make_image(image, "64x48")
    info = media.probe_media_info(str(image))
    assert (info["width"], info["height"]) == (64, 48)

    junk = tmp_path / "junk.mp4"
    junk.write_bytes(b"this is not media")
    assert media.probe_media_info(str(junk)) is None
    assert media.probe_media_info(str(tmp_path / "missing.mp4")) is None


@needs_ffmpeg
def test_new_posts_store_probed_duration_and_size_and_expose_them(workspace):
    output, db, owner = workspace
    make_video(output / "uploads" / "a.mp4", seconds=2.0, size="160x160")
    post = create_or_update_post(db, media_path="uploads/a.mp4", media_type="video", owner=owner, title="A")
    db.commit()
    assert (post.width, post.height) == (160, 160)
    assert 1900 <= post.duration_ms <= 2100

    card = post_card(post, db, owner.id)
    assert card["duration_ms"] == post.duration_ms
    assert (card["width"], card["height"]) == (160, 160)


@needs_ffmpeg
def test_images_keep_their_size_but_never_get_a_runtime(workspace):
    output, db, owner = workspace
    make_image(output / "uploads" / "p.png", "80x60")
    post = create_or_update_post(db, media_path="uploads/p.png", media_type="image", owner=owner)
    assert (post.width, post.height) == (80, 60)
    assert post.duration_ms is None


@needs_ffmpeg
def test_runtime_is_only_kept_for_video_posts(workspace):
    # An animated/odd file registered as an image still has a probeable duration; it must be ignored.
    output, db, owner = workspace
    make_video(output / "uploads" / "anim.mp4", seconds=2.0, size="96x96")
    post = create_or_update_post(db, media_path="uploads/anim.mp4", media_type="image", owner=owner)
    assert post.media_type == "image"
    assert (post.width, post.height) == (96, 96)
    assert post.duration_ms is None


@needs_ffmpeg
def test_replacing_the_file_refreshes_the_numbers(workspace):
    output, db, owner = workspace
    target = output / "uploads" / "r.mp4"
    make_video(target, seconds=1.0, size="128x128")
    post = create_or_update_post(db, media_path="uploads/r.mp4", media_type="video", owner=owner)
    first = post.duration_ms
    make_video(target, seconds=3.0, size="256x256")
    post = create_or_update_post(db, media_path="uploads/r.mp4", media_type="video", owner=owner)
    assert post.duration_ms > first + 1500
    assert (post.width, post.height) == (256, 256)


def test_missing_or_unreadable_media_leaves_values_unknown_without_failing(workspace):
    output, db, owner = workspace
    missing = create_or_update_post(db, media_path="uploads/gone.mp4", media_type="video", owner=owner)
    assert (missing.duration_ms, missing.width, missing.height) == (None, None, None)
    card = post_card(missing, db, owner.id)
    assert card["duration_ms"] is None and card["width"] is None and card["height"] is None

    (output / "uploads").mkdir()
    (output / "uploads" / "bad.mp4").write_bytes(b"not a video")
    bad = create_or_update_post(db, media_path="uploads/bad.mp4", media_type="video", owner=owner)
    assert bad.duration_ms is None


@needs_ffmpeg
def test_a_failed_reprobe_keeps_the_previous_values(workspace):
    output, db, owner = workspace
    target = output / "uploads" / "k.mp4"
    make_video(target, seconds=1.0, size="128x128")
    post = create_or_update_post(db, media_path="uploads/k.mp4", media_type="video", owner=owner)
    kept = (post.duration_ms, post.width, post.height)
    target.write_bytes(b"corrupted afterwards")
    post = create_or_update_post(db, media_path="uploads/k.mp4", media_type="video", owner=owner)
    assert (post.duration_ms, post.width, post.height) == kept


# ── retroactive backfill ────────────────────────────────────────────────────

from sqlalchemy.orm import sessionmaker as _sessionmaker  # noqa: E402

from server.social import services  # noqa: E402
from server.social.models import Post  # noqa: E402


@pytest.fixture
def backfill(workspace, monkeypatch):
    output, db, owner = workspace
    services._media_probe_failed.clear()
    factory = _sessionmaker(bind=db.get_bind(), autoflush=False, expire_on_commit=False)
    calls = []
    real = media.probe_media_info

    def counting(path):
        calls.append(path)
        return real(path)

    monkeypatch.setattr(media, "probe_media_info", counting)

    def add(path, media_type="video"):
        post = Post(owner_id=owner.id, media_path=path, media_type=media_type, title="", caption="",
                    location={}, source="legacy", status="published")
        db.add(post)
        db.commit()
        return post.id

    def row(post_id):
        with factory() as session:
            post = session.get(Post, post_id)
            return post.duration_ms, post.width, post.height

    yield output, factory, add, row, calls
    services._media_probe_failed.clear()


@needs_ffmpeg
def test_backfill_fills_existing_posts_without_a_reupload(backfill):
    output, factory, add, row, calls = backfill
    make_video(output / "uploads" / "old.mp4", seconds=2.0, size="200x100")
    make_image(output / "uploads" / "old.png", "50x40")
    video_id = add("uploads/old.mp4")
    image_id = add("uploads/old.png", "image")
    assert row(video_id) == (None, None, None)

    assert services.backfill_media_info(factory) == 2
    duration, width, height = row(video_id)
    assert (width, height) == (200, 100) and 1900 <= duration <= 2100
    assert row(image_id) == (None, 50, 40)  # still: size only, never a runtime


@needs_ffmpeg
def test_backfill_is_idempotent_and_leaves_filled_posts_alone(backfill):
    output, factory, add, row, calls = backfill
    make_video(output / "uploads" / "a.mp4", seconds=1.0, size="64x64")
    add("uploads/a.mp4")
    make_image(output / "uploads" / "a.png")
    add("uploads/a.png", "image")
    assert services.backfill_media_info(factory) == 2
    probed = len(calls)
    assert services.backfill_media_info(factory) == 0
    assert len(calls) == probed  # nothing was probed again, images included


@needs_ffmpeg
def test_backfill_picks_up_media_that_arrives_later(backfill):
    output, factory, add, row, calls = backfill
    post_id = add("uploads/late.mp4")  # migrated on a machine without the file
    assert services.backfill_media_info(factory) == 0
    assert calls == []  # a missing file is skipped, not probed...
    make_video(output / "uploads" / "late.mp4", seconds=1.5, size="96x96")
    assert services.backfill_media_info(factory) == 1  # ...and not remembered as failed
    assert row(post_id)[1:] == (96, 96)


def test_backfill_does_not_retry_an_unreadable_file_but_retries_a_replaced_one(backfill):
    output, factory, add, row, calls = backfill
    (output / "uploads").mkdir()
    bad = output / "uploads" / "bad.mp4"
    bad.write_bytes(b"not a video")
    post_id = add("uploads/bad.mp4")
    assert services.backfill_media_info(factory) == 0
    assert services.backfill_media_info(factory) == 0
    assert len(calls) == 1  # probed once, then remembered as failed
    assert row(post_id) == (None, None, None)

    if shutil.which("ffmpeg"):
        make_video(bad, seconds=1.0, size="64x64")  # replaced with a real file
        assert services.backfill_media_info(factory) == 1
        assert row(post_id)[1:] == (64, 64)


@needs_ffmpeg
def test_backfill_respects_the_limit_and_finishes_the_rest_next_time(backfill):
    output, factory, add, row, calls = backfill
    ids = []
    for n in range(3):
        make_video(output / "uploads" / f"l{n}.mp4", seconds=1.0, size="32x32")
        ids.append(add(f"uploads/l{n}.mp4"))
    assert services.backfill_media_info(factory, limit=2) == 2
    assert sum(row(i)[1] is not None for i in ids) == 2
    assert services.backfill_media_info(factory, limit=2) == 1
    assert all(row(i)[1] == 32 for i in ids)


def _stream_hash(path: Path) -> str:
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0", "-c", "copy", "-f", "streamhash", "-"],
        capture_output=True, text=True, check=True,
    ).stdout


@needs_ffmpeg
def test_faststart_moves_the_index_forward_without_touching_the_streams(tmp_path):
    source = tmp_path / "clip.mp4"
    make_video(source)
    # Publish remuxes the hidden part file, whose name has no video extension.
    part = tmp_path / ".clip.mp4.part"
    shutil.copy(source, part)
    assert media._moov_after_mdat(part)

    media.make_faststart(part, "mp4")

    assert not media._moov_after_mdat(part)
    assert _stream_hash(part) == _stream_hash(source)
    assert sorted(p.name for p in tmp_path.iterdir()) == [".clip.mp4.part", "clip.mp4"]


def test_faststart_leaves_unreadable_files_alone(tmp_path):
    junk = tmp_path / "junk.mp4"
    junk.write_bytes(b"\x00\x00\x00\x10mdat" + b"\x00" * 8)
    media.make_faststart(junk, "mp4")
    assert junk.read_bytes() == b"\x00\x00\x00\x10mdat" + b"\x00" * 8
    assert [p.name for p in tmp_path.iterdir()] == ["junk.mp4"]
