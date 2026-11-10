"""Trust tiers, computed on demand from existing rows (no stored column).

- ``restricted``: in the last 30 days staff suspended the account or removed
  its content, or one of its Stripe purchases was reversed. A suspension that
  was reinstated and a removal that was restored do not count.
- ``new``: younger than ``SX_TRUST_NEW_HOURS`` (72).
- ``trusted``: older than ``SX_TRUST_TRUSTED_DAYS`` (30) with a fulfilled purchase.
- ``standard``: everyone else.

Each tier has its own limits. ``standard`` keeps the flat env values
(``SX_UPLOAD_HOURLY_MAX`` etc.); the other tiers read the same name with the
tier after ``SX_``, for example ``SX_NEW_UPLOAD_HOURLY_MAX``.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import and_, exists
from sqlalchemy.orm import Session, aliased

from server.settings import env_int
from server.social.auth import aware
from server.social.models import StaffAction, StripePurchase, User, utcnow
from server.social.staff import CONTENT_MODELS, REMOVE_ACTION

RESTRICTED_DAYS = 30

# Limit name -> (standard env name, standard default, {tier: default}).
TIER_LIMITS = {
    "upload_hourly": ("SX_UPLOAD_HOURLY_MAX", 30, {"restricted": 5, "new": 10, "trusted": 60}),
    "publish_hourly": ("SX_PUBLISH_HOURLY_MAX", 5, {"restricted": 1, "new": 2, "trusted": 10}),
    "publish_daily": ("SX_PUBLISH_DAILY_MAX", 20, {"restricted": 3, "new": 5, "trusted": 40}),
    "jobs_per_user": ("SX_MAX_JOBS_PER_USER", 2, {"restricted": 1, "new": 1, "trusted": 3}),
    "daily_credits": ("SX_DAILY_CREDIT_CAP", 1000, {"restricted": 50, "new": 100, "trusted": 3000}),
}


def account_age(user: User, now: datetime | None = None) -> timedelta:
    return (now or utcnow()) - aware(user.created_at)


def _not_undone(undo_action: str):
    """No later staff action of ``undo_action`` on the same target."""
    undo = aliased(StaffAction)
    return ~exists().where(and_(
        undo.action == undo_action,
        undo.target_type == StaffAction.target_type,
        undo.target_id == StaffAction.target_id,
        undo.created_at >= StaffAction.created_at,
    ))


def _restricted(db: Session, user: User, since: datetime) -> bool:
    suspended = db.query(StaffAction.id).filter(
        StaffAction.action == "user.suspend",
        StaffAction.target_type == "user",
        StaffAction.target_id == user.id,
        StaffAction.created_at >= since,
        _not_undone("user.reinstate"),
    ).first()
    if suspended:
        return True
    for target_type, (model, owner_field) in CONTENT_MODELS.items():
        removed = db.query(StaffAction.id).join(model, model.id == StaffAction.target_id).filter(
            StaffAction.action == REMOVE_ACTION,
            StaffAction.target_type == target_type,
            getattr(model, owner_field) == user.id,
            StaffAction.created_at >= since,
            _not_undone("content.restore"),
        ).first()
        if removed:
            return True
    return db.query(StripePurchase.id).filter(
        StripePurchase.user_id == user.id,
        StripePurchase.status.in_(("reversed", "partially_reversed")),
        StripePurchase.reversed_at >= since,
    ).first() is not None


def tier(db: Session, user: User) -> str:
    now = utcnow()
    if _restricted(db, user, now - timedelta(days=RESTRICTED_DAYS)):
        return "restricted"
    age = account_age(user, now)
    if age < timedelta(hours=env_int("SX_TRUST_NEW_HOURS", 72, minimum=0)):
        return "new"
    if age >= timedelta(days=env_int("SX_TRUST_TRUSTED_DAYS", 30, minimum=0)):
        purchased = db.query(StripePurchase.id).filter(
            StripePurchase.user_id == user.id,
            StripePurchase.status == "fulfilled",
        ).first()
        if purchased:
            return "trusted"
    return "standard"


def limit(db: Session, user: User, name: str) -> int:
    """The caller's value for one ``TIER_LIMITS`` entry."""
    env_name, default, tier_defaults = TIER_LIMITS[name]
    user_tier = tier(db, user)
    if user_tier == "standard":
        return env_int(env_name, default, minimum=1)
    return env_int(f"SX_{user_tier.upper()}_{env_name[3:]}", tier_defaults[user_tier], minimum=1)
