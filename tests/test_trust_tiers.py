"""Trust tiers: one test per signal, and the limits each tier gets."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from server import trust
from server.jobs import JobManager, QueueFull
from server.social.database import Base
from server.social.models import Post, StaffAction, StripePurchase, User, utcnow


@pytest.fixture
def db(monkeypatch):
    monkeypatch.setenv("SX_TRUST_NEW_HOURS", "72")
    monkeypatch.setenv("SX_TRUST_TRUSTED_DAYS", "30")
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine, expire_on_commit=False)() as session:
        yield session
    engine.dispose()


def add_user(db, username="member", age=timedelta(days=10)):
    user = User(username=username, username_norm=username, display_name=username, created_at=utcnow() - age)
    db.add(user)
    db.commit()
    return user


def add_purchase(db, user, status, reversed_at=None):
    db.add(StripePurchase(
        user_id=user.id, pack_id="starter", stripe_price_id="price_1", checkout_session_id=f"cs_{status}",
        amount_total_cents=500, credits=50, status=status, reversed_at=reversed_at,
    ))
    db.commit()


def test_a_young_account_is_new(db):
    assert trust.tier(db, add_user(db, age=timedelta(hours=1))) == "new"


def test_an_older_account_is_standard(db):
    assert trust.tier(db, add_user(db, age=timedelta(days=4))) == "standard"


def test_an_old_account_with_a_purchase_is_trusted(db):
    user = add_user(db, age=timedelta(days=40))
    assert trust.tier(db, user) == "standard"
    add_purchase(db, user, "fulfilled")
    assert trust.tier(db, user) == "trusted"


def test_a_recent_suspension_restricts(db):
    user = add_user(db, age=timedelta(days=40))
    db.add(StaffAction(action="user.suspend", target_type="user", target_id=user.id))
    db.commit()
    assert trust.tier(db, user) == "restricted"


def test_removed_content_restricts_its_author(db):
    user = add_user(db)
    post = Post(owner_id=user.id, media_path="removed.jpg", media_type="image", title="")
    db.add(post)
    db.flush()
    db.add(StaffAction(action="content.remove", target_type="post", target_id=post.id))
    db.commit()
    assert trust.tier(db, user) == "restricted"


def test_a_reversed_purchase_restricts(db):
    user = add_user(db, age=timedelta(days=40))
    add_purchase(db, user, "reversed", reversed_at=utcnow())
    assert trust.tier(db, user) == "restricted"


def test_an_old_suspension_no_longer_restricts(db):
    user = add_user(db, age=timedelta(days=60))
    db.add(StaffAction(
        action="user.suspend", target_type="user", target_id=user.id, created_at=utcnow() - timedelta(days=31),
    ))
    db.commit()
    assert trust.tier(db, user) == "standard"


def test_each_tier_reads_its_own_limit(db, monkeypatch):
    monkeypatch.setenv("SX_UPLOAD_HOURLY_MAX", "30")
    monkeypatch.setenv("SX_NEW_UPLOAD_HOURLY_MAX", "4")
    assert trust.limit(db, add_user(db, "fresh", age=timedelta(hours=1)), "upload_hourly") == 4
    assert trust.limit(db, add_user(db, "settled"), "upload_hourly") == 30
    assert trust.limit(db, add_user(db, "default_new", age=timedelta(hours=2)), "jobs_per_user") == 1


def test_reserve_job_honours_the_tier_job_limit(monkeypatch):
    monkeypatch.setenv("SX_MAX_JOBS_PER_USER", "5")
    manager = JobManager(max_image_workers=1, max_video_workers=1)
    manager.reserve_job(kind="image", owner_id="u1", max_per_user=1)
    with pytest.raises(QueueFull):
        manager.reserve_job(kind="image", owner_id="u1", max_per_user=1)
