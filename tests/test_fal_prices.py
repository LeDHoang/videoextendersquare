"""Live fal price sync (server/fal_prices.py) and the shared model defaults.

fal's pricing API is never called: fetch_prices is replaced with canned rows.
"""

from __future__ import annotations

import time
from decimal import Decimal

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from core import models
from core.pricing import PricingError, quote_video
from server import fal_prices
from server.billing.parameters import (
    CATALOG_DEFAULTS,
    MODEL_OVERRIDES_KEY,
    image_parameters,
    model_defaults,
    video_parameters,
)
from server.routers import config, social
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import AppSetting

LTX = "fal-ai/ltx-2.3-quality/outpaint"
RAY = "luma/agent/ray/v3.2/reframe"
BYTEDANCE = "fal-ai/bytedance-upscaler/upscale/video"
SEEDVR = "fal-ai/seedvr/upscale/video"


@pytest.fixture
def db(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "fal-prices.db"))
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine, expire_on_commit=False)() as session:
        yield session
    engine.dispose()


@pytest.fixture
def alerts(monkeypatch):
    sent: list[list[str]] = []
    monkeypatch.setattr(fal_prices, "_alert", lambda fingerprint, message: sent.append(fingerprint))
    return sent


def fal_rows(**changes) -> dict[str, dict]:
    """fal's answer at the catalog's own prices; changes maps a model id to a row patch or None (unlisted)."""
    rows = {
        entry["model"]: {
            "endpoint_id": entry["model"],
            "unit_price": float(entry["fal_base_usd"]),
            "unit": entry["fal_unit"],
            "currency": "USD",
        }
        for entry in models.synced_entries()
    }
    for model_id, patch in changes.items():
        if patch is None:
            rows.pop(model_id)
        else:
            rows[model_id] = {**rows[model_id], **patch}
    return rows


def serve(monkeypatch, rows):
    monkeypatch.setenv("FAL_KEY", "test-only-fal-key")
    monkeypatch.setattr(fal_prices, "fetch_prices", lambda key, ids: rows)


def ray_cost(resolution="540p"):
    quote = quote_video(
        width=1080, height=1920, duration=6.2,
        params={"outpaint_model": RAY, "luma_resolution": resolution},
    )
    return Decimal(quote["stages"][0]["provider_cost_usd"])


def stored(db):
    db.expire_all()
    return db.get(AppSetting, fal_prices.SETTING_KEY).value


def test_unchanged_prices_are_stored_without_an_alert(db, alerts, monkeypatch):
    serve(monkeypatch, fal_rows())
    assert fal_prices.sync(db) == []
    assert alerts == []
    records = stored(db)
    assert {record["status"] for record in records.values()} == {"ok"}
    assert ray_cost() == Decimal("0.42")


def test_a_price_change_reprices_quotes_and_alerts_once(db, alerts, monkeypatch):
    serve(monkeypatch, fal_rows(**{RAY: {"unit_price": 0.045}}))
    assert fal_prices.sync(db) == [RAY]
    assert alerts == [[RAY, "price", "0.045", "seconds"]]
    # Tiers keep their ratio to the base: 540p was 2x, 1080p 12x.
    assert ray_cost("540p") == Decimal("0.63")
    assert ray_cost("1080p") == Decimal("3.78")
    ray = next(entry for entry in models.VIDEO_OUTPAINT if entry["model"] == RAY)
    assert ray["resolution_rates"] == {"540p": "0.09", "720p": "0.18", "1080p": "0.54"}
    assert ray["pricing_verified_at"] == stored(db)[RAY]["synced_at"][:10]

    # The same price again is not a new change.
    assert fal_prices.sync(db) == []
    assert len(alerts) == 1


def test_stored_prices_apply_at_startup(db, alerts, monkeypatch):
    serve(monkeypatch, fal_rows(**{RAY: {"unit_price": 0.045}}))
    fal_prices.sync(db)
    models.apply_synced_prices({})
    assert ray_cost() == Decimal("0.42")
    fal_prices.load(db)
    assert ray_cost() == Decimal("0.63")


def test_a_tiered_upscaler_scales_every_tier(db, alerts, monkeypatch):
    serve(monkeypatch, fal_rows(**{BYTEDANCE: {"unit_price": 0.0144}}))
    fal_prices.sync(db)
    entry = next(entry for entry in models.VIDEO_UPSCALE if entry["model"] == BYTEDANCE)
    assert entry["base_rates_usd"] == {"1080p": "0.0144", "2k": "0.0288", "4k": "0.0576"}
    assert entry["base_rates"]["4k"] == 0.0576


@pytest.mark.parametrize(
    ("patch", "status"),
    [
        ({"unit": "megapixels"}, "unit_mismatch"),
        ({"unit_price": 0}, "invalid_price"),
        ({"unit_price": "free"}, "invalid_price"),
        ({"currency": "EUR"}, "invalid_price"),
        (None, "missing"),
    ],
)
def test_a_price_the_catalog_cannot_trust_turns_credits_off(db, alerts, monkeypatch, patch, status):
    serve(monkeypatch, fal_rows(**{RAY: patch}))
    assert fal_prices.sync(db) == [RAY]
    assert stored(db)[RAY]["status"] == status
    assert alerts[0][:2] == [RAY, status]
    ray = next(entry for entry in models.VIDEO_OUTPAINT if entry["model"] == RAY)
    assert ray["credit_enabled"] is False
    with pytest.raises(PricingError):
        ray_cost()
    # Every other model keeps its price and stays on.
    ltx = next(entry for entry in models.VIDEO_OUTPAINT if entry["model"] == LTX)
    assert ltx.get("credit_enabled", True) is not False

    # A later clean sync turns it back on, with an alert for that change too.
    serve(monkeypatch, fal_rows())
    assert fal_prices.sync(db) == [RAY]
    assert ray_cost() == Decimal("0.42")


def test_an_unreachable_api_keeps_the_last_prices(db, alerts, monkeypatch):
    serve(monkeypatch, fal_rows(**{RAY: {"unit_price": 0.045}}))
    fal_prices.sync(db)

    def down(key, ids):
        raise OSError("connection refused")

    monkeypatch.setattr(fal_prices, "fetch_prices", down)
    assert fal_prices.sync(db) == []
    assert alerts[-1] == ["sync-failed"]
    assert stored(db)[RAY]["unit_price"] == "0.045"
    assert ray_cost() == Decimal("0.63")


def test_no_platform_key_means_no_sync(db, alerts, monkeypatch):
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.setattr(fal_prices, "fetch_prices", lambda key, ids: pytest.fail("fetched without a key"))
    assert fal_prices.sync(db) == []
    assert db.get(AppSetting, fal_prices.SETTING_KEY) is None


def test_only_credit_priced_models_are_synced():
    synced = {entry["model"] for entry in models.synced_entries()}
    assert {LTX, RAY, BYTEDANCE, SEEDVR} <= synced
    assert "fal-ai/ccsr" not in synced


@pytest.mark.parametrize("omitted", [{}, {"upscale_model": "", "outpaint_model": ""}, {"upscale_model": None}])
def test_quote_and_job_resolve_the_same_default_models(db, omitted):
    # The quote endpoint receives JSON without the field; the job form sends "".
    assert video_parameters(omitted)["upscale_model"] == BYTEDANCE == video_parameters({"upscale_model": ""})["upscale_model"]
    assert video_parameters(omitted)["outpaint_model"] == LTX
    assert image_parameters(omitted)["upscale_model"] == models.IMAGE_MODELS["upscale_img"]
    assert image_parameters(omitted)["outpaint_model"] == models.IMAGE_MODELS["outpaint_img"]

    db.add(AppSetting(key=MODEL_OVERRIDES_KEY, value={"upscale_vid": SEEDVR}))
    db.commit()
    defaults = model_defaults(db)
    assert defaults == {**CATALOG_DEFAULTS, "upscale_vid": SEEDVR}
    assert video_parameters(omitted, defaults)["upscale_model"] == SEEDVR
    assert video_parameters({"upscale_model": BYTEDANCE}, defaults)["upscale_model"] == BYTEDANCE


def test_admin_model_overrides_persist(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    monkeypatch.setenv("SX_ADMIN_USERS", "models_admin@example.com")
    engine = create_engine("sqlite:///" + str(tmp_path / "overrides.db"), connect_args={"check_same_thread": False})
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    application.include_router(social.router)
    application.include_router(config.router)

    def override_get_db():
        with Session() as session:
            yield session

    application.dependency_overrides[get_db] = override_get_db
    with TestClient(application) as client:
        response = register_verified(client, json={
            "email": "models_admin@example.com",
            "username": "models_admin",
            "password": "correct-horse-battery",
            "accept_terms": True,
            "display_name": "models_admin",
        })
        assert response.status_code == 200, response.text
        headers = {"x-csrf-token": client.cookies.get("echo_csrf")}

        updated = client.put("/api/config/models", json={"upscale_vid": SEEDVR}, headers=headers)
        assert updated.status_code == 200, updated.text
        with Session() as session:
            assert session.get(AppSetting, MODEL_OVERRIDES_KEY).value == {"upscale_vid": SEEDVR}
        # A fresh read (as after a restart) still serves the override.
        assert client.get("/api/config").json()["models"]["upscale_vid"] == SEEDVR

        # Back to the catalog default: nothing is pinned.
        assert client.put("/api/config/models", json={"upscale_vid": ""}, headers=headers).status_code == 200
        with Session() as session:
            assert session.get(AppSetting, MODEL_OVERRIDES_KEY).value == {}
        assert client.get("/api/config").json()["models"]["upscale_vid"] == BYTEDANCE
    engine.dispose()


@pytest.mark.parametrize("kind", ["image", "video"])
def test_a_minimal_client_quote_funds_its_job(tmp_path, monkeypatch, kind):
    """Quote and process with only the required fields: the job matches its quote."""
    from server.billing.service import grant_credits
    from server.routers import billing, image, video

    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    monkeypatch.setenv("SX_FAL_KEY_ENCRYPTION_KEY", "test-only-dedicated-fal-encryption-secret")
    monkeypatch.setenv("SX_CREDITS_ENABLED", "1")
    monkeypatch.setenv("FAL_KEY", "platform-fal-key")
    monkeypatch.setattr(image, "get_image_dimensions", lambda _path: (1000, 500))
    monkeypatch.setattr(billing, "get_image_dimensions", lambda _path: (1000, 500))
    monkeypatch.setattr(video, "get_video_dimensions_and_duration", lambda *_a, **_k: (1920, 1080, 5.0))
    monkeypatch.setattr(billing, "get_video_dimensions_and_duration", lambda *_a, **_k: (1920, 1080, 5.0))
    monkeypatch.setattr(billing, "get_video_frame_metadata", lambda _path: (24.0, 120))
    submitted = []
    monkeypatch.setattr(image.job_manager, "submit", lambda *args, **kwargs: submitted.append(args))
    engine = create_engine("sqlite:///" + str(tmp_path / "minimal.db"), connect_args={"check_same_thread": False})
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    for module in (social, billing, image, video):
        application.include_router(module.router)

    def override_get_db():
        with Session() as session:
            yield session

    application.dependency_overrides[get_db] = override_get_db
    staged = image.STAGED_UPLOADS if kind == "image" else video.STAGED_UPLOADS
    stage_id = f"minimal-{kind}"
    source = tmp_path / f"{stage_id}.bin"
    source.write_bytes(b"staged")
    try:
        with TestClient(application) as client:
            response = register_verified(client, json={
                "email": "minimal_client@example.com",
                "username": "minimal_client",
                "password": "correct-horse-battery",
                "accept_terms": True,
                "display_name": "minimal_client",
            })
            assert response.status_code == 200, response.text
            user = response.json()["user"]
            staged[stage_id] = (str(source), time.time(), f"user:{user['id']}")
            with Session() as session:
                grant_credits(session, user["id"], 10_000, source="purchase", idempotency_key="purchase:minimal")
                session.commit()
            headers = {"x-csrf-token": client.cookies.get("echo_csrf")}

            # Fal upscaling, so the omitted upscale_model is priced and checked.
            quoted = client.post(
                "/api/billing/quote",
                json={"kind": kind, "stage_id": stage_id, "parameters": {"upscale_engine": "fal"}},
                headers=headers,
            )
            assert quoted.status_code == 200, quoted.text
            processed = client.post(
                f"/api/{kind}/process",
                data={"stage_id": stage_id, "upscale_engine": "fal", "quote_id": quoted.json()["quote_id"]},
                headers=headers,
            )
            assert processed.status_code == 200, processed.text
            assert submitted
    finally:
        staged.pop(stage_id, None)
        engine.dispose()
