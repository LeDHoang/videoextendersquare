"""Per-upload trace in a private R2 bucket: every step, its timing, and how it ended.

One trace follows an upload from staging through processing and publish to
the background encodes. It is the JSON object ``traces/<trace_id>.json``
(the trace id is the stage id) with a list of events. Publishing writes
``by-post/<post_id>.json``, a pointer to the trace, so staff can look an
upload up by its post id (``GET /api/admin/upload-logs/<post_id>``).

Traces hold user ids, server paths and Fal costs, so they go to their own
bucket (``R2_LOG_BUCKET``) with their own token, never the public media bucket.
Without ``R2_LOG_BUCKET`` and its keys every call is a no-op.

Every event also updates the trace's row in the ``upload_traces`` table, so
staff can filter and sort uploads (the moderation page's Upload logs tab).
The upload's own file is copied to ``files/<trace_id>/`` in the same bucket
(:func:`attach`), so staff can review it later: staged uploads only live in the
container's /tmp. The job's result is not copied: ``output.keep`` already stores
it in the public bucket under ``jobs/<hash>/``, so the ``process_complete`` event
records that key (``result_key``) and staff open it there until the ``jobs/``
lifecycle rule deletes it (:data:`JOB_RESULT_DAYS`).

Logging never fails the pipeline: writes run on one background thread (which
also keeps each trace's events in order) and errors are only logged locally.
File copies run on a second thread, so a large video never delays events.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from server import media_store

logger = logging.getLogger(__name__)

TRACE_PREFIX = "traces/"
POST_PREFIX = "by-post/"
FILE_PREFIX = "files/"
JOB_MESSAGES_KEPT = 40
FILE_URL_SECONDS = 15 * 60
# The public bucket's lifecycle rule deletes ``jobs/`` objects after this many days.
JOB_RESULT_DAYS = 30
# How each event moves the upload along; other events leave the status as it is.
STATUS_BY_EVENT = {
    "upload": "staged",
    "process_queued": "processing",
    "process_complete": "processed",
    "process_failed": "failed",
    "process_cancelled": "cancelled",
    "process_enqueue_failed": "failed",
    "publish": "published",
    "publish_failed": "publish_failed",
}
# Event prefixes of side jobs on an upload (link_job events=...).
SIDE_JOB_EVENTS = ("spatial_", "convert_")

_client = None
_client_lock = threading.Lock()
_writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix="upload-log")
_last_write: Future | None = None
_files = ThreadPoolExecutor(max_workers=1, thread_name_prefix="upload-log-files")
_last_file: Future | None = None
# job_id -> trace_id, so job events and a publish by job_id find their upload.
_job_traces: dict[str, str] = {}
# job_id -> event prefix of a side job on the upload (the spatial version,
# MAKE 3D); its events never move the upload's status. Other jobs log process_*.
_job_events: dict[str, str] = {}


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
    try:
        _index(trace_id, event, post_id)
    except Exception as ex:
        logger.warning("Upload log %s: could not index the %s event: %s", trace_id, event.get("event"), ex)


def _error_text(error) -> str | None:
    if not error:
        return None
    if isinstance(error, dict):
        error = error.get("headline") or error.get("detail") or json.dumps(error, default=str)
    return str(error)[:500]


def _cost(metrics) -> float | None:
    if not isinstance(metrics, dict):
        return None
    costs = [value for key, value in metrics.items() if key.endswith("_cost") and isinstance(value, (int, float))]
    return round(sum(costs), 4) if costs else None


def _index(trace_id: str, event: dict, post_id: str | None) -> None:
    """Fold one event into the trace's ``upload_traces`` row."""
    from server.social import database
    from server.social.models import UploadTrace

    name = event["event"]
    at = datetime.fromisoformat(event["at"])
    db = database.SessionLocal()
    try:
        row = db.get(UploadTrace, trace_id)
        if row is None:
            row = UploadTrace(id=trace_id, status="staged", created_at=at, event_count=0, file_count=0)
            db.add(row)
        row.updated_at = at
        row.event_count = (row.event_count or 0) + 1
        row.status = STATUS_BY_EVENT.get(name, row.status)
        # A side job (spatial_*, convert_*) keeps the row's job_id on the job that made the post's file.
        side_job = name.startswith(SIDE_JOB_EVENTS)
        for field in ("user_id", "kind", "job_id"):
            if event.get(field) and not (side_job and field == "job_id"):
                setattr(row, field, str(event[field]))
        if post_id:
            row.post_id = post_id
        if name == "upload":
            row.filename = (event.get("filename") or "")[:255] or None
            row.size_bytes = event.get("size_bytes")
        if name.startswith("process_") and name != "process_queued":
            row.process_ms = event.get("ms")
            row.cost = _cost(event.get("metrics"))
        if name == "process_complete":
            row.error = None
        elif name.endswith("_failed") and name != "attachment_failed":
            row.error = _error_text(event.get("error"))
        if name == "attachment":
            row.file_count = (row.file_count or 0) + 1
        db.commit()
    finally:
        db.close()


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
    """Wait until queued file copies and events are written (tests, shutdown)."""
    if _last_file is not None:
        _last_file.result(timeout=timeout)
    # Read after the copies finish: each copy queues an event of its own.
    if _last_write is not None:
        _last_write.result(timeout=timeout)


def attach(trace_id: str | None, role: str, path, *, filename: str | None = None) -> None:
    """Queue a copy of one file of the upload (``source``, ``result``) to the log bucket; never raises."""
    global _last_file
    if not trace_id or not path or not enabled():
        return
    try:
        _last_file = _files.submit(_store_file, trace_id, role, str(path), filename)
    except RuntimeError:
        logger.warning("Upload log %s: file writer stopped, %s file dropped", trace_id, role)


def _store_file(trace_id: str, role: str, path: str, filename: str | None) -> None:
    source = Path(path)
    key = f"{FILE_PREFIX}{trace_id}/{role}{source.suffix.lower()}"
    content_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
    started = time.monotonic()
    try:
        size = source.stat().st_size
        client().upload_file(str(source), _bucket(), key, ExtraArgs={"ContentType": content_type})
    except Exception as ex:
        logger.warning("Upload log %s: could not copy the %s file: %s", trace_id, role, ex)
        record(trace_id, "attachment_failed", role=role, error=str(ex)[:300])
        return
    record(
        trace_id, "attachment", role=role, key=key, filename=filename or source.name,
        size_bytes=size, content_type=content_type, ms=round((time.monotonic() - started) * 1000),
    )


def file_url(key: str) -> str:
    """A short-lived signed link to a copied file (the log bucket is private)."""
    return client().generate_presigned_url(
        "get_object", Params={"Bucket": _bucket(), "Key": key}, ExpiresIn=FILE_URL_SECONDS,
    )


def link_job(job_id: str, trace_id: str, *, events: str = "process") -> None:
    """Log *job_id*'s end in *trace_id*'s trace as ``<events>_<status>``."""
    _job_traces[job_id] = trace_id
    if events != "process":
        _job_events[job_id] = events


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
    if status == "complete":
        fields["result_key"] = _result_key(record_)
    events = _job_events.get(record_.job_id, "process")
    # A side job's failure is "<events>_error", not "_failed": it neither fails
    # the upload nor sets its row's error (_index), since publish goes ahead without it.
    if events != "process" and status == "failed":
        status = "error"
    record(trace_id, f"{events}_{status}", **fields)


def _result_key(record_) -> str | None:
    """Public-bucket key of the job's kept result (``output.keep``), or None when it kept none."""
    from server import output

    result = record_.result if isinstance(record_.result, dict) else {}
    # The H.264 preview plays in any browser; the HEVC master may not.
    path = result.get("preview") or result.get("path")
    if not (path and media_store.enabled()):
        return None
    return output._r2_prefix(record_.job_id) + Path(path).name


def read_trace(trace_id: str) -> dict | None:
    """The trace *trace_id*, or None. Raises when R2 fails."""
    return _get(f"{TRACE_PREFIX}{trace_id}.json")


def read_by_post(post_id: str) -> dict | None:
    """The trace of *post_id*, or None when it has none. Raises when R2 fails."""
    pointer = _get(f"{POST_PREFIX}{post_id}.json")
    if not pointer:
        return None
    return _get(f"{TRACE_PREFIX}{pointer['trace_id']}.json")
