"""Transactional services for ECHO Credits and Fal-backed generation billing."""

from __future__ import annotations

import os
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import func, update
from sqlalchemy.orm import Session

from core.pricing import QUOTE_TTL_SECONDS, PricingError, parameter_hash, quote_image, quote_video
from server.social.auth import aware
from server.social.models import (
    BillingQuote,
    CloudGenerationBilling,
    CloudGenerationStage,
    CreditAccount,
    CreditLedgerEntry,
    EngagementEvent,
    Post,
    RecommendationImpression,
    RecommendationSession,
    ReelRewardClaim,
    utcnow,
)


class BillingError(RuntimeError):
    code = "BILLING_ERROR"


class InsufficientCredits(BillingError):
    code = "INSUFFICIENT_CREDITS"


class QuoteError(BillingError):
    code = "INVALID_QUOTE"


class RewardError(BillingError):
    code = "REWARD_INELIGIBLE"


def flag_enabled(name: str) -> bool:
    return os.environ.get(name, "0").strip().casefold() in {"1", "true", "yes", "on"}


def _insert_ignore(db: Session, model, values: dict[str, Any]):
    table = model.__table__
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as dialect_insert

        return db.execute(dialect_insert(table).values(**values).on_conflict_do_nothing())
    if dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as dialect_insert

        return db.execute(dialect_insert(table).values(**values).on_conflict_do_nothing())
    existing = db.get(model, values.get("user_id")) if "user_id" in values else None
    if existing is None:
        db.add(model(**values))
        db.flush()
    return None


def ensure_account(db: Session, user_id: str) -> CreditAccount:
    now = utcnow()
    _insert_ignore(
        db,
        CreditAccount,
        {
            "user_id": user_id,
            "available_balance": 0,
            "reserved_balance": 0,
            "lifetime_purchased": 0,
            "lifetime_earned": 0,
            "lifetime_spent": 0,
            "created_at": now,
            "updated_at": now,
        },
    )
    account = db.get(CreditAccount, user_id)
    if account is None:
        raise BillingError("Unable to initialize credit account")
    return account


def _wallet_payload(account: CreditAccount) -> dict[str, Any]:
    return {
        "available_credits": int(account.available_balance or 0),
        "reserved_credits": int(account.reserved_balance or 0),
        "total_credits": int(account.available_balance or 0) + int(account.reserved_balance or 0),
        "lifetime_purchased": int(account.lifetime_purchased or 0),
        "lifetime_earned": int(account.lifetime_earned or 0),
        "lifetime_spent": int(account.lifetime_spent or 0),
        "can_spend": int(account.available_balance or 0) >= 0,
        "currency": "ECHO Credits",
    }


def get_wallet(db: Session, user_id: str) -> dict[str, Any]:
    account = ensure_account(db, user_id)
    db.commit()
    db.refresh(account)
    return _wallet_payload(account)


def list_transactions(db: Session, user_id: str, *, limit: int = 50, before: str | None = None) -> list[dict]:
    query = db.query(CreditLedgerEntry).filter(CreditLedgerEntry.user_id == user_id)
    if before:
        cursor = db.get(CreditLedgerEntry, before)
        if cursor and cursor.user_id == user_id:
            query = query.filter(CreditLedgerEntry.created_at < cursor.created_at)
    rows = query.order_by(CreditLedgerEntry.created_at.desc(), CreditLedgerEntry.id.desc()).limit(max(1, min(limit, 100))).all()
    return [
        {
            "id": row.id,
            "type": row.entry_type,
            "source": row.source,
            "delta_available": row.delta_available,
            "delta_reserved": row.delta_reserved,
            "balance_available": row.balance_available,
            "balance_reserved": row.balance_reserved,
            "reference_type": row.reference_type,
            "reference_id": row.reference_id,
            "details": row.details or {},
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]


def _ledger(
    db: Session,
    account: CreditAccount,
    *,
    entry_type: str,
    source: str,
    delta_available: int,
    delta_reserved: int,
    idempotency_key: str,
    reference_type: str | None = None,
    reference_id: str | None = None,
    details: dict | None = None,
) -> CreditLedgerEntry:
    db.refresh(account)
    row = CreditLedgerEntry(
        user_id=account.user_id,
        entry_type=entry_type,
        source=source,
        delta_available=int(delta_available),
        delta_reserved=int(delta_reserved),
        balance_available=int(account.available_balance),
        balance_reserved=int(account.reserved_balance),
        reference_type=reference_type,
        reference_id=reference_id,
        idempotency_key=idempotency_key,
        details=dict(details or {}),
    )
    db.add(row)
    db.flush()
    return row


def grant_credits(
    db: Session,
    user_id: str,
    amount: int,
    *,
    source: str,
    idempotency_key: str,
    reference_type: str | None = None,
    reference_id: str | None = None,
    details: dict | None = None,
) -> tuple[CreditAccount, bool]:
    amount = int(amount)
    if amount <= 0:
        raise BillingError("Credit grant must be positive")
    existing = db.query(CreditLedgerEntry.id).filter(CreditLedgerEntry.idempotency_key == idempotency_key).first()
    account = ensure_account(db, user_id)
    if existing:
        return account, False
    values: dict[Any, Any] = {
        CreditAccount.available_balance: CreditAccount.available_balance + amount,
        CreditAccount.updated_at: utcnow(),
    }
    if source == "purchase":
        values[CreditAccount.lifetime_purchased] = CreditAccount.lifetime_purchased + amount
    elif source == "earned":
        values[CreditAccount.lifetime_earned] = CreditAccount.lifetime_earned + amount
    db.execute(update(CreditAccount).where(CreditAccount.user_id == user_id).values(values))
    db.expire(account)
    _ledger(
        db,
        account,
        entry_type="credit",
        source=source,
        delta_available=amount,
        delta_reserved=0,
        idempotency_key=idempotency_key,
        reference_type=reference_type,
        reference_id=reference_id,
        details=details,
    )
    return account, True


def debit_credits(
    db: Session,
    user_id: str,
    amount: int,
    *,
    source: str,
    idempotency_key: str,
    reference_type: str | None = None,
    reference_id: str | None = None,
    details: dict | None = None,
) -> tuple[CreditAccount, bool]:
    """Apply an idempotent debit, allowing a negative balance for reversals."""
    amount = int(amount)
    if amount <= 0:
        raise BillingError("Credit debit must be positive")
    existing = db.query(CreditLedgerEntry.id).filter(CreditLedgerEntry.idempotency_key == idempotency_key).first()
    account = ensure_account(db, user_id)
    if existing:
        return account, False
    db.execute(
        update(CreditAccount)
        .where(CreditAccount.user_id == user_id)
        .values(available_balance=CreditAccount.available_balance - amount, updated_at=utcnow())
    )
    db.expire(account)
    _ledger(
        db,
        account,
        entry_type="debit",
        source=source,
        delta_available=-amount,
        delta_reserved=0,
        idempotency_key=idempotency_key,
        reference_type=reference_type,
        reference_id=reference_id,
        details=details,
    )
    return account, True


def reserve_credits(db: Session, user_id: str, amount: int, *, job_id: str) -> CreditAccount:
    amount = int(amount)
    account = ensure_account(db, user_id)
    if amount <= 0:
        return account
    result = db.execute(
        update(CreditAccount)
        .where(CreditAccount.user_id == user_id, CreditAccount.available_balance >= amount)
        .values(
            available_balance=CreditAccount.available_balance - amount,
            reserved_balance=CreditAccount.reserved_balance + amount,
            updated_at=utcnow(),
        )
    )
    if result.rowcount != 1:
        raise InsufficientCredits("Not enough ECHO Credits for this job")
    db.expire(account)
    _ledger(
        db,
        account,
        entry_type="reserve",
        source="generation",
        delta_available=-amount,
        delta_reserved=amount,
        idempotency_key=f"generation:{job_id}:reserve",
        reference_type="cloud_job",
        reference_id=job_id,
    )
    return account


def create_quote(
    db: Session,
    *,
    user_id: str,
    kind: str,
    stage_id: str,
    width: int,
    height: int,
    duration: float | None,
    params: dict[str, Any],
    source_fps: float | None = None,
    source_frames: int | None = None,
) -> BillingQuote:
    kind = str(kind).casefold()
    try:
        snapshot = (
            quote_video(
                width=width, height=height, duration=float(duration or 0), params=params,
                source_fps=source_fps, source_frames=source_frames,
            )
            if kind == "video"
            else quote_image(width=width, height=height, params=params)
            if kind == "image"
            else None
        )
    except PricingError as exc:
        raise QuoteError(str(exc)) from exc
    if snapshot is None:
        raise QuoteError("Unsupported quote kind")
    now = utcnow()
    db.query(BillingQuote).filter(
        BillingQuote.user_id == user_id,
        BillingQuote.status == "active",
        BillingQuote.expires_at <= now,
    ).update({BillingQuote.status: "expired"}, synchronize_session=False)
    row = BillingQuote(
        user_id=user_id,
        kind=kind,
        stage_id=stage_id,
        parameter_hash=parameter_hash(kind=kind, stage_id=stage_id, params=params),
        parameters=params,
        pricing_snapshot=snapshot,
        provider_cost_microusd=int(snapshot["provider_cost_microusd"]),
        credits=int(snapshot["credits"]),
        expires_at=now + timedelta(seconds=QUOTE_TTL_SECONDS),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def quote_payload(row: BillingQuote) -> dict[str, Any]:
    return {
        "quote_id": row.id,
        "kind": row.kind,
        "stage_id": row.stage_id,
        "pricing_version": (row.pricing_snapshot or {}).get("pricing_version"),
        "provider_cost_usd": (row.pricing_snapshot or {}).get("provider_cost_usd"),
        "provider_cost_microusd": row.provider_cost_microusd,
        "credits": row.credits,
        "stages": (row.pricing_snapshot or {}).get("stages", []),
        "details": (row.pricing_snapshot or {}).get("details", {}),
        "expires_at": row.expires_at.isoformat(),
    }


def create_billing_job(
    db: Session,
    *,
    user_id: str,
    job_id: str,
    kind: str,
    payment_source: str,
    stage_id: str,
    params: dict[str, Any],
    quote_id: str | None = None,
    stage_specs: list[tuple[str, str]] | None = None,
) -> CloudGenerationBilling:
    payment_source = str(payment_source).casefold()
    if payment_source == "byok":
        billing = CloudGenerationBilling(
            job_id=job_id,
            user_id=user_id,
            kind=kind,
            payment_source="byok",
            status="queued",
        )
        db.add(billing)
        db.flush()
        for index, (stage_name, model_id) in enumerate(stage_specs or []):
            db.add(
                CloudGenerationStage(
                    billing_id=billing.id,
                    stage_name=stage_name,
                    sequence=index,
                    model_id=model_id,
                    provider_cost_microusd=0,
                    reserved_credits=0,
                )
            )
        db.commit()
        return billing
    if payment_source != "credits" or not quote_id:
        raise QuoteError("A valid quote is required for credit-funded work")

    now = utcnow()
    quote = db.get(BillingQuote, quote_id)
    if not quote or quote.user_id != user_id or quote.kind != kind or quote.stage_id != stage_id:
        raise QuoteError("Quote does not belong to this user, upload, or pipeline")
    if quote.status != "active":
        raise QuoteError("Quote has already been used or expired")
    if aware(quote.expires_at) <= now:
        quote.status = "expired"
        db.commit()
        raise QuoteError("Quote has expired; request a new quote")
    if quote.parameter_hash != parameter_hash(kind=kind, stage_id=stage_id, params=params):
        raise QuoteError("Processing parameters do not match the quote")

    consumed = db.execute(
        update(BillingQuote)
        .where(BillingQuote.id == quote.id, BillingQuote.status == "active")
        .values(status="consumed", consumed_at=now)
    )
    if consumed.rowcount != 1:
        raise QuoteError("Quote has already been used")
    reserve_credits(db, user_id, quote.credits, job_id=job_id)
    billing = CloudGenerationBilling(
        job_id=job_id,
        user_id=user_id,
        quote_id=quote.id,
        kind=kind,
        payment_source="credits",
        status="reserved",
        reserved_credits=quote.credits,
    )
    db.add(billing)
    db.flush()
    for index, stage in enumerate((quote.pricing_snapshot or {}).get("stages", [])):
        db.add(
            CloudGenerationStage(
                billing_id=billing.id,
                stage_name=str(stage["stage"]),
                sequence=index,
                model_id=str(stage["model"]),
                provider_cost_microusd=int(stage["provider_cost_microusd"]),
                reserved_credits=int(stage["credits"]),
            )
        )
    db.commit()
    db.refresh(billing)
    return billing


def _load_stage(db: Session, job_id: str, stage_name: str) -> tuple[CloudGenerationBilling, CloudGenerationStage]:
    billing = db.query(CloudGenerationBilling).filter(CloudGenerationBilling.job_id == job_id).first()
    if not billing:
        raise BillingError("Cloud billing job was not found")
    stage = db.query(CloudGenerationStage).filter(
        CloudGenerationStage.billing_id == billing.id,
        CloudGenerationStage.stage_name == stage_name,
    ).first()
    if not stage:
        raise BillingError(f"Billing stage {stage_name!r} was not found")
    return billing, stage


def mark_stage_submitted(db: Session, job_id: str, stage_name: str, request_id: str | None) -> None:
    billing, stage = _load_stage(db, job_id, stage_name)
    if stage.status in {"captured", "completed", "released", "failed"}:
        return
    stage.status = "submitted"
    stage.submitted_at = stage.submitted_at or utcnow()
    if request_id:
        stage.fal_request_id = str(request_id)[:160]
    billing.status = "submitted"
    db.commit()


def _capture_stage(db: Session, billing: CloudGenerationBilling, stage: CloudGenerationStage) -> None:
    if billing.payment_source != "credits":
        if stage.status not in {"completed", "failed"}:
            stage.status = "completed"
            stage.settled_at = utcnow()
        return
    if stage.status == "captured":
        return
    if stage.status in {"released", "failed"}:
        raise BillingError("Cannot capture a released billing stage")
    amount = int(stage.reserved_credits)
    account = ensure_account(db, billing.user_id)
    result = db.execute(
        update(CreditAccount)
        .where(CreditAccount.user_id == billing.user_id, CreditAccount.reserved_balance >= amount)
        .values(
            reserved_balance=CreditAccount.reserved_balance - amount,
            lifetime_spent=CreditAccount.lifetime_spent + amount,
            updated_at=utcnow(),
        )
    )
    if result.rowcount != 1:
        raise BillingError("Reserved credit balance is inconsistent")
    db.expire(account)
    _ledger(
        db,
        account,
        entry_type="capture",
        source="generation",
        delta_available=0,
        delta_reserved=-amount,
        idempotency_key=f"generation:{billing.job_id}:capture:{stage.stage_name}",
        reference_type="cloud_job",
        reference_id=billing.job_id,
        details={"stage": stage.stage_name, "model": stage.model_id},
    )
    stage.status = "captured"
    stage.captured_credits = amount
    stage.settled_at = utcnow()
    billing.captured_credits = int(billing.captured_credits or 0) + amount


def capture_stage(db: Session, job_id: str, stage_name: str) -> None:
    billing, stage = _load_stage(db, job_id, stage_name)
    _capture_stage(db, billing, stage)
    db.commit()


def _release_stage(db: Session, billing: CloudGenerationBilling, stage: CloudGenerationStage, reason: str) -> None:
    if billing.payment_source != "credits":
        stage.status = "failed"
        stage.settled_at = utcnow()
        return
    if stage.status in {"captured", "released", "failed"}:
        return
    amount = int(stage.reserved_credits)
    account = ensure_account(db, billing.user_id)
    db.execute(
        update(CreditAccount)
        .where(CreditAccount.user_id == billing.user_id)
        .values(
            available_balance=CreditAccount.available_balance + amount,
            reserved_balance=CreditAccount.reserved_balance - amount,
            updated_at=utcnow(),
        )
    )
    db.expire(account)
    _ledger(
        db,
        account,
        entry_type="release",
        source="generation",
        delta_available=amount,
        delta_reserved=-amount,
        idempotency_key=f"generation:{billing.job_id}:release:{stage.stage_name}",
        reference_type="cloud_job",
        reference_id=billing.job_id,
        details={"stage": stage.stage_name, "reason": reason},
    )
    stage.status = "released"
    stage.released_credits = amount
    stage.settled_at = utcnow()
    billing.released_credits = int(billing.released_credits or 0) + amount


def fail_stage(db: Session, job_id: str, stage_name: str, *, definitive: bool = True) -> None:
    billing, stage = _load_stage(db, job_id, stage_name)
    if definitive:
        _release_stage(db, billing, stage, "provider_failed")
        stage.status = "failed"
    db.commit()


def finalize_job_success(db: Session, job_id: str) -> None:
    billing = db.query(CloudGenerationBilling).filter(CloudGenerationBilling.job_id == job_id).first()
    if not billing:
        return
    if billing.payment_source == "credits":
        stages = db.query(CloudGenerationStage).filter(CloudGenerationStage.billing_id == billing.id).all()
        for stage in stages:
            _capture_stage(db, billing, stage)
    billing.status = "complete"
    billing.completed_at = utcnow()
    db.commit()


def finalize_job_failure(db: Session, job_id: str, error_code: str = "pipeline_failed") -> None:
    billing = db.query(CloudGenerationBilling).filter(CloudGenerationBilling.job_id == job_id).first()
    if not billing:
        return
    pending = False
    if billing.payment_source == "credits":
        stages = db.query(CloudGenerationStage).filter(CloudGenerationStage.billing_id == billing.id).all()
        for stage in stages:
            if stage.status == "reserved":
                _release_stage(db, billing, stage, error_code)
            elif stage.status == "submitted":
                pending = True
    billing.status = "pending_reconciliation" if pending else "failed"
    billing.error_code = str(error_code)[:64]
    if not pending:
        billing.completed_at = utcnow()
    db.commit()


def finalize_reconciled_job(db: Session, job_id: str) -> bool:
    billing = db.query(CloudGenerationBilling).filter(CloudGenerationBilling.job_id == job_id).first()
    if not billing:
        return False
    stages = db.query(CloudGenerationStage).filter(CloudGenerationStage.billing_id == billing.id).all()
    if any(stage.status in {"reserved", "submitted"} for stage in stages):
        return False
    billing.status = "failed" if any(stage.status in {"failed", "released"} for stage in stages) else "complete"
    billing.completed_at = billing.completed_at or utcnow()
    db.commit()
    return True


def owns_job(db: Session, job_id: str, user_id: str) -> bool:
    return db.query(CloudGenerationBilling.id).filter(
        CloudGenerationBilling.job_id == job_id,
        CloudGenerationBilling.user_id == user_id,
    ).first() is not None


def claim_reel_reward(
    db: Session,
    *,
    user_id: str,
    post_id: str,
    impression_id: str,
    ip_hash: str,
) -> dict[str, Any]:
    now = utcnow()
    today = now.date().isoformat()
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    account = ensure_account(db, user_id)
    # A no-op update locks this user's wallet row on PostgreSQL and starts a
    # SQLite write transaction, serializing milestone assignment.
    db.execute(
        update(CreditAccount)
        .where(CreditAccount.user_id == user_id)
        .values(updated_at=CreditAccount.updated_at)
    )
    impression = db.get(RecommendationImpression, impression_id)
    session = db.get(RecommendationSession, impression.session_id) if impression else None
    post = db.get(Post, post_id)
    if not impression or not session or impression.post_id != post_id or session.user_id != user_id:
        raise RewardError("Recommendation impression is invalid or belongs to another viewer")
    if not impression.first_visible_at:
        raise RewardError("The reel must be visibly presented before it can earn rewards")
    visible_at = aware(impression.first_visible_at)
    if visible_at < day_start or session.status != "active" or aware(session.expires_at) <= now:
        raise RewardError("Recommendation impression is no longer eligible for rewards")
    if not post or post.owner_id == user_id:
        raise RewardError("Self-views are not eligible for rewards")

    existing = db.query(ReelRewardClaim).filter(
        ReelRewardClaim.user_id == user_id,
        ReelRewardClaim.post_id == post_id,
        ReelRewardClaim.utc_date == today,
    ).first()
    if existing:
        count = db.query(func.count(ReelRewardClaim.id)).filter(
            ReelRewardClaim.user_id == user_id, ReelRewardClaim.utc_date == today
        ).scalar() or 0
        awarded = db.query(func.count(ReelRewardClaim.id)).filter(
            ReelRewardClaim.user_id == user_id,
            ReelRewardClaim.utc_date == today,
            ReelRewardClaim.awarded_credit.is_(True),
        ).scalar() or 0
        return _reward_payload(count, awarded, False, duplicate=True)

    event = (
        db.query(EngagementEvent)
        .filter(
            EngagementEvent.user_id == user_id,
            EngagementEvent.post_id == post_id,
            EngagementEvent.recommendation_impression_id == impression_id,
            EngagementEvent.event_type == "reward_eligible",
            EngagementEvent.source == "reels",
            EngagementEvent.created_at >= impression.first_visible_at,
        )
        .order_by(EngagementEvent.created_at.desc())
        .first()
    )
    if not event:
        raise RewardError("Qualified foreground playback telemetry was not found")
    media_type = str(post.media_type or (event.context or {}).get("media_type") or "video").casefold()
    duration_ms = max(0, int(event.duration_ms or 0))
    threshold_ms = 3000 if media_type == "image" else min(10000, max(3000, round(duration_ms * 0.5)))
    foreground_ms = max(0, int(event.foreground_ms or 0))
    if foreground_ms < threshold_ms:
        raise RewardError(f"Watch at least {threshold_ms / 1000:g} seconds in the foreground")
    server_elapsed_ms = max(0, int((aware(event.created_at) - visible_at).total_seconds() * 1000))
    if server_elapsed_ms + 500 < threshold_ms:
        raise RewardError("The reel was claimed before the server-observed viewing threshold")

    user_count = db.query(func.count(ReelRewardClaim.id)).filter(
        ReelRewardClaim.user_id == user_id, ReelRewardClaim.utc_date == today
    ).scalar() or 0
    awarded_count = db.query(func.count(ReelRewardClaim.id)).filter(
        ReelRewardClaim.user_id == user_id,
        ReelRewardClaim.utc_date == today,
        ReelRewardClaim.awarded_credit.is_(True),
    ).scalar() or 0
    ip_count = db.query(func.count(ReelRewardClaim.id)).filter(
        ReelRewardClaim.ip_hash == ip_hash, ReelRewardClaim.utc_date == today
    ).scalar() or 0
    ip_cap = max(10, int(os.environ.get("SX_REEL_REWARD_IP_DAILY_CLAIMS", "50")))
    if user_count >= 50 or awarded_count >= 5:
        return _reward_payload(user_count, awarded_count, False, daily_cap=True)
    if ip_count >= ip_cap:
        raise RewardError("Daily reward activity limit reached for this network")

    next_count = int(user_count) + 1
    should_award = next_count % 10 == 0 and int(awarded_count) < 5
    claim = ReelRewardClaim(
        user_id=user_id,
        post_id=post_id,
        impression_id=impression_id,
        utc_date=today,
        ip_hash=ip_hash,
        media_type=media_type,
        foreground_ms=foreground_ms,
        duration_ms=duration_ms or None,
        awarded_credit=should_award,
    )
    db.add(claim)
    db.flush()
    if should_award:
        grant_credits(
            db,
            user_id,
            1,
            source="earned",
            idempotency_key=f"reel-reward:{user_id}:{today}:{next_count // 10}",
            reference_type="reel_reward",
            reference_id=claim.id,
            details={"post_id": post_id, "impression_id": impression_id},
        )
    db.commit()
    db.refresh(account)
    return {
        **_reward_payload(next_count, int(awarded_count) + (1 if should_award else 0), should_award),
        "wallet": _wallet_payload(account),
    }


def _reward_payload(count: int, awarded: int, credit_awarded: bool, **extra: Any) -> dict[str, Any]:
    capped = int(awarded) >= 5 or int(count) >= 50
    progress = 10 if capped else int(count) % 10
    return {
        "eligible_reels_today": int(count),
        "credits_earned_today": int(awarded),
        "credit_awarded": bool(credit_awarded),
        "progress": progress,
        "target": 10,
        "remaining": 0 if capped else 10 - progress,
        "daily_cap_reached": capped,
        **extra,
    }
