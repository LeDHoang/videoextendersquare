"""Processing kill switches (/api/admin/switches): gates, cancelling jobs, audit."""

from __future__ import annotations

import threading

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from server import kill_switch
from server.jobs import JobCancelled, JobManager, JobStatus, job_manager
from server.routers import admin, config, image, reels, social, uploads
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import StaffAction


PASSWORD = "correct-horse-battery"
REASON = "abuse wave"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    monkeypatch.setenv("SX_ADMIN_USERS", "admin_user")
    monkeypatch.setattr("tempfile.tempdir", str(tmp_path))
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "kill-switch.db"),
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    for module in (social, image, admin, config, reels, uploads):
        application.include_router(module.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    application.state.Session = Session
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


def set_switches(client, free, paid, cancel_running=False, reason=REASON):
    return client.put(
        "/api/admin/switches",
        json={"free": free, "paid": paid, "cancel_running": cancel_running, "reason": reason},
        headers=csrf_headers(client),
    )


def upload(client):
    return client.post(
        "/api/image/upload",
        files={"file": ("square.png", b"staged", "image/png")},
        headers=csrf_headers(client),
    )


def process(client, stage_id):
    return client.post(
        "/api/image/process",
        data={"stage_id": stage_id, "upscale_only": "false", "upscale_engine": "fast"},
        headers=csrf_headers(client),
    )


def code(response):
    return response.json()["detail"]["code"]


def test_free_switch_stops_free_work_but_not_paid_jobs(app, monkeypatch):
    monkeypatch.setattr(image, "get_image_dimensions", lambda _path: (1000, 1000))
    with TestClient(app) as client:
        register(client, "admin_user")
        stage_id = upload(client).json()["stage_id"]
        response = set_switches(client, free=False, paid=True)
        assert response.status_code == 200, response.text
        assert response.json()["switches"] == {"free": False, "paid": True}
        assert client.get("/api/config").json()["processing"] == {"free": False, "paid": True}

        response = process(client, stage_id)
        assert response.status_code == 503 and code(response) == "FREE_USAGE_PAUSED"
        response = client.post(
            "/api/uploads/publish", json={"kind": "image", "title": "t", "stage_id": "x"}, headers=csrf_headers(client),
        )
        assert response.status_code == 503 and code(response) == "FREE_USAGE_PAUSED"
        response = client.post("/api/reels/explore-preview", json=["a.mp4"], headers=csrf_headers(client))
        assert response.status_code == 503 and code(response) == "FREE_USAGE_PAUSED"

        # Uploads and cloud jobs still pass.
        assert upload(client).status_code == 200
    with app.state.Session() as db:
        kill_switch.require_open(db, paid=True)


def test_all_switch_stops_uploads_and_paid_jobs(app, monkeypatch):
    monkeypatch.setattr(image, "get_image_dimensions", lambda _path: (1000, 500))
    with TestClient(app) as client:
        register(client, "admin_user")
        stage_id = upload(client).json()["stage_id"]
        assert set_switches(client, free=True, paid=False).status_code == 200
        response = upload(client)
        assert response.status_code == 503 and code(response) == "PROCESSING_PAUSED"
        response = process(client, stage_id)
        assert response.status_code == 503 and code(response) == "PROCESSING_PAUSED"

        assert set_switches(client, free=True, paid=True).status_code == 200
        assert upload(client).status_code == 200


def test_cancel_running_stops_free_jobs_and_releases_them(app, monkeypatch):
    manager = JobManager(max_image_workers=1, max_video_workers=1)
    monkeypatch.setattr(admin, "job_manager", manager)
    gate, started = threading.Event(), threading.Event()
    try:
        running = manager.reserve_job("image", "alice")
        manager.submit(running, lambda status_callback: (started.set(), gate.wait(5), status_callback("next")), {})
        assert started.wait(5)
        released = []
        queued_free = manager.reserve_job("image", "bob")
        manager.submit(queued_free, lambda status_callback: "never", {}, on_failure=released.append)
        queued_paid = manager.reserve_job("image", "carol", paid=True)
        manager.submit(queued_paid, lambda status_callback: "paid", {})

        with TestClient(app) as client:
            register(client, "admin_user")
            response = set_switches(client, free=False, paid=True, cancel_running=True)
        assert response.status_code == 200, response.text
        assert response.json()["cancelled"] == 2

        record = manager.get_job(queued_free)
        assert record.status == JobStatus.CANCELLED
        assert record.error == ("CANCELLED", "Cancelled: processing was paused by staff.")
        assert len(released) == 1 and isinstance(released[0], JobCancelled)
        gate.set()
        manager.get_job(running).future.result(timeout=5)
        assert manager.get_job(running).status == JobStatus.CANCELLED
        manager.get_job(queued_paid).future.result(timeout=5)
        assert manager.get_job(queued_paid).status == JobStatus.COMPLETE

        with app.state.Session() as db:
            row = db.query(StaffAction).one()
        assert row.action == "system.kill_switch" and row.reason == REASON
        assert row.details == {
            "before": {"free": True, "paid": True},
            "after": {"free": False, "paid": True},
            "cancelled": 2,
        }
    finally:
        gate.set()
        manager._image_pool.shutdown(wait=False, cancel_futures=True)


def test_only_admins_flip_switches_with_a_reason(app):
    with TestClient(app) as client:
        register(client, "plain_user")
        assert client.get("/api/admin/switches").status_code == 403
        assert set_switches(client, free=False, paid=True).status_code == 403
    with TestClient(app) as client:
        register(client, "admin_user")
        response = set_switches(client, free=False, paid=True, reason="")
        assert response.status_code == 422 and code(response) == "REASON_REQUIRED"
        assert client.get("/api/admin/switches").json()["switches"] == {"free": True, "paid": True}


def test_state_is_read_from_the_database(app):
    with TestClient(app) as client:
        register(client, "admin_user")
        assert set_switches(client, free=False, paid=False).status_code == 200
    # A fresh session (as after a restart) sees the stored state.
    with app.state.Session() as db:
        assert kill_switch.state(db) == {"free": False, "paid": False}
