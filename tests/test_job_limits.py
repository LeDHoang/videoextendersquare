"""Queue caps: per-user and server-wide job slots (429 QUEUE_FULL)."""

from __future__ import annotations

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from server.jobs import JobManager, JobStatus, QueueFull, job_manager
from server.routers import image, social
from server.social import auth
from server.social.database import Base, get_db


PASSWORD = "correct-horse-battery"


@pytest.fixture
def manager():
    mgr = JobManager(max_image_workers=1, max_video_workers=1)
    yield mgr
    mgr._image_pool.shutdown(wait=False, cancel_futures=True)
    mgr._video_pool.shutdown(wait=False, cancel_futures=True)


def test_per_user_cap(manager, monkeypatch):
    monkeypatch.setenv("SX_MAX_JOBS_PER_USER", "2")
    monkeypatch.setenv("SX_MAX_PENDING_JOBS", "10")
    manager.reserve_job("image", "alice")
    manager.reserve_job("video", "alice")
    with pytest.raises(QueueFull) as caught:
        manager.reserve_job("image", "alice")
    assert caught.value.retry_after == 60
    # Another user still gets a slot.
    manager.reserve_job("image", "bob")


def test_server_wide_cap_and_terminal_jobs_free_slots(manager, monkeypatch):
    monkeypatch.setenv("SX_MAX_JOBS_PER_USER", "5")
    monkeypatch.setenv("SX_MAX_PENDING_JOBS", "2")
    first = manager.reserve_job("image", "alice")
    manager.reserve_job("image", "bob")
    with pytest.raises(QueueFull) as caught:
        manager.reserve_job("image", "carol")
    assert caught.value.retry_after == 120
    for status in (JobStatus.COMPLETE, JobStatus.FAILED, JobStatus.CANCELLED):
        manager.get_job(first).status = status
        third = manager.reserve_job("image", "carol")
        manager.discard_job(third)


def test_uncounted_jobs_do_not_take_slots(manager, monkeypatch):
    monkeypatch.setenv("SX_MAX_JOBS_PER_USER", "1")
    monkeypatch.setenv("SX_MAX_PENDING_JOBS", "1")
    # Admin spatialize batches use create_job and stay outside the caps.
    manager.create_job("video", owner_id="admin")
    manager.create_job("video", owner_id="admin")
    manager.reserve_job("video", "admin")


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    monkeypatch.setenv("SX_MAX_JOBS_PER_USER", "2")
    monkeypatch.setenv("SX_MAX_PENDING_JOBS", "6")
    monkeypatch.setattr("tempfile.tempdir", str(tmp_path))
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "job-limits.db"),
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    application.include_router(social.router)
    application.include_router(image.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(image.job_manager, "submit", lambda *args, **kwargs: None)
    with job_manager._lock:
        before_jobs = set(job_manager._jobs)
    before_stages = set(image.STAGED_UPLOADS)
    yield application
    for stage_id in set(image.STAGED_UPLOADS) - before_stages:
        image.STAGED_UPLOADS.pop(stage_id, None)
    with job_manager._lock:
        for job_id in set(job_manager._jobs) - before_jobs:
            job_manager._jobs.pop(job_id, None)
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


def csrf_headers(client):
    return {"x-csrf-token": client.cookies.get("echo_csrf")}


def upload(client):
    response = client.post(
        "/api/image/upload",
        files={"file": ("square.png", b"staged", "image/png")},
        headers=csrf_headers(client),
    )
    assert response.status_code == 200, response.text
    return response.json()["stage_id"]


def process(client, stage_id):
    return client.post(
        "/api/image/process",
        data={"stage_id": stage_id, "upscale_only": "false", "upscale_engine": "fast"},
        headers=csrf_headers(client),
    )


def test_third_job_for_one_user_is_queue_full(app, monkeypatch):
    monkeypatch.setattr(image, "get_image_dimensions", lambda _path: (1000, 1000))
    with TestClient(app) as client:
        register(client, "busy_user")
        stage_id = upload(client)
        assert process(client, stage_id).status_code == 200
        assert process(client, stage_id).status_code == 200
        refused = process(client, stage_id)
        assert refused.status_code == 429
        assert refused.json()["detail"]["code"] == "QUEUE_FULL"
        assert refused.headers["Retry-After"] == "60"


def test_billing_failure_gives_the_slot_back(app, monkeypatch):
    monkeypatch.setenv("SX_MAX_JOBS_PER_USER", "1")
    # Non-square needs cloud outpaint, so the route reaches billing.
    monkeypatch.setattr(image, "get_image_dimensions", lambda _path: (1000, 500))

    def refuse(*_args, **_kwargs):
        raise image.BillingError("no key")

    monkeypatch.setattr(image, "resolve_fal_key", refuse)
    with TestClient(app) as client:
        user = register(client, "billing_fail")
        stage_id = upload(client)
        for _ in range(2):
            response = process(client, stage_id)
            assert response.status_code == 409, response.text
        with job_manager._lock:
            assert not [rec for rec in job_manager._jobs.values() if rec.owner_id == user["id"]]
