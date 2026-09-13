from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from server.billing import stripe_service
from server.billing.service import BillingError, get_wallet
from server.social.database import Base
from server.social.models import StripeEvent, StripePurchase, User


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    with Session() as session:
        yield session
    engine.dispose()


def add_user(db, username="stripe_user"):
    user = User(username=username, username_norm=username, display_name=username)
    db.add(user)
    db.commit()
    return user


def paid_session(user_id, *, session_id="cs_1", payment_intent="pi_1", pack_id="starter"):
    return {
        "id": session_id,
        "client_reference_id": user_id,
        "metadata": {"echo_user_id": user_id, "echo_pack_id": pack_id},
        "line_items": {"data": [{"price": {"id": "price_500"}}]},
        "amount_total": 500,
        "currency": "usd",
        "payment_status": "paid",
        "payment_intent": payment_intent,
    }


def event(event_id, event_type, obj):
    return {"id": event_id, "type": event_type, "data": {"object": obj}}


def configure(monkeypatch):
    monkeypatch.setenv("SX_STRIPE_PRICE_500", "price_500")


def test_completed_checkout_and_duplicate_event_grant_once(db, monkeypatch):
    configure(monkeypatch)
    user = add_user(db)
    session = paid_session(user.id)
    monkeypatch.setattr(stripe_service, "construct_event", lambda payload, signature: event("evt_1", "checkout.session.completed", {"id": "cs_1"}))
    monkeypatch.setattr(stripe_service, "_retrieve_checkout", lambda session_id: session)

    first = stripe_service.process_webhook(db, payload=b"completed", signature="valid")
    second = stripe_service.process_webhook(db, payload=b"completed", signature="valid")

    assert first == {"received": True, "duplicate": False, "changed": True}
    assert second["duplicate"] is True
    assert get_wallet(db, user.id)["available_credits"] == 500
    assert db.query(StripePurchase).one().status == "fulfilled"


def test_delayed_checkout_success_fulfills_only_after_paid(db, monkeypatch):
    configure(monkeypatch)
    user = add_user(db, "delayed_user")
    session = paid_session(user.id, session_id="cs_delayed", payment_intent="pi_delayed")
    session["payment_status"] = "unpaid"
    events = {
        b"pending": event("evt_pending", "checkout.session.completed", {"id": "cs_delayed"}),
        b"paid": event("evt_paid", "checkout.session.async_payment_succeeded", {"id": "cs_delayed"}),
    }
    monkeypatch.setattr(stripe_service, "construct_event", lambda payload, signature: events[payload])
    monkeypatch.setattr(stripe_service, "_retrieve_checkout", lambda session_id: session)

    stripe_service.process_webhook(db, payload=b"pending", signature="valid")
    assert get_wallet(db, user.id)["available_credits"] == 0
    assert db.query(StripePurchase).one().status == "pending"

    session["payment_status"] = "paid"
    stripe_service.process_webhook(db, payload=b"paid", signature="valid")
    assert get_wallet(db, user.id)["available_credits"] == 500
    assert db.query(StripePurchase).one().status == "fulfilled"


def test_failed_event_is_atomic_and_retryable(db, monkeypatch):
    configure(monkeypatch)
    user = add_user(db, "retry_user")
    session = paid_session(user.id, session_id="cs_retry", payment_intent="pi_retry")
    monkeypatch.setattr(stripe_service, "construct_event", lambda payload, signature: event("evt_retry", "checkout.session.completed", {"id": "cs_retry"}))
    attempts = {"count": 0}

    def retrieve(_session_id):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise BillingError("temporary Stripe outage")
        return session

    monkeypatch.setattr(stripe_service, "_retrieve_checkout", retrieve)
    with pytest.raises(BillingError, match="temporary"):
        stripe_service.process_webhook(db, payload=b"retry", signature="valid")
    assert db.get(StripeEvent, "evt_retry").status == "failed"
    assert db.query(StripePurchase).count() == 0

    result = stripe_service.process_webhook(db, payload=b"retry", signature="valid")
    assert result["duplicate"] is False
    assert db.get(StripeEvent, "evt_retry").status == "processed"
    assert get_wallet(db, user.id)["available_credits"] == 500


def test_out_of_order_refund_creates_then_reverses_purchase(db, monkeypatch):
    configure(monkeypatch)
    user = add_user(db, "refund_user")
    session = paid_session(user.id, session_id="cs_refund", payment_intent="pi_refund")

    class SessionApi:
        @staticmethod
        def list(payment_intent, limit):
            assert payment_intent == "pi_refund"
            assert limit == 1
            return {"data": [{"id": "cs_refund"}]}

    class FakeStripe:
        class checkout:
            Session = SessionApi

    monkeypatch.setattr(stripe_service, "_stripe", lambda: FakeStripe())
    monkeypatch.setattr(stripe_service, "_retrieve_checkout", lambda session_id: session)
    monkeypatch.setattr(stripe_service, "construct_event", lambda payload, signature: event("evt_refund", "charge.refunded", {"payment_intent": "pi_refund"}))

    result = stripe_service.process_webhook(db, payload=b"refund", signature="valid")
    purchase = db.query(StripePurchase).one()
    assert result["changed"] is True
    assert purchase.status == "reversed"
    assert get_wallet(db, user.id)["available_credits"] == 0


def test_partial_refunds_revoke_pro_rata_and_accumulate(db, monkeypatch):
    configure(monkeypatch)
    user = add_user(db, "partial_user")
    session = paid_session(user.id, session_id="cs_partial", payment_intent="pi_partial")
    completed = event("evt_partial_paid", "checkout.session.completed", {"id": "cs_partial"})
    events = {
        b"paid": completed,
        b"part1": event("evt_r1", "charge.refunded", {"payment_intent": "pi_partial", "amount_refunded": 100}),
        b"part2": event("evt_r2", "charge.refunded", {"payment_intent": "pi_partial", "amount_refunded": 250}),
        b"full": event("evt_r3", "charge.refunded", {"payment_intent": "pi_partial", "amount_refunded": 500}),
    }
    monkeypatch.setattr(stripe_service, "construct_event", lambda payload, signature: events[payload])
    monkeypatch.setattr(stripe_service, "_retrieve_checkout", lambda session_id: session)

    stripe_service.process_webhook(db, payload=b"paid", signature="valid")
    assert get_wallet(db, user.id)["available_credits"] == 500

    assert stripe_service.process_webhook(db, payload=b"part1", signature="valid")["changed"] is True
    purchase = db.query(StripePurchase).one()
    assert purchase.status == "partially_reversed"
    assert purchase.amount_refunded_cents == 100
    assert purchase.credits_revoked == 100  # ceil(500 * 100/500)
    assert get_wallet(db, user.id)["available_credits"] == 400

    assert stripe_service.process_webhook(db, payload=b"part2", signature="valid")["changed"] is True
    purchase = db.query(StripePurchase).one()
    assert purchase.status == "partially_reversed"
    assert purchase.credits_revoked == 250  # ceil(500 * 250/500) cumulative
    assert get_wallet(db, user.id)["available_credits"] == 250

    assert stripe_service.process_webhook(db, payload=b"full", signature="valid")["changed"] is True
    purchase = db.query(StripePurchase).one()
    assert purchase.status == "reversed"
    assert purchase.reversed_at is not None
    assert get_wallet(db, user.id)["available_credits"] == 0


def test_refund_on_unpaid_purchase_skips_debit(db, monkeypatch):
    configure(monkeypatch)
    user = add_user(db, "unpaid_refund_user")
    session = paid_session(user.id, session_id="cs_unpaid", payment_intent="pi_unpaid")
    session["payment_status"] = "unpaid"
    events = {
        b"pending": event("evt_unpaid", "checkout.session.completed", {"id": "cs_unpaid"}),
        b"refund": event("evt_unpaid_r", "charge.refunded", {"payment_intent": "pi_unpaid", "amount_refunded": 500}),
    }
    monkeypatch.setattr(stripe_service, "construct_event", lambda payload, signature: events[payload])
    monkeypatch.setattr(stripe_service, "_retrieve_checkout", lambda session_id: session)

    stripe_service.process_webhook(db, payload=b"pending", signature="valid")
    assert db.query(StripePurchase).one().status == "pending"
    result = stripe_service.process_webhook(db, payload=b"refund", signature="valid")
    assert result["changed"] is False
    purchase = db.query(StripePurchase).one()
    assert purchase.status == "pending"
    assert get_wallet(db, user.id)["available_credits"] == 0


def test_late_completed_after_reversal_keeps_reversed_status(db, monkeypatch):
    configure(monkeypatch)
    user = add_user(db, "late_completed_user")
    session = paid_session(user.id, session_id="cs_late", payment_intent="pi_late")

    class SessionApi:
        @staticmethod
        def list(payment_intent, limit):
            return {"data": [{"id": "cs_late"}]}

    class FakeStripe:
        class checkout:
            Session = SessionApi

    events = {
        b"refund": event("evt_late_r", "charge.refunded", {"payment_intent": "pi_late", "amount_refunded": 500}),
        b"completed": event("evt_late_c", "checkout.session.completed", {"id": "cs_late"}),
    }
    monkeypatch.setattr(stripe_service, "_stripe", lambda: FakeStripe())
    monkeypatch.setattr(stripe_service, "construct_event", lambda payload, signature: events[payload])
    monkeypatch.setattr(stripe_service, "_retrieve_checkout", lambda session_id: session)

    stripe_service.process_webhook(db, payload=b"refund", signature="valid")
    assert db.query(StripePurchase).one().status == "reversed"

    result = stripe_service.process_webhook(db, payload=b"completed", signature="valid")
    assert result["changed"] is False
    purchase = db.query(StripePurchase).one()
    assert purchase.status == "reversed"
    assert get_wallet(db, user.id)["available_credits"] == 0


def test_unknown_pack_metadata_is_rejected_without_credit(db, monkeypatch):
    configure(monkeypatch)
    user = add_user(db, "tampered_user")
    session = paid_session(user.id, session_id="cs_bad", payment_intent="pi_bad", pack_id="unknown")
    monkeypatch.setattr(stripe_service, "construct_event", lambda payload, signature: event("evt_bad", "checkout.session.completed", {"id": "cs_bad"}))
    monkeypatch.setattr(stripe_service, "_retrieve_checkout", lambda session_id: session)

    with pytest.raises(BillingError, match="metadata"):
        stripe_service.process_webhook(db, payload=b"bad", signature="valid")
    assert db.get(StripeEvent, "evt_bad").status == "failed"
    assert get_wallet(db, user.id)["available_credits"] == 0


def test_construct_event_uses_raw_payload_signature_and_secret(monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    captured = {}

    class Webhook:
        @staticmethod
        def construct_event(payload, signature, secret):
            captured.update(payload=payload, signature=signature, secret=secret)
            return {"id": "evt_verified"}

    class FakeStripe:
        pass

    FakeStripe.Webhook = Webhook

    monkeypatch.setattr(stripe_service, "_stripe", lambda: FakeStripe())
    result = stripe_service.construct_event(b"raw-body", "stripe-signature")
    assert result["id"] == "evt_verified"
    assert captured == {"payload": b"raw-body", "signature": "stripe-signature", "secret": "whsec_test"}
