"""Upload traces in the private log bucket: events, timing, errors, and lookup by post id."""

from __future__ import annotations

import io
import json
from types import SimpleNamespace

import pytest
from botocore.exceptions import ClientError
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server import upload_log
from server.jobs import JobManager, JobStatus
from server.routers import admin
from server.social import auth


class FakeLogS3:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.fail = False

    def put_object(self, Bucket, Key, Body, **extra):
        assert Bucket == "upload-logs"
        if self.fail:
            raise RuntimeError("R2 down")
        self.objects[Key] = Body

    def get_object(self, Bucket, Key):
        assert Bucket == "upload-logs"
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "Not Found"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[Key])}

    def json(self, key: str) -> dict:
        return json.loads(self.objects[key])


@pytest.fixture
def logs(monkeypatch):
    monkeypatch.setenv("R2_LOG_BUCKET", "upload-logs")
    monkeypatch.setenv("R2_LOG_ACCESS_KEY_ID", "key")
    monkeypatch.setenv("R2_LOG_SECRET_ACCESS_KEY", "secret")
    fake = FakeLogS3()
    upload_log.set_client(fake)
    yield fake
    upload_log.flush()
    upload_log.set_client(None)
    upload_log._job_traces.clear()


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
def admin_client(logs):
    app = FastAPI()
    app.include_router(admin.router)
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
