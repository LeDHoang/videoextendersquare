"""_pipeline_context skips reads whose answer is already known."""

from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from server.social.database import Base
from server.social.models import (
    ActorCreatorAffinity,
    Post,
    PostRecommendationStats,
    PostTag,
    RecommendationDismissal,
    Tag,
    User,
)
from server.social.recommendations import actor_identity, service
from server.social.recommendations.ranking import stats_quality

START = datetime(2026, 11, 1, tzinfo=timezone.utc)


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'waste.db'}")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    for name in ("ann", "bob", "cat", "dan"):
        session.add(User(id=name, username=name, username_norm=name))
    session.add_all([Tag(id=f"t{n}", name=f"t{n}", slug=f"t{n}") for n in range(3)])
    for n in range(8):
        owner = ("ann", "bob", "cat")[n % 3]
        created = START + timedelta(hours=min(n, 4) if n < 6 else n)
        session.add(Post(id=f"p{n}", owner_id=owner, media_path=f"{n}.mp4", media_type="video", created_at=created))
    session.flush()
    session.add_all([
        PostTag(post_id="p0", tag_id="t1"),
        PostTag(post_id="p0", tag_id="t0"),
        PostTag(post_id="p3", tag_id="t2"),
        PostTag(post_id="p5", tag_id="t0"),
    ])
    session.add(PostRecommendationStats(post_id="p1", impressions=40, qualified_views=12, likes=3))
    session.commit()
    session.queries = []
    event.listen(engine, "before_cursor_execute", lambda *args: session.queries.append(args[2]))
    yield session
    session.close()
    engine.dispose()


def stats_queries(db):
    return [sql for sql in db.queries if "FROM post_recommendation_stats" in sql]


def context(db, **flags):
    actor = actor_identity(None, "anon")
    return service._pipeline_context(
        db, actor=actor, session=None, surface="for_you", seed_post_id=None,
        allowed_post_ids=None, manual_order=None, **flags,
    )


def test_post_stats_are_read_once_per_ttl(db):
    first = context(db)
    assert first.stats["p1"].impressions == 40 and first.stats["p1"].likes == 3
    # A cold catalog also reads stats once to order its pool; count from here.
    after_first = len(stats_queries(db))
    context(db)
    assert len(stats_queries(db)) == after_first
    # Age only this cache: moving the clock would also expire the catalog's.
    at, cached = service._post_stats_cache["entry"]
    service._post_stats_cache["entry"] = (at - service.RECENT_STATS_TTL_S - 1, cached)
    context(db)
    assert len(stats_queries(db)) == after_first + 1


def test_post_without_stats_row_scores_like_today(db):
    ctx = context(db)
    assert "p2" not in ctx.stats
    assert stats_quality(ctx.stats.get("p2"), 0, 0) == stats_quality(None, 0, 0)


def new_session(db, actor):
    return service._new_session(db, actor=actor, surface="for_you", seed_post_id=None,
                                filters={}, algorithm_version=service.REELS_ALGORITHM_VERSION)


def tables(db):
    return " ".join(db.queries)


def test_fresh_session_reads_no_impressions_or_events_and_matches_full(db):
    actor = actor_identity(None, "anon")
    session = new_session(db, actor)
    db.flush()
    full = service._pipeline_context(db, actor=actor, session=session, surface="for_you",
        seed_post_id=None, allowed_post_ids=None, manual_order=None)
    db.queries.clear()
    lean = service._pipeline_context(db, actor=actor, session=session, surface="for_you",
        seed_post_id=None, allowed_post_ids=None, manual_order=None, fresh_session=True)
    assert dataclasses.replace(lean, now=full.now) == full
    assert "FROM recommendation_impressions" not in tables(db)
    # Only the watched read remains: the actor is not fresh in this task.
    assert len([sql for sql in db.queries if "FROM engagement_events" in sql]) == 1
    assert "FROM posts" not in tables(db)  # event_posts skipped


def test_restarted_session_is_fresh(db, monkeypatch):
    # get_reel_page passes fresh_session=True for no cursor and for a restart, False for a resumed cursor.
    seen = []
    real = service._materialize_reel_page
    monkeypatch.setattr(service, "_materialize_reel_page",
                        lambda *a, **k: seen.append(k["fresh_session"]) or real(*a, **k))
    actor = actor_identity(None, "anon")
    page = service.get_reel_page(db, actor=actor, filters={"a": 1}, limit=2)
    service.get_reel_page(db, actor=actor, filters={"a": 1}, limit=2, cursor=page.next_cursor)
    service.get_reel_page(db, actor=actor, filters={"a": 2}, limit=2, cursor=page.next_cursor)
    assert seen == [True, False, True]


def context_for(db, actor, **flags):
    return service._pipeline_context(
        db, actor=actor, session=None, surface="for_you", seed_post_id=None,
        allowed_post_ids=None, manual_order=None, **flags,
    )


AFFINITY = (
    "FROM actor_item_affinit",
    "FROM actor_creator_affinit",
    "FROM actor_tag_affinit",
    "FROM engagement_events",
    "FROM recommendation_dismissals",
    "FROM follows",
)


def test_fresh_actor_reads_no_actor_rows_and_matches_full(db):
    actor = actor_identity(None, "brand-new")
    full = context_for(db, actor)
    db.queries.clear()
    lean = context_for(db, actor, fresh_actor=True)
    assert dataclasses.replace(lean, now=full.now) == full
    assert [table for table in AFFINITY if table in tables(db)] == []


def test_both_flags_with_a_real_session_read_nothing_and_match_full(db):
    actor = actor_identity(None, "brand-new-too")
    session = new_session(db, actor)
    db.flush()
    full = service._pipeline_context(db, actor=actor, session=session, surface="for_you",
        seed_post_id=None, allowed_post_ids=None, manual_order=None)
    db.queries.clear()
    lean = service._pipeline_context(db, actor=actor, session=session, surface="for_you",
        seed_post_id=None, allowed_post_ids=None, manual_order=None,
        fresh_session=True, fresh_actor=True)
    assert dataclasses.replace(lean, now=full.now) == full
    skipped = AFFINITY + ("FROM recommendation_impressions", "FROM posts")
    assert [table for table in skipped if table in tables(db)] == []


def test_creator_affinity_from_a_follow_survives_without_the_flag(db):
    # A follow writes a creator-affinity row and no item rows (events.py).
    actor = actor_identity(None, "anon")
    db.add(ActorCreatorAffinity(actor_key=actor.actor_key, anonymous_id="anon", creator_id="bob",
                                score=5.0, last_event_at=START))
    db.commit()
    assert context_for(db, actor).creator_affinity["bob"] > 0


def test_dismissals_still_apply_to_a_returning_actor(db):
    actor = actor_identity(None, "anon")
    db.add(RecommendationDismissal(actor_key=actor.actor_key, anonymous_id="anon",
                                   target_type="post", post_id="p3", reason="not_interested"))
    db.commit()
    assert "p3" not in context_for(db, actor).items
