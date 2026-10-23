"""Job progress SSE frames are JSON, as web/src/hooks/useSSE.js parses them."""

from __future__ import annotations

import json

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sse_starlette.sse import EventSourceResponse

from server.jobs import JobRecord, JobStatus
from server.sse import job_progress_stream


def test_stream_data_frames_are_json():
    rec = JobRecord(
        job_id="job-1",
        kind="video",
        status=JobStatus.COMPLETE,
        phase="COMPLETE",
        progress=1.0,
        elapsed="0:07",
        messages=["Uploading…", "Done"],
        result={
            "path": "/srv/jobs/job-1/result.mp4",
            "kind": "video",
            "bytes": 42,
            "preview": None,
            "outpaint_url": None,
            "metrics": {"total_time": 6.5, "custom_outpaint_args": {}},
            "download_url": "/api/video/jobs/job-1/download",
        },
    )
    app = FastAPI()

    @app.get("/stream")
    async def stream(request: Request):
        return EventSourceResponse(job_progress_stream(request, rec))

    with TestClient(app) as client:
        body = client.get("/stream").text

    frames = [line[len("data:"):].strip() for line in body.splitlines() if line.startswith("data:")]
    assert len(frames) == 1, body
    payload = json.loads(frames[0])
    assert set(payload) == {"status", "phase", "progress", "elapsed", "messages", "result", "error"}
    assert payload["status"] == "complete"
    assert payload["messages"] == ["Uploading…", "Done"]
    assert payload["result"] == {
        "kind": "video",
        "bytes": 42,
        "outpaint_url": None,
        "metrics": {"total_time": 6.5, "custom_outpaint_args": {}},
        "download_url": "/api/video/jobs/job-1/download",
    }
    assert payload["error"] is None
