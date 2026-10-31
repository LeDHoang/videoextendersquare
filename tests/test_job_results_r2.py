"""Completed job results kept in R2 under jobs/: they outlive a restart and the retention sweep."""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from server import media_store, output
from server.jobs import JobManager, JobStatus, job_manager
from server.routers import video
from test_media_store import FakeS3


@pytest.fixture
def r2(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_MEDIA_BASE_URL", "https://media.example.com")
    monkeypatch.setenv("R2_PUBLIC_BUCKET", "public-media")
    monkeypatch.setattr(output, "jobs_root", lambda: tmp_path / "jobs")
    fake = FakeS3()
    media_store.set_client(fake)
    yield fake
    media_store.set_client(None)


def _run_video_job(manager: JobManager, owner_id: str | None = "owner-1") -> str:
    job_id = manager.reserve_job("video", owner_id=owner_id)

    def fn(status_callback):
        master = output.job_dir(job_id) / "result.mp4"
        master.write_bytes(b"hevc master")
        preview = output.job_dir(job_id) / "result-preview.mp4"
        preview.write_bytes(b"h264 preview")
        return {
            "path": str(master),
            "preview": str(preview),
            "kind": "video",
            "download_url": f"/api/video/jobs/{job_id}/download",
        }

    manager.submit(job_id, fn, {})
    manager.get_job(job_id).future.result()
    return job_id


def test_a_completed_job_survives_a_restart(r2, tmp_path):
    first = JobManager(1, 1)
    job_id = _run_video_job(first)
    first.shutdown(0)
    # The container is recreated: no record, no job dir.
    shutil.rmtree(tmp_path / "jobs")

    restarted = JobManager(1, 1)
    record = restarted.get_job(job_id)
    restarted.shutdown(0)

    assert record.status == JobStatus.COMPLETE
    assert record.owner_id == "owner-1"
    assert record.result["download_url"] == f"/api/video/jobs/{job_id}/download"
    assert restarted.get_job(job_id) is record
    assert output.fetch(job_id, record.result["path"])
    assert Path(record.result["path"]).read_bytes() == b"hevc master"
    # The job id appears in URLs and the bucket is public, so keys use a keyed hash of it.
    assert len(r2.objects) == 3
    assert all(key.startswith("jobs/") and job_id not in key for key in r2.objects)


def test_cleanup_sweeps_the_disk_but_not_r2(r2, tmp_path):
    manager = JobManager(1, 1)
    job_id = _run_video_job(manager)
    assert manager.cleanup_old(max_age_seconds=-1) == 1
    assert not (tmp_path / "jobs" / job_id).exists()

    assert manager.get_job(job_id).status == JobStatus.COMPLETE
    manager.shutdown(0)


def test_a_failed_upload_leaves_nothing_to_restore(r2):
    r2.fail_uploads = True
    manager = JobManager(1, 1)
    job_id = _run_video_job(manager)
    assert manager.get_job(job_id).status == JobStatus.COMPLETE  # the job itself still succeeded
    manager.shutdown(0)

    assert output.restore(job_id) is None


def test_restore_reads_r2_only_for_job_ids(r2, monkeypatch):
    reads = []
    monkeypatch.setattr(r2, "get_object", lambda **kwargs: reads.append(kwargs))
    assert output.restore("../../etc") is None
    assert output.restore("ABCDEF123456") is None
    assert reads == []


def test_no_r2_keeps_jobs_in_memory_only(r2, monkeypatch):
    monkeypatch.delenv("R2_PUBLIC_BUCKET")
    manager = JobManager(1, 1)
    job_id = _run_video_job(manager)
    manager.shutdown(0)
    assert r2.objects == {}
    assert JobManager(1, 1).get_job(job_id) is None


def test_download_after_a_restart_fetches_the_file(r2, tmp_path, monkeypatch):
    job_id = _run_video_job(job_manager, owner_id=None)
    with job_manager._lock:
        job_manager._jobs.pop(job_id)
    shutil.rmtree(tmp_path / "jobs")
    app = FastAPI()
    app.include_router(video.router)

    try:
        with TestClient(app) as client:
            master = client.get(f"/api/video/jobs/{job_id}/download")
            preview = client.get(f"/api/video/jobs/{job_id}/download?kind=preview")
            status = client.get(f"/api/video/jobs/{job_id}")
    finally:
        with job_manager._lock:
            job_manager._jobs.pop(job_id, None)

    assert master.status_code == 200 and master.content == b"hevc master"
    assert preview.status_code == 200 and preview.content == b"h264 preview"
    assert status.json()["status"] == "complete"
    assert "path" not in status.json()["result"]
