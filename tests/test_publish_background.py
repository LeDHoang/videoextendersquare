"""Video publish returns before the derived encodes; they land afterwards through commit."""

from __future__ import annotations

import logging
import subprocess
import threading
import time
from pathlib import Path

import pytest
from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server import media as SM
from server import media_store
from server.routers import reels, social, uploads
from server.routers import video as video_router
from server.social import auth, database
from server.social.database import Base, get_db
from server.social.models import Post
from server.social.services import post_card, post_media_items
from test_media_store import FakeS3, register

DERIVED = ("-poster.jpg", "-explore.mp4", "-preview.mp4")


class OrderedS3(FakeS3):
    """Fails the test if a local file appears before its R2 object."""

    def upload_file(self, filename, bucket, key, ExtraArgs=None):
        assert not (Path("output") / key).exists(), f"{key} existed locally before its R2 object"
        super().upload_file(filename, bucket, key, ExtraArgs)


class FakeFfmpeg:
    """Stands in for ffmpeg/ffprobe: each encode waits on *gate*, then writes its output."""

    def __init__(self):
        self.gate = threading.Event()
        self.encodes: list[str] = []
        self.fail: set[str] = set()

    def __call__(self, cmd, **kwargs):
        if cmd[0] == "ffprobe":
            if "stream=codec_name" in cmd:
                return subprocess.CompletedProcess(cmd, 0, stdout="hevc\n", stderr="")
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="no probe in tests")
        out = Path(cmd[-1])
        self.encodes.append(out.name)
        assert self.gate.wait(10), "test never released the encode"
        out.write_bytes(b"encoded " + out.name.encode())
        failed = any(out.name.endswith(f"{suffix}.part") for suffix in self.fail)
        return subprocess.CompletedProcess(cmd, 1 if failed else 0, stdout=b"", stderr=b"")


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output" / "uploads").mkdir(parents=True)
    monkeypatch.setenv("SX_MEDIA_BASE_URL", "https://media.example.com")
    monkeypatch.setenv("R2_PUBLIC_BUCKET", "public-media")
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setattr(uploads, "OUTPUT_DIR", Path("output"))
    monkeypatch.setattr(uploads, "UPLOAD_DIR", Path("output") / "uploads")
    s3 = OrderedS3()
    media_store.set_client(s3)
    ffmpeg = FakeFfmpeg()
    monkeypatch.setattr(SM.subprocess, "run", ffmpeg)
    futures = []
    monkeypatch.setattr(uploads, "_submit_derived_assets", lambda fn: futures.append(uploads._derived_pool.submit(fn)))

    engine = create_engine("sqlite:///" + str(tmp_path / "publish.db"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    # The background job checks the post on the module-level session factory.
    monkeypatch.setattr(database, "SessionLocal", Session)
    application = FastAPI()
    application.include_router(social.router)
    application.include_router(uploads.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    with TestClient(application) as client:
        yield client, Session, s3, ffmpeg, futures
    ffmpeg.gate.set()
    for future in futures:
        future.result(timeout=10)
    media_store.set_client(None)
    video_router.STAGED_UPLOADS.pop("bg-video", None)
    engine.dispose()


def publish_video(client, tmp_path):
    user = register(client, "bg_publisher")
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"\x00" * 4096)
    video_router.STAGED_UPLOADS["bg-video"] = (str(source), time.time(), f"user:{user['id']}")
    response = client.post(
        "/api/uploads/publish",
        json={"kind": "video", "title": "Big clip", "stage_id": "bg-video"},
        headers={"x-csrf-token": client.cookies.get("echo_csrf")},
    )
    assert response.status_code == 200, response.text
    return response.json()


def stored_path(body) -> Path:
    return Path("output") / body["rel_path"]


def sibling(stored: Path, suffix: str) -> Path:
    return stored.with_name(stored.stem + suffix)


def part_files() -> list[Path]:
    return list(Path("output/uploads").glob(".*.part"))


def test_publish_returns_before_encodes_and_assets_land_after(setup, tmp_path):
    client, Session, s3, ffmpeg, futures = setup
    body = publish_video(client, tmp_path)
    stored = stored_path(body)

    # Returned while the first encode is still blocked inside ffmpeg.
    assert len(futures) == 1 and not futures[0].done()
    assert body["preview_url"] is None and body["poster_url"] is None
    assert set(s3.objects) == {body["rel_path"]}
    assert stored.exists()
    assert not any(sibling(stored, suffix).exists() for suffix in DERIVED)
    assert SM.derived_pending(stored)
    # Cards fall back to the original, no poster.
    with Session() as db:
        card = post_card(db.query(Post).one(), db)
    assert card["preview_url"] == body["media_url"]
    assert card["poster_url"] is None
    # The grid's request-time generator leaves the pending upload alone.
    encodes_before = list(ffmpeg.encodes)
    assert reels._gen_explore_assets(body["rel_path"]) == (body["rel_path"], None, None, "pending")
    assert ffmpeg.encodes == encodes_before

    ffmpeg.gate.set()
    futures[0].result(timeout=10)

    assert [name for name in ffmpeg.encodes] == [
        f".{stored.stem}-poster.jpg.part",
        f".{stored.stem}-explore.mp4.part",
        f".{stored.stem}-preview.mp4.part",
    ]
    for suffix in DERIVED:
        assert media_store.rel_path(sibling(stored, suffix)) in s3.objects
    # R2 holds the post now: this disk keeps no copy.
    assert not any(path.exists() for path in SM.derived_files(stored))
    assert part_files() == []
    assert not SM.derived_pending(stored)
    with Session() as db:
        card = post_card(db.query(Post).one(), db)
    assert card["preview_url"] == f"https://media.example.com/uploads/{stored.stem}-explore.mp4"
    assert card["poster_url"] == f"https://media.example.com/uploads/{stored.stem}-poster.jpg"


def test_the_post_records_its_files_as_they_land(setup, tmp_path):
    client, Session, s3, ffmpeg, futures = setup
    body = publish_video(client, tmp_path)
    stored = stored_path(body)
    with Session() as db:
        files = db.query(Post).one().media_files
    assert files == {body["rel_path"]: {"bytes": 4096, "codec": "hevc", "width": None, "height": None}}

    ffmpeg.gate.set()
    futures[0].result(timeout=10)
    with Session() as db:
        files = db.query(Post).one().media_files
    assert set(files) == {body["rel_path"], *(media_store.rel_path(sibling(stored, s)) for s in DERIVED)}
    poster = media_store.rel_path(sibling(stored, "-poster.jpg"))
    assert files[poster] == {"bytes": len(s3.objects[poster]["body"])}
    assert files[media_store.rel_path(sibling(stored, "-preview.mp4"))]["codec"] == "hevc"

    # Readers trust the record: the dropped poster is still served (from R2).
    assert not sibling(stored, "-poster.jpg").exists()
    with Session() as db:
        card = post_card(db.query(Post).one(), db)
    assert card["poster_url"] == f"https://media.example.com/uploads/{stored.stem}-poster.jpg"


def test_a_post_with_no_local_files_still_lists_and_previews(setup, tmp_path):
    client, Session, s3, ffmpeg, futures = setup
    body = publish_video(client, tmp_path)
    ffmpeg.gate.set()
    futures[0].result(timeout=10)
    stored = stored_path(body)
    assert not any(path.exists() for path in SM.derived_files(stored))

    with Session() as db:
        files = db.query(Post).one().media_files
        items = post_media_items(db)
    assert [(item["rel_path"], item["size_bytes"]) for item in items] == [(body["rel_path"], 4096)]
    # The Explore tile is answered from the record: nothing is fetched or encoded.
    encodes = len(ffmpeg.encodes)
    rel, preview_url, poster_url, error = reels._gen_explore_assets(body["rel_path"], "mono", files)
    assert error is None
    assert preview_url == f"https://media.example.com/uploads/{stored.stem}-explore.mp4"
    assert poster_url == f"https://media.example.com/uploads/{stored.stem}-poster.jpg"
    assert not stored.exists() and len(ffmpeg.encodes) == encodes


def test_failed_encodes_are_logged_and_leave_a_usable_post(setup, tmp_path, caplog):
    client, Session, s3, ffmpeg, futures = setup
    ffmpeg.fail.add("-explore.mp4")
    original_upload = s3.upload_file

    def upload_file(filename, bucket, key, ExtraArgs=None):
        if key.endswith("-preview.mp4"):
            raise RuntimeError("R2 down")
        original_upload(filename, bucket, key, ExtraArgs)

    s3.upload_file = upload_file
    body = publish_video(client, tmp_path)
    stored = stored_path(body)
    with caplog.at_level(logging.WARNING, logger="server.routers.uploads"):
        ffmpeg.gate.set()
        futures[0].result(timeout=10)

    assert "Could not build the explore preview" in caplog.text
    assert "Could not build the web preview" in caplog.text
    assert set(s3.objects) == {body["rel_path"], media_store.rel_path(sibling(stored, "-poster.jpg"))}
    assert not any(path.exists() for path in SM.derived_files(stored))
    assert part_files() == []
    with Session() as db:
        post = db.query(Post).one()
        assert post.status == "published"
        assert set(post.media_files) == {body["rel_path"], media_store.rel_path(sibling(stored, "-poster.jpg"))}
        card = post_card(post, db)
    assert card["preview_url"] == body["media_url"]
    assert card["poster_url"].endswith("-poster.jpg")


def test_a_raising_build_still_cleans_up(setup, tmp_path, monkeypatch, caplog):
    client, _Session, _s3, ffmpeg, futures = setup

    def explode(src, *args, **kwargs):
        SM._part_path(SM.explore_preview_path(src)).write_bytes(b"half")
        raise RuntimeError("encoder crashed")

    monkeypatch.setattr(SM, "make_explore_preview", explode)
    body = publish_video(client, tmp_path)
    with caplog.at_level(logging.ERROR, logger="server.routers.uploads"):
        ffmpeg.gate.set()
        futures[0].result(timeout=10)
    assert "Building the explore preview" in caplog.text
    assert part_files() == []
    assert media_store.rel_path(sibling(stored_path(body), "-preview.mp4")) in _s3.objects
    assert not SM.derived_pending(stored_path(body))


def test_post_deleted_while_encoding_drops_late_r2_siblings(setup, tmp_path):
    client, Session, s3, ffmpeg, futures = setup
    body = publish_video(client, tmp_path)
    stored = stored_path(body)
    response = client.delete(
        f"/api/posts/{body['post_id']}", headers={"x-csrf-token": client.cookies.get("echo_csrf")}
    )
    assert response.status_code == 200, response.text
    ffmpeg.gate.set()
    futures[0].result(timeout=10)
    assert s3.objects == {}
    # Local copies stay as unserved moderation evidence, like unpublish.
    assert sibling(stored, "-poster.jpg").exists()


def test_startup_sweep_removes_stale_part_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    uploads_dir = tmp_path / "output" / "uploads"
    uploads_dir.mkdir(parents=True)
    (uploads_dir / ".clip-preview.mp4.part").write_bytes(b"half")
    (uploads_dir / "clip.mp4").write_bytes(b"keep")
    assert SM.sweep_part_files() == 1
    assert [path.name for path in uploads_dir.iterdir()] == ["clip.mp4"]
