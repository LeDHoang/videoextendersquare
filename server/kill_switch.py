"""Processing kill switches that staff flip at runtime, with no deploy.

Two switches, both on by default and stored in app_settings:
- ``free``: free (local) jobs, publishing and Explore previews.
- ``paid``: everything, cloud (credit or BYOK) jobs and uploads too.

The state is one primary-key read per gated request, so a flip applies to the
next request and survives a restart.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.orm import Session

from server.social.models import AppSetting, User, utcnow

KEY = "processing"
DEFAULT = {"free": True, "paid": True}


def state(db: Session) -> dict:
    row = db.get(AppSetting, KEY)
    value = row.value if row is not None and isinstance(row.value, dict) else {}
    return {name: bool(value.get(name, on)) for name, on in DEFAULT.items()}


def set_state(db: Session, actor: User, *, free: bool, paid: bool) -> dict:
    """Store the new state; the caller commits it with the audit row."""
    value = {"free": bool(free), "paid": bool(paid)}
    row = db.get(AppSetting, KEY)
    if row is None:
        db.add(AppSetting(key=KEY, value=value, updated_by=actor.id))
    else:
        row.value = value
        row.updated_by = actor.id
        row.updated_at = utcnow()
    db.flush()
    return value


def require_open(db: Session, *, paid: bool) -> None:
    """Raise 503 when the switch covering this work is off."""
    current = state(db)
    if not current["paid"]:
        raise HTTPException(
            status_code=503,
            detail={"code": "PROCESSING_PAUSED", "message": "Processing is paused for maintenance. Try again later."},
        )
    if not paid and not current["free"]:
        raise HTTPException(
            status_code=503,
            detail={"code": "FREE_USAGE_PAUSED", "message": "Free processing is paused for now. Paid (cloud) jobs still run."},
        )
