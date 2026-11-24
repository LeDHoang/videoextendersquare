"""_pipeline_context skips reads whose answer is already known."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from server.social.database import Base
from server.social.models import Post, PostRecommendationStats, PostTag, Tag, User
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
