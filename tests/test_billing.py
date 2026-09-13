from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from server.billing.crypto import decrypt_fal_key, encrypt_fal_key
from server.billing.runtime import resolve_fal_key
from server.billing.service import (
    BillingError,
    InsufficientCredits,
    QuoteError,
    RewardError,
    capture_stage,
    claim_reel_reward,
    create_billing_job,
    create_quote,
    debit_credits,
    fail_stage,
    finalize_job_failure,
    finalize_reconciled_job,
    get_wallet,
    grant_credits,
    mark_stage_submitted,
    reserve_credits,
)
from server.social.database import Base
from server.social.models import (
    CloudGenerationBilling,
    CloudGenerationStage,
    EngagementEvent,
    FalCredential,
    Post,
    RecommendationImpression,
    RecommendationRequest,
    RecommendationSession,
    User,
    utcnow,
)


@pytest.fixture
def sessions():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    event.listen(engine, "connect", lambda connection, _: connection.execute("PRAGMA foreign_keys=ON"))
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)


def add_user(db, username="viewer"):
    user = User(username=username, username_norm=username, display_name=username)
    db.add(user)
    db.commit()
    return user


def test_reserve_capture_release_and_idempotency(sessions):
    with sessions() as db:
        user = add_user(db)
        grant_credits(db, user.id, 100, source="purchase", idempotency_key="purchase:1")
        db.commit()
        params = {
            "prompt": "",
            "upscale_only": False,
            "upscale_engine": "fal",
            "sharpening": 0.0,
            "outpaint_model": "fal-ai/luma-dream-machine/ray-2-flash/reframe",
            "upscale_model": "fal-ai/bytedance-upscaler/upscale/video",
            "ltx_resolution": "720p",
            "ltx_audio": True,
            "ltx_guidance": 1.0,
            "ltx_prompt_expansion": False,
            "ltx_negative_prompt": "",
            "ltx_loras": [],
            "wan_resolution": "720p",
            "seedvr_factor": 2.0,
            "seedvr_target": "1080p",
            "bytedance_target_res": "4k",
            "bytedance_target_fps": "30fps",
            "bytedance_tier": "fast",
            "bytedance_preset": "general",
            "bytedance_fidelity": "medium",
            "trim_enabled": False,
            "trim_start": 0.0,
            "trim_duration": 15.0,
            "custom_outpaint_args": {},
            "custom_upscale_args": {},
        }
        quote = create_quote(
            db, user_id=user.id, kind="video", stage_id="stage", width=1920, height=1080,
            duration=5, params=params,
        )
        assert quote.credits == 61
        create_billing_job(
            db, user_id=user.id, job_id="job1", kind="video", payment_source="credits",
            stage_id="stage", params=params, quote_id=quote.id,
        )
        assert get_wallet(db, user.id)["available_credits"] == 39
        assert get_wallet(db, user.id)["reserved_credits"] == 61

        mark_stage_submitted(db, "job1", "outpaint", "fal-request-1")
        capture_stage(db, "job1", "outpaint")
        capture_stage(db, "job1", "outpaint")
        finalize_job_failure(db, "job1")
        wallet = get_wallet(db, user.id)
        assert wallet["available_credits"] == 59
        assert wallet["reserved_credits"] == 0
        assert wallet["lifetime_spent"] == 41


def test_quote_reuse_and_tamper_are_rejected(sessions):
    with sessions() as db:
        user = add_user(db)
        grant_credits(db, user.id, 20, source="purchase", idempotency_key="purchase:2")
        db.commit()
        params = {"prompt": "", "upscale_only": False, "upscale_engine": "fast", "outpaint_model": "fal-ai/image-apps-v2/outpaint", "upscale_model": "fal-ai/clarity-upscaler", "sharpening": 0.0, "custom_outpaint_args": {}, "custom_upscale_args": {}}
        quote = create_quote(db, user_id=user.id, kind="image", stage_id="img", width=1000, height=500, duration=None, params=params)
        changed = dict(params, prompt="tampered")
        with pytest.raises(QuoteError, match="do not match"):
            create_billing_job(db, user_id=user.id, job_id="bad", kind="image", payment_source="credits", stage_id="img", params=changed, quote_id=quote.id)
        db.rollback()
        create_billing_job(db, user_id=user.id, job_id="good", kind="image", payment_source="credits", stage_id="img", params=params, quote_id=quote.id)
        with pytest.raises(QuoteError, match="already"):
            create_billing_job(db, user_id=user.id, job_id="again", kind="image", payment_source="credits", stage_id="img", params=params, quote_id=quote.id)


def test_atomic_reservation_prevents_overspend(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'wallet.db'}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    event.listen(engine, "connect", lambda connection, _: connection.execute("PRAGMA journal_mode=WAL"))
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    with Session() as db:
        user = add_user(db, "concurrent")
        user_id = user.id
        grant_credits(db, user_id, 100, source="purchase", idempotency_key="purchase:concurrent")
        db.commit()

    def attempt(job_id):
        with Session() as db:
            try:
                reserve_credits(db, user_id, 80, job_id=job_id)
                db.commit()
                return True
            except InsufficientCredits:
                db.rollback()
                return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(attempt, ("a", "b")))
    assert sorted(outcomes) == [False, True]
    with Session() as db:
        wallet = get_wallet(db, user_id)
        assert wallet["available_credits"] == 20
        assert wallet["reserved_credits"] == 80


def test_fal_key_encryption_is_user_bound(monkeypatch):
    monkeypatch.setenv("SX_FAL_KEY_ENCRYPTION_KEY", "test-only-dedicated-fal-encryption-secret")
    envelope = encrypt_fal_key("user-a", "fal-secret-value")
    assert "fal-secret-value" not in envelope
    assert decrypt_fal_key("user-a", envelope) == "fal-secret-value"
    with pytest.raises(Exception):
        decrypt_fal_key("user-b", envelope)


def test_corrupt_saved_fal_key_is_reported_as_billing_error(sessions, monkeypatch):
    monkeypatch.setenv("SX_FAL_KEY_ENCRYPTION_KEY", "test-only-dedicated-fal-encryption-secret")
    with sessions() as db:
        user = add_user(db, "corrupt_key_user")
        envelope = encrypt_fal_key(user.id, "fal-secret-value")
        version, nonce, ciphertext = envelope.split(".", 2)
        replacement = ("A" if ciphertext[0] != "A" else "B") + ciphertext[1:]
        db.add(FalCredential(
            user_id=user.id,
            ciphertext=f"{version}.{nonce}.{replacement}",
            key_hint="••••alue",
        ))
        db.commit()
        with pytest.raises(BillingError, match="could not be decrypted"):
            resolve_fal_key(db, user_id=user.id, payment_source="byok")


def test_ten_distinct_qualified_reels_award_one_credit(sessions):
    with sessions() as db:
        viewer = add_user(db, "reward_viewer")
        owner = add_user(db, "reward_owner")
        rec_session = RecommendationSession(
            actor_key=f"u:{viewer.id}", user_id=viewer.id, surface="reels", filter_hash="all",
            filters={}, algorithm_version="test", expires_at=utcnow() + timedelta(hours=1),
        )
        db.add(rec_session)
        db.flush()
        request = RecommendationRequest(session_id=rec_session.id, page_index=0, requested_count=10, returned_count=10)
        db.add(request)
        db.flush()
        pairs = []
        for index in range(10):
            post = Post(owner_id=owner.id, media_path=f"reward-{index}.jpg", media_type="image", title="")
            db.add(post)
            db.flush()
            impression = RecommendationImpression(
                request_id=request.id, session_id=rec_session.id, post_id=post.id,
                position=index, primary_source="test", reason_key="test", provenance={},
                first_visible_at=utcnow() - timedelta(seconds=4),
            )
            db.add(impression)
            db.flush()
            db.add(EngagementEvent(
                user_id=viewer.id, post_id=post.id, recommendation_impression_id=impression.id,
                recommendation_request_id=request.id, recommendation_session_id=rec_session.id,
                event_type="reward_eligible", source="reels", watch_ms=3000, foreground_ms=3000,
                duration_ms=3000, watch_ratio=1.0, context={"media_type": "image"},
            ))
            pairs.append((post.id, impression.id))
        db.commit()
        results = [
            claim_reel_reward(db, user_id=viewer.id, post_id=post_id, impression_id=impression_id, ip_hash="ip")
            for post_id, impression_id in pairs
        ]
        assert sum(1 for result in results if result["credit_awarded"]) == 1
        assert results[-1]["progress"] == 0
        assert get_wallet(db, viewer.id)["available_credits"] == 1
        duplicate = claim_reel_reward(db, user_id=viewer.id, post_id=pairs[0][0], impression_id=pairs[0][1], ip_hash="ip")
        assert duplicate["duplicate"] is True
        assert get_wallet(db, viewer.id)["available_credits"] == 1


def _reward_candidate(
    db, viewer, owner, *, index, media_type="video", duration_ms=10000,
    foreground_ms=5000, visible_seconds_ago=11,
):
    rec_session = RecommendationSession(
        actor_key=f"u:{viewer.id}:{index}", user_id=viewer.id, surface="reels", filter_hash=f"reward-{index}",
        filters={}, algorithm_version="test", expires_at=utcnow() + timedelta(hours=1),
    )
    db.add(rec_session)
    db.flush()
    request = RecommendationRequest(session_id=rec_session.id, page_index=0, requested_count=1, returned_count=1)
    db.add(request)
    db.flush()
    post = Post(owner_id=owner.id, media_path=f"reward-extra-{index}.mp4", media_type=media_type, title="")
    db.add(post)
    db.flush()
    impression = RecommendationImpression(
        request_id=request.id, session_id=rec_session.id, post_id=post.id,
        position=0, primary_source="test", reason_key="test", provenance={},
        first_visible_at=utcnow() - timedelta(seconds=visible_seconds_ago),
    )
    db.add(impression)
    db.flush()
    event = EngagementEvent(
        user_id=viewer.id, post_id=post.id, recommendation_impression_id=impression.id,
        recommendation_request_id=request.id, recommendation_session_id=rec_session.id,
        event_type="reward_eligible", source="reels", watch_ms=foreground_ms,
        foreground_ms=foreground_ms, duration_ms=duration_ms,
        watch_ratio=foreground_ms / duration_ms if duration_ms else None,
        context={"media_type": media_type},
    )
    db.add(event)
    db.commit()
    return post, impression, event


def test_reel_reward_enforces_video_threshold_and_self_view(sessions):
    with sessions() as db:
        viewer = add_user(db, "threshold_viewer")
        owner = add_user(db, "threshold_owner")
        post, impression, event = _reward_candidate(
            db, viewer, owner, index=100, duration_ms=10000, foreground_ms=4999,
        )
        with pytest.raises(RewardError, match="Watch at least 5 seconds"):
            claim_reel_reward(db, user_id=viewer.id, post_id=post.id, impression_id=impression.id, ip_hash="threshold-ip")
        event.foreground_ms = 5000
        db.commit()
        result = claim_reel_reward(
            db, user_id=viewer.id, post_id=post.id, impression_id=impression.id, ip_hash="threshold-ip",
        )
        assert result["progress"] == 1

        self_post, self_impression, _ = _reward_candidate(
            db, viewer, viewer, index=101, media_type="image", duration_ms=3000, foreground_ms=3000,
        )
        with pytest.raises(RewardError, match="Self-views"):
            claim_reel_reward(
                db, user_id=viewer.id, post_id=self_post.id,
                impression_id=self_impression.id, ip_hash="threshold-ip",
            )


def test_reel_reward_rejects_immediate_client_claim(sessions):
    with sessions() as db:
        viewer = add_user(db, "early_viewer")
        owner = add_user(db, "early_owner")
        post, impression, _ = _reward_candidate(
            db, viewer, owner, index=150, duration_ms=20000,
            foreground_ms=10000, visible_seconds_ago=0,
        )
        with pytest.raises(RewardError, match="server-observed viewing threshold"):
            claim_reel_reward(
                db, user_id=viewer.id, post_id=post.id,
                impression_id=impression.id, ip_hash="early-ip",
            )


def test_reel_reward_ip_cap_applies_across_accounts(sessions, monkeypatch):
    monkeypatch.setenv("SX_REEL_REWARD_IP_DAILY_CLAIMS", "10")
    with sessions() as db:
        first_viewer = add_user(db, "network_viewer_a")
        second_viewer = add_user(db, "network_viewer_b")
        owner = add_user(db, "network_owner")
        for index in range(10):
            post, impression, _ = _reward_candidate(
                db, first_viewer, owner, index=200 + index,
                media_type="image", duration_ms=3000, foreground_ms=3000,
            )
            claim_reel_reward(
                db, user_id=first_viewer.id, post_id=post.id,
                impression_id=impression.id, ip_hash="shared-network",
            )
        post, impression, _ = _reward_candidate(
            db, second_viewer, owner, index=299,
            media_type="image", duration_ms=3000, foreground_ms=3000,
        )
        with pytest.raises(RewardError, match="network"):
            claim_reel_reward(
                db, user_id=second_viewer.id, post_id=post.id,
                impression_id=impression.id, ip_hash="shared-network",
            )


def test_timeout_keeps_submitted_stage_reserved_until_reconciled(sessions):
    with sessions() as db:
        user = add_user(db, "timeout_user")
        grant_credits(db, user.id, 100, source="purchase", idempotency_key="purchase:timeout")
        db.commit()
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
        quote = create_quote(
            db, user_id=user.id, kind="video", stage_id="timeout-stage",
            width=1920, height=1080, duration=5, params=params,
        )
        create_billing_job(
            db, user_id=user.id, job_id="timeout-job", kind="video", payment_source="credits",
            stage_id="timeout-stage", params=params, quote_id=quote.id,
        )
        mark_stage_submitted(db, "timeout-job", "outpaint", "fal-timeout-request")
        finalize_job_failure(db, "timeout-job", error_code="provider_timeout")
        billing = db.query(CloudGenerationBilling).filter_by(job_id="timeout-job").one()
        stages = {stage.stage_name: stage for stage in db.query(CloudGenerationStage).filter_by(billing_id=billing.id)}
        assert billing.status == "pending_reconciliation"
        assert stages["outpaint"].status == "submitted"
        assert stages["upscale"].status == "released"
        assert get_wallet(db, user.id)["reserved_credits"] == stages["outpaint"].reserved_credits

        fail_stage(db, "timeout-job", "outpaint", definitive=True)
        fail_stage(db, "timeout-job", "outpaint", definitive=True)
        assert finalize_reconciled_job(db, "timeout-job") is True
        db.refresh(billing)
        assert billing.status == "failed"
        assert get_wallet(db, user.id)["reserved_credits"] == 0
        assert get_wallet(db, user.id)["available_credits"] == 100


def test_byok_jobs_do_not_touch_wallet_and_negative_balance_blocks_reservation(sessions):
    with sessions() as db:
        user = add_user(db, "byok_user")
        create_billing_job(
            db, user_id=user.id, job_id="byok-job", kind="image", payment_source="byok",
            stage_id="byok-stage", params={}, quote_id=None,
            stage_specs=[("outpaint", "fal-ai/custom-model")],
        )
        wallet = get_wallet(db, user.id)
        assert wallet["available_credits"] == 0
        assert wallet["reserved_credits"] == 0
        billing = db.query(CloudGenerationBilling).filter_by(job_id="byok-job").one()
        stage = db.query(CloudGenerationStage).filter_by(billing_id=billing.id).one()
        assert billing.payment_source == "byok"
        assert stage.reserved_credits == 0

        debit_credits(
            db, user.id, 1, source="refund", idempotency_key="negative:test",
            reference_type="stripe_purchase", reference_id="purchase",
        )
        db.commit()
        assert get_wallet(db, user.id)["available_credits"] == -1
        with pytest.raises(InsufficientCredits):
            reserve_credits(db, user.id, 1, job_id="blocked-negative")
