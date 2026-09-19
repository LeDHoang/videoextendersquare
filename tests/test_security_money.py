"""Security/money regression tests for the <1d hardening batch.

Covers: admin-gated reels proxy/spatialize, publish ownership, Civitai
hostname allowlist + quote spend cap, signed anon cookies, Stripe webhook
caps, quote/pack/publish rate limits + probe cache, SSE stream caps, login
timing alignment, staged-image pixel ceiling, Fal-key entropy assert, and
FalCredential deletion on account closure.
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import patch

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from starlette.requests import Request as StarletteRequest
from starlette.responses import Response as StarletteResponse

from pipeline import utils as pipeline_utils
from pipeline.utils import attach_civitai_token, get_image_dimensions
from server.billing.crypto import FalKeyConfigurationError, decrypt_fal_key, encrypt_fal_key
from server.billing.service import QuoteError, create_quote, reel_reward_ip_cap
from server.jobs import JobStatus, job_manager
from server.routers import (
    account_safety,
    billing as billing_router,
    image as image_router,
    messages as messages_router,
    packs,
    reels,
    social,
    uploads,
    video as video_router,
)
from server.routers import billing as billing_module
from server.social import auth
from server.social.auth import (
    AuthContext,
    _sign_anon_cookie,
    _verify_anon_cookie,
    ensure_anonymous_cookie,
    stage_owner_matches,
    token_hash,
)
from server.social.database import Base, get_db
from server.social.models import FalCredential, User

PASSWORD = "correct-horse-battery-99"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_MESSAGE_ENCRYPTION_KEY", "test-only-message-key-with-at-least-32-chars")
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret-for-hmac-cookies")
    monkeypatch.setenv("SX_FAL_KEY_ENCRYPTION_KEY", "test-only-dedicated-fal-encryption-secret")
    monkeypatch.setattr(
        auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1)
    )
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "security-money.db"),
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    for router in (
        social.router,
        packs.router,
        messages_router.router,
        reels.router,
        uploads.router,
        billing_router.router,
        image_router.router,
        account_safety.router,
    ):
        application.include_router(router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    application.state.testing_session = Session
    yield application
    engine.dispose()


def register(client, username, email=None):
    response = client.post(
        "/api/auth/register",
        json={
            "email": email or f"{username}@example.com",
            "username": username,
            "password": PASSWORD,
            "display_name": username,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]


def csrf_headers(client):
    token = client.cookies.get("echo_csrf")
    assert token
    return {"x-csrf-token": token}


def mutate(client, method, path, body=None):
    return client.request(method, path, headers=csrf_headers(client), json=body)


# ─── A: admin-gated proxy / spatialize ──────────────────────────────────────


def test_proxy_anon_denied(app):
    with TestClient(app) as client:
        response = client.post("/api/reels/proxy", json=["output/x.mp4"])
        assert response.status_code in {401, 403}, response.text


def test_proxy_non_admin_denied(app):
    with TestClient(app) as client:
        register(client, "sec_proxy_user")
        response = mutate(client, "POST", "/api/reels/proxy", ["output/x.mp4"])
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "ADMIN_REQUIRED"


def test_proxy_admin_allowed_no_transcode_without_files(app, monkeypatch):
    monkeypatch.setenv("SX_ADMIN_USERS", "sec_proxy_admin@example.com")
    with TestClient(app) as client:
        register(client, "sec_proxy_admin", "sec_proxy_admin@example.com")
        response = mutate(client, "POST", "/api/reels/proxy", ["no-such-file.mp4"])
        assert response.status_code == 200, response.text
        assert response.json()["failed"][0]["error"] == "not found"


def test_spatialize_strength_validated(app, monkeypatch):
    monkeypatch.setenv("SX_ADMIN_USERS", "sec_spat_admin@example.com")
    with TestClient(app) as client:
        register(client, "sec_spat_admin", "sec_spat_admin@example.com")
        response = mutate(client, "POST", "/api/reels/spatialize", {"strength": 999.0})
        assert response.status_code == 422, response.text


def test_spatialize_anon_denied(app):
    with TestClient(app) as client:
        response = client.post("/api/reels/spatialize", json={})
        assert response.status_code in {401, 403}, response.text


# ─── B: publish ownership ───────────────────────────────────────────────────


def _stage_image_as(app, tmp_path, owner_tag, name="own.png"):
    from PIL import Image as PILImage

    path = tmp_path / name
    PILImage.new("RGB", (32, 32), (10, 20, 30)).save(path, "PNG")
    stage_id = f"stage-{name.replace('.', '-')}"
    image_router.STAGED_UPLOADS[stage_id] = (str(path), time.time(), owner_tag)
    return stage_id


def test_publish_cross_user_stage_forbidden(app, tmp_path):
    with TestClient(app) as owner_client, TestClient(app) as other_client:
        owner = register(owner_client, "sec_pub_owner")
        register(other_client, "sec_pub_other")
        stage_id = _stage_image_as(app, tmp_path, f"user:{owner['id']}", "cross.png")
        try:
            response = mutate(
                other_client, "POST", "/api/uploads/publish",
                {"kind": "image", "title": "stolen", "stage_id": stage_id},
            )
            assert response.status_code == 403
            assert "stage_id" in str(response.json())
        finally:
            image_router.STAGED_UPLOADS.pop(stage_id, None)


def test_publish_own_stage_allowed(app, tmp_path):
    with TestClient(app) as client:
        owner = register(client, "sec_pub_mine")
        stage_id = _stage_image_as(app, tmp_path, f"user:{owner['id']}", "mine.png")
        try:
            response = mutate(
                client, "POST", "/api/uploads/publish",
                {"kind": "image", "title": "Mine", "stage_id": stage_id},
            )
            assert response.status_code == 200, response.text
            assert response.json()["post_id"]
        finally:
            image_router.STAGED_UPLOADS.pop(stage_id, None)


def test_publish_cross_user_owned_job_forbidden(app, tmp_path):
    target = tmp_path / "job-result.png"
    target.write_bytes(b"fake-image-bytes")
    with TestClient(app) as owner_client, TestClient(app) as other_client:
        owner = register(owner_client, "sec_job_owner")
        register(other_client, "sec_job_other")
        job_id = job_manager.create_job(kind="image", owner_id=owner["id"], job_id="secjobowned1")
        try:
            rec = job_manager.get_job(job_id)
            with rec._lock:
                rec.status = JobStatus.COMPLETE
                rec.result = {"path": str(target)}
            stolen = mutate(
                other_client, "POST", "/api/uploads/publish",
                {"kind": "image", "title": "stolen job", "job_id": job_id},
            )
            assert stolen.status_code == 403
        finally:
            job_manager.discard_job(job_id)


# ─── C: Civitai allowlist + quote cap ───────────────────────────────────────


def test_civitai_token_only_on_real_host():
    key = "civitai-secret-key"
    good = "https://civitai.com/api/download/models/12345?fileId=1"
    assert attach_civitai_token(good, key) == f"{good}&token={key}"
    evil = "https://evil.example/?x=civitai.com/api/download/models/1"
    assert attach_civitai_token(evil, key) == evil
    plain_http = "http://civitai.com/api/download/models/1"
    assert attach_civitai_token(plain_http, key) == plain_http
    with_token = good + "&token=existing"
    assert attach_civitai_token(with_token, key) == with_token
    assert attach_civitai_token("https://fal.run/fal-ai/foo", key) == "https://fal.run/fal-ai/foo"


def test_quote_spend_cap_enforced(app, monkeypatch):
    params = {
        "prompt": "", "upscale_only": False, "upscale_engine": "fal", "sharpening": 0.0,
        "outpaint_model": "fal-ai/luma-dream-machine/ray-2-flash/reframe",
        "upscale_model": "fal-ai/bytedance-upscaler/upscale/video",
        "ltx_resolution": "720p", "ltx_audio": True, "ltx_guidance": 1.0,
        "ltx_prompt_expansion": False, "ltx_negative_prompt": "", "ltx_loras": [],
        "wan_resolution": "720p", "seedvr_factor": 2.0, "seedvr_target": "1080p",
        "bytedance_target_res": "4k", "bytedance_target_fps": "30fps",
        "bytedance_tier": "fast", "bytedance_preset": "general",
        "bytedance_fidelity": "medium", "trim_enabled": False,
        "trim_start": 0.0, "trim_duration": 15.0,
        "custom_outpaint_args": {}, "custom_upscale_args": {},
    }
    with app.state.testing_session() as db:
        user = User(username="sec_cap_user", username_norm="sec_cap_user", display_name="cap")
        db.add(user)
        db.commit()
        monkeypatch.setenv("SX_FAL_MAX_QUOTE_USD", "0.000001")
        with pytest.raises(QuoteError):
            create_quote(db, user_id=user.id, kind="video", stage_id="cap",
                         width=1920, height=1080, duration=5, params=params)
        db.rollback()
        monkeypatch.delenv("SX_FAL_MAX_QUOTE_USD", raising=False)
        quote = create_quote(db, user_id=user.id, kind="video", stage_id="cap",
                             width=1920, height=1080, duration=5, params=params)
        assert quote.credits > 0


# ─── D: signed anon cookies ─────────────────────────────────────────────────


def test_anon_cookie_sign_verify_roundtrip():
    raw = "test-raw-value"
    signed = _sign_anon_cookie(raw)
    assert _verify_anon_cookie(signed) == raw
    assert _verify_anon_cookie("unsigned-legacy-value") is None
    assert _verify_anon_cookie(raw + ".forged-signature") is None
    assert _verify_anon_cookie(None) is None


def _bare_request(cookie_value=None):
    headers = []
    if cookie_value is not None:
        headers.append((b"cookie", f"echo_anon={cookie_value}".encode()))
    return StarletteRequest({"type": "http", "headers": headers})


def test_anon_cookie_forged_rotates():
    request = _bare_request("attacker-chosen-value")
    response = StarletteResponse()
    first = ensure_anonymous_cookie(request, response)
    assert first == token_hash(_verify_anon_cookie(response.headers["set-cookie"].split("echo_anon=")[1].split(";")[0]))
    assert first != token_hash("attacker-chosen-value")
    assert "echo_anon=" in response.headers["set-cookie"]


def test_stage_owner_rejects_forged_anon():
    forged_hash = token_hash("attacker-chosen-value")
    request = _bare_request("attacker-chosen-value")
    assert stage_owner_matches(f"anon:{forged_hash}", request, None) is False


# ─── E: Stripe webhook caps ─────────────────────────────────────────────────


def test_stripe_webhook_oversized_rejected(app, monkeypatch):
    monkeypatch.setenv("SX_STRIPE_WEBHOOK_MAX_BYTES", "1024")
    with TestClient(app) as client:
        response = client.post(
            "/api/billing/webhooks/stripe", content=b"x" * 4096,
            headers={"stripe-signature": "t=1,v1=abc"},
        )
        assert response.status_code == 413
        assert response.json()["detail"]["code"] == "WEBHOOK_TOO_LARGE"


def test_stripe_webhook_rate_limited(app, monkeypatch):
    monkeypatch.setenv("SX_STRIPE_WEBHOOK_RPM", "2")
    monkeypatch.setenv("SX_STRIPE_WEBHOOK_MAX_BYTES", "1048576")
    with TestClient(app) as client:
        codes = set()
        for _ in range(4):
            response = client.post(
                "/api/billing/webhooks/stripe", content=b"{}",
                headers={"stripe-signature": "t=1,v1=nope"},
            )
            codes.add(response.status_code)
        assert 429 in codes


# ─── F: quote / pack / publish limits + probe cache ─────────────────────────


def _stage_quote_image(app, tmp_path, owner_id, stage_id="secquote1"):
    path = tmp_path / "quote.png"
    Image.new("RGB", (64, 64), (1, 2, 3)).save(path, "PNG")
    image_router.STAGED_UPLOADS[stage_id] = (str(path), time.time(), f"user:{owner_id}")
    return stage_id


def test_quote_rate_limited_and_probe_cached(app, tmp_path, monkeypatch):
    monkeypatch.setenv("SX_CREDITS_ENABLED", "1")
    monkeypatch.setenv("SX_QUOTE_RPM", "2")
    billing_module._PROBE_CACHE.clear()
    with TestClient(app) as client:
        user = register(client, "sec_quote_user")
        stage_id = _stage_quote_image(app, tmp_path, user["id"])
        try:
            body = {"kind": "image", "stage_id": stage_id, "parameters": {"upscale_only": True}}
            first = mutate(client, "POST", "/api/billing/quote", body)
            assert first.status_code == 200, first.text
            second = mutate(client, "POST", "/api/billing/quote", body)
            assert second.status_code == 200, second.text
            assert f"img:{stage_id}" in billing_module._PROBE_CACHE
            third = mutate(client, "POST", "/api/billing/quote", body)
            assert third.status_code == 429
        finally:
            image_router.STAGED_UPLOADS.pop(stage_id, None)
            billing_module._PROBE_CACHE.clear()


def test_pack_create_rate_limited(app):
    with TestClient(app) as client:
        register(client, "sec_pack_spammer")
        last = None
        for index in range(11):
            last = mutate(client, "POST", "/api/packs", {
                "title": f"Spam {index}", "description": "", "visibility": "public",
                "tags": [], "post_ids": [],
            })
            if last.status_code == 429:
                break
        assert last is not None and last.status_code == 429


def test_pack_progress_coalesced(app):
    with TestClient(app) as client:
        register(client, "sec_prog_user")
        created = mutate(client, "POST", "/api/packs", {
            "title": "Progress pack", "description": "", "visibility": "public",
            "tags": [], "post_ids": [],
        })
        assert created.status_code == 200, created.text
        pack_id = created.json()["pack"]["id"]
        last = None
        for _ in range(13):
            last = mutate(client, "PUT", f"/api/packs/{pack_id}/progress", {"position_ms": 1000})
        assert last is not None and last.status_code == 429


# ─── G: SSE stream caps ─────────────────────────────────────────────────────


def test_sse_connection_cap(app):
    with TestClient(app) as client:
        user = register(client, "sec_sse_user")
        messages_router._SSE_STREAMS[user["id"]] = 3
        try:
            response = client.get("/api/messages/events")
            assert response.status_code == 429
        finally:
            messages_router._SSE_STREAMS.pop(user["id"], None)


def test_sse_slot_released_after_stream(app, monkeypatch):
    # stream() polls via the module-level SessionLocal: point it at the test
    # database so the seeded event is visible and the first frame is immediate.
    monkeypatch.setattr(messages_router, "SessionLocal", app.state.testing_session)

    async def exercise():
        from server.social.models import MessageEvent as MessageEventModel

        with app.state.testing_session() as db:
            user = db.query(User).filter(User.username_norm == "sec_sse_slot").first()
            if user is None:
                user = User(username="sec_sse_slot", username_norm="sec_sse_slot", display_name="slot")
                db.add(user)
                db.commit()
            user_id = user.id
            db.add(MessageEventModel(
                recipient_id=user_id, conversation_id="conv-test",
                event_type="message.created",
            ))
            db.commit()
        scope = {"type": "http", "headers": []}

        async def _receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        request = StarletteRequest(scope, _receive)
        context = AuthContext(user=type("U", (), {"id": user_id, "status": "active", "account_type": "real"})(), session=None)
        messages_router._SSE_STREAMS.pop(user_id, None)
        try:
            response = await messages_router.message_events(request, 0, context)
            assert response.status_code == 200
            assert messages_router._SSE_STREAMS.get(user_id) == 1
            first = await asyncio.wait_for(response.body_iterator.__anext__(), timeout=10)
            assert "message.created" in first
        finally:
            await response.body_iterator.aclose()
        assert messages_router._SSE_STREAMS.get(user_id, 0) == 0

    asyncio.run(exercise())


# ─── H: login timing, pixel ceiling, key entropy ────────────────────────────


def test_login_unknown_and_wrong_password_share_code(app):
    with TestClient(app) as client:
        register(client, "sec_login_user")
        unknown = client.post("/api/auth/login", json={"identifier": "sec_nonexistent", "password": PASSWORD})
        wrong = client.post("/api/auth/login", json={"identifier": "sec_login_user", "password": "wrong-password-99"})
        assert unknown.status_code == 401
        assert wrong.status_code == 401
        assert unknown.json()["detail"]["code"] == wrong.json()["detail"]["code"] == "INVALID_CREDENTIALS"


def test_staged_image_pixel_ceiling(tmp_path):
    tiny = tmp_path / "tiny.png"
    Image.new("RGB", (8, 8), (9, 9, 9)).save(tiny, "PNG")
    assert get_image_dimensions(str(tiny)) == (8, 8)

    class FakeImg:
        size = (100000, 100000)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    with patch.object(pipeline_utils.Image, "open", return_value=FakeImg()):
        with pytest.raises(ValueError, match="pixel limit"):
            get_image_dimensions(str(tiny))


def test_fal_key_entropy_assert(monkeypatch):
    monkeypatch.setenv("SX_FAL_KEY_ENCRYPTION_KEY", "short")
    with pytest.raises(FalKeyConfigurationError):
        encrypt_fal_key("user-1", "fal-key-value")
    monkeypatch.setenv("SX_FAL_KEY_ENCRYPTION_KEY", "a-sufficiently-long-test-secret-123")
    envelope = encrypt_fal_key("user-1", "fal-key-value")
    assert decrypt_fal_key("user-1", envelope) == "fal-key-value"


# ─── I: FalCredential deletion ──────────────────────────────────────────────


def test_delete_account_removes_fal_credential(app):
    with TestClient(app) as client:
        user = register(client, "sec_bye_user")
        with app.state.testing_session() as db:
            row = FalCredential(user_id=user["id"], ciphertext="v1.n.c", key_hint="••••test")
            db.add(row)
            db.commit()
        deleted = mutate(client, "DELETE", "/api/users/me",
                         {"current_password": PASSWORD, "confirmation": "DELETE"})
        assert deleted.status_code == 200, deleted.text
        with app.state.testing_session() as db:
            assert db.get(FalCredential, user["id"]) is None
