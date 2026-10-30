"""MAKE 3D route (server/routers/stereo_convert.py) and publishing its result:
the real converter runs with the depth model stubbed, so this needs ffmpeg and
OpenCV, not torch."""
from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

import numpy as np
import pytest
from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from pipeline import spatial_worker as sw
from server import media, output
from server.jobs import JobStatus, job_manager
from server.routers import config as config_router
from server.routers import image as image_router
from server.routers import social, stereo_convert, uploads
from server.routers import video as video_router
from server.social import auth, database
from server.social.database import Base, get_db
from server.social.models import Post

PASSWORD = "correct horse battery staple 2026"

pytestmark = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="ffmpeg/ffprobe are required to build and probe sample media",
)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret-for-hmac-cookies")
    monkeypatch.setenv("SX_STEREO_CONVERT_ENABLED", "1")
    monkeypatch.setattr(stereo_convert, "stereo_convert_installed", lambda: True)
    monkeypatch.setattr(output, "jobs_root", lambda: tmp_path / "jobs")
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setattr(uploads, "OUTPUT_DIR", Path("output"))
    monkeypatch.setattr(uploads, "UPLOAD_DIR", Path("output") / "uploads")
    monkeypatch.setattr(uploads, "_submit_derived_assets", lambda fn: fn())
    # Depth stub: a left-to-right ramp, so the right eye gets real parallax.
    monkeypatch.setattr(sw, "_depth_image", lambda rgb: (
        np.broadcast_to(np.linspace(0, 1, rgb.shape[1], dtype=np.float32), rgb.shape[:2]).copy(), "stub"))
    monkeypatch.setattr(sw, "_depth_video", lambda frames, fps: (
        np.broadcast_to(np.linspace(0, 1, frames[0].shape[1], dtype=np.float32),
                        (len(frames), *frames[0].shape[:2])).copy(), "stub"))
    engine = create_engine("sqlite:///" + str(tmp_path / "convert.db"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", Session)
    application = FastAPI()
    for router in (social.router, uploads.router, image_router.router, video_router.router,
                   stereo_convert.router, config_router.router):
        application.include_router(router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    with job_manager._lock:
        before = set(job_manager._jobs)
    with TestClient(application) as test_client:
        test_client.testing_session = Session
        yield test_client
    with job_manager._lock:
        for job_id in set(job_manager._jobs) - before:
            job_manager._jobs.pop(job_id, None)
    image_router.STAGED_UPLOADS.clear()
    video_router.STAGED_UPLOADS.clear()
    engine.dispose()


def _register(client, username):
    response = register_verified(client, json={
        "email": f"{username}@example.com", "username": username,
        "password": PASSWORD, "accept_terms": True, "display_name": username,
    })
    assert response.status_code == 200, response.text
    return response.json()["user"]


def _csrf(client):
    return {"x-csrf-token": client.cookies.get("echo_csrf")}


def _convert(client, body):
    return client.post("/api/stereo/convert", json=body, headers=_csrf(client))


def _publish(client, body):
    return client.post("/api/uploads/publish", json=body, headers=_csrf(client))


def _stage(tmp_path, user, name, size=(96, 96), suffix="png"):
    path = tmp_path / f"{name}.{suffix}"
    Image.fromarray(np.random.default_rng(0).integers(0, 256, (size[1], size[0], 3), np.uint8)).save(path)
    image_router.STAGED_UPLOADS[name] = (str(path), time.time(), f"user:{user['id']}")
    return name


def _stage_video(tmp_path, user, name, size="96x96", seconds=1):
    path = tmp_path / f"{name}.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=s={size}:r=10:d={seconds}",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], check=True)
    video_router.STAGED_UPLOADS[name] = (str(path), time.time(), f"user:{user['id']}")
    return name


def _wait(job_id, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rec = job_manager.get_job(job_id)
        if rec.status in (JobStatus.COMPLETE, JobStatus.FAILED, JobStatus.CANCELLED):
            return rec
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} still {rec.status}")


def _finished_job(kind, owner_id, path: Path):
    """A completed job of `kind` whose result is `path` (an extend render)."""
    job_id = job_manager.create_job(kind, owner_id=owner_id)
    rec = job_manager.get_job(job_id)
    rec.status, rec.result = JobStatus.COMPLETE, {"path": str(path), "kind": kind}
    return job_id


def test_square_image_converts_and_publishes_as_sbs(client, tmp_path):
    user = _register(client, "convert_img")
    stage = _stage(tmp_path, user, "sq")
    response = _convert(client, {"kind": "image", "stage_id": stage})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "queued" and body["kind"] == "image" and body["payment_source"] == "local"
    rec = _wait(body["job_id"])
    assert rec.status == JobStatus.COMPLETE, rec.error
    assert rec.owner_id == user["id"] and rec.counted

    status = client.get(f"/api/image/jobs/{body['job_id']}").json()
    result = status["result"]
    assert "path" not in result
    assert result["stereo_layout"] == "sbs"
    assert result["download_url"] == f"/api/image/jobs/{body['job_id']}/download"
    assert any(m.startswith("Rendering 3D") for m in status["messages"])
    download = client.get(result["download_url"])
    assert download.status_code == 200 and download.headers["content-type"] == "image/jpeg"

    rw, rh, crop = sw.eye_geometry(96, 96)
    eye = rw - 2 * crop
    with Image.open(rec.result["path"]) as img:
        assert img.size == (2 * eye, eye)

    wrong_kind = _publish(client, {"kind": "video", "title": "Deep", "job_id": body["job_id"], "stereo_layout": "sbs"})
    assert wrong_kind.status_code == 422
    published = _publish(client, {"kind": "image", "title": "Deep", "job_id": body["job_id"], "stereo_layout": "sbs"})
    assert published.status_code == 200, published.text
    meta = published.json()["meta"]
    assert meta["stereo_layout"] == "sbs"
    assert meta["url"].endswith("-mono.jpg")
    assert meta["stereo_url"] == f"/media/{meta['path']}"
    assert meta["poster_url"].endswith("-mono-poster.jpg")
    with Image.open(Path("output") / meta["url"].removeprefix("/media/")) as mono:
        assert mono.size == (eye, eye)
    with client.testing_session() as db:
        post = db.query(Post).one()
        assert (post.stereo_layout, post.source) == ("sbs", "converted")


def test_extend_render_converts_and_publishes_as_sbs(client, tmp_path):
    user = _register(client, "convert_vid")
    render = tmp_path / "render.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=96x96:r=10:d=1",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(render)], check=True)
    extend_job = _finished_job("video", user["id"], render)

    response = _convert(client, {"kind": "video", "job_id": extend_job})
    assert response.status_code == 200, response.text
    job_id = response.json()["job_id"]
    rec = _wait(job_id)
    assert rec.status == JobStatus.COMPLETE, rec.error
    result = client.get(f"/api/video/jobs/{job_id}/result").json()["result"]
    assert result["stereo_layout"] == "sbs"
    assert "preview_url" not in result  # the H.264 master plays in the browser as-is
    assert client.get(result["download_url"]).status_code == 200
    assert media.get_video_codec(rec.result["path"]) == "h264"
    info = media.probe_media_info(rec.result["path"])
    rw, rh, crop = sw.eye_geometry(96, 96)
    assert (info["width"], info["height"]) == (2 * (rw - 2 * crop), rh - 2 * crop)

    # The extend render itself is still 2D-only; the MAKE 3D job is 3D-only.
    assert _publish(client, {"kind": "video", "title": "Ext", "job_id": extend_job, "stereo_layout": "sbs"}).status_code == 422
    mono = _publish(client, {"kind": "video", "title": "Flat", "job_id": job_id})
    assert mono.status_code == 422 and "side-by-side" in mono.text.lower()
    assert _publish(client, {"kind": "video", "title": "TB", "job_id": job_id, "stereo_layout": "tb"}).status_code == 422

    published = _publish(client, {"kind": "video", "title": "Deep", "job_id": job_id, "stereo_layout": "sbs"})
    assert published.status_code == 200, published.text
    meta = published.json()["meta"]
    assert meta["stereo_layout"] == "sbs" and meta["url"].endswith("-mono.mp4")
    with client.testing_session() as db:
        assert db.query(Post).one().source == "converted"


def test_staged_square_video_converts(client, tmp_path):
    user = _register(client, "convert_stage_vid")
    stage = _stage_video(tmp_path, user, "clip")
    response = _convert(client, {"kind": "video", "stage_id": stage})
    assert response.status_code == 200, response.text
    rec = _wait(response.json()["job_id"])
    assert rec.status == JobStatus.COMPLETE, rec.error
    assert rec.result["metrics"]["frames"] == 10


def test_off_by_default_and_unavailable_without_the_model(client, tmp_path, monkeypatch):
    user = _register(client, "convert_flags")
    stage = _stage(tmp_path, user, "sq")
    monkeypatch.delenv("SX_STEREO_CONVERT_ENABLED")
    assert _convert(client, {"kind": "image", "stage_id": stage}).status_code == 404
    monkeypatch.setenv("SX_STEREO_CONVERT_ENABLED", "1")
    monkeypatch.setattr(stereo_convert, "stereo_convert_installed", lambda: False)
    response = _convert(client, {"kind": "image", "stage_id": stage})
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "STEREO_CONVERT_UNAVAILABLE"


def test_config_reports_the_flag_and_the_install(client, monkeypatch):
    import server.features as features

    monkeypatch.setattr(features, "stereo_convert_installed", lambda: True)
    monkeypatch.setenv("SX_STEREO_CONVERT_ENABLED", "1")
    assert client.get("/api/config").json()["features"]["stereo_convert"] is True
    monkeypatch.setenv("SX_STEREO_CONVERT_ENABLED", "0")
    assert client.get("/api/config").json()["features"]["stereo_convert"] is False
    monkeypatch.setenv("SX_STEREO_CONVERT_ENABLED", "1")
    monkeypatch.setattr(features, "stereo_convert_installed", lambda: False)
    assert client.get("/api/config").json()["features"]["stereo_convert"] is False


def test_needs_sign_in_and_ownership(client, tmp_path):
    owner = _register(client, "convert_owner")
    stage = _stage(tmp_path, owner, "mine")
    render = tmp_path / "render.png"
    Image.new("RGB", (96, 96)).save(render)
    owned_job = _finished_job("image", owner["id"], render)

    client.cookies.clear()
    assert client.post("/api/stereo/convert", json={"kind": "image", "stage_id": stage}).status_code == 401
    _register(client, "convert_other")
    assert _convert(client, {"kind": "image", "stage_id": stage}).status_code == 403
    assert _convert(client, {"kind": "image", "job_id": owned_job}).status_code == 403


@pytest.mark.parametrize("make,code", [
    (lambda tmp_path, user: _stage(tmp_path, user, "wide", size=(128, 96)), "NOT_SQUARE"),
    (lambda tmp_path, user: _stage(tmp_path, user, "tiny", size=(66, 66)), "TOO_SMALL"),
])
def test_rejects_wrong_images(client, tmp_path, make, code):
    user = _register(client, f"convert_{code.lower()}")
    response = _convert(client, {"kind": "image", "stage_id": make(tmp_path, user)})
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == code
    with job_manager._lock:
        assert not [rec for rec in job_manager._jobs.values() if rec.owner_id == user["id"]]


def test_smallest_source_is_68(client, tmp_path):
    user = _register(client, "convert_68")
    rw, _rh, crop = sw.eye_geometry(68, 68)
    assert rw - 2 * crop == 64
    response = _convert(client, {"kind": "image", "stage_id": _stage(tmp_path, user, "edge", size=(68, 68))})
    assert response.status_code == 200, response.text
    assert _wait(response.json()["job_id"]).status == JobStatus.COMPLETE


def test_rejects_long_video_and_wrong_kind(client, tmp_path, monkeypatch):
    user = _register(client, "convert_limits")
    monkeypatch.setattr(sw, "MAX_VIDEO_SECONDS", 1)
    long_clip = _stage_video(tmp_path, user, "long", seconds=2)
    response = _convert(client, {"kind": "video", "stage_id": long_clip})
    assert response.status_code == 400 and response.json()["detail"]["code"] == "SOURCE_TOO_LONG"
    monkeypatch.setattr(sw, "MAX_VIDEO_SECONDS", 60)
    monkeypatch.setattr(stereo_convert.SM, "probe_media_info", lambda path: {"width": 96, "height": 96, "duration_ms": None})
    response = _convert(client, {"kind": "video", "stage_id": long_clip})
    assert response.status_code == 400 and response.json()["detail"]["code"] == "SOURCE_TOO_LONG"

    still = tmp_path / "still.png"
    Image.new("RGB", (96, 96)).save(still)
    image_job = _finished_job("image", user["id"], still)
    response = _convert(client, {"kind": "video", "job_id": image_job})
    assert response.status_code == 400 and response.json()["detail"]["code"] == "WRONG_KIND"


def test_takes_a_queue_slot_and_is_rate_limited(client, tmp_path, monkeypatch):
    user = _register(client, "convert_caps")
    stage = _stage(tmp_path, user, "sq")
    monkeypatch.setenv("SX_MAX_JOBS_PER_USER", "1")
    held = job_manager.reserve_job("image", owner_id=user["id"])
    full = _convert(client, {"kind": "image", "stage_id": stage})
    assert full.status_code == 429
    job_manager.discard_job(held)

    monkeypatch.setenv("SX_MAX_JOBS_PER_USER", "5")
    monkeypatch.setattr(stereo_convert, "CONVERTS_PER_HOUR", 3)  # the queue-full try above counted
    for _ in range(2):
        ok = _convert(client, {"kind": "image", "stage_id": stage})
        assert ok.status_code == 200, ok.text
        _wait(ok.json()["job_id"])
    limited = _convert(client, {"kind": "image", "stage_id": stage})
    assert limited.status_code == 429 and limited.json()["detail"]["code"] == "RATE_LIMITED"
