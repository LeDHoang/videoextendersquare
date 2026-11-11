"""The recommendation catalog keeps the viewer-independent posts between requests."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, event, or_
from sqlalchemy.orm import sessionmaker

from server.social import services
from server.social.database import Base
from server.social.models import Follow, Post, PostTag, RecommendationDismissal, Tag, User, UserBlock
from server.social.recommendations import actor_identity, service
from server.social.recommendations.types import CatalogItem
from server.social.safety import blocked_user_ids

START = datetime(2026, 11, 1, tzinfo=timezone.utc)


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'catalog.db'}")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    for name in ("ann", "bob", "cat", "dan"):
        session.add(User(id=name, username=name, username_norm=name))
    session.add_all([Tag(id=f"t{n}", name=f"t{n}", slug=f"t{n}") for n in range(3)])
    for n in range(8):
        owner = ("ann", "bob", "cat")[n % 3]
        # Posts 4 and 5 share a time, so the id breaks the tie.
        created = START + timedelta(hours=min(n, 4) if n < 6 else n)
        session.add(Post(id=f"p{n}", owner_id=owner, media_path=f"{n}.mp4", media_type="video", created_at=created))
    session.flush()
    session.add_all([
        PostTag(post_id="p0", tag_id="t1"),
        PostTag(post_id="p0", tag_id="t0"),
        PostTag(post_id="p3", tag_id="t2"),
        PostTag(post_id="p5", tag_id="t0"),
    ])
    session.add(Post(id="draft", owner_id="ann", media_path="draft.mp4", media_type="video", status="draft"))
    session.commit()
    session.queries = []
    event.listen(engine, "before_cursor_execute", lambda *args: session.queries.append(args[2]))
    yield session
    session.close()
    engine.dispose()


def old_catalog(db, *, actor, allowed_post_ids, excluded_post_ids, surface):
    """The catalog as it was built before the cache: one filtered query per request."""
    hidden_users = blocked_user_ids(db, actor.user_id)
    dismissed_posts, dismissed_creators = service._active_dismissals(db, actor.actor_key)
    query = (
        db.query(Post.id, Post.owner_id, Post.created_at, Post.like_count, Post.view_count)
        .join(User, User.id == Post.owner_id)
        .filter(Post.status == "published", Post.deleted_at.is_(None), User.status == "active")
    )
    excluded_creators = hidden_users | dismissed_creators
    if excluded_creators:
        query = query.filter(~Post.owner_id.in_(excluded_creators))
    excluded = excluded_post_ids | dismissed_posts
    if excluded:
        query = query.filter(~Post.id.in_(excluded))
    if allowed_post_ids is not None:
        if not allowed_post_ids:
            return {}
        query = query.filter(Post.id.in_(allowed_post_ids))
    if surface == "following":
        if not actor.user_id:
            return {}
        followed = db.query(Follow.followee_id).filter(Follow.follower_id == actor.user_id)
        query = query.filter(or_(Post.owner_id == actor.user_id, Post.owner_id.in_(followed)))
    posts = query.order_by(Post.created_at.desc(), Post.id.desc()).limit(service.MAX_CATALOG_SIZE).all()
    tags = defaultdict(list)
    if posts:
        for post_id, tag_id in db.query(PostTag.post_id, PostTag.tag_id).filter(
            PostTag.post_id.in_([post.id for post in posts])
        ):
            tags[post_id].append(tag_id)
    return {
        post.id: CatalogItem(
            post_id=post.id,
            owner_id=post.owner_id,
            tag_ids=tuple(tags.get(post.id, ())),
            created_at=service.aware(post.created_at),
            like_count=int(post.like_count or 0),
            view_count=int(post.view_count or 0),
        )
        for post in posts
    }


def catalog(db, user_id=None, anonymous_id="anon", allowed=None, excluded=(), surface="for_you"):
    actor = actor_identity(user_id, None if user_id else anonymous_id)
    return service._catalog(
        db, actor=actor, allowed_post_ids=allowed, excluded_post_ids=set(excluded), surface=surface,
    )


def post_queries(db) -> list[str]:
    return [sql for sql in db.queries if "FROM posts" in sql or "FROM post_tags" in sql]


def test_second_catalog_reads_no_posts(db):
    first = catalog(db)
    assert list(first) == ["p7", "p6", "p5", "p4", "p3", "p2", "p1", "p0"]
    assert first["p0"].tag_ids == ("t0", "t1")
    db.queries.clear()

    assert catalog(db) == first
    assert catalog(db, anonymous_id="someone-else") == first
    assert post_queries(db) == []


def test_a_committed_change_shows_at_once_but_a_view_waits_for_the_ttl(db, monkeypatch):
    assert "p0" in catalog(db)

    db.add(Post(id="p8", owner_id="ann", media_path="8.mp4", media_type="video", created_at=START + timedelta(days=1)))
    db.commit()
    assert list(catalog(db))[0] == "p8"

    db.get(Post, "p8").deleted_at = START + timedelta(days=2)
    db.commit()
    assert "p8" not in catalog(db)

    db.get(User, "bob").status = "suspended"
    db.commit()
    assert {item.owner_id for item in catalog(db).values()} == {"ann", "cat"}

    db.get(Post, "p0").like_count = 4
    db.commit()
    assert catalog(db)["p0"].like_count == 4

    db.add(PostTag(post_id="p0", tag_id="t2"))
    db.commit()
    assert catalog(db)["p0"].tag_ids == ("t0", "t1", "t2")

    db.get(Post, "p0").view_count = 9
    db.commit()
    assert catalog(db)["p0"].view_count == 0
    monkeypatch.setitem(services._reel_records_cache, "at", -services._REEL_RECORDS_TTL - 1)
    assert catalog(db)["p0"].view_count == 9


def test_viewer_filters_stay_out_of_the_shared_catalog(db):
    everyone = catalog(db)
    db.add_all([
        UserBlock(blocker_id="dan", blocked_id="bob"),
        Follow(follower_id="cat", followee_id="ann"),
        RecommendationDismissal(
            actor_key=actor_identity(None, "anon").actor_key, anonymous_id="anon",
            target_type="post", post_id="p0", reason="not_interested",
        ),
        RecommendationDismissal(
            actor_key=actor_identity("cat", None).actor_key, user_id="cat",
            target_type="creator", creator_id="ann", reason="not_interested",
        ),
    ])
    db.commit()

    assert "p0" not in catalog(db)
    assert "p0" in catalog(db, anonymous_id="other")
    assert {item.owner_id for item in catalog(db, user_id="dan").values()} == {"ann", "cat"}
    assert {item.owner_id for item in catalog(db, user_id="bob").values()} == {"ann", "bob", "cat"}
    assert {item.owner_id for item in catalog(db, user_id="cat").values()} == {"bob", "cat"}
    assert list(catalog(db, user_id="cat", surface="following")) == ["p5", "p2"]
    assert catalog(db, surface="following") == {}
    assert list(catalog(db, anonymous_id="other", allowed={"p1", "p3"}, excluded={"p3"})) == ["p1"]
    assert catalog(db, anonymous_id="other", allowed=set()) == {}
    assert catalog(db, anonymous_id="other") == everyone


@pytest.mark.parametrize("cap", [3, 1000])
def test_catalog_matches_the_uncached_query(db, monkeypatch, cap):
    monkeypatch.setattr(service, "MAX_CATALOG_SIZE", cap)
    db.add_all([
        UserBlock(blocker_id="dan", blocked_id="ann"),
        Follow(follower_id="dan", followee_id="cat"),
        RecommendationDismissal(
            actor_key=actor_identity("dan", None).actor_key, user_id="dan",
            target_type="post", post_id="p7", reason="not_interested",
        ),
    ])
    db.commit()
    cases = [
        {},
        {"user_id": "dan"},
        {"user_id": "dan", "surface": "following"},
        {"user_id": "cat", "allowed": {"p0", "p3", "p4", "p6"}},
        {"user_id": "dan", "excluded": {"p6", "p5"}},
        {"allowed": set()},
        {"surface": "following"},
    ]
    for case in cases:
        actor = actor_identity(case.get("user_id"), None if case.get("user_id") else "anon")
        expected = old_catalog(
            db,
            actor=actor,
            allowed_post_ids=case.get("allowed"),
            excluded_post_ids=set(case.get("excluded", ())),
            surface=case.get("surface", "for_you"),
        )
        got = catalog(db, **case)
        assert list(got.items()) == list(expected.items()), case
