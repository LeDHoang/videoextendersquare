from __future__ import annotations

from datetime import datetime, timedelta
from uuid import uuid4

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.routers import account_safety, social
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import (
    AppSetting, AuthSession, CloudGenerationBilling, Comment, DirectMessage, Conversation, Post, Report, User, utcnow,
)

PASSWORD = "correct-horse-battery"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    engine = create_engine("sqlite:///" + str(tmp_path / "stats.db"), connect_args={"check_same_thread": False})
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    # Login re-derives the role from these lists, so a role set on the row alone would be reset.
    monkeypatch.setenv("SX_MODERATOR_USERS", "the_mod")
    monkeypatch.setenv("SX_ADMIN_USERS", "")
    application = FastAPI()
    application.include_router(account_safety.router)
    application.include_router(social.router)

    def override_get_db():
        db = session()
        try:
            yield db
        finally:
            db.close()

    application.dependency_overrides[get_db] = override_get_db
    application.state.testing_session = session
    yield application
    Base.metadata.drop_all(engine)
    engine.dispose()


def add_user(app, name: str, role: str = "user", status: str = "active", age: timedelta = timedelta(0)) -> str:
    with app.state.testing_session() as db:
        user = User(
            email=f"{name}@example.com",
            email_norm=f"{name}@example.com",
            username=name,
            username_norm=name,
            password_hash=auth.hash_password(PASSWORD),
            display_name=name,
            role=role,
            status=status,
            created_at=utcnow() - age,
        )
        db.add(user)
        db.commit()
        return user.id


def sign_in(app, name: str) -> TestClient:
    client = TestClient(app)
    response = client.post("/api/auth/login", json={"identifier": name, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return client


def test_stats_require_a_moderator(app):
    add_user(app, "plain_user")
    assert TestClient(app).get("/api/moderation/stats").status_code == 401
    assert sign_in(app, "plain_user").get("/api/moderation/stats").status_code == 403


def test_stats_count_windows_and_flag_spikes(app, monkeypatch):
    monkeypatch.setenv("SX_MOD_SPIKE_MIN", "5")
    add_user(app, "the_mod", role="moderator")
    spammer = add_user(app, "spammer")
    # Previous 24 h window: one report. Current window: six, so 6 >= 3 * 1 and 6 >= floor 5.
    with app.state.testing_session() as db:
        db.add(Report(reporter_id=spammer, target_type="user", target_id="x", reason="spam",
                      created_at=utcnow() - timedelta(hours=30)))
        for index in range(6):
            db.add(Report(reporter_id=spammer, target_type="user", target_id=f"x{index}", reason="spam" if index else "other",
                          created_at=utcnow() - timedelta(hours=2)))
        db.commit()
    body = sign_in(app, "the_mod").get("/api/moderation/stats").json()
    reports = body["windows"]["24h"]["reports"]
    assert (reports["current"], reports["previous"], reports["spike"]) == (6, 1, True)
    assert reports["by_reason"] == {"spam": 5, "other": 1}
    assert body["open_reports"] == 7
    assert body["spike_floor"] == 5
    assert body["disk"]


def test_stats_count_accounts_and_people_active_now(app):
    add_user(app, "the_mod", role="moderator")
    add_user(app, "idle_user")
    add_user(app, "unverified", status="pending")
    add_user(app, "banned", status="suspended")
    recent = add_user(app, "recent_user")
    stale = add_user(app, "stale_user")
    demo = add_user(app, "demo_user")
    with app.state.testing_session() as db:
        db.get(User, recent).last_seen_at = utcnow() - timedelta(minutes=10)
        db.get(User, stale).last_seen_at = utcnow() - timedelta(minutes=40)
        demo_user = db.get(User, demo)
        demo_user.account_type = "demo"
        demo_user.last_seen_at = utcnow()
        db.commit()
    # Signing in stamps the moderator's own last_seen_at, so they count as active too.
    body = sign_in(app, "the_mod").get("/api/moderation/stats").json()
    # Active real accounts: the_mod, idle_user, recent_user, stale_user.
    assert body["accounts"] == {"total": 4, "active_now": 2, "active_window_min": 15, "capacity": 800, "capacity_warn": 560}


def test_small_counts_below_the_floor_do_not_flag(app, monkeypatch):
    monkeypatch.setenv("SX_MOD_SPIKE_MIN", "10")
    add_user(app, "the_mod", role="moderator")
    for index in range(3):
        add_user(app, f"newcomer{index}")
    body = sign_in(app, "the_mod").get("/api/moderation/stats").json()
    active = body["windows"]["24h"]["registrations"]["active"]
    assert active["current"] == 4 and active["previous"] == 0
    assert active["spike"] is False


def test_pending_registrations_are_counted_apart(app):
    add_user(app, "the_mod", role="moderator")
    add_user(app, "waiting", status="pending")
    body = sign_in(app, "the_mod").get("/api/moderation/stats").json()
    registrations = body["windows"]["7d"]["registrations"]
    assert registrations["pending"]["current"] == 1
    assert registrations["active"]["current"] == 1


def test_top_senders_rank_by_volume(app):
    add_user(app, "the_mod", role="moderator")
    loud = add_user(app, "loud")
    quiet = add_user(app, "quiet")
    with app.state.testing_session() as db:
        conversation = Conversation(direct_key=f"{loud}:{quiet}", requester_id=loud)
        db.add(conversation)
        db.flush()
        for sender, count in ((loud, 3), (quiet, 1)):
            for _ in range(count):
                db.add(DirectMessage(conversation_id=conversation.id, sender_id=sender, kind="text", payload_ciphertext="x"))
        db.commit()
    body = sign_in(app, "the_mod").get("/api/moderation/stats").json()
    senders = body["windows"]["24h"]["messages"]["top_senders"]
    assert [(row["username"], row["sent"]) for row in senders] == [("loud", 3), ("quiet", 1)]


def test_stats_carry_the_queue_backlog_limits(app, monkeypatch):
    monkeypatch.setenv("SX_ALERT_OPEN_REPORTS", "7")
    add_user(app, "the_mod", role="moderator")
    body = sign_in(app, "the_mod").get("/api/moderation/stats").json()
    assert body["queue_limits"] == {"open_reports": 7, "open_support_requests": 10}


def test_hourly_stats_bucket_each_metric_by_hour(app):
    add_user(app, "the_mod", role="moderator")
    add_user(app, "waiting", status="pending", age=timedelta(hours=3))
    reporter = add_user(app, "reporter", age=timedelta(days=20))
    now = utcnow()
    times = [now - timedelta(minutes=1), now - timedelta(hours=5), now - timedelta(hours=5), now - timedelta(days=15)]
    with app.state.testing_session() as db:
        for created_at in times:
            db.add(Report(reporter_id=reporter, target_type="user", target_id="x", reason="spam", created_at=created_at))
        db.commit()
    client = sign_in(app, "the_mod")
    assert TestClient(app).get("/api/moderation/stats/hourly").status_code == 401
    body = client.get("/api/moderation/stats/hourly").json()
    assert body["hours"] == 336
    start = datetime.fromisoformat(body["start"])
    expected = [0] * 336
    # The report from 15 days ago is outside the span.
    for created_at in times[:3]:
        expected[int((created_at - start).total_seconds() // 3600)] += 1
    assert body["series"]["reports"] == expected
    assert sum(body["series"]["unverified"]) == 1
    assert sum(body["series"]["signups"]) == 1
    assert set(body["series"]) == {"reports", "support_requests", "posts", "signups", "unverified", "messages", "credits_captured"}


def test_hourly_stats_require_a_moderator(app):
    add_user(app, "plain_user")
    assert sign_in(app, "plain_user").get("/api/moderation/stats/hourly").status_code == 403


def add_billing(app, user_id: str, job_id: str, reserved: int = 0, captured: int = 0, age: timedelta = timedelta(0)):
    with app.state.testing_session() as db:
        db.add(CloudGenerationBilling(
            job_id=job_id, user_id=user_id, kind="image", payment_source="credits",
            reserved_credits=reserved, captured_credits=captured, created_at=utcnow() - age,
        ))
        db.commit()


def add_session(app, user_id: str, ip_hash: str = "", device_hash: str | None = None):
    with app.state.testing_session() as db:
        db.add(AuthSession(
            user_id=user_id, token_hash=uuid4().hex, csrf_hash="x", ip_hash=ip_hash,
            device_hash=device_hash, expires_at=utcnow() + timedelta(days=1),
        ))
        db.commit()


def test_flagged_accounts_list_each_signal(app, monkeypatch):
    monkeypatch.setenv("SX_ALERT_USER_SPEND_HOURLY", "50")
    monkeypatch.setenv("SX_ALERT_NEW_ACCOUNT_SPEND", "20")
    monkeypatch.setenv("SX_ALERT_ACCOUNTS_PER_DEVICE", "3")
    monkeypatch.setenv("SX_ALERT_ACCOUNTS_PER_IP", "1000")
    add_user(app, "the_mod", role="moderator", age=timedelta(days=10))
    spender = add_user(app, "spender", age=timedelta(days=10))
    add_billing(app, spender, "s1", reserved=30, age=timedelta(minutes=10))
    add_billing(app, spender, "s2", reserved=30, age=timedelta(minutes=20))
    add_billing(app, spender, "old", reserved=500, age=timedelta(hours=3))
    newcomer = add_user(app, "newcomer", age=timedelta(hours=2))
    add_billing(app, newcomer, "n1", captured=25, age=timedelta(hours=1, minutes=30))
    farm = [add_user(app, f"farm{index}", age=timedelta(days=10)) for index in range(3)]
    for user_id in farm:
        add_session(app, user_id, ip_hash="farmip", device_hash="d" * 64)
    add_session(app, spender, device_hash="e" * 64)

    response = sign_in(app, "the_mod").get("/api/moderation/stats/accounts")
    assert response.status_code == 200, response.text
    rows = {row["signal"]: row for row in response.json()["accounts"]}
    assert set(rows) == {"spend_hourly", "accounts_per_device", "new_account_spend"}
    assert (rows["spend_hourly"]["value"], rows["spend_hourly"]["users"][0]["username"]) == (60, "spender")
    assert rows["accounts_per_device"]["value"] == 3
    assert rows["accounts_per_device"]["key"] == "d" * 12
    assert sorted(user["username"] for user in rows["accounts_per_device"]["users"]) == ["farm0", "farm1", "farm2"]
    assert rows["new_account_spend"]["users"][0] == {"id": newcomer, "username": "newcomer", "tier": "standard"}


def test_flagged_accounts_require_a_moderator(app):
    add_user(app, "plain_user")
    assert sign_in(app, "plain_user").get("/api/moderation/stats/accounts").status_code == 403


def test_flagged_accounts_cover_reports_and_new_account_bursts(app, monkeypatch):
    monkeypatch.setenv("SX_ALERT_REPORTERS_PER_TARGET", "3")
    monkeypatch.setenv("SX_ALERT_REPORTERS_PER_ACCOUNT", "4")
    monkeypatch.setenv("SX_ALERT_NEW_ACCOUNT_ACTIVITY", "5")
    monkeypatch.setenv("SX_TRUST_NEW_HOURS", "72")
    add_user(app, "the_mod", role="moderator", age=timedelta(days=10))
    author = add_user(app, "author", age=timedelta(days=10))
    reporters = [add_user(app, f"reporter{index}", age=timedelta(days=10)) for index in range(4)]
    burster = add_user(app, "burster", age=timedelta(hours=3))
    veteran = add_user(app, "veteran", age=timedelta(days=10))
    with app.state.testing_session() as db:
        post = Post(owner_id=author, media_path="reported.jpg", media_type="image", title="", created_at=utcnow() - timedelta(days=3))
        db.add(post)
        db.flush()
        # Three people report the post today; a fourth reported the profile three days ago.
        for reporter in reporters[:3]:
            db.add(Report(reporter_id=reporter, target_type="post", target_id=post.id, reason="hate"))
        db.add(Report(reporter_id=reporters[3], target_type="user", target_id=author, reason="spam",
                      created_at=utcnow() - timedelta(days=3)))
        # A reviewed report no longer counts.
        db.add(Report(reporter_id=veteran, target_type="post", target_id=post.id, reason="spam", status="dismissed"))
        # Five comments in the last hour: flagged for the new account, not for the old one.
        for user_id in (burster, veteran):
            for index in range(5):
                db.add(Comment(post_id=post.id, author_id=user_id, text=f"spam {index}"))
        db.commit()
        post_id = post.id

    rows = {row["signal"]: row for row in sign_in(app, "the_mod").get("/api/moderation/stats/accounts").json()["accounts"]}
    assert set(rows) == {"reporters_per_target", "reporters_per_account", "new_account_activity"}
    assert (rows["reporters_per_target"]["key"], rows["reporters_per_target"]["target_type"]) == (post_id, "post")
    assert (rows["reporters_per_target"]["value"], rows["reporters_per_target"]["users"][0]["username"]) == (3, "author")
    assert (rows["reporters_per_account"]["value"], rows["reporters_per_account"]["users"][0]["username"]) == (4, "author")
    assert (rows["new_account_activity"]["value"], rows["new_account_activity"]["users"][0]["username"]) == (5, "burster")


def test_a_stricter_sensitivity_flags_sooner(app, monkeypatch):
    monkeypatch.setenv("SX_ALERT_REPORTERS_PER_TARGET", "4")
    add_user(app, "the_mod", role="moderator", age=timedelta(days=10))
    author = add_user(app, "author", age=timedelta(days=10))
    with app.state.testing_session() as db:
        for index in range(2):
            reporter = add_user(app, f"reporter{index}", age=timedelta(days=10))
            db.add(Report(reporter_id=reporter, target_type="user", target_id=author, reason="hate"))
        db.commit()
    client = sign_in(app, "the_mod")
    assert client.get("/api/moderation/stats/accounts").json()["accounts"] == []
    with app.state.testing_session() as db:
        db.add(AppSetting(key="alert_sensitivity", value={"community": 4, "abuse": 2}))
        db.commit()
    # VERY STRICT halves the limit of 4, so two reporters are enough.
    signals = [row["signal"] for row in client.get("/api/moderation/stats/accounts").json()["accounts"]]
    assert signals == ["reporters_per_target"]
