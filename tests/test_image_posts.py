"""Multi-image (slideshow) posts: data model rules, payload, scan, publish."""

from __future__ import annotations

import time

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from server.routers import image as image_router
from server.routers import reels, social, uploads
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import Post, PostSlide, User
from server.social.services import (
    IMAGE_POST_DWELL_MS,
    MAX_POST_IMAGES,
    create_or_update_post,
    post_card,
    post_image_fields,
)

PASSWORD = "correct-horse-battery-99"


@pytest.fixture
def session(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "image-posts.db"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with Session() as db:
        yield db
    engine.dispose()


@pytest.fixture
def owner(session):
    user = User(username="slides", username_norm="slides", display_name="Slides", status="active")
    session.add(user)
    session.flush()
    return user


def test_image_post_keeps_its_slides_in_order(session, owner):
    post = create_or_update_post(
        session, media_path="uploads/a.png", media_type="image", owner=owner, title="A",
        slide_paths=["uploads/b.png", "uploads/c.png"],
    )
    session.commit()
    assert [slide.media_path for slide in post.slides] == ["uploads/b.png", "uploads/c.png"]
    assert [slide.position for slide in post.slides] == [1, 2]
    fields = post_image_fields(post)
    assert [image["path"] for image in fields["images"]] == ["uploads/a.png", "uploads/b.png", "uploads/c.png"]
    assert fields["dwell_ms"] == IMAGE_POST_DWELL_MS == 15_000
    card = post_card(post, session)
    assert len(card["images"]) == 3 and card["dwell_ms"] == 15_000


def test_republish_replaces_slides_and_none_keeps_them(session, owner):
    create_or_update_post(session, media_path="uploads/a.png", media_type="image", owner=owner,
                          slide_paths=["uploads/b.png", "uploads/c.png"])
    post = create_or_update_post(session, media_path="uploads/a.png", media_type="image", owner=owner,
                                 slide_paths=["uploads/c.png"])
    assert [slide.media_path for slide in post.slides] == ["uploads/c.png"]
    post = create_or_update_post(session, media_path="uploads/a.png", media_type="image", owner=owner)
    assert [slide.media_path for slide in post.slides] == ["uploads/c.png"]


def test_single_image_and_video_posts_serialize_without_slides(session, owner):
    image = create_or_update_post(session, media_path="uploads/solo.png", media_type="image", owner=owner)
    video = create_or_update_post(session, media_path="uploads/clip.mp4", media_type="video", owner=owner)
    assert [entry["path"] for entry in post_image_fields(image)["images"]] == ["uploads/solo.png"]
    assert post_image_fields(video) == {"images": [], "dwell_ms": None}


@pytest.mark.parametrize(
    "media_type, slides, message",
    [
        ("video", ["uploads/b.png"], "Only image posts"),
        ("image", [f"uploads/{index}.png" for index in range(MAX_POST_IMAGES)], "at most"),
        ("image", ["uploads/b.png", "uploads/b.png"], "repeat"),
        ("image", ["uploads/a.png"], "repeat"),
    ],
)
def test_invalid_slides_are_rejected(session, owner, media_type, slides, message):
    path = "uploads/a.png" if media_type == "image" else "uploads/a.mp4"
    with pytest.raises(ValueError, match=message):
        create_or_update_post(session, media_path=path, media_type=media_type, owner=owner, slide_paths=slides)


def test_an_image_belongs_to_one_post(session, owner):
    create_or_update_post(session, media_path="uploads/a.png", media_type="image", owner=owner,
                          slide_paths=["uploads/b.png"])
    with pytest.raises(ValueError, match="another post"):
        create_or_update_post(session, media_path="uploads/x.png", media_type="image", owner=owner,
                              slide_paths=["uploads/b.png"])
    with pytest.raises(ValueError, match="another post"):
        create_or_update_post(session, media_path="uploads/y.png", media_type="image", owner=owner,
                              slide_paths=["uploads/a.png"])


def test_deleting_a_post_removes_its_slides(session, owner):
    post = create_or_update_post(session, media_path="uploads/a.png", media_type="image", owner=owner,
                                 slide_paths=["uploads/b.png"])
    session.commit()
    session.delete(post)
    session.commit()
    assert session.query(PostSlide).count() == 0


def test_scan_hides_slides_behind_their_post(monkeypatch):
    scanned = [
        {"rel_path": "uploads/a.png", "filename": "a.png", "media_type": "image", "mtime": 3.0},
        {"rel_path": "uploads/b.png", "filename": "b.png", "media_type": "image", "mtime": 2.0},
        {"rel_path": "uploads/clip.mp4", "filename": "clip.mp4", "media_type": "video", "mtime": 1.0},
    ]
    monkeypatch.setattr(reels.SM, "scan_output_media", lambda _root: list(scanned))
    monkeypatch.setattr(reels, "post_media_items", lambda db=None: [])
    monkeypatch.setattr(reels, "slide_media_paths", lambda db=None: {"uploads/b.png"})
    monkeypatch.setitem(reels._scan_cache, "at", 0.0)
    monkeypatch.setitem(reels._scan_cache, "data", [])
    assert [item["rel_path"] for item in reels._scan_cached()] == ["uploads/a.png", "uploads/clip.mp4"]


# ─── Publish endpoint ────────────────────────────────────────────────────

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret-for-hmac-cookies")
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setattr(uploads, "OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(uploads, "UPLOAD_DIR", tmp_path / "output" / "uploads")
    engine = create_engine("sqlite:///" + str(tmp_path / "publish.db"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    application = FastAPI()
    for router in (social.router, uploads.router, image_router.router):
        application.include_router(router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    with TestClient(application) as test_client:
        test_client.testing_session = Session
        yield test_client
    engine.dispose()


def _register(client, username):
    response = register_verified(client, json={
        "email": f"{username}@example.com", "username": username,
        "password": PASSWORD, "accept_terms": True, "display_name": username,
    })
    assert response.status_code == 200, response.text
    return response.json()["user"]


def _publish(client, body):
    return client.post("/api/uploads/publish", json=body, headers={"x-csrf-token": client.cookies.get("echo_csrf")})


def _stage(tmp_path, user, name, color):
    path = tmp_path / f"{name}.png"
    Image.new("RGB", (32, 32), color).save(path, "PNG")
    image_router.STAGED_UPLOADS[name] = (str(path), time.time(), f"user:{user['id']}")
    return name


def test_publish_multi_image_post(client, tmp_path):
    user = _register(client, "slide_pub")
    stage_ids = [_stage(tmp_path, user, f"slide-pub-{index}", (index, 2, 3)) for index in range(3)]
    try:
        response = _publish(client, {
            "kind": "image", "title": "Three frames",
            "stage_id": stage_ids[0], "extra_stage_ids": stage_ids[1:],
        })
        assert response.status_code == 200, response.text
        images = response.json()["meta"]["images"]
        assert len(images) == 3
        assert all((tmp_path / "output" / image["path"]).is_file() for image in images)
        with client.testing_session() as db:
            post = db.query(Post).one()
            assert post.media_type == "image"
            assert len(post.slides) == 2
    finally:
        for stage_id in stage_ids:
            image_router.STAGED_UPLOADS.pop(stage_id, None)


def test_publish_rejects_mixed_or_oversized_posts(client, tmp_path):
    user = _register(client, "slide_reject")
    stage_ids = [_stage(tmp_path, user, f"slide-reject-{index}", (index, 4, 5)) for index in range(MAX_POST_IMAGES + 1)]
    try:
        video_with_images = _publish(client, {
            "kind": "video", "title": "Mixed", "stage_id": stage_ids[0], "extra_stage_ids": stage_ids[1:2],
        })
        assert video_with_images.status_code == 400
        too_many = _publish(client, {
            "kind": "image", "title": "Too many", "stage_id": stage_ids[0], "extra_stage_ids": stage_ids[1:],
        })
        assert too_many.status_code == 400
        assert "at most" in too_many.text
        repeated = _publish(client, {
            "kind": "image", "title": "Twice", "stage_id": stage_ids[0], "extra_stage_ids": [stage_ids[0]],
        })
        assert repeated.status_code == 400
        with_job = _publish(client, {
            "kind": "image", "title": "Extended", "job_id": "nope", "extra_stage_ids": stage_ids[1:2],
        })
        assert with_job.status_code == 400
        with client.testing_session() as db:
            assert db.query(Post).count() == 0
        assert not list((tmp_path / "output").rglob("*.png"))
    finally:
        for stage_id in stage_ids:
            image_router.STAGED_UPLOADS.pop(stage_id, None)


def _job(tmp_path, owner_id, job_id, color, *, size=(32, 32), kind="image", ext="png", **result):
    """A finished job whose result is an image of one colour."""
    from server.jobs import JobStatus, job_manager

    path = tmp_path / f"{job_id}.{ext}"
    Image.new("RGB", size, color).save(path, "PNG")
    job_manager.create_job(kind=kind, owner_id=owner_id, job_id=job_id)
    record = job_manager.get_job(job_id)
    with record._lock:
        record.status = JobStatus.COMPLETE
        record.result = {"path": str(path), **result}
    return job_id


def _drop_jobs(*job_ids):
    from server.jobs import job_manager

    for job_id in job_ids:
        job_manager.discard_job(job_id)


def test_publish_multi_image_post_from_made_square_results(client, tmp_path):
    user = _register(client, "slide_jobs")
    cover = _job(tmp_path, user["id"], "slidejobcov1", (10, 0, 0))
    second = _job(tmp_path, user["id"], "slidejobtwo1", (20, 0, 0))
    third = _stage(tmp_path, user, "slide-jobs-stage", (30, 0, 0))
    try:
        response = _publish(client, {
            "kind": "image", "title": "Made square", "job_id": cover,
            "extra_items": [{"job_id": second}, {"stage_id": third}],
        })
        assert response.status_code == 200, response.text
        images = response.json()["meta"]["images"]
        reds = [Image.open(tmp_path / "output" / image["path"]).convert("RGB").getpixel((0, 0))[0] for image in images]
        assert reds == [10, 20, 30]
    finally:
        _drop_jobs(cover, second)
        image_router.STAGED_UPLOADS.pop(third, None)


def test_publish_rejects_slides_that_are_foreign_3d_or_not_images(client, tmp_path):
    user = _register(client, "slide_jobs_bad")
    cover = _stage(tmp_path, user, "slide-bad-cover", (1, 1, 1))
    foreign = _job(tmp_path, "someone-else", "slidejobfor1", (2, 2, 2))
    stereo = _job(tmp_path, user["id"], "slidejobsbs1", (3, 3, 3), size=(64, 32), stereo_layout="sbs")
    clip = _job(tmp_path, user["id"], "slidejobvid1", (4, 4, 4), kind="video", ext="mp4")
    try:
        def post(extra):
            return _publish(client, {"kind": "image", "title": "Bad", "stage_id": cover, "extra_items": [extra]})

        assert post({"job_id": foreign}).status_code == 403
        assert post({"job_id": stereo}).status_code == 422
        assert post({"job_id": clip}).status_code == 400
        assert post({"stage_id": cover}).status_code == 400
        assert post({"stage_id": cover, "job_id": foreign}).status_code == 400
        with client.testing_session() as db:
            assert db.query(Post).count() == 0
    finally:
        _drop_jobs(foreign, stereo, clip)
        image_router.STAGED_UPLOADS.pop(cover, None)

