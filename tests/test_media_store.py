"""Published media storage: R2 upload-then-rename, URLs, unpublish keeps the objects."""

from __future__ import annotations

import io
import shutil
import time
import subprocess
from pathlib import Path
from types import SimpleNamespace

from argon2 import PasswordHasher
from botocore.exceptions import ClientError
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from server import media as SM
from server import media_store
from server.routers import social
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import Post, PostSlide
from server.social.services import post_card, post_media_files


PASSWORD = "correct-horse-battery"
needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


class FakeS3:
    def __init__(self, fail_uploads=False):
        self.objects: dict[str, dict] = {}
        self.deleted: list[list[str]] = []
        self.fail_uploads = fail_uploads

    def upload_file(self, filename, bucket, key, ExtraArgs=None):
        if self.fail_uploads:
            raise RuntimeError("R2 down")
        assert bucket == "public-media"
        self.objects[key] = {"body": Path(filename).read_bytes(), **(ExtraArgs or {})}

    def download_file(self, bucket, key, filename):
        assert bucket == "public-media"
        if key not in self.objects:
            raise ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
        Path(filename).write_bytes(self.objects[key]["body"])

    def put_object(self, Bucket, Key, Body, **extra):
        if self.fail_uploads:
            raise RuntimeError("R2 down")
        assert Bucket == "public-media"
        self.objects[Key] = {"body": Body, **extra}

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "Not Found"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[Key]["body"])}

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
        return {"ContentLength": len(self.objects[Key]["body"])}

    def delete_objects(self, Bucket, Delete):
        keys = [item["Key"] for item in Delete["Objects"]]
        self.deleted.append(keys)
        for key in keys:
            self.objects.pop(key, None)
        return {}


@pytest.fixture
def workdir(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output" / "uploads").mkdir(parents=True)
    yield tmp_path
    media_store.set_client(None)


@pytest.fixture
def r2(workdir, monkeypatch):
    monkeypatch.setenv("SX_MEDIA_BASE_URL", "https://media.example.com")
    monkeypatch.setenv("R2_PUBLIC_BUCKET", "public-media")
    fake = FakeS3()
    media_store.set_client(fake)
    return fake


def test_urls_keep_dev_mount_without_r2(workdir, monkeypatch):
    monkeypatch.delenv("SX_MEDIA_BASE_URL", raising=False)
    monkeypatch.delenv("R2_PUBLIC_BUCKET", raising=False)
    assert not media_store.enabled()
    assert media_store.public_url("uploads/a.mp4") == "/media/uploads/a.mp4"
    assert media_store.url_for_path(Path("output/uploads/a.mp4")) == "/media/uploads/a.mp4"
    assert media_store.url_for_path(workdir / "elsewhere.mp4") is None


def test_urls_point_at_media_domain_with_r2(r2):
    assert media_store.public_url("uploads/a.mp4") == "https://media.example.com/uploads/a.mp4"
    assert media_store.public_url("/uploads/a.mp4") == "https://media.example.com/uploads/a.mp4"


def test_endpoint_defaults_to_r2_account(monkeypatch):
    monkeypatch.setenv("R2_ACCOUNT_ID", "abc123")
    monkeypatch.delenv("R2_ENDPOINT_URL", raising=False)
    assert media_store.endpoint_url() == "https://abc123.r2.cloudflarestorage.com"


def test_endpoint_override_points_at_stand_in(monkeypatch):
    monkeypatch.setenv("R2_ACCOUNT_ID", "abc123")
    monkeypatch.setenv("R2_ENDPOINT_URL", " http://minio:9000 ")
    assert media_store.endpoint_url() == "http://minio:9000"


def test_commit_uploads_published_files_before_renaming(r2):
    part = Path("output/uploads/.clip.mp4.part")
    part.write_bytes(b"video")
    media_store.commit(part, Path("output/uploads/clip.mp4"))
    assert Path("output/uploads/clip.mp4").read_bytes() == b"video"
    assert not part.exists()
    stored = r2.objects["uploads/clip.mp4"]
    assert stored["body"] == b"video"
    assert stored["ContentType"] == "video/mp4"
    assert stored["CacheControl"] == "public, max-age=86400"


def test_commit_skips_upload_outside_uploads(r2):
    Path("output/testpipeline").mkdir()
    part = Path("output/testpipeline/.x.jpg.part")
    part.write_bytes(b"jpg")
    media_store.commit(part, Path("output/testpipeline/x.jpg"))
    assert Path("output/testpipeline/x.jpg").exists()
    assert r2.objects == {}


def test_failed_upload_never_creates_the_local_file(r2):
    r2.fail_uploads = True
    dest = Path("output/uploads/poster.jpg")
    part = SM._part_path(dest)
    part.write_bytes(b"jpg")
    with pytest.raises(media_store.MediaStoreError):
        media_store.commit(part, dest)
    assert not dest.exists()
    # The generator wrapper swallows the error and drops the part.
    part.write_bytes(b"jpg")
    assert SM._commit_part(part, dest) is None
    assert not part.exists() and not dest.exists()


def test_republish_uploads_kept_local_copies(r2):
    Path("output/uploads/clip.mp4").write_bytes(b"video")
    count = media_store.republish_paths([
        Path("output/uploads/clip.mp4"),
        Path("output/uploads/clip-preview.mp4"),  # never generated: skipped
    ])
    assert count == 1
    assert r2.objects["uploads/clip.mp4"]["body"] == b"video"
    r2.fail_uploads = True
    with pytest.raises(media_store.MediaStoreError):
        media_store.republish_paths([Path("output/uploads/clip.mp4")])


def test_fetch_local_downloads_a_dropped_copy(r2):
    r2.objects["uploads/clip.mp4"] = {"body": b"video"}
    dest = Path("output/uploads/clip.mp4")
    assert media_store.fetch_local(dest)
    assert dest.read_bytes() == b"video"
    assert not Path("output/uploads/.clip.mp4.part").exists()
    # Seed media outside uploads/ is fetched by its key too.
    r2.objects["testpipeline/x.mp4"] = {"body": b"seed"}
    assert media_store.fetch_local(Path("output/testpipeline/x.mp4"))
    assert Path("output/testpipeline/x.mp4").read_bytes() == b"seed"
    # Already local: no download.
    r2.objects.clear()
    assert media_store.fetch_local(dest)


def test_fetch_local_fails_without_an_object(r2, caplog):
    assert not media_store.fetch_local(Path("output/uploads/gone.mp4"))
    assert "R2 download" in caplog.text
    assert list(Path("output/uploads").iterdir()) == []
    Path("output/testpipeline").mkdir()
    assert not media_store.fetch_local(Path("output/testpipeline/x.mp4"))


def test_fetch_local_is_a_no_op_without_r2(workdir):
    assert not media_store.fetch_local(Path("output/uploads/clip.mp4"))


def test_drop_local_removes_only_copies_r2_holds(r2, caplog):
    for name, body in (("same.mp4", b"video"), ("short.mp4", b"video"), ("local-only.mp4", b"video")):
        Path("output/uploads", name).write_bytes(body)
    r2.objects["uploads/same.mp4"] = {"body": b"video"}
    r2.objects["uploads/short.mp4"] = {"body": b"vid"}
    Path("output/testpipeline").mkdir()
    Path("output/testpipeline/x.mp4").write_bytes(b"video")
    r2.objects["testpipeline/x.mp4"] = {"body": b"video"}
    Path("outside.mp4").write_bytes(b"video")
    count = media_store.drop_local([
        Path("output/uploads/same.mp4"),
        Path("output/uploads/short.mp4"),  # its object differs: kept
        Path("output/uploads/local-only.mp4"),  # never reached R2: kept
        Path("output/uploads/never-built.mp4"),
        Path("output/testpipeline/x.mp4"),  # seed media R2 holds: dropped
        Path("outside.mp4"),  # not under output/: kept
    ])
    assert count == 2
    assert not Path("output/uploads/same.mp4").exists()
    assert Path("output/uploads/short.mp4").exists()
    assert Path("output/uploads/local-only.mp4").exists()
    assert not Path("output/testpipeline/x.mp4").exists()
    assert Path("outside.mp4").exists()
    assert "its R2 object has 3 bytes, this copy 5" in caplog.text


def test_drop_local_keeps_the_copy_when_r2_cannot_be_checked(r2, caplog):
    def boom(**_kwargs):
        raise RuntimeError("R2 down")

    r2.head_object = boom
    Path("output/uploads/clip.mp4").write_bytes(b"video")
    assert media_store.drop_local([Path("output/uploads/clip.mp4")]) == 0
    assert Path("output/uploads/clip.mp4").exists()
    assert "could not check its R2 object" in caplog.text


def test_drop_local_is_a_no_op_without_r2(workdir):
    Path("output/uploads/clip.mp4").write_bytes(b"video")
    assert media_store.drop_local([Path("output/uploads/clip.mp4")]) == 0
    assert Path("output/uploads/clip.mp4").exists()


def test_delete_skips_unpublished_keys_and_batches(r2, monkeypatch):
    monkeypatch.setattr(media_store, "_DELETE_BATCH", 2)
    count = media_store.delete(["uploads/a.mp4", "uploads/b.jpg", "uploads/c.jpg", "testpipeline/x.mp4"])
    assert count == 3
    assert r2.deleted == [["uploads/a.mp4", "uploads/b.jpg"], ["uploads/c.jpg"]]


def test_delete_is_best_effort(r2, caplog):
    def boom(**_kwargs):
        raise RuntimeError("R2 down")

    r2.delete_objects = boom
    assert media_store.delete(["uploads/a.mp4"]) == 1
    assert "R2 delete" in caplog.text


def test_delete_is_a_no_op_without_r2(workdir, monkeypatch):
    monkeypatch.delenv("R2_PUBLIC_BUCKET", raising=False)
    assert media_store.delete(["uploads/a.mp4"]) == 0


def test_post_media_files_cover_slides_and_siblings(workdir):
    post = SimpleNamespace(
        media_path="uploads/cover.jpg",
        slides=[SimpleNamespace(media_path="uploads/slide.jpg")],
    )
    names = {path.name for path in post_media_files([post])}
    assert {"cover.jpg", "cover-poster.jpg", "slide.jpg", "slide-poster.jpg", "cover-mono.jpg"} <= names


@needs_ffmpeg
def test_image_poster_writes_jpeg_through_commit(r2):
    src = Path("output/uploads/still.png")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48", "-frames:v", "1", str(src)],
        check=True,
    )
    poster = SM.make_image_poster(str(src), height=32)
    assert poster and Path(poster).read_bytes()[:3] == b"\xff\xd8\xff"
    assert r2.objects["uploads/still-poster.jpg"]["ContentType"] == "image/jpeg"
    assert not list(Path("output/uploads").glob(".*.part"))


@needs_ffmpeg
def test_explore_preview_and_poster_write_through_commit(r2):
    src = Path("output/uploads/clip.mp4")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=128x96:d=1:r=10",
         "-pix_fmt", "yuv420p", str(src)],
        check=True,
    )
    preview = SM.make_explore_preview(str(src))
    poster = SM.make_explore_poster(str(src))
    assert preview and poster
    assert media_store.rel_path(preview) in r2.objects
    assert r2.objects[media_store.rel_path(poster)]["body"][:3] == b"\xff\xd8\xff"
    assert not list(Path("output/uploads").glob(".*.part"))


# ─── Unpublish routes ────────────────────────────────────────────────────

@pytest.fixture
def app(r2, workdir, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    engine = create_engine(
        "sqlite:///" + str(workdir / "media-store.db"),
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    application.include_router(social.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    application.state.Session = Session
    yield application
    engine.dispose()


def register(client, username):
    response = register_verified(client,
        json={
            "email": f"{username}@example.com",
            "username": username,
            "password": PASSWORD,
            "accept_terms": True,
            "display_name": username,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]


def test_owner_delete_only_hides_the_post(app, r2):
    for name in ("cover.jpg", "cover-poster.jpg", "slide.jpg"):
        Path("output/uploads", name).write_bytes(b"x")
        r2.objects[f"uploads/{name}"] = {"body": b"x"}
    with TestClient(app) as client:
        user = register(client, "unpublisher")
        with app.state.Session() as db:
            post = Post(owner_id=user["id"], media_path="uploads/cover.jpg", media_type="image")
            post.slides.append(PostSlide(media_path="uploads/slide.jpg", position=1))
            db.add(post)
            db.commit()
            post_id = post.id
        response = client.delete(f"/api/posts/{post_id}", headers={"x-csrf-token": client.cookies.get("echo_csrf")})
        assert response.status_code == 200, response.text
    assert set(r2.objects) == {"uploads/cover.jpg", "uploads/cover-poster.jpg", "uploads/slide.jpg"}
    assert r2.deleted == []


# ─── Publish ─────────────────────────────────────────────────────────────

@pytest.fixture
def publisher(app, workdir, monkeypatch):
    from server.routers import image as image_router
    from server.routers import uploads

    monkeypatch.setattr(uploads, "OUTPUT_DIR", Path("output"))
    monkeypatch.setattr(uploads, "UPLOAD_DIR", Path("output") / "uploads")
    app.include_router(uploads.router)
    before = set(image_router.STAGED_UPLOADS)

    def stage(user):
        from PIL import Image

        path = workdir / "staged.png"
        Image.new("RGB", (96, 64), (200, 40, 40)).save(path, "PNG")
        image_router.STAGED_UPLOADS["publish-stage"] = (str(path), time.time(), f"user:{user['id']}")
        return "publish-stage"

    yield stage
    for stage_id in set(image_router.STAGED_UPLOADS) - before:
        image_router.STAGED_UPLOADS.pop(stage_id, None)


def _publish(client, stage_id):
    return client.post(
        "/api/uploads/publish",
        json={"kind": "image", "title": "Still", "stage_id": stage_id},
        headers={"x-csrf-token": client.cookies.get("echo_csrf")},
    )


@needs_ffmpeg
def test_publish_stores_original_and_poster_in_r2(app, publisher, r2):
    with TestClient(app) as client:
        stage_id = publisher(register(client, "r2_publisher"))
        response = _publish(client, stage_id)
        assert response.status_code == 200, response.text
        body = response.json()
    rel = body["rel_path"]
    assert body["media_url"] == f"https://media.example.com/{rel}"
    assert body["poster_url"].startswith("https://media.example.com/uploads/")
    assert rel in r2.objects
    assert any(key.endswith("-poster.jpg") for key in r2.objects)
    # R2 holds the post from here on: this disk keeps no copy, and its card still reads.
    assert [path.name for path in Path("output/uploads").iterdir()] == []
    with app.state.Session() as db:
        card = post_card(db.query(Post).one(), db)
    assert card["url"] == body["media_url"]
    assert card["images"][0]["poster_url"] == body["poster_url"]


def test_publish_with_r2_down_is_503_and_leaves_nothing(app, publisher, r2):
    r2.fail_uploads = True
    with TestClient(app) as client:
        stage_id = publisher(register(client, "r2_down"))
        response = _publish(client, stage_id)
        assert response.status_code == 503, response.text
        assert response.json()["detail"]["code"] == "STORAGE_UNAVAILABLE"
        with app.state.Session() as db:
            assert db.query(Post).count() == 0
    assert list(Path("output/uploads").iterdir()) == []
