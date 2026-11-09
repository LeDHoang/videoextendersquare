"""Per-upload trace in a private R2 bucket: every step, its timing, and how it ended.

One trace follows an upload from staging through processing and publish to
the background encodes. It is the JSON object ``traces/<trace_id>.json``
(the trace id is the stage id) with a list of events. Publishing writes
``by-post/<post_id>.json``, a pointer to the trace, so staff can look an
upload up by its post id (``GET /api/admin/upload-logs/<post_id>``).

Traces hold user ids, server paths and Fal costs, so they go to their own
bucket (``R2_LOG_BUCKET``) with their own token, never the public media bucket.
Without ``R2_LOG_BUCKET`` and its keys every call is a no-op.

Logging never fails the pipeline: writes run on one background thread (which
also keeps each trace's events in order) and errors are only logged locally.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone

from server import media_store

logger = logging.getLogger(__name__)

TRACE_PREFIX = "traces/"
POST_PREFIX = "by-post/"
JOB_MESSAGES_KEPT = 40

_client = None
_client_lock = threading.Lock()
_writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix="upload-log")
_last_write: Future | None = None
# job_id -> trace_id, so job events and a publish by job_id find their upload.
_job_traces: dict[str, str] = {}


def enabled() -> bool:
    return all(
        os.environ.get(name, "").strip()
        for name in ("R2_LOG_BUCKET", "R2_LOG_ACCESS_KEY_ID", "R2_LOG_SECRET_ACCESS_KEY")
    )


def _bucket() -> str:
    return os.environ.get("R2_LOG_BUCKET", "").strip()


def set_client(client) -> None:
    """Swap the S3 client (tests inject a fake; None resets to boto3)."""
    global _client
    with _client_lock:
        _client = client


def client():
    global _client
    with _client_lock:
        if _client is None:
            import boto3
            from botocore.config import Config

            _client = boto3.client(
                "s3",
                endpoint_url=media_store.endpoint_url(),
                aws_access_key_id=os.environ.get("R2_LOG_ACCESS_KEY_ID", "").strip(),
                aws_secret_access_key=os.environ.get("R2_LOG_SECRET_ACCESS_KEY", "").strip(),
                region_name="auto",
                config=Config(
                    request_checksum_calculation="when_required",
                    response_checksum_validation="when_required",
                    retries={"max_attempts": 3, "mode": "standard"},
                ),
            )
        return _client


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _get(key: str) -> dict | None:
    try:
        body = client().get_object(Bucket=_bucket(), Key=key)["Body"].read()
    except Exception as ex:
        if media_store._missing(ex):
            return None
        raise
    return json.loads(body)


def _put(key: str, data: dict) -> None:
    client().put_object(
        Bucket=_bucket(), Key=key, Body=json.dumps(data, default=str).encode("utf-8"),
        ContentType="application/json",
    )


def _append(trace_id: str, event: dict, post_id: str | None) -> None:
    key = f"{TRACE_PREFIX}{trace_id}.json"
    try:
        trace = _get(key) or {"trace_id": trace_id, "created_at": event["at"], "post_id": None, "events": []}
        trace["events"].append(event)
        trace["updated_at"] = event["at"]
        if post_id:
            trace["post_id"] = post_id
        _put(key, trace)
        if post_id:
            _put(f"{POST_PREFIX}{post_id}.json", {"trace_id": trace_id, "post_id": post_id})
    except Exception as ex:
        logger.warning("Upload log %s: could not write the %s event: %s", trace_id, event.get("event"), ex)


def record(trace_id: str | None, event: str, *, post_id: str | None = None, **fields) -> None:
    """Queue one event for *trace_id*'s trace; never raises."""
    global _last_write
    if not trace_id or not enabled():
        return
    entry = {"event": event, "at": _now(), **fields}
    try:
        _last_write = _writer.submit(_append, trace_id, entry, post_id)
    except RuntimeError:
        logger.warning("Upload log %s: writer stopped, %s event dropped", trace_id, event)


def flush(timeout: float = 10.0) -> None:
    """Wait until queued events are written (tests, shutdown)."""
    pending = _last_write
    if pending is not None:
        pending.result(timeout=timeout)


def link_job(job_id: str, trace_id: str) -> None:
    _job_traces[job_id] = trace_id


def trace_for_job(job_id: str | None) -> str | None:
    """The upload a job belongs to; a job not started from an upload traces under its own id."""
    if not job_id:
        return None
    return _job_traces.get(job_id, job_id)


def job_finished(record_, seconds: float | None) -> None:
    """Log how a job ended: status, timing, worker metrics or error, and its last messages."""
    trace_id = _job_traces.get(record_.job_id)
    if not trace_id:
        return
    status = getattr(record_.status, "value", str(record_.status))
    fields = {
        "job_id": record_.job_id,
        "kind": record_.kind,
        "status": status,
        "ms": round(seconds * 1000) if seconds is not None else None,
    }
    if record_.result and isinstance(record_.result, dict) and record_.result.get("metrics"):
        fields["metrics"] = record_.result["metrics"]
    if record_.error:
        fields["error"] = {"headline": record_.error[0], "detail": record_.error[1]}
    fields["messages"] = list(record_.messages[-JOB_MESSAGES_KEPT:])
    record(trace_id, f"process_{status}", **fields)


def read_by_post(post_id: str) -> dict | None:
    """The trace of *post_id*, or None when it has none. Raises when R2 fails."""
    pointer = _get(f"{POST_PREFIX}{post_id}.json")
    if not pointer:
        return None
    return _get(f"{TRACE_PREFIX}{pointer['trace_id']}.json")
