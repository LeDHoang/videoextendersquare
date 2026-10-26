from __future__ import annotations

from datetime import datetime, timedelta

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.routers import account_safety, social
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import DirectMessage, Conversation, Report, User, utcnow

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
