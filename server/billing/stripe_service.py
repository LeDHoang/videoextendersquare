"""Stripe Checkout creation and idempotent webhook fulfillment."""

from __future__ import annotations

import hashlib
import os
from typing import Any

from sqlalchemy.orm import Session

from server.social.models import StripeEvent, StripePurchase, utcnow

from .service import BillingError, debit_credits, flag_enabled, grant_credits


CREDIT_PACKS = {
    "starter": {"label": "500 Credits", "amount_cents": 500, "credits": 500, "price_env": "SX_STRIPE_PRICE_500"},
    "plus": {"label": "1,050 Credits", "amount_cents": 1000, "credits": 1050, "price_env": "SX_STRIPE_PRICE_1050"},
    "creator": {"label": "2,750 Credits", "amount_cents": 2500, "credits": 2750, "price_env": "SX_STRIPE_PRICE_2750"},
}


def catalog() -> list[dict[str, Any]]:
    return [
        {
            "id": pack_id,
            "label": pack["label"],
            "amount_cents": pack["amount_cents"],
            "currency": "usd",
            "credits": pack["credits"],
            "configured": bool(os.environ.get(pack["price_env"], "").strip()),
        }
        for pack_id, pack in CREDIT_PACKS.items()
    ]


def _stripe():
    try:
        import stripe
    except ImportError as exc:
        raise BillingError("Stripe support is not installed") from exc
    secret = os.environ.get("STRIPE_SECRET_KEY", "").strip()
    if not secret:
        raise BillingError("STRIPE_SECRET_KEY is not configured")
    stripe.api_key = secret
    return stripe


def create_checkout(db: Session, *, user_id: str, pack_id: str, base_url: str) -> dict[str, str]:
    if not flag_enabled("SX_STRIPE_ENABLED"):
        raise BillingError("Stripe checkout is disabled")
    pack = CREDIT_PACKS.get(str(pack_id))
    if not pack:
        raise BillingError("Unknown credit pack")
    price_id = os.environ.get(pack["price_env"], "").strip()
    if not price_id:
        raise BillingError(f"Stripe price is not configured for pack {pack_id}")
    stripe = _stripe()
    origin = base_url.rstrip("/")
    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{"price": price_id, "quantity": 1}],
        success_url=f"{origin}/wallet?checkout=success&session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{origin}/wallet?checkout=cancelled",
        client_reference_id=user_id,
        metadata={"echo_user_id": user_id, "echo_pack_id": pack_id},
        payment_intent_data={"metadata": {"echo_user_id": user_id, "echo_pack_id": pack_id}},
    )
    row = StripePurchase(
        user_id=user_id,
        pack_id=pack_id,
        stripe_price_id=price_id,
        checkout_session_id=session.id,
        amount_total_cents=pack["amount_cents"],
        currency="usd",
        credits=pack["credits"],
        status="created",
    )
    db.add(row)
    db.commit()
    return {"checkout_url": session.url, "session_id": session.id}


def construct_event(payload: bytes, signature: str):
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()
    if not secret:
        raise BillingError("STRIPE_WEBHOOK_SECRET is not configured")
    return _stripe().Webhook.construct_event(payload, signature, secret)


def _event_value(event: Any, key: str, default=None):
    if isinstance(event, dict):
        return event.get(key, default)
    return getattr(event, key, default)


def _metadata(obj: Any) -> dict[str, str]:
    value = _event_value(obj, "metadata", {}) or {}
    return dict(value)


def _retrieve_checkout(session_id: str):
    return _stripe().checkout.Session.retrieve(session_id, expand=["line_items"])


def _validate_checkout(session: Any) -> tuple[str, dict[str, Any], str]:
    metadata = _metadata(session)
    user_id = str(metadata.get("echo_user_id") or _event_value(session, "client_reference_id") or "")
    pack_id = str(metadata.get("echo_pack_id") or "")
    pack = CREDIT_PACKS.get(pack_id)
    if not user_id or not pack:
        raise BillingError("Checkout metadata is missing or invalid")
    price_id = os.environ.get(pack["price_env"], "").strip()
    line_items = _event_value(session, "line_items")
    rows = _event_value(line_items, "data", []) if line_items else []
    actual_price = ""
    if rows:
        actual_price = str(_event_value(_event_value(rows[0], "price", {}), "id", ""))
    if not price_id or actual_price != price_id:
        raise BillingError("Checkout price does not match a configured credit pack")
    if int(_event_value(session, "amount_total", -1)) != int(pack["amount_cents"]):
        raise BillingError("Checkout amount does not match the configured credit pack")
    if str(_event_value(session, "currency", "")).casefold() != "usd":
        raise BillingError("Checkout currency does not match the configured credit pack")
    return user_id, pack, price_id


def _fulfill_checkout(db: Session, session_obj: Any) -> bool:
    session_id = str(_event_value(session_obj, "id", ""))
    session = _retrieve_checkout(session_id)
    user_id, pack, price_id = _validate_checkout(session)
    purchase = db.query(StripePurchase).filter(StripePurchase.checkout_session_id == session_id).first()
    if purchase and purchase.user_id != user_id:
        raise BillingError("Checkout session ownership does not match")
    if not purchase:
        purchase = StripePurchase(
            user_id=user_id,
            pack_id=str(_metadata(session).get("echo_pack_id")),
            stripe_price_id=price_id,
            checkout_session_id=session_id,
            amount_total_cents=pack["amount_cents"],
            currency="usd",
            credits=pack["credits"],
            status="created",
        )
        db.add(purchase)
        db.flush()
    payment_intent = _event_value(session, "payment_intent")
    if payment_intent:
        purchase.payment_intent_id = str(_event_value(payment_intent, "id", payment_intent))
    if str(_event_value(session, "payment_status", "")).casefold() != "paid":
        purchase.status = "pending"
        return False
    _, granted = grant_credits(
        db,
        user_id,
        int(pack["credits"]),
        source="purchase",
        idempotency_key=f"stripe-checkout:{session_id}",
        reference_type="stripe_purchase",
        reference_id=purchase.id,
        details={"pack_id": purchase.pack_id, "amount_cents": purchase.amount_total_cents},
    )
    purchase.status = "fulfilled"
    purchase.fulfilled_at = purchase.fulfilled_at or utcnow()
    return granted


def _reverse_payment(db: Session, payment_intent_id: str, event_type: str) -> bool:
    purchase = db.query(StripePurchase).filter(StripePurchase.payment_intent_id == payment_intent_id).first()
    if not purchase and payment_intent_id:
        sessions = _stripe().checkout.Session.list(payment_intent=payment_intent_id, limit=1)
        rows = _event_value(sessions, "data", []) or []
        if rows:
            _fulfill_checkout(db, rows[0])
            purchase = db.query(StripePurchase).filter(
                StripePurchase.payment_intent_id == payment_intent_id
            ).first()
    if not purchase:
        return False
    _, debited = debit_credits(
        db,
        purchase.user_id,
        purchase.credits,
        source="refund" if event_type == "charge.refunded" else "dispute",
        idempotency_key=f"stripe-reversal:{purchase.id}",
        reference_type="stripe_purchase",
        reference_id=purchase.id,
        details={"stripe_event_type": event_type},
    )
    purchase.status = "reversed"
    purchase.reversed_at = purchase.reversed_at or utcnow()
    return debited


def process_webhook(db: Session, *, payload: bytes, signature: str) -> dict[str, Any]:
    event = construct_event(payload, signature)
    event_id = str(_event_value(event, "id", ""))
    event_type = str(_event_value(event, "type", ""))
    if not event_id:
        raise BillingError("Stripe event ID is missing")
    payload_hash = hashlib.sha256(payload).hexdigest()
    row = db.get(StripeEvent, event_id)
    if row:
        if row.payload_hash != payload_hash or row.event_type != event_type:
            raise BillingError("Stripe event ID was reused with different content")
        if row.status == "processed":
            return {"received": True, "duplicate": True, "status": row.status}
        if row.status == "processing":
            return {"received": True, "duplicate": True, "status": row.status}
        row.status = "processing"
        row.error = None
        row.processed_at = None
    else:
        row = StripeEvent(
            event_id=event_id,
            event_type=event_type,
            payload_hash=payload_hash,
            status="processing",
        )
        db.add(row)
    db.flush()
    try:
        obj = _event_value(_event_value(event, "data", {}), "object", {})
        changed = False
        if event_type in {"checkout.session.completed", "checkout.session.async_payment_succeeded"}:
            changed = _fulfill_checkout(db, obj)
        elif event_type == "checkout.session.async_payment_failed":
            purchase = db.query(StripePurchase).filter(
                StripePurchase.checkout_session_id == str(_event_value(obj, "id", ""))
            ).first()
            if purchase and purchase.status != "fulfilled":
                purchase.status = "failed"
        elif event_type == "charge.refunded":
            changed = _reverse_payment(db, str(_event_value(obj, "payment_intent", "")), event_type)
        elif event_type == "charge.dispute.created":
            charge = _event_value(obj, "charge")
            if charge and not isinstance(charge, str):
                payment_intent = str(_event_value(charge, "payment_intent", ""))
            else:
                charge_obj = _stripe().Charge.retrieve(str(charge)) if charge else {}
                payment_intent = str(_event_value(charge_obj, "payment_intent", ""))
            changed = _reverse_payment(db, payment_intent, event_type)
        row.status = "processed"
        row.processed_at = utcnow()
        db.commit()
        return {"received": True, "duplicate": False, "changed": changed}
    except Exception as exc:
        db.rollback()
        failed = db.get(StripeEvent, event_id)
        if not failed:
            failed = StripeEvent(
                event_id=event_id,
                event_type=event_type,
                payload_hash=payload_hash,
            )
            db.add(failed)
        failed.status = "failed"
        failed.error = str(exc)[:500]
        failed.processed_at = utcnow()
        db.commit()
        raise
