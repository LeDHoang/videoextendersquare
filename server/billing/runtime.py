"""Runtime helpers shared by image and video cloud job routes."""

from __future__ import annotations

import os
from collections.abc import Callable
from cryptography.exceptions import InvalidTag

from sqlalchemy.orm import Session

from server.social.models import FalCredential

from .crypto import FalKeyConfigurationError, decrypt_fal_key
from .service import (
    BillingError,
    capture_stage,
    fail_stage,
    finalize_job_failure,
    finalize_job_success,
    finalize_reconciled_job,
    flag_enabled,
    mark_stage_submitted,
)


def resolve_fal_key(db: Session, *, user_id: str, payment_source: str) -> str:
    source = str(payment_source or "").casefold()
    if source == "credits":
        if not flag_enabled("SX_CREDITS_ENABLED"):
            raise BillingError("ECHO Credits are disabled")
        key = os.environ.get("FAL_KEY", "").strip()
        if not key:
            raise BillingError("Platform Fal processing is temporarily unavailable")
        return key
    if source != "byok":
        raise BillingError("payment_source must be credits or byok")
    row = db.get(FalCredential, user_id)
    if not row:
        raise BillingError("Save a personal Fal key before using My Fal Key")
    try:
        return decrypt_fal_key(user_id, row.ciphertext)
    except (FalKeyConfigurationError, InvalidTag, ValueError) as exc:
        raise BillingError("The saved Fal key could not be decrypted") from exc


def lifecycle_callback(job_id: str) -> Callable[[str, str, str | None], None]:
    def callback(event: str, stage: str, request_id: str | None = None) -> None:
        from server.social.database import SessionLocal

        with SessionLocal() as db:
            if event == "submitted":
                mark_stage_submitted(db, job_id, stage, request_id)
            elif event == "completed":
                capture_stage(db, job_id, stage)
            elif event == "failed":
                fail_stage(db, job_id, stage, definitive=True)

    return callback


def success_callback(job_id: str) -> Callable[[object], None]:
    def callback(_result: object) -> None:
        from server.social.database import SessionLocal

        with SessionLocal() as db:
            finalize_job_success(db, job_id)

    return callback


def failure_callback(job_id: str) -> Callable[[Exception], None]:
    def callback(exc: Exception) -> None:
        from server.social.database import SessionLocal

        with SessionLocal() as db:
            error_code = "provider_timeout" if isinstance(exc, TimeoutError) else "pipeline_failed"
            finalize_job_failure(db, job_id, error_code=error_code)

    return callback



def reconcile_pending_requests() -> dict[str, int]:
    """Reconcile submitted Fal stages after a process restart.

    A completed remote request is captured. A provider-confirmed failure is
    released. Network/auth ambiguity intentionally leaves the reservation in
    ``submitted`` so credits are never returned while Fal may still be running.
    """
    import fal_client

    from server.social.database import SessionLocal
    from server.social.models import CloudGenerationBilling, CloudGenerationStage, FalCredential

    stats = {"checked": 0, "captured": 0, "released": 0, "pending": 0}
    with SessionLocal() as db:
        rows = (
            db.query(CloudGenerationStage, CloudGenerationBilling)
            .join(CloudGenerationBilling, CloudGenerationBilling.id == CloudGenerationStage.billing_id)
            .filter(
                CloudGenerationStage.status == "submitted",
                CloudGenerationStage.fal_request_id.is_not(None),
            )
            .all()
        )
        for stage, billing in rows:
            stats["checked"] += 1
            try:
                if billing.payment_source == "credits":
                    key = os.environ.get("FAL_KEY", "").strip()
                else:
                    credential = db.get(FalCredential, billing.user_id)
                    key = decrypt_fal_key(billing.user_id, credential.ciphertext) if credential else ""
                if not key:
                    stats["pending"] += 1
                    continue
                client = fal_client.SyncClient(key=key)
                handle = client.get_handle(stage.model_id, stage.fal_request_id)
                status = handle.status(with_logs=False)
                status_name = type(status).__name__.casefold()
                if isinstance(status, fal_client.Completed) or status_name == "completed":
                    handle.get()
                    capture_stage(db, billing.job_id, stage.stage_name)
                    finalize_reconciled_job(db, billing.job_id)
                    stats["captured"] += 1
                elif status_name in {"failed", "error", "cancelled", "canceled"}:
                    fail_stage(db, billing.job_id, stage.stage_name, definitive=True)
                    finalize_reconciled_job(db, billing.job_id)
                    stats["released"] += 1
                else:
                    stats["pending"] += 1
            except Exception:
                db.rollback()
                stats["pending"] += 1
    return stats
