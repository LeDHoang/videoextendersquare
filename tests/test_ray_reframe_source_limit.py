"""Ray 3.2 reframe accepts a source of 10 s or less.

The quote path refuses longer selections (tests/test_pricing.py); these tests
cover the /api/video/process gate, which BYOK jobs reach without a quote, and
the worker's own check before any fal upload.
"""

from __future__ import annotations

import time

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from pipeline import video_worker
from server.routers import social, video as video_router
from server.social import auth
from server.social.database import Base, get_db

PASSWORD = "correct-horse-battery-99"
RAY = "luma/agent/ray/v3.2/reframe"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret-for-hmac-cookies")
    monkeypatch.setattr(
        auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1)
    )
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "ray-limit.db"),
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    application.include_router(social.router)
    application.include_router(video_router.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    yield application
    engine.dispose()


def _register(client, username):
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


def _stage(tmp_path, user, stage_id):
    path = tmp_path / f"{stage_id}.mp4"
    path.write_bytes(b"not-a-real-video")
    video_router.STAGED_UPLOADS[stage_id] = (str(path), time.time(), f"user:{user['id']}")


def _submit(client, stage_id, **form):
    data = {"stage_id": stage_id, "outpaint_model": RAY, "payment_source": "byok", **form}
    return client.post(
        "/api/video/process",
        data=data,
        headers={"x-csrf-token": client.cookies.get("echo_csrf")},
    )


def _no_billing(*_args, **_kwargs):
    raise AssertionError("billing must not start for a source over the limit")


def test_process_refuses_ray_source_over_ten_seconds(app, tmp_path, monkeypatch):
    monkeypatch.setattr(video_router, "get_video_dimensions_and_duration", lambda *_a, **_k: (1080, 1920, 12.0))
    monkeypatch.setattr(video_router, "create_billing_job", _no_billing)
    monkeypatch.setattr(video_router, "require_billing_secrets", lambda: None)
    with TestClient(app) as client:
        user = _register(client, "ray_limit_user")
        _stage(tmp_path, user, "ray-long")
        try:
            response = _submit(client, "ray-long")
            assert response.status_code == 400, response.text
            detail = response.json()["detail"]
            assert detail["code"] == "SOURCE_TOO_LONG"
            assert "10 s or less" in detail["message"]
        finally:
            video_router.STAGED_UPLOADS.pop("ray-long", None)


def test_process_gate_uses_trimmed_segment_and_skips_square(app, tmp_path, monkeypatch):
    reached = []

    def _billing_reached(*_args, **_kwargs):
        reached.append(True)
        raise video_router.BillingError("stop here")

    monkeypatch.setattr(video_router, "get_video_dimensions_and_duration", lambda *_a, **_k: (1080, 1920, 30.0))
    monkeypatch.setattr(video_router, "create_billing_job", _billing_reached)
    monkeypatch.setattr(video_router, "resolve_fal_key", lambda *_a, **_k: "key")
    monkeypatch.setattr(video_router, "require_billing_secrets", lambda: None)
    with TestClient(app) as client:
        user = _register(client, "ray_trim_user")
        _stage(tmp_path, user, "ray-trim")
        try:
            response = _submit(client, "ray-trim", trim_enabled="true", trim_start="4", trim_duration="9")
            # Past the length gate: the stubbed billing step answered.
            assert response.status_code == 409, response.text
            assert reached == [True]
            bad = _submit(client, "ray-trim", luma_resolution="4k")
            assert bad.status_code == 400
            assert bad.json()["detail"] == "Invalid luma_resolution"
        finally:
            video_router.STAGED_UPLOADS.pop("ray-trim", None)


def test_worker_refuses_long_ray_source_before_upload(tmp_path, monkeypatch):
    uploads = []
    monkeypatch.setattr(video_worker, "get_video_dimensions_and_duration", lambda *_a, **_k: (1080, 1920, 10.5))

    class _FakeFal:
        def __init__(self, *_a, **_k):
            pass

        def upload_file(self, *_a, **_k):
            uploads.append(True)

    monkeypatch.setattr(video_worker.fal_client, "SyncClient", _FakeFal)
    source = tmp_path / "long.mp4"
    source.write_bytes(b"x")
    with pytest.raises(ValueError, match="10 s or less"):
        video_worker.process_video(str(source), "", fal_key="key", outpaint_model=RAY)
    assert uploads == []
