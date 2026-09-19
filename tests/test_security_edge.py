"""Edge-case verification for the config + security/money hardening batches."""

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
        "sqlite:///" + str(tmp_path / "security-edge.db"),
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


def tiny_png(path, color=(4, 5, 6)):
    Image.new("RGB", (32, 32), color).save(path, "PNG")
    return str(path)


@pytest.mark.parametrize("flag", ["0", "false", "False", "NO", "no"])
def test_registration_closed_flag_variants(app, monkeypatch, flag):
    monkeypatch.setenv("SX_REGISTRATION_ENABLED", flag)
    monkeypatch.delenv("SX_REGISTRATION_ALLOWLIST", raising=False)
    with TestClient(app) as client:
        response = client.post(
            "/api/auth/register",
            json={"email": "v@example.com", "username": "edge_variant",
                  "password": PASSWORD, "display_name": "v"},
        )
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "REGISTRATION_DISABLED"


def test_registration_open_ignores_allowlist(app, monkeypatch):
    monkeypatch.setenv("SX_REGISTRATION_ENABLED", "1")
    monkeypatch.setenv("SX_REGISTRATION_ALLOWLIST", "nobody@example.com")
    with TestClient(app) as client:
        response = client.post(
            "/api/auth/register",
            json={"email": "anyone@example.com", "username": "edge_open",
                  "password": PASSWORD, "display_name": "a"},
        )
        assert response.status_code == 200, response.text


def test_allowlist_dedupes_and_skips_blanks(monkeypatch):
    monkeypatch.setenv("SX_REGISTRATION_ALLOWLIST", " A@x.com,,A@X.COM, ,b@x.com,")
    assert social.registration_allowlist() == {"a@x.com", "b@x.com"}


def test_import_time_constant_and_env_both_close(app, monkeypatch):
    monkeypatch.setattr(social, "REGISTRATION_ENABLED", False)
    monkeypatch.setenv("SX_REGISTRATION_ENABLED", "1")
    monkeypatch.delenv("SX_REGISTRATION_ALLOWLIST", raising=False)
    with TestClient(app) as client:
        response = client.post(
            "/api/auth/register",
            json={"email": "c@example.com", "username": "edge_and",
                  "password": PASSWORD, "display_name": "c"},
        )
        assert response.status_code == 403


def test_rewards_cap_parsing_edges(monkeypatch):
    monkeypatch.setenv("SX_REEL_REWARD_IP_DAILY_CLAIMS", "-5")
    assert reel_reward_ip_cap() == 1
    monkeypatch.setenv("SX_REEL_REWARD_IP_DAILY_CLAIMS", "  20 ")
    assert reel_reward_ip_cap() == 20
    monkeypatch.setenv("SX_REEL_REWARD_IP_DAILY_CLAIMS", "")
    assert reel_reward_ip_cap() == 50
    monkeypatch.setenv("SX_REEL_REWARD_IP_DAILY_CLAIMS", "1000000")
    assert reel_reward_ip_cap() == 1000000


def test_proxy_admin_empty_list_ok(app, monkeypatch):
    monkeypatch.setenv("SX_ADMIN_USERS", "edge_padmin@example.com")
    with TestClient(app) as client:
        register(client, "edge_padmin", "edge_padmin@example.com")
        response = mutate(client, "POST", "/api/reels/proxy", [])
        assert response.status_code == 200, response.text
        assert response.json() == {"generated": [], "failed": []}


def test_proxy_admin_too_many_paths_rejected(app, monkeypatch):
    monkeypatch.setenv("SX_ADMIN_USERS", "edge_pmany@example.com")
    with TestClient(app) as client:
        register(client, "edge_pmany", "edge_pmany@example.com")
        response = mutate(client, "POST", "/api/reels/proxy", [f"f{i}.mp4" for i in range(51)])
        assert response.status_code == 400


@pytest.mark.parametrize("strength", [0.0, 2.0])
def test_spatialize_strength_boundaries_accepted(app, monkeypatch, strength):
    monkeypatch.setenv("SX_ADMIN_USERS", "edge_sbound@example.com")
    with TestClient(app) as client:
        register(client, "edge_sbound", "edge_sbound@example.com")
        # Nonexistent source → 400 source validation (never queues a real job).
        response = mutate(client, "POST", "/api/reels/spatialize",
                          {"paths": ["no-such-master.mp4"], "strength": strength})
        assert response.status_code == 400, response.text
        assert "HEVC" in response.text


@pytest.mark.parametrize("strength", [-0.1, 2.1])
def test_spatialize_strength_out_of_range_rejected(app, monkeypatch, strength):
    monkeypatch.setenv("SX_ADMIN_USERS", "edge_srange@example.com")
    with TestClient(app) as client:
        register(client, "edge_srange", "edge_srange@example.com")
        response = mutate(client, "POST", "/api/reels/spatialize", {"strength": strength})
        assert response.status_code == 422, response.text


def test_publish_pointer_matrix(app, tmp_path):
    with TestClient(app) as client:
        user = register(client, "edge_pub_matrix")
        good = tiny_png(tmp_path / "matrix.png")
        stage_id = "edge-matrix-stage"
        image_router.STAGED_UPLOADS[stage_id] = (good, time.time(), f"user:{user['id']}")
        try:
            both = mutate(client, "POST", "/api/uploads/publish",
                          {"kind": "image", "title": "x", "stage_id": stage_id, "job_id": "j"})
            assert both.status_code == 400
            neither = mutate(client, "POST", "/api/uploads/publish",
                             {"kind": "image", "title": "x"})
            assert neither.status_code == 400
            unknown = mutate(client, "POST", "/api/uploads/publish",
                             {"kind": "image", "title": "x", "stage_id": "nope"})
            assert unknown.status_code == 400
            mismatch = mutate(client, "POST", "/api/uploads/publish",
                              {"kind": "video", "title": "x", "stage_id": stage_id})
            assert mismatch.status_code in {400, 403}
            gone_path = tmp_path / "gone.png"
            tiny_png(gone_path)
            gone_path.unlink()
            image_router.STAGED_UPLOADS["edge-gone-stage"] = (
                str(gone_path), time.time(), f"user:{user['id']}")
            gone = mutate(client, "POST", "/api/uploads/publish",
                          {"kind": "image", "title": "x", "stage_id": "edge-gone-stage"})
            assert gone.status_code == 400
        finally:
            image_router.STAGED_UPLOADS.pop(stage_id, None)
            image_router.STAGED_UPLOADS.pop("edge-gone-stage", None)


def test_publish_unfinished_job_rejected(app, tmp_path):
    target = tiny_png(tmp_path / "unfinished.png")
    with TestClient(app) as client:
        user = register(client, "edge_pub_unfin")
        job_id = job_manager.create_job(kind="image", owner_id=user["id"], job_id="edgeunfinjob1")
        try:
            rec = job_manager.get_job(job_id)
            with rec._lock:
                rec.status = JobStatus.QUEUED
                rec.result = {"path": target}
            response = mutate(client, "POST", "/api/uploads/publish",
                              {"kind": "image", "title": "early", "job_id": job_id})
            assert response.status_code == 400
        finally:
            job_manager.discard_job(job_id)


def test_publish_ownerless_job_legacy_allowed(app, tmp_path):
    target = tiny_png(tmp_path / "legacy.png")
    with TestClient(app) as client:
        register(client, "edge_pub_legacy")
        job_id = job_manager.create_job(kind="image", owner_id=None, job_id="edgelegacyjob1")
        try:
            rec = job_manager.get_job(job_id)
            with rec._lock:
                rec.status = JobStatus.COMPLETE
                rec.result = {"path": target}
            response = mutate(client, "POST", "/api/uploads/publish",
                              {"kind": "image", "title": "legacy", "job_id": job_id})
            assert response.status_code == 200, response.text
        finally:
            job_manager.discard_job(job_id)


def test_publish_hourly_cap_triggers(app, tmp_path, monkeypatch):
    monkeypatch.setenv("SX_PUBLISH_HOURLY_MAX", "5")
    monkeypatch.setenv("SX_PUBLISH_DAILY_MAX", "20")
    with TestClient(app) as client:
        user = register(client, "edge_pub_cap")
        last = None
        try:
            for index in range(6):
                path = tiny_png(tmp_path / f"cap{index}.png", (index, 1, 2))
                sid = f"edge-cap-{index}"
                image_router.STAGED_UPLOADS[sid] = (path, time.time(), f"user:{user['id']}")
                last = mutate(client, "POST", "/api/uploads/publish",
                              {"kind": "image", "title": f"Cap {index}", "stage_id": sid})
            assert last is not None and last.status_code == 429
        finally:
            for index in range(6):
                image_router.STAGED_UPLOADS.pop(f"edge-cap-{index}", None)


def test_civitai_host_edge_cases():
    key = "k"
    assert attach_civitai_token("HTTPS://CIVITAI.COM/api/download/models/7", key).endswith("token=" + key)
    assert attach_civitai_token("https://civitai.com:443/api/download/models/7", key).endswith("token=" + key)
    assert attach_civitai_token("https://www.civitai.com/api/download/models/7", key).endswith("token=" + key)
    assert attach_civitai_token("https://civitai.com.evil.example/api/download/models/7", key) == \
        "https://civitai.com.evil.example/api/download/models/7"
    assert attach_civitai_token("https://evil.example/civitai.com/api/download/models/7", key) == \
        "https://evil.example/civitai.com/api/download/models/7"
    assert attach_civitai_token("", key) == ""
    assert attach_civitai_token("https://civitai.com/api/download/models/7", None) == \
        "https://civitai.com/api/download/models/7"
    upper_token = "https://civitai.com/api/download/models/7?TOKEN=abc"
    assert attach_civitai_token(upper_token, key) == upper_token


_VIDEO_PARAMS = {
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


def test_quote_cap_boundary_and_disable(app, monkeypatch):
    with app.state.testing_session() as db:
        user = User(username="edge_cap", username_norm="edge_cap", display_name="cap")
        db.add(user)
        db.commit()
        monkeypatch.delenv("SX_FAL_MAX_QUOTE_USD", raising=False)
        baseline = create_quote(db, user_id=user.id, kind="video", stage_id="edge-base",
                                width=1920, height=1080, duration=5, params=dict(_VIDEO_PARAMS))
        exact_usd = baseline.provider_cost_microusd / 1_000_000
        monkeypatch.setenv("SX_FAL_MAX_QUOTE_USD", repr(exact_usd))
        allowed = create_quote(db, user_id=user.id, kind="video", stage_id="edge-exact",
                               width=1920, height=1080, duration=5, params=dict(_VIDEO_PARAMS))
        assert allowed.credits > 0
        monkeypatch.setenv("SX_FAL_MAX_QUOTE_USD", "0")
        disabled = create_quote(db, user_id=user.id, kind="video", stage_id="edge-off",
                                width=1920, height=1080, duration=5, params=dict(_VIDEO_PARAMS))
        assert disabled.credits > 0
        monkeypatch.setenv("SX_FAL_MAX_QUOTE_USD", "bogus")
        fallback = create_quote(db, user_id=user.id, kind="video", stage_id="edge-fb",
                                width=1920, height=1080, duration=5, params=dict(_VIDEO_PARAMS))
        assert fallback.credits > 0


def test_probe_cache_invalidates_on_file_change(app, tmp_path, monkeypatch):
    monkeypatch.setenv("SX_CREDITS_ENABLED", "1")
    monkeypatch.setenv("SX_QUOTE_RPM", "30")
    billing_module._PROBE_CACHE.clear()
    with TestClient(app) as client:
        user = register(client, "edge_cache_user")
        path = tmp_path / "cache.png"
        Image.new("RGB", (64, 64), (1, 1, 1)).save(path, "PNG")
        stage_id = "edgecache1"
        image_router.STAGED_UPLOADS[stage_id] = (str(path), time.time(), f"user:{user['id']}")
        try:
            body = {"kind": "image", "stage_id": stage_id, "parameters": {"upscale_only": True}}
            first = mutate(client, "POST", "/api/billing/quote", body)
            assert first.status_code == 200, first.text
            Image.new("RGB", (80, 40), (2, 2, 2)).save(path, "PNG")
            __import__("os").utime(path, ns=(0, 0))
            second = mutate(client, "POST", "/api/billing/quote", body)
            assert second.status_code == 200, second.text
        finally:
            image_router.STAGED_UPLOADS.pop(stage_id, None)
            billing_module._PROBE_CACHE.clear()


def test_anon_cookie_valid_sets_no_new_cookie():
    raw = "stable-raw-value"
    signed = _sign_anon_cookie(raw)

    async def _receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    request = StarletteRequest(
        {"type": "http", "headers": [(b"cookie", f"echo_anon={signed}".encode())]}, _receive)
    response = StarletteResponse()
    first = ensure_anonymous_cookie(request, response)
    second = ensure_anonymous_cookie(request, response)
    assert first == second == token_hash(raw)
    assert "set-cookie" not in response.headers


def test_anon_cookie_multidot_rejected():
    assert _verify_anon_cookie("a.b.c") is None
    assert _verify_anon_cookie(".") is None
    assert _verify_anon_cookie("") is None


def test_anon_cookie_wrong_secret_rejected(monkeypatch):
    import server.social.auth as auth_module

    raw = "secret-bound-value"
    signed = _sign_anon_cookie(raw)
    monkeypatch.setattr(auth_module, "SECURITY_SECRET", "a-different-secret-value-xyz")
    assert _verify_anon_cookie(signed) is None


def test_stage_owner_matches_matrix():
    async def _receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    raw = "matrix-raw"
    signed = _sign_anon_cookie(raw)
    req = StarletteRequest(
        {"type": "http", "headers": [(b"cookie", f"echo_anon={signed}".encode())]}, _receive)
    assert stage_owner_matches(None, req, None) is False
    assert stage_owner_matches("", req, None) is False
    assert stage_owner_matches("anon:" + token_hash(raw), req, None) is True
    assert stage_owner_matches("anon:" + token_hash("other"), req, None) is False


def test_webhook_exact_cap_passes_size_check(app, monkeypatch):
    monkeypatch.setenv("SX_STRIPE_WEBHOOK_MAX_BYTES", "1024")
    with TestClient(app) as client:
        response = client.post(
            "/api/billing/webhooks/stripe", content=b"y" * 1024,
            headers={"stripe-signature": "t=1,v1=abc"},
        )
        assert response.status_code == 400


def test_webhook_invalid_rpm_falls_back(app, monkeypatch):
    monkeypatch.setenv("SX_STRIPE_WEBHOOK_RPM", "bogus")
    with TestClient(app) as client:
        codes = set()
        for _ in range(3):
            response = client.post(
                "/api/billing/webhooks/stripe", content=b"{}",
                headers={"stripe-signature": "t=1,v1=nope"},
            )
            codes.add(response.status_code)
        assert 429 not in codes


def test_pack_like_full_threshold(app):
    with TestClient(app) as client:
        register(client, "edge_like_user")
        created = mutate(client, "POST", "/api/packs", {
            "title": "Like pack", "description": "", "visibility": "public",
            "tags": [], "post_ids": [],
        })
        assert created.status_code == 200, created.text
        pack_id = created.json()["pack"]["id"]
        last = None
        for _ in range(121):
            last = mutate(client, "PUT", f"/api/packs/{pack_id}/like")
        assert last is not None and last.status_code == 429


def test_pack_progress_isolated_per_pack(app):
    with TestClient(app) as client:
        register(client, "edge_prog_iso")
        mutate(client, "POST", "/api/packs", {
            "title": "Iso A", "description": "", "visibility": "public",
            "tags": [], "post_ids": [],
        })
        second = mutate(client, "POST", "/api/packs", {
            "title": "Iso B", "description": "", "visibility": "public",
            "tags": [], "post_ids": [],
        })
        pack_b = second.json()["pack"]["id"]
        for _ in range(12):
            response = mutate(client, "PUT", f"/api/packs/{pack_b}/progress", {"position_ms": 5})
            assert response.status_code == 200, response.text
        throttled = mutate(client, "PUT", f"/api/packs/{pack_b}/progress", {"position_ms": 5})
        assert throttled.status_code == 429


def test_sse_concurrent_gate(app, monkeypatch):
    monkeypatch.setattr(messages_router, "SessionLocal", app.state.testing_session)

    async def exercise():
        with app.state.testing_session() as db:
            user = db.query(User).filter(User.username_norm == "edge_sse_conc").first()
            if user is None:
                user = User(username="edge_sse_conc", username_norm="edge_sse_conc", display_name="c")
                db.add(user)
                db.commit()
            user_id = user.id

        async def _receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        def make_call():
            request = StarletteRequest({"type": "http", "headers": []}, _receive)
            context = AuthContext(
                user=type("U", (), {"id": user_id, "status": "active", "account_type": "real"})(),
                session=None,
            )
            return messages_router.message_events(request, 0, context)

        messages_router._SSE_STREAMS.pop(user_id, None)
        try:
            results = await asyncio.gather(*[make_call() for _ in range(5)], return_exceptions=True)
            ok = sum(1 for r in results if not isinstance(r, Exception))
            limited = sum(
                1 for r in results
                if isinstance(r, Exception) and getattr(r, "status_code", None) == 429
            )
            assert ok == 3
            assert limited == 2
            assert messages_router._SSE_STREAMS.get(user_id) == 3
            for r in results:
                if not isinstance(r, Exception):
                    await r.body_iterator.aclose()
        finally:
            messages_router._SSE_STREAMS.pop(user_id, None)

    asyncio.run(exercise())


def test_sse_max_lifetime_frame(app, monkeypatch):
    monkeypatch.setattr(messages_router, "SessionLocal", app.state.testing_session)
    monkeypatch.setenv("SX_SSE_MAX_MIN", "30")
    base = time.monotonic()
    clock = {"now": base}
    monkeypatch.setattr("time.monotonic", lambda: clock["now"])

    async def exercise():
        with app.state.testing_session() as db:
            user = db.query(User).filter(User.username_norm == "edge_sse_life").first()
            if user is None:
                user = User(username="edge_sse_life", username_norm="edge_sse_life", display_name="l")
                db.add(user)
                db.commit()
            user_id = user.id

        async def _receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        request = StarletteRequest({"type": "http", "headers": []}, _receive)
        context = AuthContext(
            user=type("U", (), {"id": user_id, "status": "active", "account_type": "real"})(),
            session=None,
        )
        messages_router._SSE_STREAMS.pop(user_id, None)
        response = await messages_router.message_events(request, 0, context)
        # Advance past the 30-minute deadline *after* the deadline is computed.
        clock["now"] = base + 31 * 60
        try:
            first = await asyncio.wait_for(response.body_iterator.__anext__(), timeout=10)
            assert "reconnect" in first and "max-stream-lifetime" in first
        finally:
            await response.body_iterator.aclose()
        assert messages_router._SSE_STREAMS.get(user_id, 0) == 0

    asyncio.run(exercise())


def test_login_empty_password_unknown_user(app):
    with TestClient(app) as client:
        response = client.post("/api/auth/login", json={"identifier": "edge_ghost", "password": ""})
        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "INVALID_CREDENTIALS"


def test_login_dummy_hash_cached(app):
    with TestClient(app) as client:
        for _ in range(2):
            response = client.post(
                "/api/auth/login", json={"identifier": "edge_ghost2", "password": PASSWORD})
            assert response.status_code == 401
    assert social._DUMMY_PASSWORD_HASH is not None


def test_pixel_ceiling_exact_boundary(tmp_path):
    tiny = tmp_path / "tiny2.png"
    Image.new("RGB", (8, 8), (1, 1, 1)).save(tiny, "PNG")

    class FakeImg:
        def __init__(self, size):
            self.size = size

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    with patch.object(pipeline_utils.Image, "open", return_value=FakeImg((10000, 5000))):
        assert get_image_dimensions(str(tiny)) == (10000, 5000)
    with patch.object(pipeline_utils.Image, "open", return_value=FakeImg((10000, 5001))):
        with pytest.raises(ValueError, match="pixel limit"):
            get_image_dimensions(str(tiny))


def test_fal_key_length_boundaries(monkeypatch):
    monkeypatch.setenv("SX_FAL_KEY_ENCRYPTION_KEY", "0123456789abcde")
    assert len("0123456789abcde") == 15
    with pytest.raises(FalKeyConfigurationError):
        encrypt_fal_key("u", "k")
    monkeypatch.setenv("SX_FAL_KEY_ENCRYPTION_KEY", "0123456789abcdef")
    envelope = encrypt_fal_key("u", "k")
    assert decrypt_fal_key("u", envelope) == "k"
    monkeypatch.setenv("SX_FAL_KEY_ENCRYPTION_KEY", "xxCHANGE-THIS-secretxx")
    with pytest.raises(FalKeyConfigurationError):
        encrypt_fal_key("u", "k")
    monkeypatch.setenv("SX_FAL_KEY_ENCRYPTION_KEY", "")
    with pytest.raises(FalKeyConfigurationError):
        encrypt_fal_key("u", "k")
