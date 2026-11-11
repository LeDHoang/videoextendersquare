"""reel_records keeps the viewer-independent records between requests."""

from __future__ import annotations

import copy

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from server.social import services
from server.social.database import Base
from server.social.models import Comment, CommentLike, Follow, Post, PostLike, PostSave, User, UserBlock
from server.social.services import reel_records

PATHS = ["a.mp4", "b.mp4", "missing.mp4"]


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'records.db'}")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    for name in ("ann", "bob", "cat"):
        session.add(User(id=name, username=name, username_norm=name))
    session.add(Post(id="pa", owner_id="ann", media_path="a.mp4", media_type="video"))
    session.add(Post(id="pb", owner_id="bob", media_path="b.mp4", media_type="video"))
    session.add(Comment(id="c1", post_id="pa", author_id="bob", text="from bob"))
    session.add(Comment(id="c2", post_id="pa", author_id="cat", text="from cat"))
    session.commit()
    session.queries = []
    event.listen(engine, "before_cursor_execute", lambda *args: session.queries.append(args[2]))
    yield session
    session.close()
    engine.dispose()


def test_second_anonymous_lookup_reads_nothing(db):
    first = reel_records(PATHS, db=db)
    assert list(first) == ["a.mp4", "b.mp4"]
    assert [comment["id"] for comment in first["a.mp4"]["comments"]] == ["c1", "c2"]
    db.queries.clear()

    assert reel_records(PATHS, db=db) == first
    assert reel_records(["b.mp4", "missing.mp4"], db=db) == {"b.mp4": first["b.mp4"]}
    assert db.queries == []


def test_a_committed_change_shows_at_once_but_a_view_waits_for_the_ttl(db, monkeypatch):
    assert reel_records(PATHS, db=db)["a.mp4"]["likes"] == 0
    post = db.get(Post, "pa")

    post.view_count = 7
    db.commit()
    assert reel_records(PATHS, db=db)["a.mp4"]["views"] == 0
    monkeypatch.setitem(services._reel_records_cache, "at", -services._REEL_RECORDS_TTL - 1)
    assert reel_records(PATHS, db=db)["a.mp4"]["views"] == 7

    post.like_count = 3
    db.flush()
    assert reel_records(PATHS, db=db)["a.mp4"]["likes"] == 3
    db.rollback()
    assert reel_records(PATHS, db=db)["a.mp4"]["likes"] == 0

    db.add(Comment(id="c3", post_id="pa", author_id="ann", text="new"))
    db.commit()
    assert [comment["id"] for comment in reel_records(PATHS, db=db)["a.mp4"]["comments"]] == ["c1", "c2", "c3"]


def test_a_viewer_gets_their_own_state_over_the_shared_records(db):
    db.add_all([
        PostLike(user_id="cat", post_id="pa"),
        PostSave(user_id="cat", post_id="pb"),
        Follow(follower_id="cat", followee_id="ann"),
        CommentLike(user_id="cat", comment_id="c1"),
    ])
    db.commit()
    anonymous = reel_records(PATHS, db=db)
    before = copy.deepcopy(anonymous)

    mine = reel_records(PATHS, viewer_id="cat", db=db)

    assert mine["a.mp4"]["viewer_state"] == {"liked": True, "saved": False, "following_creator": True, "can_edit": False}
    assert mine["b.mp4"]["viewer_state"] == {"liked": False, "saved": True, "following_creator": False, "can_edit": False}
    assert (mine["a.mp4"]["liked_by_me"], mine["b.mp4"]["saved_by_me"]) == (True, True)
    assert mine["a.mp4"]["creator"]["is_following"] is True
    assert [(c["id"], c["liked_by_me"], c["can_delete"]) for c in mine["a.mp4"]["comments"]] == [
        ("c1", True, False),
        ("c2", False, True),
    ]
    assert reel_records(PATHS, viewer_id="ann", db=db)["a.mp4"]["viewer_state"]["can_edit"] is True
    assert [list(record) for record in mine.values()] == [list(record) for record in anonymous.values()]
    assert reel_records(PATHS, db=db) == before


def test_a_block_hides_posts_and_comments_from_that_viewer_only(db):
    db.add(UserBlock(blocker_id="cat", blocked_id="bob"))
    db.commit()

    mine = reel_records(PATHS, viewer_id="cat", db=db)

    assert list(mine) == ["a.mp4"]
    assert [comment["id"] for comment in mine["a.mp4"]["comments"]] == ["c2"]
    assert list(reel_records(PATHS, db=db)) == ["a.mp4", "b.mp4"]
    assert len(reel_records(PATHS, viewer_id="ann", db=db)["a.mp4"]["comments"]) == 2
