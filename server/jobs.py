"""In-memory job registry and background executor.

Wraps pipeline workers in a thread pool so the API can return immediately
and stream progress via SSE.  Jobs are keyed by UUID and hold status,
progress messages, and the final result or error.
"""

import logging
import shutil
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

from core.phases import MAX_LOG_LINES, classify, default_pool_sizes, fmt_elapsed, format_error
from server import metrics
from server.settings import env_int

logger = logging.getLogger(__name__)


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"
    CANCELLED = "cancelled"


TERMINAL_STATUSES = frozenset({JobStatus.COMPLETE, JobStatus.FAILED, JobStatus.CANCELLED})

# Absolute server paths kept on the record for downloads/publish, never sent
# to clients.
_PRIVATE_RESULT_KEYS = ("path", "preview")


class QueueFull(Exception):
    """A processing slot could not be reserved (server-wide or per-user cap)."""

    def __init__(self, message: str, retry_after: int = 30):
        super().__init__(message)
        self.retry_after = retry_after


class ShuttingDown(QueueFull):
    """The server is draining for a restart and takes no new jobs (503)."""

    def __init__(self, message: str = "The server is restarting. Try again in a minute.", retry_after: int = 60):
        super().__init__(message, retry_after)


class JobCancelled(BaseException):
    """Raised inside a worker once its job was cancelled.

    A BaseException so the workers' broad ``except Exception`` handlers
    (per-file loops, best-effort probes) cannot swallow it.
    """


@dataclass
class JobRecord:
    job_id: str
    kind: str  # "image" or "video"
    owner_id: str | None = None
    status: JobStatus = JobStatus.QUEUED
    phase: str = "QUEUED"
    progress: float = 0.0
    elapsed: str = "0:00"
    messages: list[str] = field(default_factory=list)
    result: Any = None
    error: tuple[str, str] | None = None  # (headline, detail)
    created_at: float = field(default_factory=time.monotonic)
    # Only reserved (user-submitted) jobs count toward the queue caps;
    # admin spatialize batches are created directly and stay uncounted.
    counted: bool = False
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)
    future: Future | None = field(default=None, repr=False)
    on_failure: Callable | None = field(default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


def public_result(result: Any) -> Any:
    """Job result as sent to clients: absolute server paths removed."""
    if not isinstance(result, dict):
        return result
    return {key: value for key, value in result.items() if key not in _PRIVATE_RESULT_KEYS}


def job_retention_seconds() -> int:
    return env_int("SX_JOB_RETENTION_S", 21600, minimum=60)


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
        self._image_workers = max_image_workers or default_image
        self._video_workers = max_video_workers or default_video
        self._image_pool = ThreadPoolExecutor(max_workers=self._image_workers)
        self._video_pool = ThreadPoolExecutor(max_workers=self._video_workers)
        self._accepting = True

    def start(self) -> None:
        """Accept jobs again after shutdown() (a new lifespan in the same process)."""
        with self._lock:
            if self._accepting:
                return
            self._image_pool = ThreadPoolExecutor(max_workers=self._image_workers)
            self._video_pool = ThreadPoolExecutor(max_workers=self._video_workers)
            self._accepting = True

    def shutdown(self, drain_s: float = 15.0) -> dict:
        """Stop for a restart: refuse new jobs, cancel queued ones, let running ones stop.

        Queued jobs go through the same path as a user cancel, so their
        failure callbacks release any billing reservation. Running jobs get
        their cancel flag and stop at their next progress report; this waits
        up to *drain_s* seconds for them. Returns counts for the log line.
        """
        with self._lock:
            self._accepting = False
            records = list(self._jobs.values())
            pools = (self._image_pool, self._video_pool)
        queued = running = 0
        waiting: list[Future] = []
        for record in records:
            with record._lock:
                if record.status in TERMINAL_STATUSES:
                    continue
                record.cancel_event.set()
            future = record.future
            if future is not None and future.cancel():
                self._finish_cancelled(record, JobCancelled(), reason="Cancelled: the server restarted.")
                queued += 1
            elif future is not None:
                running += 1
                waiting.append(future)
        for pool in pools:
            pool.shutdown(wait=False, cancel_futures=True)
        _done, not_done = wait(waiting, timeout=max(0.0, drain_s)) if waiting else (set(), set())
        return {"cancelled": queued, "running": running, "unfinished": len(not_done)}

    def create_job(self, kind: str, owner_id: str | None = None, job_id: str | None = None) -> str:
        job_id = job_id or uuid.uuid4().hex[:12]
        record = JobRecord(job_id=job_id, kind=kind, owner_id=owner_id)
        with self._lock:
            self._jobs[job_id] = record
        return job_id

    def reserve_job(self, kind: str, owner_id: str, job_id: str | None = None) -> str:
        """Create a counted job, or raise QueueFull when a cap is reached.

        The check and the insert happen under one lock, so two concurrent
        submits can never both take the last slot. Callers reserve before
        any billing and discard the job if a later step fails.
        """
        max_pending = env_int("SX_MAX_PENDING_JOBS", 6, minimum=1)
        max_per_user = env_int("SX_MAX_JOBS_PER_USER", 2, minimum=1)
        job_id = job_id or uuid.uuid4().hex[:12]
        record = JobRecord(job_id=job_id, kind=kind, owner_id=owner_id, counted=True)
        with self._lock:
            if not self._accepting:
                raise ShuttingDown()
            active = [
                rec for rec in self._jobs.values()
                if rec.counted and rec.status not in TERMINAL_STATUSES
            ]
            if sum(1 for rec in active if rec.owner_id == owner_id) >= max_per_user:
                metrics.incr("queue_full_user")
                raise QueueFull(
                    f"You already have {max_per_user} jobs running. Wait for one to finish or cancel it.",
                    retry_after=60,
                )
            if len(active) >= max_pending:
                metrics.incr("queue_full")
                raise QueueFull("The processing queue is full. Try again in a few minutes.", retry_after=120)
            self._jobs[job_id] = record
        return job_id

    def queue_depth(self) -> dict:
        """Counted (capped) jobs by state, against the server-wide cap."""
        with self._lock:
            active = [rec.status for rec in self._jobs.values() if rec.counted and rec.status not in TERMINAL_STATUSES]
        return {
            "queued": sum(1 for status in active if status == JobStatus.QUEUED),
            "running": sum(1 for status in active if status == JobStatus.RUNNING),
            "active": len(active),
            "capacity": env_int("SX_MAX_PENDING_JOBS", 6, minimum=1),
        }

    def discard_job(self, job_id: str) -> bool:
        """Remove a job that could not be handed to its executor."""
        with self._lock:
            return self._jobs.pop(job_id, None) is not None

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
        on_success: Callable | None = None,
        on_failure: Callable | None = None,
    ) -> None:
        """Submit a pipeline function for background execution.

        *postprocess* (optional) transforms the worker's raw result before it
        is stored on the record.
        """
        record = self.get_job(job_id)
        if not record:
            raise ValueError(f"Unknown job_id: {job_id}")

        with self._lock:
            if not self._accepting:
                raise ShuttingDown()
            pool = self._video_pool if record.kind == "video" else self._image_pool
        record.on_failure = on_failure

        def _run():
            t0 = time.monotonic()
            highest_w = 0.0
            worker_done = False

            with record._lock:
                record.status = JobStatus.RUNNING
                record.phase = "STARTING"

            def status_callback(msg: str):
                nonlocal highest_w
                # Workers report between stages, so this is where a cancel
                # lands: a running ffmpeg step finishes, the next (possibly
                # paid) stage never starts.
                if record.cancel_event.is_set() and not worker_done:
                    raise JobCancelled()
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
                if record.cancel_event.is_set():
                    raise JobCancelled()
                result = fn(status_callback=status_callback, **kwargs)
                if postprocess is not None:
                    result = postprocess(result)
                # The work (and any spend) is done: a late cancel no longer applies.
                worker_done = True
                if on_success is not None:
                    try:
                        on_success(result)
                    except Exception as settle_ex:
                        # The pipeline itself succeeded and its output is real.
                        # A settlement failure (billing DB unreachable, lost
                        # settlement race) must not mis-mark the job FAILED
                        # with a partial capture kept: the billing row is left
                        # for pending_reconciliation (restart/server reconcile),
                        # and the settlement error is surfaced on the record.
                        status_callback(f"NOTE: billing settlement deferred ({settle_ex}); reconciliation will finalize charges")
                with record._lock:
                    record.status = JobStatus.COMPLETE
                    record.phase = "COMPLETE"
                    record.progress = 1.0
                    record.elapsed = fmt_elapsed(time.monotonic() - t0)
                    record.result = result
            except JobCancelled as ex:
                self._finish_cancelled(record, ex, elapsed=fmt_elapsed(time.monotonic() - t0))
            except Exception as ex:
                metrics.incr("job_failed")
                if on_failure is not None:
                    try:
                        on_failure(ex)
                    except Exception:
                        pass
                with record._lock:
                    record.status = JobStatus.FAILED
                    record.phase = "FAILED"
                    record.elapsed = fmt_elapsed(time.monotonic() - t0)
                    record.error = format_error(ex)

        record.future = pool.submit(_run)

    def cancel(self, job_id: str) -> bool:
        """Request cancellation; False when the job is unknown or already finished.

        A job still waiting for a worker is cancelled at once (its failure
        callback releases any reservation). A running job stops at its next
        progress report.
        """
        record = self.get_job(job_id)
        if record is None:
            return False
        with record._lock:
            if record.status in TERMINAL_STATUSES:
                return False
            record.cancel_event.set()
        future = record.future
        if future is not None and future.cancel():
            self._finish_cancelled(record, JobCancelled())
        return True

    @staticmethod
    def _finish_cancelled(
        record: JobRecord,
        ex: BaseException,
        elapsed: str | None = None,
        reason: str = "Cancelled by user.",
    ) -> None:
        if record.on_failure is not None:
            try:
                record.on_failure(ex)
            except Exception:
                logger.exception("Failure callback for cancelled job %s failed", record.job_id)
        with record._lock:
            record.status = JobStatus.CANCELLED
            record.phase = "CANCELLED"
            if elapsed is not None:
                record.elapsed = elapsed
            record.error = ("CANCELLED", reason)

    def cleanup_old(self, max_age_seconds: float | None = None) -> int:
        """Remove finished jobs older than *max_age_seconds* and their job dirs."""
        from server.output import jobs_root

        if max_age_seconds is None:
            max_age_seconds = job_retention_seconds()
        now = time.monotonic()
        to_remove = []
        with self._lock:
            for jid, rec in self._jobs.items():
                if rec.status in TERMINAL_STATUSES:
                    if now - rec.created_at > max_age_seconds:
                        to_remove.append(jid)
            for jid in to_remove:
                del self._jobs[jid]
        root = jobs_root()
        for jid in to_remove:
            shutil.rmtree(root / jid, ignore_errors=True)
        return len(to_remove)

    def sweep_orphan_dirs(self, max_age_seconds: float = 24 * 3600) -> int:
        """Delete job dirs no live record owns (e.g. left by a restart)."""
        from server.output import jobs_root

        root = jobs_root()
        if not root.is_dir():
            return 0
        with self._lock:
            live = set(self._jobs)
        cutoff = time.time() - max_age_seconds
        removed = 0
        for entry in root.iterdir():
            if entry.name == "uploads" or entry.name in live or not entry.is_dir():
                continue
            try:
                if entry.stat().st_mtime > cutoff:
                    continue
            except OSError:
                continue
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
        return removed


# Process-wide singleton
job_manager = JobManager()
