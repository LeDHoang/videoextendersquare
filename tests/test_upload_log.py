"""Upload traces in the private log bucket: events, timing, errors, and lookup by post id."""

from __future__ import annotations

import io
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from botocore.exceptions import ClientError
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server import upload_log
from server.jobs import JobManager, JobStatus
from server.routers import admin
from server.social import auth, database
from server.social.models import UploadTrace, User


class FakeLogS3:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.fail = False

    def put_object(self, Bucket, Key, Body, **extra):
        assert Bucket == "upload-logs"
        if self.fail:
            raise RuntimeError("R2 down")
        self.objects[Key] = Body

    def upload_file(self, Filename, Bucket, Key, ExtraArgs=None):
        assert Bucket == "upload-logs"
        if self.fail:
            raise RuntimeError("R2 down")
        with open(Filename, "rb") as handle:
            self.objects[Key] = handle.read()
        self.types = {**getattr(self, "types", {}), Key: (ExtraArgs or {}).get("ContentType")}

    def generate_presigned_url(self, operation, Params, ExpiresIn):
        assert operation == "get_object" and Params["Bucket"] == "upload-logs"
        return f"https://signed.example/{Params['Key']}?ttl={ExpiresIn}"

    def get_object(self, Bucket, Key):
        assert Bucket == "upload-logs"
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "Not Found"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[Key])}

    def json(self, key: str) -> dict:
        return json.loads(self.objects[key])


@pytest.fixture
def sessions(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "logs.db"), connect_args={"check_same_thread": False})
    database.Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", factory)
    yield factory
    engine.dispose()


@pytest.fixture
def logs(monkeypatch, sessions):
    monkeypatch.setenv("R2_LOG_BUCKET", "upload-logs")
    monkeypatch.setenv("R2_LOG_ACCESS_KEY_ID", "key")
    monkeypatch.setenv("R2_LOG_SECRET_ACCESS_KEY", "secret")
    fake = FakeLogS3()
    upload_log.set_client(fake)
    yield fake
    upload_log.flush()
    upload_log.set_client(None)
    upload_log._job_traces.clear()
    upload_log._job_events.clear()


def test_nothing_is_written_without_the_log_bucket(monkeypatch):
    monkeypatch.delenv("R2_LOG_BUCKET", raising=False)
    fake = FakeLogS3()
    upload_log.set_client(fake)
    try:
        upload_log.record("stage1", "upload", ms=12)
        upload_log.flush()
        assert fake.objects == {}
    finally:
        upload_log.set_client(None)


def test_events_append_in_order_and_publish_indexes_the_post(logs):
    upload_log.record("stage1", "upload", ms=120, size_bytes=4096)
    upload_log.record("stage1", "publish", ms=800, post_id="post-9", source="upload")
    upload_log.record("stage1", "assets_built", ms=5000, outcome="ok")
    upload_log.flush()

    trace = logs.json("traces/stage1.json")
    assert [event["event"] for event in trace["events"]] == ["upload", "publish", "assets_built"]
    assert trace["events"][0]["ms"] == 120 and trace["events"][0]["at"]
    assert trace["post_id"] == "post-9"
    assert logs.json("by-post/post-9.json") == {"trace_id": "stage1", "post_id": "post-9"}
    assert upload_log.read_by_post("post-9") == trace
    assert upload_log.read_by_post("unknown") is None


def test_a_failing_bucket_never_raises(logs):
    logs.fail = True
    upload_log.record("stage1", "upload", ms=1)
    upload_log.flush()
    assert logs.objects == {}


def _job(manager: JobManager, trace_id: str, fn) -> str:
    job_id = manager.reserve_job("video", owner_id="owner-1")
    upload_log.link_job(job_id, trace_id)
    manager.submit(job_id, fn, {})
    manager.get_job(job_id).future.result()
    upload_log.flush()
    return job_id


def test_job_outcomes_land_in_the_upload_trace(logs, monkeypatch):
    monkeypatch.setattr("server.output.keep", lambda record: None)
    manager = JobManager(1, 1)

    def ok(status_callback):
        status_callback("Outpainting on fal…")
        return {"metrics": {"outpaint_time": 41.2, "outpaint_cost": 0.3}}

    def boom(status_callback):
        status_callback("Upscaling locally…")
        raise RuntimeError("ffmpeg exited 1")

    ok_id = _job(manager, "stage-ok", ok)
    bad_id = _job(manager, "stage-bad", boom)
    manager.shutdown(0)

    done = logs.json("traces/stage-ok.json")["events"][-1]
    assert done["event"] == "process_complete" and done["job_id"] == ok_id
    assert done["metrics"] == {"outpaint_time": 41.2, "outpaint_cost": 0.3}
    assert done["messages"] == ["Outpainting on fal…"]
    assert isinstance(done["ms"], int)
    failed = logs.json("traces/stage-bad.json")["events"][-1]
    assert failed["event"] == "process_failed" and failed["job_id"] == bad_id
    assert "ffmpeg exited 1" in json.dumps(failed["error"])
    assert failed["messages"] == ["Upscaling locally…"]


def test_a_spatial_job_never_moves_the_upload_status(logs, sessions, monkeypatch):
    monkeypatch.setattr("server.output.keep", lambda record: None)
    manager = JobManager(1, 1)
    upload_log.record("stage-sp", "process_complete", job_id="extend-1", ms=40_000, metrics={"outpaint_cost": 0.3})

    def ok(status_callback):
        return {"metrics": {"total_time": 9.0}, "stereo_layout": "sbsd"}

    def boom(status_callback):
        raise RuntimeError("depth model ran out of memory")

    for fn in (ok, boom):
        job_id = manager.reserve_job("video", owner_id="owner-1")
        upload_log.link_job(job_id, "stage-sp", events="spatial")
        manager.submit(job_id, fn, {})
        manager.get_job(job_id).future.result()
    manager.shutdown(0)
    upload_log.flush()

    events = logs.json("traces/stage-sp.json")["events"]
    assert [e["event"] for e in events] == ["process_complete", "spatial_complete", "spatial_error"]
    assert "out of memory" in json.dumps(events[-1]["error"])
    with sessions() as db:
        row = db.get(UploadTrace, "stage-sp")
        # The extend job's status, job, timing and cost stay; a spatial failure is no upload error.
        assert (row.status, row.job_id, row.process_ms, row.error) == ("processed", "extend-1", 40_000, None)
        assert row.cost == pytest.approx(0.3)


def test_a_cancelled_job_is_logged(logs):
    manager = JobManager(1, 1)
    job_id = manager.reserve_job("video", owner_id="owner-1")
    upload_log.link_job(job_id, "stage-cancel")
    record = manager.get_job(job_id)
    record.cancel_event.set()
    manager.submit(job_id, lambda status_callback: {}, {})
    record.future.result()
    manager.shutdown(0)
    upload_log.flush()
    event = logs.json("traces/stage-cancel.json")["events"][-1]
    assert event["event"] == "process_cancelled"
    assert record.status == JobStatus.CANCELLED


def test_unlinked_jobs_are_not_logged(logs):
    manager = JobManager(1, 1)
    job_id = manager.reserve_job("video", owner_id="owner-1")
    manager.submit(job_id, lambda status_callback: {}, {})
    manager.get_job(job_id).future.result()
    manager.shutdown(0)
    upload_log.flush()
    assert logs.objects == {}


@pytest.fixture
def admin_client(logs, sessions):
    app = FastAPI()
    app.include_router(admin.router)

    def db():
        session = sessions()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[admin.get_db] = db
    role = {"value": "user"}
    app.dependency_overrides[auth.require_auth] = lambda: SimpleNamespace(user=SimpleNamespace(id="u1", role=role["value"]))
    with TestClient(app) as client:
        yield client, role


def test_staff_read_a_trace_by_post_id(admin_client):
    client, role = admin_client
    upload_log.record("stage1", "publish", ms=800, post_id="post-9")
    upload_log.flush()

    assert client.get("/api/admin/upload-logs/post-9").status_code == 403
    role["value"] = "moderator"
    response = client.get("/api/admin/upload-logs/post-9")
    assert response.status_code == 200
    assert response.json()["trace_id"] == "stage1"
    assert client.get("/api/admin/upload-logs/nope").status_code == 404


def test_the_endpoint_says_when_logging_is_off(admin_client, monkeypatch):
    client, role = admin_client
    role["value"] = "admin"
    monkeypatch.delenv("R2_LOG_BUCKET")
    response = client.get("/api/admin/upload-logs/post-9")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "UPLOAD_LOGS_OFF"


def test_events_fold_into_the_index_row(logs, sessions):
    upload_log.record("stage1", "upload", kind="video", user_id="u1", filename="clip.mp4", size_bytes=4096, ms=120)
    upload_log.record("stage1", "process_queued", kind="video", job_id="job-1", user_id="u1")
    upload_log.record("stage1", "process_failed", job_id="job-1", ms=900, error={"headline": "Fal timed out", "detail": "…"})
    upload_log.flush()
    with sessions() as db:
        row = db.get(UploadTrace, "stage1")
        assert (row.status, row.kind, row.user_id, row.job_id) == ("failed", "video", "u1", "job-1")
        assert (row.filename, row.size_bytes, row.process_ms, row.error) == ("clip.mp4", 4096, 900, "Fal timed out")
        assert row.event_count == 3

    upload_log.record("stage1", "process_complete", job_id="job-2", ms=40_000,
                      metrics={"outpaint_cost": 0.3, "upscale_cost": 0.05, "outpaint_time": 41.2})
    upload_log.record("stage1", "publish", post_id="post-9", ms=800)
    upload_log.record("stage1", "assets_built", outcome="ok")
    upload_log.flush()
    with sessions() as db:
        row = db.get(UploadTrace, "stage1")
        assert (row.status, row.post_id, row.job_id, row.error) == ("published", "post-9", "job-2", None)
        assert row.process_ms == 40_000 and row.cost == pytest.approx(0.35)


def test_files_are_copied_and_counted(logs, sessions, tmp_path):
    source = tmp_path / "Clip.MP4"
    source.write_bytes(b"video-bytes")
    upload_log.record("stage1", "upload", kind="video", filename="Clip.MP4")
    upload_log.attach("stage1", "source", source, filename="Clip.MP4")
    upload_log.attach("stage1", "result", tmp_path / "missing.mp4")
    upload_log.flush()

    assert logs.objects["files/stage1/source.mp4"] == b"video-bytes"
    assert logs.types["files/stage1/source.mp4"] == "video/mp4"
    events = logs.json("traces/stage1.json")["events"]
    attached = [event for event in events if event["event"] == "attachment"]
    assert attached == [{**attached[0], "role": "source", "key": "files/stage1/source.mp4", "filename": "Clip.MP4", "size_bytes": 11}]
    assert events[-1]["event"] == "attachment_failed" and events[-1]["role"] == "result"
    with sessions() as db:
        assert db.get(UploadTrace, "stage1").file_count == 1


def test_a_completed_job_points_at_its_public_result_without_copying_it(logs, monkeypatch, tmp_path):
    monkeypatch.setattr("server.output.keep", lambda record: None)
    monkeypatch.setenv("SX_MEDIA_BASE_URL", "https://media.example/")
    monkeypatch.setenv("R2_PUBLIC_BUCKET", "public")
    preview = tmp_path / "preview.mp4"
    preview.write_bytes(b"h264")
    manager = JobManager(1, 1)
    job_id = _job(manager, "stage-ok", lambda status_callback: {"path": str(tmp_path / "master.mp4"), "preview": str(preview)})
    manager.shutdown(0)
    upload_log.flush()

    from server import output
    complete = logs.json("traces/stage-ok.json")["events"][-1]
    assert complete["event"] == "process_complete"
    assert complete["result_key"] == output._r2_prefix(job_id) + "preview.mp4"
    assert not [key for key in logs.objects if key.startswith("files/")]


def test_a_completed_job_without_public_r2_has_no_result_key(logs, monkeypatch, tmp_path):
    monkeypatch.setattr("server.output.keep", lambda record: None)
    monkeypatch.delenv("SX_MEDIA_BASE_URL", raising=False)
    manager = JobManager(1, 1)
    _job(manager, "stage-local", lambda status_callback: {"path": str(tmp_path / "master.mp4"), "preview": None})
    manager.shutdown(0)
    upload_log.flush()
    assert logs.json("traces/stage-local.json")["events"][-1]["result_key"] is None


def _seed(sessions):
    with sessions() as db:
        db.add(User(id="u1", username="Alice", username_norm="alice"))
        db.commit()
    upload_log.record("a", "upload", kind="video", user_id="u1", filename="beach.mp4", size_bytes=300)
    upload_log.record("a", "process_complete", ms=5000, metrics={"outpaint_cost": 0.5})
    upload_log.record("b", "upload", kind="image", user_id="u2", filename="cat.png", size_bytes=100)
    upload_log.record("b", "process_failed", ms=100, error="boom")
    upload_log.record("c", "upload", kind="video", user_id="u1", filename="city.mov", size_bytes=200)
    upload_log.flush()


def test_staff_list_filter_and_sort_uploads(admin_client, sessions):
    client, role = admin_client
    _seed(sessions)
    assert client.get("/api/admin/upload-logs").status_code == 403
    role["value"] = "moderator"

    def ids(**params):
        response = client.get("/api/admin/upload-logs", params=params)
        assert response.status_code == 200, response.text
        return [item["id"] for item in response.json()["items"]]

    assert ids() == ["c", "b", "a"]
    assert ids(order="asc") == ["a", "b", "c"]
    assert ids(sort="size_bytes") == ["a", "c", "b"]
    assert ids(sort="process_ms") == ["a", "b", "c"]  # no timing yet sorts last
    assert ids(status="failed") == ["b"]
    assert ids(kind="video") == ["c", "a"]
    assert ids(user="@alice") == ["c", "a"]
    assert ids(q="CAT") == ["b"]
    first = client.get("/api/admin/upload-logs", params={"limit": 2}).json()
    assert first["next_cursor"] == "2" and first["items"][0]["username"] == "Alice"
    rest = client.get("/api/admin/upload-logs", params={"limit": 2, "cursor": first["next_cursor"]}).json()
    assert [item["id"] for item in rest["items"]] == ["a"] and rest["next_cursor"] is None


def test_staff_open_one_upload_with_signed_file_links(admin_client, sessions, tmp_path):
    client, role = admin_client
    role["value"] = "moderator"
    source = tmp_path / "beach.mp4"
    source.write_bytes(b"v")
    upload_log.record("a", "upload", kind="video", user_id="u1", filename="beach.mp4")
    upload_log.attach("a", "source", source, filename="beach.mp4")
    upload_log.flush()

    body = client.get("/api/admin/upload-logs/trace/a").json()
    assert body["summary"]["id"] == "a" and body["summary"]["file_count"] == 1
    assert [event["event"] for event in body["trace"]["events"]] == ["upload", "attachment"]
    assert body["files"] == [{
        "role": "source", "filename": "beach.mp4", "size_bytes": 1, "content_type": "video/mp4",
        "url": "https://signed.example/files/a/source.mp4?ttl=900", "expired": False,
    }]
    assert client.get("/api/admin/upload-logs/trace/nope").status_code == 404


def test_staff_get_the_public_result_link_until_the_jobs_lifecycle_deletes_it(admin_client, monkeypatch):
    client, role = admin_client
    role["value"] = "moderator"
    monkeypatch.setenv("SX_MEDIA_BASE_URL", "https://media.example/")
    monkeypatch.setenv("R2_PUBLIC_BUCKET", "public")
    fresh = datetime.now(timezone.utc).isoformat()
    old = (datetime.now(timezone.utc) - timedelta(days=upload_log.JOB_RESULT_DAYS + 1)).isoformat()
    for trace_id, at in (("fresh", fresh), ("old", old)):
        upload_log._put(f"traces/{trace_id}.json", {"trace_id": trace_id, "events": [
            {"event": "process_complete", "at": at, "result_key": "jobs/abc/result_preview.mp4"},
        ]})

    result = client.get("/api/admin/upload-logs/trace/fresh").json()["files"]
    assert result == [{
        "role": "result", "filename": "result_preview.mp4", "size_bytes": None, "content_type": "video/mp4",
        "url": "https://media.example/jobs/abc/result_preview.mp4", "expired": False,
    }]
    expired = client.get("/api/admin/upload-logs/trace/old").json()["files"][0]
    assert expired["url"] is None and expired["expired"] is True
