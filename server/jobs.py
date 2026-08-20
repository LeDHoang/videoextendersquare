"""In-memory job registry and background executor.

Wraps pipeline workers in a thread pool so the API can return immediately
and stream progress via SSE.  Jobs are keyed by UUID and hold status,
progress messages, and the final result or error.
"""

import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable


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


# Phase classification — mirrors ui/runner.py
PHASES: list[tuple[str, str, float]] = [
    ("Analyzing", "ANALYZE SOURCE", 0.05),
    ("Uploading", "UPLOAD TO CDN", 0.10),
    ("Submitting", "SUBMIT JOB", 0.15),
    ("Queued", "QUEUED AT FAL", 0.20),
    ("already square", "SKIP OUTPAINT", 0.55),
    ("Outpainting: Completed", "OUTPAINT COMPLETE", 0.60),
    ("Outpainting", "OUTPAINTING", 0.40),
    ("Downloading", "DOWNLOAD RESULT", 0.70),
    ("Performing studio-quality", "STUDIO UPSCALE", 0.80),
    ("Performing", "LOCAL 4K UPSCALE", 0.85),
]


def _classify(msg: str) -> tuple[str, float]:
    for needle, label, weight in PHASES:
        if needle.lower() in msg.lower():
            return label, weight
    return "WORKING", 0.0


def _fmt_elapsed(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 60}:{s % 60:02d}"


def _format_error(ex: Exception) -> tuple[str, str]:
    msg = str(ex)
    name = type(ex).__name__
    if isinstance(ex, ValueError) and "FAL_KEY" in msg:
        return (
            "API KEY MISSING",
            "Cloud outpainting needs a fal.ai key. Set it via the sidebar.",
        )
    if isinstance(ex, FileNotFoundError) or "WinError 2" in msg:
        return ("FFMPEG NOT FOUND", f"{msg}")
    if name == "CalledProcessError":
        stderr = getattr(ex, "stderr", None)
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", "replace")
        tail = "\n".join((stderr or "").strip().splitlines()[-12:])
        return ("FFMPEG FAILED", tail or msg)
    return (f"{name.upper()}", msg)


# Cap retained progress messages per job so a long-running job (or a client
# that never polls) can't grow a record's memory unboundedly. Mirrors
# ui/runner.py's MAX_LOG_LINES.
MAX_LOG_LINES = 200


# NOTE: pipeline runs used to be serialized process-wide behind a lock,
# justified by both workers writing to a "fixed shared temp path". That is no
# longer true — every intermediate file worker-side is uuid4()-suffixed (see
# pipeline/video_worker.py and pipeline/image_worker.py), and the fal.ai key
# is now passed via a per-call client instead of mutating os.environ. So jobs
# can run concurrently; the pool sizes below are the only concurrency cap.


def _default_pool_sizes() -> tuple[int, int]:
    """CPU-aware worker counts, mirroring the clamp in ui/runner.py."""
    cpus = os.cpu_count() or 2
    max_video = max(1, min(2, cpus // 2))
    max_image = max(1, min(4, cpus))
    return max_image, max_video


class JobManager:
    """Process-wide singleton managing background pipeline jobs."""

    def __init__(self, max_image_workers: int | None = None, max_video_workers: int | None = None):
        default_image, default_video = _default_pool_sizes()
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
                label, weight = _classify(msg)
                highest_w = max(highest_w, weight)
                elapsed = _fmt_elapsed(time.monotonic() - t0)
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
                    record.elapsed = _fmt_elapsed(time.monotonic() - t0)
                    record.result = result
            except Exception as ex:
                with record._lock:
                    record.status = JobStatus.FAILED
                    record.phase = "FAILED"
                    record.elapsed = _fmt_elapsed(time.monotonic() - t0)
                    record.error = _format_error(ex)

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
