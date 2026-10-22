"""Upload quotas: sign-in, hourly budget, per-file cap, staged-bytes ceiling, job dir cleanup."""

from __future__ import annotations

import os
import time

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from server import media as SM
from server.jobs import JobManager, JobStatus
from server.output import jobs_root
from server.routers import config, image, social, video
from server.social import auth
from server.social.database import Base, get_db


PASSWORD = "correct-horse-battery"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    # Staging and job dirs live under the tempdir: keep them per-test.
    monkeypatch.setattr("tempfile.tempdir", str(tmp_path))
    monkeypatch.setattr(image, "get_image_dimensions", lambda _path: (1000, 1000))
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "upload-quotas.db"),
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    application.include_router(social.router)
    application.include_router(image.router)
    application.include_router(video.router)
    application.include_router(config.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    before = set(image.STAGED_UPLOADS)
    yield application
    for stage_id in set(image.STAGED_UPLOADS) - before:
        image.STAGED_UPLOADS.pop(stage_id, None)
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


def upload(client, body=b"staged", kind="image"):
    name, mime = ("still.png", "image/png") if kind == "image" else ("clip.mp4", "video/mp4")
    return client.post(
        f"/api/{kind}/upload",
        files={"file": (name, body, mime)},
        headers=csrf_headers(client),
    )


def test_uploads_need_sign_in_and_csrf(app):
    with TestClient(app) as anonymous, TestClient(app) as client:
        for kind in ("image", "video"):
            response = anonymous.post(f"/api/{kind}/upload", files={"file": ("x.png", b"x", "image/png")})
            assert response.status_code == 401
            assert response.json()["detail"]["code"] == "AUTH_REQUIRED"
        register(client, "csrf_uploader")
        no_csrf = client.post("/api/image/upload", files={"file": ("x.png", b"x", "image/png")})
        assert no_csrf.status_code == 403


def test_hourly_upload_budget(app, monkeypatch):
    monkeypatch.setenv("SX_UPLOAD_HOURLY_MAX", "2")
    with TestClient(app) as client:
        register(client, "hourly_uploader")
        assert upload(client).status_code == 200
        assert upload(client).status_code == 200
        refused = upload(client)
        assert refused.status_code == 429
        assert refused.json()["detail"]["code"] == "RATE_LIMITED"


def test_per_file_cap_comes_from_env(app, monkeypatch):
    monkeypatch.setenv("SX_MAX_IMAGE_UPLOAD_MB", "1")
    with TestClient(app) as client:
        register(client, "big_uploader")
        refused = upload(client, body=b"x" * (1024 * 1024 + 1))
        assert refused.status_code == 400
        assert "1MB" in refused.json()["detail"]
        assert list(SM.staging_dir().iterdir()) == []
        assert upload(client, body=b"x" * 1024).status_code == 200


def test_staged_bytes_ceiling_is_storage_full(app, monkeypatch):
    monkeypatch.setenv("SX_STAGED_BYTES_MAX", "100")
    with TestClient(app) as client:
        register(client, "full_uploader")
        assert upload(client, body=b"x" * 60).status_code == 200
        refused = upload(client, body=b"x" * 60)
        assert refused.status_code == 507
        assert refused.json()["detail"]["code"] == "STORAGE_FULL"
        # The refused upload left no partial file behind.
        assert SM.staged_bytes() == 60


def test_config_reports_upload_limits(app, monkeypatch):
    monkeypatch.setenv("SX_MAX_IMAGE_UPLOAD_MB", "20")
    monkeypatch.setenv("SX_MAX_VIDEO_UPLOAD_MB", "95")
    with TestClient(app) as client:
        assert client.get("/api/config").json()["upload_limits"] == {"image_mb": 20, "video_mb": 95}


def test_cleanup_removes_evicted_job_dirs_and_orphans(tmp_path, monkeypatch):
    monkeypatch.setattr("tempfile.tempdir", str(tmp_path))
    manager = JobManager(max_image_workers=1, max_video_workers=1)
    try:
        done = manager.reserve_job("image", "alice")
        live = manager.reserve_job("image", "alice")
        manager.get_job(done).status = JobStatus.COMPLETE
        root = jobs_root()
        for name in (done, live, "orphan", "uploads"):
            (root / name).mkdir(parents=True)
        old = time.time() - 2 * 24 * 3600
        for name in ("orphan", "uploads", live):
            os.utime(root / name, (old, old))

        assert manager.cleanup_old(max_age_seconds=-1) == 1
        assert manager.get_job(done) is None and not (root / done).exists()
        assert manager.sweep_orphan_dirs() == 1
        assert not (root / "orphan").exists()
        assert (root / "uploads").exists() and (root / live).exists()
    finally:
        manager._image_pool.shutdown(wait=False)
        manager._video_pool.shutdown(wait=False)
