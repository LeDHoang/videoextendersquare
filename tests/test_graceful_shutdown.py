"""Graceful shutdown: queued jobs cancelled and refunded, 503 after drain, lost encodes re-queued at boot."""

from __future__ import annotations

import logging
from unittest.mock import patch
import threading
from pathlib import Path

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server import media as SM
from server.jobs import JobCancelled, JobManager, JobStatus, ShuttingDown
from server.routers import image, social, uploads
from server.social import auth, database
from server.social.database import Base, get_db
from server.social.models import Post, User

# server.app calls load_dotenv() at import; keep the developer's .env out of
# the test process (see test_production_boot.py).
with patch("dotenv.load_dotenv"):
    from server import app as app_module

PASSWORD = "correct-horse-battery"


@pytest.fixture
def manager():
    mgr = JobManager(max_image_workers=1, max_video_workers=1)
    yield mgr
    mgr.shutdown(drain_s=0)


def test_queued_job_is_cancelled_and_refunded_on_shutdown(manager):
    started, release = threading.Event(), threading.Event()
    progress = []

    def slow_worker(status_callback):
        status_callback("stage one")
        started.set()
        release.wait(5)
        progress.append("after release")
        status_callback("stage two")  # raises: shutdown set the cancel flag
        return "never"

    refunds = []
    running = manager.reserve_job("image", "alice")
    manager.submit(running, slow_worker, {}, on_failure=refunds.append)
    assert started.wait(5)
    queued = manager.reserve_job("image", "bob")
    manager.submit(queued, lambda status_callback: "never", {}, on_failure=refunds.append)

    timer = threading.Timer(0.2, release.set)
    timer.start()
    summary = manager.shutdown(drain_s=5)
    timer.join()

    assert summary == {"cancelled": 1, "running": 1, "unfinished": 0}
    queued_record = manager.get_job(queued)
    assert queued_record.status == JobStatus.CANCELLED
    assert queued_record.error == ("CANCELLED", "Cancelled: the server restarted.")
    running_record = manager.get_job(running)
    assert running_record.status == JobStatus.CANCELLED
    assert progress == ["after release"]
    # Both failure callbacks (the billing refund path) ran with JobCancelled.
    assert len(refunds) == 2 and all(isinstance(ex, JobCancelled) for ex in refunds)


def test_shutdown_returns_at_the_deadline(manager):
    release = threading.Event()
    job_id = manager.reserve_job("image", "alice")
    manager.submit(job_id, lambda status_callback: release.wait(5), {})
    summary = manager.shutdown(drain_s=0.1)
    assert summary["unfinished"] == 1
    release.set()


def test_reserve_and_submit_refused_after_shutdown(manager):
    job_id = manager.create_job("video", owner_id="admin")
    manager.shutdown(drain_s=0)
    with pytest.raises(ShuttingDown):
        manager.reserve_job("image", "alice")
    with pytest.raises(ShuttingDown):
        manager.submit(job_id, lambda status_callback: None, {})
    manager.start()
    assert manager.reserve_job("image", "alice")


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    monkeypatch.setattr("tempfile.tempdir", str(tmp_path))
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "graceful-shutdown.db"),
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
    before_stages = set(image.STAGED_UPLOADS)
    yield application
    for stage_id in set(image.STAGED_UPLOADS) - before_stages:
        image.STAGED_UPLOADS.pop(stage_id, None)
    engine.dispose()


def test_submit_after_shutdown_is_503(app, manager, monkeypatch):
    monkeypatch.setattr(image, "job_manager", manager)
    monkeypatch.setattr(image, "get_image_dimensions", lambda _path: (1000, 1000))
    manager.shutdown(drain_s=0)
    with TestClient(app) as client:
        response = client.post(
            "/api/auth/register",
            json={
                "email": "late@example.com",
                "username": "late_submitter",
                "password": PASSWORD,
                "accept_terms": True,
                "display_name": "late",
            },
        )
        assert response.status_code == 200, response.text
        headers = {"x-csrf-token": client.cookies.get("echo_csrf")}
        staged = client.post(
            "/api/image/upload",
            files={"file": ("square.png", b"staged", "image/png")},
            headers=headers,
        )
        assert staged.status_code == 200, staged.text
        refused = client.post(
            "/api/image/process",
            data={"stage_id": staged.json()["stage_id"], "upscale_only": "false", "upscale_engine": "fast"},
            headers=headers,
        )
    assert refused.status_code == 503
    assert refused.json()["detail"]["code"] == "SHUTTING_DOWN"
    assert refused.headers["Retry-After"] == "60"


# ─── Boot re-enqueue of derived encodes ─────────────────────────────────────


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output" / "uploads").mkdir(parents=True)
    monkeypatch.setattr(uploads, "OUTPUT_DIR", Path("output"))
    monkeypatch.setattr(uploads, "UPLOAD_DIR", Path("output") / "uploads")
    engine = create_engine("sqlite:///" + str(tmp_path / "requeue.db"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", Session)
    # Originals are H.264, so no web preview is expected.
    monkeypatch.setattr(SM, "get_video_codec", lambda _src: "h264")
    encodes: list[str] = []

    def fake_poster(src, height=720, crop=None):
        dest = SM.explore_poster_path(src)
        dest.write_bytes(b"poster")
        encodes.append(dest.name)
        return str(dest)

    def fake_preview(src, height=720, crop=None):
        dest = SM.explore_preview_path(src)
        if not dest.exists():
            dest.write_bytes(b"preview")
            encodes.append(dest.name)
        return str(dest)

    monkeypatch.setattr(SM, "make_explore_poster", fake_poster)
    monkeypatch.setattr(SM, "make_explore_preview", fake_preview)
    monkeypatch.setattr(SM, "make_web_preview", lambda src, **_kwargs: src)
    futures = []
    monkeypatch.setattr(uploads, "_submit_derived_assets", lambda fn: futures.append(uploads._derived_pool.submit(fn)))
    with Session() as db:
        owner = User(username="owner", username_norm="owner", display_name="Owner", status="active")
        db.add(owner)
        db.commit()
        owner_id = owner.id

    def add_post(name: str, *, poster: bool, preview: bool = True, status: str = "published") -> Path:
        stored = Path("output") / "uploads" / f"{name}.mp4"
        stored.write_bytes(b"original")
        if poster:
            SM.explore_poster_path(str(stored)).write_bytes(b"poster")
        if preview:
            SM.explore_preview_path(str(stored)).write_bytes(b"preview")
        with Session() as db:
            db.add(Post(owner_id=owner_id, media_path=f"uploads/{name}.mp4", media_type="video",
                        title=name, caption="", status=status))
            db.commit()
        return stored

    yield add_post, encodes, futures
    for future in futures:
        future.result(timeout=10)
    engine.dispose()


def test_post_with_a_missing_poster_is_re_encoded_at_boot(library):
    add_post, encodes, futures = library
    lost = add_post("lost-poster", poster=False)
    add_post("complete", poster=True)
    add_post("hidden", poster=False, status="hidden")

    assert uploads.requeue_missing_derived() == 1
    for future in futures:
        future.result(timeout=10)

    assert encodes == ["lost-poster-poster.jpg"]
    assert SM.explore_poster_path(str(lost)).read_bytes() == b"poster"
    assert not SM.derived_pending(lost)
    # Nothing is left to do on the next boot.
    assert uploads.requeue_missing_derived() == 0


def test_boot_requeue_is_capped(library):
    add_post, encodes, futures = library
    for index in range(3):
        add_post(f"lost-{index}", poster=False, preview=False)
    assert uploads.requeue_missing_derived(limit=2) == 2
    for future in futures:
        future.result(timeout=10)
    assert len(encodes) == 4  # poster + explore preview of two posts


def test_boot_task_logs_the_count(library, caplog):
    add_post, _encodes, futures = library
    add_post("lost", poster=False)
    with caplog.at_level(logging.INFO, logger="server.app"):
        app_module._requeue_derived_assets()
    for future in futures:
        future.result(timeout=10)
    assert "Re-queued derived assets for 1 posts at boot" in caplog.text


def test_derived_pool_drains_and_reopens(monkeypatch):
    started, gate = threading.Event(), threading.Event()
    monkeypatch.setattr(uploads, "_derived_pool", uploads.ThreadPoolExecutor(max_workers=1))
    running = uploads._submit_derived_assets(lambda: (started.set(), gate.wait(5)))
    assert started.wait(5)
    dropped = uploads._submit_derived_assets(lambda: None)
    threading.Timer(0.2, gate.set).start()
    summary = uploads.shutdown_derived_pool(drain_s=5)
    assert summary == {"dropped": 1, "running": 1, "unfinished": 0}
    assert running.done() and dropped.cancelled()
    with pytest.raises(RuntimeError):
        uploads._submit_derived_assets(lambda: None)
    uploads.start_derived_pool()
    assert uploads._submit_derived_assets(lambda: "ok").result(timeout=5) == "ok"
