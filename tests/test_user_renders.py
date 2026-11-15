"""The per-user list of job results (user_renders, GET /api/uploads/mine)."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server import media_store, output, render_index
from server.jobs import job_manager
from server.routers import image as image_router
from server.routers import social, uploads, video as video_router
from server.social import auth, database
from server.social.database import Base, get_db
from server.social.models import UserRender
from test_media_store import FakeS3
from verified_signup import register_verified


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret-for-hmac-cookies")
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setattr(output, "jobs_root", lambda: tmp_path / "jobs")
    engine = create_engine("sqlite:///" + str(tmp_path / "renders.db"), connect_args={"check_same_thread": False})
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    # The index writes through the global session factory; the routes read through get_db.
    monkeypatch.setattr(database, "SessionLocal", Session)
    application = FastAPI()
    application.include_router(social.router)
    application.include_router(uploads.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    application.state.session = Session
    started = []
    application.state.jobs = started
    yield application
    with job_manager._lock:
        for job_id in started:
            job_manager._jobs.pop(job_id, None)
    engine.dispose()


@pytest.fixture
def r2(monkeypatch):
    monkeypatch.setenv("SX_MEDIA_BASE_URL", "https://media.example.com")
    monkeypatch.setenv("R2_PUBLIC_BUCKET", "public-media")
    fake = FakeS3()
    media_store.set_client(fake)
    yield fake
    media_store.set_client(None)


def register(client, username):
    response = register_verified(client, json={
        "email": f"{username}@example.com", "username": username, "password": "correct-horse-battery-99",
        "accept_terms": True, "display_name": username,
    })
    assert response.status_code == 200, response.text
    return response.json()["user"]


def run_job(app, user_id, *, kind="video", fail=False, **index):
    """Queue and finish one job the way the process routes do."""
    job_id = job_manager.reserve_job(kind, owner_id=user_id)
    app.state.jobs.append(job_id)
    render_index.started(job_id, user_id=user_id, kind=kind, **index)

    def fn(status_callback):
        if fail:
            raise RuntimeError("worker broke")
        master = output.job_dir(job_id) / ("result.mp4" if kind == "video" else "result.png")
        master.write_bytes(b"master")
        result = {"path": str(master), "kind": kind, "download_url": f"/api/{kind}/jobs/{job_id}/download"}
        if kind == "video":
            preview = output.job_dir(job_id) / "result-preview.mp4"
            preview.write_bytes(b"preview")
            result["preview"] = str(preview)
        return result

    job_manager.submit(job_id, fn, {})
    job_manager.get_job(job_id).future.result()
    return job_id


def forget(job_id):
    """What a restart does: the process no longer holds the job."""
    with job_manager._lock:
        job_manager._jobs.pop(job_id, None)


def mine(client, **params):
    response = client.get("/api/uploads/mine", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_a_kept_result_is_listed_with_its_r2_links_for_30_days(app, r2, tmp_path, monkeypatch):
    thumb = tmp_path / "thumb.jpg"
    thumb.write_bytes(b"jpeg")
    monkeypatch.setattr(output, "_thumbnail", lambda record, source: thumb)
    with TestClient(app) as client:
        user = register(client, "renders_kept")
        job_id = run_job(app, user["id"], stage_id="stage-1", filename="beach walk.mp4")
        forget(job_id)
        body = mine(client)

    [item] = body["items"]
    prefix = "https://media.example.com/" + output._r2_prefix(job_id)
    assert item["job_id"] == job_id and item["status"] == "ready" and item["kept"] is True
    assert item["role"] == "square" and item["source_stage_id"] == "stage-1" and item["filename"] == "beach walk.mp4"
    assert item["media_url"] == prefix + "result-preview.mp4"
    assert item["thumb_url"] == prefix + "thumb.jpg"
    assert item["download_url"] == f"/api/video/jobs/{job_id}/download"
    assert output._r2_prefix(job_id) + "thumb.jpg" in r2.objects
    left = datetime.fromisoformat(item["expires_at"]) - datetime.now(timezone.utc)
    assert timedelta(days=29, hours=23) < left <= timedelta(days=30)
    assert body["retention"] == {"stage_seconds": 6 * 3600, "result_seconds": 30 * 24 * 3600}


def test_a_result_that_missed_r2_is_listed_only_while_the_process_holds_it(app, r2):
    r2.fail_uploads = True
    with TestClient(app) as client:
        user = register(client, "renders_unkept")
        job_id = run_job(app, user["id"], kind="image")
        [item] = mine(client)["items"]
        assert item["kept"] is False and item["thumb_url"] is None
        assert item["media_url"] == f"/api/image/jobs/{job_id}/download"
        left = datetime.fromisoformat(item["expires_at"]) - datetime.now(timezone.utc)
        assert timedelta(hours=5, minutes=59) < left <= timedelta(hours=6)

        forget(job_id)
        assert mine(client)["items"] == []


def test_without_r2_a_video_result_links_its_preview_and_lasts_the_memory_window(app):
    with TestClient(app) as client:
        user = register(client, "renders_local")
        job_id = run_job(app, user["id"])
        body = mine(client)
    assert body["items"][0]["media_url"] == f"/api/video/jobs/{job_id}/download?kind=preview"
    assert body["retention"]["result_seconds"] == 6 * 3600


def test_failed_and_lost_jobs_are_listed_as_failed(app):
    with TestClient(app) as client:
        user = register(client, "renders_failed")
        failed = run_job(app, user["id"], fail=True)
        lost = job_manager.reserve_job("image", owner_id=user["id"])
        render_index.started(lost, user_id=user["id"], kind="image")
        forget(lost)
        statuses = {item["job_id"]: item["status"] for item in mine(client)["items"]}
    assert statuses == {failed: "failed", lost: "failed"}
    with app.state.session() as db:
        assert db.get(UserRender, lost).status == "failed"


def test_the_list_is_per_user_and_sorts_by_added_or_last_action(app, r2):
    with TestClient(app) as client:
        other = register(client, "renders_other")
        run_job(app, other["id"])
        client.cookies.clear()
        user = register(client, "renders_sorted")
        first = run_job(app, user["id"])
        second = run_job(app, user["id"])
        # A 3D version of the first render: the newest row, and it touches nothing else.
        third = run_job(app, user["id"], role="3d", source_job_id=first)
        render_index.published([first], "post-1")

        added = [item["job_id"] for item in mine(client, sort="added")["items"]]
        acted = mine(client, sort="last_action")["items"]
    assert added == [third, second, first]
    assert [item["job_id"] for item in acted] == [first, third, second]
    assert acted[0]["post_id"] == "post-1"
    assert acted[1]["role"] == "3d" and acted[1]["source_job_id"] == first


def test_a_side_job_takes_the_filename_of_the_render_it_was_made_from(app):
    with TestClient(app) as client:
        user = register(client, "renders_named")
        source = run_job(app, user["id"], kind="image", filename="harbour.png")
        spatial = run_job(app, user["id"], kind="image", role="spatial", source_job_id=source)
        names = {item["job_id"]: item["filename"] for item in mine(client)["items"]}
    assert names[spatial] == "harbour.png"


def test_only_the_callers_live_staged_uploads_are_listed(app, tmp_path):
    with TestClient(app) as client:
        user = register(client, "renders_stages")
        mine_path = tmp_path / "mine.png"
        mine_path.write_bytes(b"png")
        now = time.time()
        image_router.STAGED_UPLOADS.update({
            "stage-mine": (str(mine_path), now - 60, f"user:{user['id']}", "holiday.png"),
            "stage-old": (str(mine_path), now - 7 * 3600, f"user:{user['id']}", "old.png"),
            "stage-gone": (str(tmp_path / "gone.png"), now, f"user:{user['id']}", "gone.png"),
            "stage-theirs": (str(mine_path), now, "user:someone-else", "theirs.png"),
        })
        video_router.STAGED_UPLOADS["stage-clip"] = (str(mine_path), now, f"user:{user['id']}")
        try:
            stages = mine(client)["stages"]
        finally:
            for stage_id in ("stage-mine", "stage-old", "stage-gone", "stage-theirs"):
                image_router.STAGED_UPLOADS.pop(stage_id, None)
            video_router.STAGED_UPLOADS.pop("stage-clip", None)

    by_id = {stage["stage_id"]: stage for stage in stages}
    assert set(by_id) == {"stage-mine", "stage-clip"}
    assert by_id["stage-mine"]["kind"] == "image" and by_id["stage-mine"]["filename"] == "holiday.png"
    assert by_id["stage-clip"]["kind"] == "video" and by_id["stage-clip"]["filename"] is None
    age = datetime.now(timezone.utc) - datetime.fromisoformat(by_id["stage-mine"]["staged_at"])
    assert timedelta(seconds=59) < age < timedelta(seconds=70)


def test_the_list_needs_a_session(app):
    with TestClient(app) as client:
        assert client.get("/api/uploads/mine").status_code == 401
