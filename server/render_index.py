"""Per-user index of job results: the ``user_renders`` table behind ``GET /api/uploads/mine``.

A job gets a row when a signed-in user starts it (:func:`started`), the row follows
how the job ended (:func:`finished`) and which post it became (:func:`published`).
The files themselves stay where they are: the job dir, and R2 once ``output.keep``
stored them.

Like the upload log, indexing never fails the pipeline: errors are only logged.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

STATUS_BY_JOB = {"complete": "ready", "failed": "failed", "cancelled": "cancelled"}


def _session():
    from server.social import database

    return database.SessionLocal()


def started(
    job_id: str,
    *,
    user_id: str,
    kind: str,
    role: str = "square",
    stage_id: str | None = None,
    source_job_id: str | None = None,
    filename: str | None = None,
) -> None:
    """Add the row of a job that was just queued."""
    from server.social.models import UserRender

    try:
        db = _session()
        try:
            if not filename and source_job_id:
                source = db.get(UserRender, source_job_id)
                filename = source.filename if source else None
            now = datetime.now(timezone.utc)
            db.merge(UserRender(
                id=job_id, user_id=user_id, kind=kind, role=role, source_stage_id=stage_id,
                source_job_id=source_job_id, filename=(filename or "")[:255] or None,
                status="working", kept=False, created_at=now, updated_at=now,
            ))
            db.commit()
        finally:
            db.close()
    except Exception:
        logger.exception("Could not index job %s", job_id)


def finished(record, kept: dict | None) -> None:
    """Record how a job ended. *kept* is what ``output.keep`` stored in R2, or None."""
    from server.social.models import UserRender

    status = STATUS_BY_JOB.get(getattr(record.status, "value", str(record.status)))
    if not status:
        return
    try:
        db = _session()
        try:
            row = db.get(UserRender, record.job_id)
            if row is None:
                return
            now = datetime.now(timezone.utc)
            row.status = status
            row.updated_at = row.finished_at = now
            if kept:
                row.kept = True
                row.file_name = kept.get("path")
                row.preview_name = kept.get("preview")
                row.thumb_name = kept.get("thumb")
            db.commit()
        finally:
            db.close()
    except Exception:
        logger.exception("Could not index the outcome of job %s", record.job_id)


def published(job_ids: list[str], post_id: str) -> None:
    """Mark the rows of the jobs a post was made from."""
    from server.social.models import UserRender

    job_ids = [job_id for job_id in job_ids if job_id]
    if not job_ids:
        return
    try:
        db = _session()
        try:
            db.query(UserRender).filter(UserRender.id.in_(job_ids)).update(
                {"post_id": post_id, "updated_at": datetime.now(timezone.utc)}, synchronize_session=False,
            )
            db.commit()
        finally:
            db.close()
    except Exception:
        logger.exception("Could not index post %s", post_id)
