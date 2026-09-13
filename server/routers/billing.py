"""Wallet, quotes, Stripe Checkout, and encrypted Fal credential endpoints."""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from core import models as model_catalog
from pipeline.utils import get_image_dimensions, get_video_dimensions_and_duration, get_video_frame_metadata
from server.billing.crypto import FalKeyConfigurationError, encrypt_fal_key, key_hint
from server.billing.parameters import image_parameters, video_parameters
from server.billing.service import (
    BillingError,
    QuoteError,
    create_quote,
    flag_enabled,
    get_wallet,
    list_transactions,
    quote_payload,
)
from server.billing.stripe_service import catalog as pack_catalog
from server.billing.stripe_service import create_checkout, process_webhook
from server.social.auth import AuthContext, require_auth, require_auth_csrf, validate_origin
from server.social.database import get_db
from server.social.models import FalCredential, utcnow

router = APIRouter(tags=["billing"])


class QuoteRequest(BaseModel):
    kind: str
    stage_id: str = Field(min_length=1, max_length=64)
    parameters: dict = Field(default_factory=dict)


class CheckoutRequest(BaseModel):
    pack_id: str


class FalKeyRequest(BaseModel):
    fal_key: str = Field(min_length=8, max_length=500)


def _billing_http_error(exc: BillingError):
    status = 402 if getattr(exc, "code", "") == "INSUFFICIENT_CREDITS" else 409 if isinstance(exc, QuoteError) else 400
    raise HTTPException(status_code=status, detail={"code": getattr(exc, "code", "BILLING_ERROR"), "message": str(exc)})


def _staged_metadata(kind: str, stage_id: str) -> tuple[int, int, float | None, float | None, int | None]:
    if kind == "image":
        from server.routers.image import STAGED_UPLOADS

        staged = STAGED_UPLOADS.get(stage_id)
        path = staged[0] if staged else None
        if not path or not os.path.exists(path):
            raise HTTPException(status_code=400, detail={"code": "INVALID_STAGE", "message": "Upload is invalid or expired."})
        width, height = get_image_dimensions(path)
        return width, height, None, None, None
    if kind == "video":
        from server.routers.video import STAGED_UPLOADS

        staged = STAGED_UPLOADS.get(stage_id)
        path = staged[0] if staged else None
        if not path or not os.path.exists(path):
            raise HTTPException(status_code=400, detail={"code": "INVALID_STAGE", "message": "Upload is invalid or expired."})
        width, height, duration = get_video_dimensions_and_duration(path)
        fps, frames = get_video_frame_metadata(path)
        return width, height, duration, fps, frames
    raise HTTPException(status_code=422, detail={"code": "INVALID_KIND", "message": "kind must be image or video."})


@router.get("/api/billing/catalog")
def billing_catalog():
    defaults = {
        "outpaint_img": model_catalog.IMAGE_MODELS["outpaint_img"],
        "upscale_img": model_catalog.IMAGE_MODELS["upscale_img"],
        "outpaint_vid": model_catalog.DEFAULT_VIDEO_MODELS["outpaint_vid"],
        "upscale_vid": model_catalog.DEFAULT_VIDEO_MODELS["upscale_vid"],
    }
    return {
        "credits_enabled": flag_enabled("SX_CREDITS_ENABLED"),
        "stripe_enabled": flag_enabled("SX_STRIPE_ENABLED"),
        "reel_rewards_enabled": flag_enabled("SX_REEL_REWARDS_ENABLED"),
        "currency": {"name": "ECHO Credits", "usd_per_credit": "0.01", "markup": "1.35"},
        "packs": pack_catalog(),
        "models": model_catalog.config_payload(defaults),
    }


@router.get("/api/billing/wallet")
def wallet(context: AuthContext = Depends(require_auth), db: Session = Depends(get_db)):
    return get_wallet(db, context.user.id)


@router.get("/api/billing/transactions")
def transactions(
    limit: int = 50,
    before: str | None = None,
    context: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
):
    return {"transactions": list_transactions(db, context.user.id, limit=limit, before=before)}


@router.post("/api/billing/quote")
def quote(
    body: QuoteRequest,
    request: Request,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    validate_origin(request)
    if not flag_enabled("SX_CREDITS_ENABLED"):
        raise HTTPException(status_code=503, detail={"code": "CREDITS_DISABLED", "message": "ECHO Credits are disabled."})
    kind = body.kind.strip().casefold()
    width, height, duration, source_fps, source_frames = _staged_metadata(kind, body.stage_id)
    parameters = image_parameters(body.parameters) if kind == "image" else video_parameters(body.parameters)
    try:
        row = create_quote(
            db,
            user_id=context.user.id,
            kind=kind,
            stage_id=body.stage_id,
            width=width,
            height=height,
            duration=duration,
            params=parameters,
            source_fps=source_fps,
            source_frames=source_frames,
        )
    except BillingError as exc:
        _billing_http_error(exc)
    return quote_payload(row)


@router.post("/api/billing/checkout-session")
def checkout_session(
    body: CheckoutRequest,
    request: Request,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    validate_origin(request)
    base_url = os.environ.get("SX_PUBLIC_BASE_URL", "").strip() or str(request.base_url).rstrip("/")
    try:
        return create_checkout(db, user_id=context.user.id, pack_id=body.pack_id, base_url=base_url)
    except BillingError as exc:
        _billing_http_error(exc)


@router.post("/api/billing/webhooks/stripe")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    payload = await request.body()
    signature = request.headers.get("stripe-signature", "")
    try:
        return process_webhook(db, payload=payload, signature=signature)
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": "INVALID_STRIPE_EVENT", "message": str(exc)}) from exc


@router.get("/api/account/fal-key")
def get_fal_key(context: AuthContext = Depends(require_auth), db: Session = Depends(get_db)):
    row = db.get(FalCredential, context.user.id)
    return {"configured": bool(row), "hint": row.key_hint if row else ""}


@router.put("/api/account/fal-key")
def put_fal_key(
    body: FalKeyRequest,
    request: Request,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    validate_origin(request)
    value = body.fal_key.strip()
    try:
        ciphertext = encrypt_fal_key(context.user.id, value)
    except (FalKeyConfigurationError, ValueError) as exc:
        raise HTTPException(status_code=503, detail={"code": "FAL_KEY_ENCRYPTION_UNAVAILABLE", "message": str(exc)}) from exc
    row = db.get(FalCredential, context.user.id)
    if row:
        row.ciphertext = ciphertext
        row.key_hint = key_hint(value)
        row.key_version = 1
        row.updated_at = utcnow()
    else:
        row = FalCredential(user_id=context.user.id, ciphertext=ciphertext, key_hint=key_hint(value))
        db.add(row)
    db.commit()
    return {"configured": True, "hint": row.key_hint}


@router.delete("/api/account/fal-key")
def delete_fal_key(
    request: Request,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    validate_origin(request)
    db.query(FalCredential).filter(FalCredential.user_id == context.user.id).delete(synchronize_session=False)
    db.commit()
    return {"configured": False, "hint": ""}
