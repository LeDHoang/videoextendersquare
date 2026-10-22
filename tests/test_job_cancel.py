"""Job cancellation: queued, running, finished, and the owner-only route."""

from __future__ import annotations

from concurrent.futures import Future
import threading

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from server.jobs import JobCancelled, JobManager, JobStatus, job_manager
from server.routers import image, social
from server.social import auth
from server.social.database import Base, get_db


PASSWORD = "correct-horse-battery"


@pytest.fixture
def manager():
    mgr = JobManager(max_image_workers=1, max_video_workers=1)
    yield mgr
    mgr._image_pool.shutdown(wait=False, cancel_futures=True)


def _wait_terminal(record, timeout=5.0):
    record.future.result(timeout=timeout)
    return record


def test_queued_job_cancels_at_once_and_releases(manager):
    gate = threading.Event()
    blocker = manager.reserve_job("image", "alice")
    manager.submit(blocker, lambda status_callback: gate.wait(5), {})
    failures = []
    queued = manager.reserve_job("image", "alice")
    manager.submit(queued, lambda status_callback: "never", {}, on_failure=failures.append)

    assert manager.cancel(queued) is True
    record = manager.get_job(queued)
    assert record.status == JobStatus.CANCELLED
    assert record.error == ("CANCELLED", "Cancelled by user.")
    assert len(failures) == 1 and isinstance(failures[0], JobCancelled)
    gate.set()
    _wait_terminal(manager.get_job(blocker))


def test_running_job_stops_at_next_progress_report(manager):
    started, release = threading.Event(), threading.Event()
    stages = []

    def worker(status_callback):
        status_callback("stage one")
        stages.append("one")
        started.set()
        release.wait(5)
        status_callback("stage two")  # raises once cancelled
        stages.append("two")
        return "done"

    failures, successes = [], []
    job_id = manager.reserve_job("image", "alice")
    manager.submit(job_id, worker, {}, on_success=successes.append, on_failure=failures.append)
    assert started.wait(5)
    assert manager.cancel(job_id) is True
    release.set()
    record = _wait_terminal(manager.get_job(job_id))
    assert record.status == JobStatus.CANCELLED
    assert stages == ["one"]
    assert successes == [] and len(failures) == 1


def test_finished_job_cannot_be_cancelled(manager):
    job_id = manager.reserve_job("image", "alice")
    manager.submit(job_id, lambda status_callback: "ok", {})
    record = _wait_terminal(manager.get_job(job_id))
    assert record.status == JobStatus.COMPLETE
    assert manager.cancel(job_id) is False
    assert manager.cancel("unknown") is False


def test_cancel_after_worker_returns_keeps_the_result(manager):
    def worker(status_callback):
        return "ok"

    def settle(result):
        # A cancel landing during settlement must not undo it.
        manager.get_job(job_id).cancel_event.set()

    job_id = manager.reserve_job("image", "alice")
    manager.submit(job_id, worker, {}, on_success=settle)
    record = _wait_terminal(manager.get_job(job_id))
    assert record.status == JobStatus.COMPLETE
    assert record.result == "ok"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "job-cancel.db"),
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
    with job_manager._lock:
        before = set(job_manager._jobs)
    yield application
    with job_manager._lock:
        for job_id in set(job_manager._jobs) - before:
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


def _queued_job(owner_id):
    """A reserved job whose future has not started, as if waiting for a worker."""
    job_id = job_manager.reserve_job("image", owner_id)
    record = job_manager.get_job(job_id)
    record.future = Future()
    record.on_failure = lambda ex: setattr(record, "refunded", True)
    return job_id, record


def test_cancel_route_is_owner_only_and_csrf_checked(app):
    with TestClient(app) as owner, TestClient(app) as other, TestClient(app) as anonymous:
        user = register(owner, "cancel_owner")
        register(other, "cancel_other")
        job_id, record = _queued_job(user["id"])
        url = f"/api/image/jobs/{job_id}/cancel"

        assert anonymous.post(url).status_code == 401
        assert owner.post(url).status_code == 403
        assert other.post(url, headers=csrf_headers(other)).status_code == 404
        assert record.status == JobStatus.QUEUED

        accepted = owner.post(url, headers=csrf_headers(owner))
        assert accepted.status_code == 202
        assert accepted.json() == {"job_id": job_id, "status": "cancelled"}
        assert getattr(record, "refunded", False) is True

        again = owner.post(url, headers=csrf_headers(owner))
        assert again.status_code == 409
        assert again.json()["detail"]["code"] == "JOB_FINISHED"

        status = owner.get(f"/api/image/jobs/{job_id}")
        assert status.json()["status"] == "cancelled"


def test_job_responses_hide_server_paths(app):
    with TestClient(app) as owner:
        user = register(owner, "path_owner")
        job_id = job_manager.reserve_job("image", user["id"])
        record = job_manager.get_job(job_id)
        record.status = JobStatus.COMPLETE
        record.result = {
            "path": "/srv/output/x.png",
            "preview": "/srv/output/x-preview.png",
            "download_url": f"/api/image/jobs/{job_id}/download",
        }
        for url in (f"/api/image/jobs/{job_id}", f"/api/image/jobs/{job_id}/result"):
            body = owner.get(url).json()
            result = body.get("result", body)
            assert "path" not in result and "preview" not in result
            assert result["download_url"].endswith("/download")
