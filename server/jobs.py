"""In-memory job registry and background executor.

Wraps pipeline workers in a thread pool so the API can return immediately
and stream progress via SSE.  Jobs are keyed by UUID and hold status,
progress messages, and the final result or error.
"""

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

from core.phases import MAX_LOG_LINES, classify, default_pool_sizes, fmt_elapsed, format_error


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"


@dataclass
class JobRecord:
    job_id: str
    kind: str  # "image" or "video"
    status: JobStatus = JobStatus.QUEUED
    phase: str = "QUEUED"
    progress: float = 0.0
    elapsed: str = "0:00"
    messages: list[str] = field(default_factory=list)
    result: Any = None
    error: tuple[str, str] | None = None  # (headline, detail)
    created_at: float = field(default_factory=time.monotonic)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


# ---------------------------------------------------------------------------
# Phase classification / formatting / pool sizing — single source of truth in
# core/phases.py, shared with the Streamlit fallback (ui/runner.py). Kept as
# module-level aliases here so this file's existing call sites read the same.
# ---------------------------------------------------------------------------


class JobManager:
    """Process-wide singleton managing background pipeline jobs."""

    def __init__(self, max_image_workers: int | None = None, max_video_workers: int | None = None):
        default_image, default_video = default_pool_sizes()
        self._jobs: dict[str, JobRecord] = {}
        self._lock = threading.Lock()
        self._image_pool = ThreadPoolExecutor(max_workers=max_image_workers or default_image)
        self._video_pool = ThreadPoolExecutor(max_workers=max_video_workers or default_video)

    def create_job(self, kind: str) -> str:
        job_id = uuid.uuid4().hex[:12]
        record = JobRecord(job_id=job_id, kind=kind)
        with self._lock:
            self._jobs[job_id] = record
        return job_id

    def get_job(self, job_id: str) -> JobRecord | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list_jobs(self, kind: str | None = None) -> list[dict]:
        with self._lock:
            jobs = list(self._jobs.values())
        if kind:
            jobs = [j for j in jobs if j.kind == kind]
        return [
            {
                "job_id": j.job_id,
                "kind": j.kind,
                "status": j.status.value,
                "phase": j.phase,
                "progress": j.progress,
                "elapsed": j.elapsed,
            }
            for j in jobs
        ]

    def submit(
        self,
        job_id: str,
        fn: Callable,
        kwargs: dict,
        postprocess: Callable | None = None,
    ) -> None:
        """Submit a pipeline function for background execution.

        *postprocess* (optional) transforms the worker's raw result before it
        is stored on the record.
        """
        record = self.get_job(job_id)
        if not record:
            raise ValueError(f"Unknown job_id: {job_id}")

        pool = self._video_pool if record.kind == "video" else self._image_pool

        def _run():
            t0 = time.monotonic()
            highest_w = 0.0

            with record._lock:
                record.status = JobStatus.RUNNING
                record.phase = "STARTING"

            def status_callback(msg: str):
                nonlocal highest_w
                label, weight = classify(msg)
                highest_w = max(highest_w, weight)
                elapsed = fmt_elapsed(time.monotonic() - t0)
                with record._lock:
                    record.phase = label
                    record.progress = highest_w
                    record.elapsed = elapsed
                    record.messages.append(msg)
                    if len(record.messages) > MAX_LOG_LINES:
                        del record.messages[: len(record.messages) - MAX_LOG_LINES]

            try:
                result = fn(status_callback=status_callback, **kwargs)
                if postprocess is not None:
                    result = postprocess(result)
                with record._lock:
                    record.status = JobStatus.COMPLETE
                    record.phase = "COMPLETE"
                    record.progress = 1.0
                    record.elapsed = fmt_elapsed(time.monotonic() - t0)
                    record.result = result
            except Exception as ex:
                with record._lock:
                    record.status = JobStatus.FAILED
                    record.phase = "FAILED"
                    record.elapsed = fmt_elapsed(time.monotonic() - t0)
                    record.error = format_error(ex)

        pool.submit(_run)

    def cleanup_old(self, max_age_seconds: float = 3600) -> int:
        """Remove completed/failed jobs older than max_age_seconds."""
        now = time.monotonic()
        to_remove = []
        with self._lock:
            for jid, rec in self._jobs.items():
                if rec.status in (JobStatus.COMPLETE, JobStatus.FAILED):
                    if now - rec.created_at > max_age_seconds:
                        to_remove.append(jid)
            for jid in to_remove:
                del self._jobs[jid]
        return len(to_remove)


# Process-wide singleton
job_manager = JobManager()
