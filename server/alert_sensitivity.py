"""Alert sensitivity that staff set at runtime, with no deploy.

One step per group, stored in app_settings. A step scales that group's alert
limits (``server.metrics.alert_limits``): a higher step lowers the limits, so
alerts fire sooner. Only alerts move; the limits that stop users
(``server/trust.py``) are not touched.

- ``community``: report and sign-up spikes, queue backlogs, reporters per
  target or account, activity bursts of new accounts.
- ``abuse``: credit bursts and accounts sharing an IP or device.
"""

from __future__ import annotations

import logging

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from server.social import database
from server.social.models import AppSetting, User, utcnow

logger = logging.getLogger(__name__)

KEY = "alert_sensitivity"
GROUPS = ("community", "abuse")
# Step -> factor on the limit. Step 2 keeps the configured (env) value.
FACTORS = (2.0, 1.5, 1.0, 0.75, 0.5)
LABELS = ("VERY RELAXED", "RELAXED", "NORMAL", "STRICT", "VERY STRICT")
DEFAULT_STEP = 2


def _read(db: Session) -> dict:
    row = db.get(AppSetting, KEY)
    value = row.value if row is not None and isinstance(row.value, dict) else {}
    steps = {}
    for group in GROUPS:
        step = value.get(group, DEFAULT_STEP)
        steps[group] = step if isinstance(step, int) and 0 <= step < len(FACTORS) else DEFAULT_STEP
    return steps


def state(db: Session | None = None) -> dict:
    """The step of each group. Without ``db`` it opens its own session, and a
    database failure falls back to NORMAL so the watchdog keeps alerting."""
    if db is not None:
        return _read(db)
    try:
        with database.SessionLocal() as own:
            return _read(own)
    except SQLAlchemyError:
        logger.warning("Could not read the alert sensitivity; using NORMAL")
        return {group: DEFAULT_STEP for group in GROUPS}


def set_state(db: Session, actor: User, steps: dict) -> dict:
    """Store the new steps; the caller commits them with the audit row."""
    value = {group: int(steps[group]) for group in GROUPS}
    row = db.get(AppSetting, KEY)
    if row is None:
        db.add(AppSetting(key=KEY, value=value, updated_by=actor.id))
    else:
        row.value = value
        row.updated_by = actor.id
        row.updated_at = utcnow()
    db.flush()
    return value


def scale(base: int, step: int, minimum: int) -> int:
    return max(minimum, int(base * FACTORS[step] + 0.5))
