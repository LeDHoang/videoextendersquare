"""Processing quotas shared by the image and video routers.

Caps (all read at call time):

- ``SX_UPLOAD_HOURLY_MAX`` (30): uploads per user per hour, shared by every
  account on one device, and four times that per IP (see ``check_identity``).
- ``SX_MAX_IMAGE_UPLOAD_MB`` / ``SX_MAX_VIDEO_UPLOAD_MB`` (50 / 500): per file,
  see ``server/media.py``.
- ``SX_STAGED_BYTES_MAX`` (4 GiB): all staged uploads together, 507 when hit.
- ``SX_MAX_PENDING_JOBS`` (6) / ``SX_MAX_JOBS_PER_USER`` (2): active image and
  video jobs, 429 ``QUEUE_FULL`` when hit, see ``JobManager.reserve_job``.
"""

from __future__ import annotations

from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from server import kill_switch
from server.jobs import QueueFull, ShuttingDown
from server.settings import env_int
from server.social.auth import AuthContext, rate_limiter, request_identity

UPLOAD_WINDOW_S = 3600


def check_identity(
    db: Session, request: Request, context: AuthContext, purpose: str, limit: int, window: int, ip_factor: int = 4,
) -> None:
    """Count one use against the account, its device and its IP (429 when spent).

    A fresh account on the same browser shares the device budget. The IP gets
    ``limit * ip_factor`` so people behind one NAT are not blocked together.
    """
    rate_limiter.check(db, f"{purpose}:{context.user.id}", limit, window)
    if context.session.device_hash:
        rate_limiter.check(db, f"{purpose}:d:{context.session.device_hash}", limit, window)
    rate_limiter.check(db, f"{purpose}:ip:{request_identity(request)}", limit * ip_factor, window)


def check_upload_rate(db: Session, request: Request, context: AuthContext) -> None:
    """Count one upload against the caller's hourly budget (429 when spent).

    Paid jobs need uploads, so only the all-processing switch stops them.
    """
    kill_switch.require_open(db, paid=True)
    limit = env_int("SX_UPLOAD_HOURLY_MAX", 30, minimum=1)
    check_identity(db, request, context, "upload", limit, UPLOAD_WINDOW_S)


def queue_full_error(ex: QueueFull) -> HTTPException:
    if isinstance(ex, ShuttingDown):
        return HTTPException(
            status_code=503,
            detail={"code": "SHUTTING_DOWN", "message": str(ex)},
            headers={"Retry-After": str(ex.retry_after)},
        )
    return HTTPException(
        status_code=429,
        detail={"code": "QUEUE_FULL", "message": str(ex)},
        headers={"Retry-After": str(ex.retry_after)},
    )


def storage_full_error(message: str) -> HTTPException:
    return HTTPException(status_code=507, detail={"code": "STORAGE_FULL", "message": message})
