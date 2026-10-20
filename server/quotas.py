"""Processing quotas shared by the image and video routers.

Caps (all read at call time):

- ``SX_UPLOAD_HOURLY_MAX`` (30): uploads per user per hour.
- ``SX_MAX_IMAGE_UPLOAD_MB`` / ``SX_MAX_VIDEO_UPLOAD_MB`` (50 / 500): per file,
  see ``server/media.py``.
- ``SX_STAGED_BYTES_MAX`` (4 GiB): all staged uploads together, 507 when hit.
- ``SX_MAX_PENDING_JOBS`` (6) / ``SX_MAX_JOBS_PER_USER`` (2): active image and
  video jobs, 429 ``QUEUE_FULL`` when hit, see ``JobManager.reserve_job``.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.orm import Session

from server.jobs import QueueFull
from server.settings import env_int
from server.social.auth import AuthContext, rate_limiter

UPLOAD_WINDOW_S = 3600


def check_upload_rate(db: Session, context: AuthContext) -> None:
    """Count one upload against the caller's hourly budget (429 when spent)."""
    limit = env_int("SX_UPLOAD_HOURLY_MAX", 30, minimum=1)
    rate_limiter.check(db, f"upload:{context.user.id}", limit, UPLOAD_WINDOW_S)


def queue_full_error(ex: QueueFull) -> HTTPException:
    return HTTPException(
        status_code=429,
        detail={"code": "QUEUE_FULL", "message": str(ex)},
        headers={"Retry-After": str(ex.retry_after)},
    )


def storage_full_error(message: str) -> HTTPException:
    return HTTPException(status_code=507, detail={"code": "STORAGE_FULL", "message": message})
