from __future__ import annotations

import json
import os
import re
import threading
import uuid
from datetime import timedelta

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import joinedload, sessionmaker

from verified_signup import register_verified
from server.routers import reels, social
from server.social import auth, database, safety
from server.social.recommendations import service
from server.social.recommendations.relatedness import text_scores
from server.social.recommendations.sources import TextRelatedSource
from server.social.database import Base, get_db
from server.social.models import (
    ActorCreatorAffinity,
    ActorItemAffinity,
    CoWatchPair,
    EngagementEvent,
    Follow,
    ItemSimilarity,
    Post,
    PostRecommendationStats,
    PostTag,
    RecommendationDismissal,
    RecommendationImpression,
    RecommendationRequest,
    RecommendationSession,
    Tag,
    User,
    UserBlock,
    utcnow,
)


PASSWORD = "correct-horse-battery"
# Set to a throwaway PostgreSQL database (tables are dropped and recreated per
# test) to run the tests parametrized with the "postgres" dialect.
POSTGRES_URL = os.environ.get("SX_TEST_POSTGRES_URL", "")
BOTH_DIALECTS = pytest.mark.parametrize("app", ["sqlite", "postgres"], indirect=True)
# The `app` fixture swaps in a stub payload builder; keep the real one for wire-format tests.
_REAL_BUILD_PAYLOAD = reels._build_payload


@pytest.fixture
def app(request, tmp_path, monkeypatch):
    # SQLite unless a test opts in with BOTH_DIALECTS (indirect parametrization).
    dialect = getattr(request, "param", "sqlite")
    monkeypatch.setattr(
        auth,
        "PASSWORD_HASHER",
        PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1),
    )
    if dialect == "postgres":
        if not POSTGRES_URL:
            pytest.skip("set SX_TEST_POSTGRES_URL to run on PostgreSQL")
        test_engine = create_engine(POSTGRES_URL)
        Base.metadata.drop_all(test_engine)
    else:
        test_engine = create_engine(
            "sqlite:///" + str(tmp_path / "recommendations.db"),
            connect_args={"check_same_thread": False},
        )
    testing_session = sessionmaker(bind=test_engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(test_engine)
    # Helpers that open their own session must hit the test database too.
    monkeypatch.setattr(database, "SessionLocal", testing_session)
    monkeypatch.setattr(safety, "SessionLocal", testing_session)

    application = FastAPI()
    application.include_router(social.router)
    application.include_router(reels.router)

    def override_get_db():
        db = testing_session()
        try:
            yield db
        finally:
            db.close()

    application.dependency_overrides[get_db] = override_get_db
    application.state.testing_session = testing_session
    application.state.scan_rows = []

    monkeypatch.setattr(reels, "unavailable_media_paths_for_viewer", lambda _viewer_id, db=None: set())
    monkeypatch.setattr(reels, "_scan_cached", lambda db=None: list(application.state.scan_rows))

    def payload(items, _codec, tunnel="", viewer_id=None, db=None):
        paths = [item["rel_path"] for item in items]
        with testing_session() as db:
            posts = (
                db.query(Post)
                .options(joinedload(Post.owner))
                .filter(Post.media_path.in_(paths) if paths else False)
                .all()
            )
            by_path = {post.media_path: post for post in posts}
        result = []
        for item in items:
            post = by_path[item["rel_path"]]
            result.append(
                {
                    "post_id": post.id,
                    "path": post.media_path,
                    "url": f"/media/{post.media_path}",
                    "media_type": post.media_type,
                    "title": post.title,
                    "filename": item["filename"],
                    "folder": item["folder"],
                    "size": "1 KB",
                    "codec": "IMG",
                    "likes": post.like_count,
                    "views": post.view_count,
                    "comments": [],
                    "creator": {
                        "id": post.owner.id,
                        "username": post.owner.username,
                        "display_name": post.owner.display_name,
                    },
                    "viewer_state": {
                        "liked": False,
                        "saved": False,
                        "following_creator": False,
                        "can_edit": viewer_id == post.owner_id,
                    },
                    "tunnel_url": tunnel,
                }
            )
        return result

    monkeypatch.setattr(reels, "_build_payload", payload)
    yield application
    Base.metadata.drop_all(test_engine)
    test_engine.dispose()


def register(client: TestClient, username: str) -> dict:
    response = register_verified(client,
        json={
            "email": f"{username}@example.com",
            "username": username,
            "password": PASSWORD,
            "accept_terms": True,
            "display_name": username.title(),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]


def csrf_headers(client: TestClient) -> dict[str, str]:
    return {"x-csrf-token": client.cookies.get("echo_csrf")}


def seed_catalog(app: FastAPI, creators: int = 4, posts_per_creator: int = 3) -> list[Post]:
    scan_rows = []
    with app.state.testing_session() as db:
        tag = Tag(name="cinematic", slug="cinematic")
        db.add(tag)
        db.flush()
        posts = []
        for creator_index in range(creators):
            creator = User(
                username=f"creator_{creator_index}",
                username_norm=f"creator_{creator_index}",
                display_name=f"Creator {creator_index}",
                account_type="real",
                status="active",
            )
            db.add(creator)
            db.flush()
            for post_index in range(posts_per_creator):
                number = creator_index * posts_per_creator + post_index
                path = f"tests/reel-{number}.jpg"
                post = Post(
                    owner_id=creator.id,
                    media_path=path,
                    media_type="image",
                    title=f"Reel {number}",
                    caption="cinematic test",
                    location={},
                    source="upload",
                    status="published",
                    created_at=utcnow() - timedelta(minutes=number),
                    view_count=number * 10,
                    like_count=number,
                )
                db.add(post)
                db.flush()
                db.add(PostTag(post_id=post.id, tag_id=tag.id))
                posts.append(post)
                scan_rows.append(
                    {
                        "rel_path": path,
                        "path": f"output/{path}",
                        "filename": f"reel-{number}.jpg",
                        "folder": "tests",
                        "mtime": 1000 - number,
                        "media_type": "image",
                        "size_human": "1 KB",
                    }
                )
        db.commit()
        post_ids = [post.id for post in posts]
    app.state.scan_rows = scan_rows
    with app.state.testing_session() as db:
        return db.query(Post).filter(Post.id.in_(post_ids)).order_by(Post.created_at.desc()).all()


def test_feed_cursor_is_stable_private_and_non_repeating(app):
    seed_catalog(app)
    with TestClient(app) as client:
        first = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 4},
        )
        assert first.status_code == 200, first.text
        first_body = first.json()
        assert len(first_body["items"]) == 4
        assert first_body["next_cursor"]
        assert client.cookies.get("echo_anon")

        second = client.get(
            "/api/reels/feed",
            params={
                "folder": "ALL FOLDERS",
                "sort": "for_you",
                "limit": 4,
                "cursor": first_body["next_cursor"],
            },
        )
        retry = client.get(
            "/api/reels/feed",
            params={
                "folder": "ALL FOLDERS",
                "sort": "for_you",
                "limit": 4,
                "cursor": first_body["next_cursor"],
            },
        )
        assert second.status_code == retry.status_code == 200
        second_ids = [item["post_id"] for item in second.json()["items"]]
        assert second_ids == [item["post_id"] for item in retry.json()["items"]]
        assert set(second_ids).isdisjoint(item["post_id"] for item in first_body["items"])

        with app.state.testing_session() as db:
            assert db.query(RecommendationRequest).count() == 2
            positions = [
                row[0]
                for row in db.query(RecommendationImpression.position)
                .order_by(RecommendationImpression.position)
                .all()
            ]
            assert positions == list(range(8))

        with TestClient(app) as other_client:
            stolen = other_client.get(
                "/api/reels/feed",
                params={
                    "folder": "ALL FOLDERS",
                    "sort": "for_you",
                    "limit": 4,
                    "cursor": first_body["next_cursor"],
                },
            )
            assert stolen.status_code == 422
            assert stolen.json()["detail"]["code"] == "INVALID_CURSOR"


def test_cursor_restarts_when_algorithm_version_changes(app):
    seed_catalog(app)
    with TestClient(app) as client:
        first = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 4},
        )
        assert first.status_code == 200, first.text
        first_body = first.json()

        with app.state.testing_session() as db:
            original = db.get(RecommendationSession, first_body["session_id"])
            original.algorithm_version = "retired-algorithm"
            db.commit()

        restarted = client.get(
            "/api/reels/feed",
            params={
                "folder": "ALL FOLDERS",
                "sort": "for_you",
                "limit": 4,
                "cursor": first_body["next_cursor"],
            },
        )
        assert restarted.status_code == 200, restarted.text
        restarted_body = restarted.json()
        assert restarted_body["restarted"] is True
        assert restarted_body["session_id"] != first_body["session_id"]

        with app.state.testing_session() as db:
            original = db.get(RecommendationSession, first_body["session_id"])
            replacement = db.get(RecommendationSession, restarted_body["session_id"])
            assert original.status == "expired"
            assert replacement.restart_reason == "algorithm_version_changed"


def test_attributed_events_update_quality_affinity_and_co_watch(app):
    seed_catalog(app, creators=3, posts_per_creator=2)
    with TestClient(app) as client:
        feed = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 4},
        ).json()
        first, second = feed["items"][:2]

        visible = client.post(
            "/api/events",
            json={
                "event_type": "impression",
                "post_id": first["post_id"],
                "source": "reels",
                "client_event_id": "visible-1",
                "recommendation_impression_id": first["recommendation"]["impression_id"],
            },
        )
        duplicate = client.post(
            "/api/events",
            json={
                "event_type": "impression",
                "post_id": first["post_id"],
                "source": "reels",
                "client_event_id": "visible-1-retry",
                "recommendation_impression_id": first["recommendation"]["impression_id"],
            },
        )
        assert visible.json()["accepted"] is True
        assert duplicate.json()["accepted"] is False

        for index, item in enumerate((first, second), start=1):
            viewed = client.post(
                f"/api/posts/{item['post_id']}/view",
                json={
                    "watch_ms": 8000,
                    "foreground_ms": 8000,
                    "duration_ms": 10000,
                    "watch_ratio": 0.8,
                    "source": "reels",
                    "client_event_id": f"view-{index}",
                    "recommendation_impression_id": item["recommendation"]["impression_id"],
                    "playback_quality": {"dropped_frames": 0, "total_frames": 240},
                },
            )
            assert viewed.status_code == 200, viewed.text

        with app.state.testing_session() as db:
            event = db.query(EngagementEvent).filter(EngagementEvent.client_event_id == "view-1").one()
            assert event.recommendation_session_id == feed["session_id"]
            assert event.watch_ratio == pytest.approx(0.8)
            stats = db.get(PostRecommendationStats, first["post_id"])
            assert stats.impressions == 1
            assert stats.qualified_views == 1
            assert db.query(CoWatchPair).count() == 1
            assert db.query(ItemSimilarity).count() == 2


def test_co_watch_scores_match_support_and_viewers_in_fixed_queries(app):
    from server.social.recommendations.events import _update_co_watch

    posts = seed_catalog(app, creators=3, posts_per_creator=2)
    p0, p1, p2 = (post.id for post in posts[:3])
    with app.state.testing_session() as db:
        for actor, watched in (("a:one", (p0, p1, p2)), ("a:two", (p0, p1))):
            for post_id in watched:
                db.add(ActorItemAffinity(actor_key=actor, post_id=post_id, qualified_watches=1))
        db.flush()
        _update_co_watch(db, "a:one", p0)

        statements = []
        listener = lambda *args: statements.append(args[2])
        event.listen(db.get_bind(), "before_cursor_execute", listener)
        try:
            _update_co_watch(db, "a:two", p0)
            _update_co_watch(db, "a:one", p0)
        finally:
            event.remove(db.get_bind(), "before_cursor_execute", listener)
        db.commit()

        # Repeat views with existing rows: 5 selects plus the flushed updates,
        # never a query per pair.
        assert len(statements) <= 2 * 8, statements
        assert db.query(CoWatchPair).count() == 3
        sims = {(row.source_post_id, row.target_post_id): row for row in db.query(ItemSimilarity)}
        assert len(sims) == 4
        # (p0, p1): watched together by both actors; each post has 2 viewers.
        for key in ((p0, p1), (p1, p0)):
            assert sims[key].support == 2
            assert sims[key].score == pytest.approx(1.0 * 2 / 5)
        # (p0, p2): one actor; p0 has 2 viewers, p2 has 1.
        for key in ((p0, p2), (p2, p0)):
            assert sims[key].support == 1
            assert sims[key].score == pytest.approx((1 / 2 ** 0.5) * 1 / 4)


def test_feedback_hard_excludes_items_and_creators(app):
    posts = seed_catalog(app, creators=3, posts_per_creator=3)
    with TestClient(app) as client:
        first_feed = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 6},
        ).json()
        target = first_feed["items"][0]
        creator_id = target["creator"]["id"]
        feedback = client.post(
            "/api/recommendations/feedback",
            json={
                "action": "hide_creator",
                "post_id": target["post_id"],
                "recommendation_impression_id": target["recommendation"]["impression_id"],
                "client_event_id": "hide-creator-1",
            },
        )
        assert feedback.status_code == 200, feedback.text

        fresh = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 12},
        ).json()
        assert all(item["creator"]["id"] != creator_id for item in fresh["items"])
        with app.state.testing_session() as db:
            dismissal = db.query(RecommendationDismissal).one()
            assert dismissal.creator_id == creator_id
            assert dismissal.expires_at is None


def test_personalization_safety_and_creator_suggestions(app):
    posts = seed_catalog(app, creators=4, posts_per_creator=2)
    with TestClient(app) as client:
        viewer = register(client, "recommend_viewer")
        with app.state.testing_session() as db:
            preferred = db.get(Post, posts[-1].id)
            db.add(
                ActorCreatorAffinity(
                    actor_key=f"u:{viewer['id']}",
                    user_id=viewer["id"],
                    creator_id=preferred.owner_id,
                    score=30.0,
                )
            )
            blocked_owner = db.get(Post, posts[0].id).owner_id
            db.add(UserBlock(blocker_id=viewer["id"], blocked_id=blocked_owner))
            followed_owner = db.get(Post, posts[2].id).owner_id
            db.add(Follow(follower_id=viewer["id"], followee_id=followed_owner))
            db.commit()

        feed = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 8},
        )
        assert feed.status_code == 200, feed.text
        items = feed.json()["items"]
        assert items[0]["creator"]["id"] == preferred.owner_id
        assert all(item["creator"]["id"] != blocked_owner for item in items)

        creators = client.get("/api/recommendations/creators", params={"limit": 8})
        assert creators.status_code == 200, creators.text
        creator_ids = {item["creator"]["id"] for item in creators.json()["items"]}
        assert viewer["id"] not in creator_ids
        assert followed_owner not in creator_ids
        assert blocked_owner not in creator_ids
        assert all(item["recommendation"]["impression_id"] for item in creators.json()["items"])


def test_inline_player_bootstraps_only_first_page_and_preserves_anonymous_cookie(app):
    seed_catalog(app, creators=5, posts_per_creator=4)
    with TestClient(app) as client:
        response = client.get(
            "/api/reels/player-inline",
            params={"folder": "ALL FOLDERS", "sort": "for_you"},
        )
        assert response.status_code == 200, response.text
        body = response.json()

        assert body["count"] == 12
        assert body["feed"]["has_more"] is True
        assert body["feed"]["next_cursor"]
        assert client.cookies.get("echo_anon")

        init_script = body["scripts"][-1]
        items_match = re.search(
            r"let videoData = (.*?);\n\s*const initialFeedState =",
            init_script,
            re.S,
        )
        state_match = re.search(
            r"const initialFeedState = (.*?);\n\s*const FeedState =",
            init_script,
            re.S,
        )
        assert items_match
        assert state_match
        bootstrap_items = json.loads(items_match.group(1))
        bootstrap_state = json.loads(state_match.group(1))
        assert len(bootstrap_items) == 12
        assert bootstrap_state["items"] == bootstrap_items
        assert bootstrap_state["next_cursor"] == body["feed"]["next_cursor"]
        assert bootstrap_state["feed_params"]["limit"] == 12

        with app.state.testing_session() as db:
            assert db.query(RecommendationRequest).count() == 1
            assert db.query(RecommendationImpression).count() == 12


def test_materialized_creator_page_reapplies_hard_exclusions(app):
    seed_catalog(app, creators=5, posts_per_creator=1)
    with TestClient(app) as client:
        first = client.get("/api/recommendations/creators", params={"limit": 2})
        assert first.status_code == 200, first.text
        cursor = first.json()["next_cursor"]
        assert cursor

        second = client.get(
            "/api/recommendations/creators",
            params={"limit": 2, "cursor": cursor},
        )
        assert second.status_code == 200, second.text
        target = second.json()["items"][0]

        dismissed = client.post(
            "/api/recommendations/feedback",
            json={
                "action": "dismiss_creator",
                "creator_id": target["creator"]["id"],
                "recommendation_impression_id": target["recommendation"]["impression_id"],
                "client_event_id": "dismiss-materialized-creator",
            },
        )
        assert dismissed.status_code == 200, dismissed.text

        retried = client.get(
            "/api/recommendations/creators",
            params={"limit": 2, "cursor": cursor},
        )
        assert retried.status_code == 200, retried.text
        assert target["creator"]["id"] not in {
            item["creator"]["id"] for item in retried.json()["items"]
        }


@BOTH_DIALECTS
def test_concurrent_page_materialization_replays_winner(app):
    """Same unmaterialized cursor from N threads: all succeed, identical page."""
    from server.social.recommendations import actor_identity, get_reel_page

    seed_catalog(app, creators=3, posts_per_creator=3)
    with app.state.testing_session() as db:
        page0 = get_reel_page(
            db,
            actor=actor_identity(None, "race-probe"),
            surface="for_you",
            filters={"folder": "ALL FOLDERS", "limit": 3},
            cursor=None,
            limit=3,
        )
    cursor = page0.next_cursor
    assert cursor

    results, errors = [], []

    def worker():
        db = app.state.testing_session()
        try:
            page = get_reel_page(
                db,
                actor=actor_identity(None, "race-probe"),
                surface="for_you",
                filters={"folder": "ALL FOLDERS", "limit": 3},
                cursor=cursor,
                limit=3,
            )
            results.append(tuple(item.target_id for item in page.items))
        except Exception as exc:  # noqa: BLE001 — collected, asserted below
            errors.append(repr(exc))
        finally:
            db.close()

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert not errors, errors
    assert len(results) == 5
    assert all(page_ids == results[0] for page_ids in results)


@BOTH_DIALECTS
def test_concurrent_affinity_upsert_dedupes(app):
    """Simultaneous view+like style writers create exactly one affinity row."""
    from server.social.models import ActorCreatorAffinity
    from server.social.recommendations.events import get_or_create

    # A real creator: PostgreSQL enforces the creator_id foreign key (SQLite does not).
    creator_id = seed_catalog(app, creators=2, posts_per_creator=1)[0].owner_id
    errors = []

    def worker():
        db = app.state.testing_session()
        try:
            row = get_or_create(
                db,
                ActorCreatorAffinity,
                ActorCreatorAffinity.actor_key == "u:race-affinity",
                ActorCreatorAffinity.creator_id == creator_id,
                actor_key="u:race-affinity",
                creator_id=creator_id,
            )
            row.score = float(row.score or 0.0) + 1.0
            db.commit()
        except Exception as exc:  # noqa: BLE001
            errors.append(repr(exc))
        finally:
            db.close()

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert not errors, errors
    with app.state.testing_session() as db:
        count = (
            db.query(ActorCreatorAffinity)
            .filter(
                ActorCreatorAffinity.actor_key == "u:race-affinity",
                ActorCreatorAffinity.creator_id == creator_id,
            )
            .count()
        )
        assert count == 1


def test_double_feedback_does_not_duplicate_dismissal(app):
    seed_catalog(app, creators=2, posts_per_creator=2)
    with TestClient(app) as client:
        feed = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 4},
        ).json()
        target = feed["items"][0]
        for index in range(2):
            response = client.post(
                "/api/recommendations/feedback",
                json={
                    "action": "not_interested",
                    "post_id": target["post_id"],
                    "recommendation_impression_id": target["recommendation"]["impression_id"],
                    "client_event_id": f"double-feedback-{index}",
                },
            )
            assert response.status_code == 200, response.text
        with app.state.testing_session() as db:
            count = (
                db.query(RecommendationDismissal)
                .filter(RecommendationDismissal.target_type == "post")
                .count()
            )
            assert count == 1


def test_recommendation_endpoints_are_rate_limited(app):
    seed_catalog(app)
    with TestClient(app) as client:
        last = None
        for _ in range(61):
            last = client.get("/api/reels/feed", params={"limit": 1})
        assert last.status_code == 429, last.text

        creators_last = None
        # Fresh client would share the same IP limiter; use creators budget
        # on the same client — 60 allowed, 61st rejected.
        for _ in range(61):
            creators_last = client.get("/api/recommendations/creators", params={"limit": 1})
        assert creators_last.status_code == 429, creators_last.text


def test_feedback_endpoint_is_rate_limited(app):
    posts = seed_catalog(app, creators=2, posts_per_creator=1)
    creator_id = posts[0].owner_id
    with TestClient(app) as client:
        last = None
        for index in range(31):
            last = client.post(
                "/api/recommendations/feedback",
                json={
                    "action": "dismiss_creator",
                    "creator_id": creator_id,
                    "client_event_id": f"rate-limit-feedback-{index}",
                },
            )
        assert last.status_code == 429, last.text


def test_stale_attribution_fails_open_on_like(app):
    posts = seed_catalog(app, creators=2, posts_per_creator=1)
    with TestClient(app) as client:
        viewer = register(client, "failopen_viewer")
        response = client.put(
            f"/api/posts/{posts[0].id}/like",
            headers={
                **csrf_headers(client),
                "x-recommendation-impression-id": "00000000-0000-0000-0000-000000000000",
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["liked"] is True
        with app.state.testing_session() as db:
            event = (
                db.query(EngagementEvent)
                .filter(
                    EngagementEvent.user_id == viewer["id"],
                    EngagementEvent.event_type == "like",
                    EngagementEvent.post_id == posts[0].id,
                )
                .one()
            )
            assert event.recommendation_impression_id is None


def test_limit_change_restarts_feed_instead_of_422(app):
    seed_catalog(app, creators=3, posts_per_creator=3)
    with TestClient(app) as client:
        first = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 4},
        )
        assert first.status_code == 200, first.text
        cursor = first.json()["next_cursor"]
        assert cursor
        changed = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 8, "cursor": cursor},
        )
        assert changed.status_code == 200, changed.text
        body = changed.json()
        assert body["restarted"] is True
        assert body["session_id"] != first.json()["session_id"]


def test_expired_sessions_and_dismissals_are_purged(app):
    from server.social.models import RecommendationDismissal, RecommendationSession
    from server.social.recommendations import actor_identity, get_reel_page

    posts = seed_catalog(app, creators=2, posts_per_creator=1)
    actor = actor_identity(None, "janitor-probe")
    with app.state.testing_session() as db:
        first = get_reel_page(
            db, actor=actor, surface="for_you",
            filters={"folder": "ALL FOLDERS", "limit": 2},
            cursor=None, limit=2,
        )
        assert first.items
        # Age a second session for the SAME actor so the next new session
        # (triggered by a filter change) purges it.
        stale = RecommendationSession(
            actor_key=actor.actor_key,
            surface="for_you",
            filter_hash="x",
            filters={},
            algorithm_version="reels-heuristic-v1",
            status="active",
            created_at=utcnow() - timedelta(hours=7),
            last_accessed_at=utcnow() - timedelta(hours=7),
            expires_at=utcnow() - timedelta(hours=1),
        )
        db.add(stale)
        db.flush()
        expired_dismissal = RecommendationDismissal(
            actor_key=actor.actor_key,
            target_type="post",
            post_id=posts[0].id,
            reason="not_interested",
            created_at=utcnow() - timedelta(days=100),
            expires_at=utcnow() - timedelta(days=10),
        )
        db.add(expired_dismissal)
        db.commit()
        stale_session_id = stale.id
    with app.state.testing_session() as db:
        # Different limit => different filter_hash => fresh session + purge.
        second = get_reel_page(
            db, actor=actor, surface="for_you",
            filters={"folder": "ALL FOLDERS", "limit": 3},
            cursor=None, limit=3,
        )
        assert second.items
    with app.state.testing_session() as db:
        assert db.get(RecommendationSession, stale_session_id) is None
        remaining = (
            db.query(RecommendationDismissal)
            .filter(RecommendationDismissal.actor_key == actor.actor_key)
            .count()
        )
        assert remaining == 0


# --- player-inline wire format: CSS scoping and keyboard wiring ---------------------------------


def test_scope_css_passes_keyframes_through_and_scopes_the_rest():
    css = """
    html, body { margin:0 }
    .a, .b { color:red; }
    @keyframes slideUpTicker { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; } }
    @media (max-width:480px) { .a { color:blue; } }
    @keyframes commentPulse { from { box-shadow: 0 0 0 1px #f00; } to { box-shadow: 0 0 9px #f00; } }
    """
    out = reels._scope_css(css)
    assert "#sxReelsRoot .a, #sxReelsRoot .b { color:red; }" in out
    assert "@media (max-width:480px) { #sxReelsRoot .a { color:blue; } }" in out
    # keyframes survive verbatim and their from/to steps are never treated as selectors
    assert "@keyframes slideUpTicker { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; } }" in out
    assert "@keyframes commentPulse" in out
    assert not re.search(r"#sxReelsRoot (from|to)\b", out)
    assert "margin:0" not in out  # html/body rules are still dropped


def test_player_css_keeps_the_ticker_and_comment_animations():
    html = (reels.ASSETS_DIR / "reels.html").read_text(encoding="utf-8")
    scoped = reels._scope_css(re.search(r"<style>(.*?)</style>", html, re.S).group(1))
    for name in ("slideUpTicker", "commentPulse"):
        assert f"@keyframes {name}" in scoped
        assert f"animation: {name}" in scoped
    assert not re.search(r"#sxReelsRoot (from|to)\b", scoped)


def test_inline_player_attaches_the_keyboard_handler_instead_of_orphaning_it(app):
    seed_catalog(app, creators=2, posts_per_creator=2)
    with TestClient(app) as client:
        body = client.get("/api/reels/player-inline", params={"folder": "ALL FOLDERS"}).json()
    init_script = body["scripts"][-1]
    # regression: the listener used to be rewritten into a bare assignment that nothing attached
    assert "window.__sxReelsKeydown = (e) => {" not in init_script
    assert "window.addEventListener('keydown', onKeydown);" in init_script
    assert "window.__sxReelsKeydown = onKeydown;" in init_script
    # and SPA teardown still detaches it
    assert "window.removeEventListener('keydown', window.__sxReelsKeydown);" in init_script


def test_inline_player_starts_on_a_deep_linked_file_that_has_no_post(app, monkeypatch):
    seed_catalog(app, creators=1, posts_per_creator=1)
    postless = {
        "rel_path": "tests/postless.jpg",
        "path": "output/tests/postless.jpg",
        "filename": "postless.jpg",
        "folder": "tests",
        "mtime": 2000,
        "media_type": "image",
        "size_human": "1 KB",
    }
    app.state.scan_rows = [postless, *app.state.scan_rows]
    stub = reels._build_payload

    def payload(items, codec, tunnel="", viewer_id=None, db=None):
        posted = [item for item in items if item is not postless]
        result = stub(posted, codec, tunnel=tunnel, viewer_id=viewer_id, db=db)
        if any(item is postless for item in items):
            result.insert(0, {"post_id": None, "path": postless["rel_path"], "filename": postless["filename"]})
        return result

    monkeypatch.setattr(reels, "_build_payload", payload)
    with TestClient(app) as client:
        # The page found the file at index 1 of /api/reels and used to send that as `start`.
        body = client.get(
            "/api/reels/player-inline",
            params={"folder": "ALL FOLDERS", "play": postless["rel_path"], "start": 1},
        ).json()
    init_script = body["scripts"][-1]
    items = json.loads(re.search(r"let videoData = (.*?);\n\s*const initialFeedState =", init_script, re.S).group(1))
    start = int(re.search(r"loadVideo\((\d+)\);", init_script).group(1))
    assert items[start]["path"] == postless["rel_path"]


def test_inline_player_items_carry_probed_duration_and_resolution(app, monkeypatch):
    posts = seed_catalog(app, creators=2, posts_per_creator=2)
    with app.state.testing_session() as db:
        probed = db.get(Post, posts[0].id)
        probed.duration_ms, probed.width, probed.height = 14000, 1920, 1080
        db.commit()
    # Run the real payload builder (and reel_records) against the test database.
    monkeypatch.setattr(reels, "_build_payload", _REAL_BUILD_PAYLOAD)
    monkeypatch.setattr("server.social.database.SessionLocal", app.state.testing_session)
    with TestClient(app) as client:
        body = client.get("/api/reels/player-inline", params={"folder": "ALL FOLDERS"}).json()
    match = re.search(r"let videoData = (.*?);\n\s*const initialFeedState =", body["scripts"][-1], re.S)
    items = {item["post_id"]: item for item in json.loads(match.group(1))}
    probed_item = items[posts[0].id]
    assert (probed_item["duration_ms"], probed_item["width"], probed_item["height"]) == (14000, 1920, 1080)
    # an unprobed reel reports null rather than a made-up number
    other = items[posts[1].id]
    assert other["duration_ms"] is None and other["width"] is None and other["height"] is None
    # sanity: this really is the real builder (it carries the caption/tags the stub omits)
    assert "caption" in probed_item and "tags" in probed_item


def test_every_player_selector_is_scoped_to_the_embed_root():
    """The SPA embed must never restyle the host app: each selector from reels.html has to come out
    prefixed with #sxReelsRoot (the naive scoper silently mis-handles some constructs)."""
    html = (reels.ASSETS_DIR / "reels.html").read_text(encoding="utf-8")
    scoped = reels._scope_css(re.search(r"<style>(.*?)</style>", html, re.S).group(1))
    rules, depth, current = [], 0, ""
    for char in scoped:
        current += char
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                rules.append(current.strip())
                current = ""
    assert len(rules) > 200
    leaks = []
    for rule in rules:
        selector = rule.split("{", 1)[0].strip()
        if selector.startswith("@"):
            continue
        leaks += [part.strip() for part in selector.split(",") if not part.strip().startswith("#sxReelsRoot")]
    assert leaks == []
    # the docked-column rules in particular must have survived scoping
    assert "#sxReelsRoot #sxReelsHost.sx-reels-docked #commentsDrawer" in scoped
    assert "#sxReelsRoot .reels-side-inner" in scoped


def test_a_reel_opened_from_a_creator_plays_that_creator_first(app):
    posts = seed_catalog(app, creators=3, posts_per_creator=3)
    with app.state.testing_session() as db:
        creator = db.query(User).filter(User.username == "creator_1").one()
        own = [post.id for post in posts if post.owner_id == creator.id]
    # Newest first: own[1] is the middle reel of the creator's three.
    with TestClient(app) as client:
        body = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "newest", "author": "creator_1", "post": own[1], "limit": 12},
        ).json()
    ids = [item["post_id"] for item in body["items"]]
    assert ids[:3] == [own[1], own[2], own[0]]
    assert len(ids) == 9 and set(ids[3:]).isdisjoint(own)



def test_after_the_creator_the_reels_related_to_the_opened_one_come_next(app):
    posts = seed_catalog(app, creators=3, posts_per_creator=3)
    with app.state.testing_session() as db:
        creator = db.query(User).filter(User.username == "creator_1").one()
        own = [post.id for post in posts if post.owner_id == creator.id]
        # posts[7] is an older reel of another creator; it shares a tag with the opened reel.
        neon = Tag(name="neon", slug="neon")
        db.add(neon)
        db.flush()
        db.add_all([PostTag(post_id=post_id, tag_id=neon.id) for post_id in (own[1], posts[7].id)])
        db.commit()
    with TestClient(app) as client:
        body = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "newest", "author": "creator_1", "post": own[1], "limit": 12},
        ).json()
    ids = [item["post_id"] for item in body["items"]]
    assert ids[:3] == [own[1], own[2], own[0]]
    assert ids[3] == posts[7].id

def test_a_reel_opened_from_a_tag_plays_that_tag_first(app):
    posts = seed_catalog(app, creators=3, posts_per_creator=3)
    tagged = [posts[1].id, posts[4].id, posts[7].id, posts[8].id]
    with app.state.testing_session() as db:
        neon = Tag(name="neon", slug="neon")
        db.add(neon)
        db.flush()
        db.add_all([PostTag(post_id=post_id, tag_id=neon.id) for post_id in tagged])
        db.commit()
    with TestClient(app) as client:
        body = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "newest", "tag": "neon", "post": tagged[2], "limit": 12},
        ).json()
    ids = [item["post_id"] for item in body["items"]]
    assert ids[:4] == [tagged[2], tagged[3], tagged[0], tagged[1]]
    assert len(ids) == 9


def test_feed_scope_ids_plays_given_order_then_related(app):
    posts = seed_catalog(app, creators=4, posts_per_creator=3)
    scope = [posts[5].id, posts[9].id, posts[1].id, posts[11].id]
    params = {
        "folder": "ALL FOLDERS", "post": posts[5].id, "scope_ids": ",".join(scope), "limit": 6,
    }
    with TestClient(app) as client:
        first = client.get("/api/reels/feed", params=params)
        assert first.status_code == 200, first.text
        body = first.json()
        ids = [item["post_id"] for item in body["items"]]
        assert ids[:4] == scope
        assert set(ids[4:]).isdisjoint(scope)
        assert all(item["recommendation"]["impression_id"] for item in body["items"])
        seen = list(ids)
        while body["has_more"]:
            body = client.get("/api/reels/feed", params={**params, "cursor": body["next_cursor"]}).json()
            seen.extend(item["post_id"] for item in body["items"])
    assert len(seen) == len(set(seen)) == 12


def test_feed_scope_ids_drops_junk(app, monkeypatch):
    posts = seed_catalog(app, creators=4, posts_per_creator=3)
    hidden = posts[7]
    with app.state.testing_session() as db:
        db.get(Post, hidden.id).status = "draft"
        db.commit()
    monkeypatch.setattr(reels, "unavailable_media_paths_for_viewer", safety.unavailable_media_paths_for_viewer)
    junk = ["nope", hidden.id, posts[2].id, posts[2].id, ""] + [str(uuid.uuid4()) for _ in range(250)]
    with TestClient(app) as client:
        response = client.get(
            "/api/reels/feed",
            params={
                "folder": "ALL FOLDERS", "post": posts[4].id, "scope_ids": ",".join(junk), "limit": 12,
            },
        )
    assert response.status_code == 200, response.text
    ids = [item["post_id"] for item in response.json()["items"]]
    assert ids[:2] == [posts[4].id, posts[2].id]
    assert hidden.id not in ids


def test_a_reel_opened_without_a_scope_still_gets_related_reels(app):
    posts = seed_catalog(app, creators=2, posts_per_creator=2)
    with TestClient(app) as client:
        body = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "newest", "post": posts[2].id, "limit": 12},
        ).json()
    ids = [item["post_id"] for item in body["items"]]
    assert ids[0] == posts[2].id and len(ids) == 4


def test_dm_share_records_share_sent_and_moves_affinity(app, monkeypatch):
    from server.routers import messages

    monkeypatch.setenv("SX_MESSAGE_ENCRYPTION_KEY", "test-only-message-key-with-at-least-32-chars")
    app.include_router(messages.router)
    post = seed_catalog(app, creators=1, posts_per_creator=1)[0]
    with TestClient(app) as sender_client, TestClient(app) as recipient_client:
        sender = register(sender_client, "dm_sender")
        recipient = register(recipient_client, "dm_recipient")
        shared = sender_client.post(
            "/api/messages/share-content",
            headers=csrf_headers(sender_client),
            json={
                "kind": "reel",
                "target_id": post.id,
                "usernames": [recipient["username"]],
                "note": "",
                "client_id": "dm-share-t1",
            },
        )
        assert shared.status_code == 200, shared.text
        assert shared.json()["succeeded"] == 1

    actor_key = f"u:{sender['id']}"
    with app.state.testing_session() as db:
        events = db.query(EngagementEvent).filter(EngagementEvent.post_id == post.id).all()
        assert [event.event_type for event in events] == ["share_sent"]
        assert events[0].source == "messages"
        item = db.query(ActorItemAffinity).filter_by(actor_key=actor_key, post_id=post.id).one()
        creator = db.query(ActorCreatorAffinity).filter_by(
            actor_key=actor_key, creator_id=post.owner_id
        ).one()
        assert item.score > 0
        assert creator.score > 0


def test_replay_event_counts_once_per_impression(app):
    seed_catalog(app, creators=3, posts_per_creator=2)
    with TestClient(app) as client:
        viewer = register(client, "replay_viewer")
        feed = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 4},
        ).json()
        item = feed["items"][0]
        actor_key = f"u:{viewer['id']}"

        def score() -> float:
            with app.state.testing_session() as db:
                row = db.query(ActorItemAffinity).filter_by(
                    actor_key=actor_key, post_id=item["post_id"]
                ).first()
                return row.score if row else 0.0

        before = score()
        scores = []
        for index in range(2):
            response = client.post(
                "/api/events",
                headers=csrf_headers(client),
                json={
                    "event_type": "replay",
                    "post_id": item["post_id"],
                    "source": "reels",
                    "client_event_id": f"replay-{index}",
                    "recommendation_impression_id": item["recommendation"]["impression_id"],
                },
            )
            assert 200 <= response.status_code < 300, response.text
            scores.append(score())
        assert scores[0] > before
        assert scores[1] == scores[0]


def test_session_context_counts_unattributed_likes(app):
    posts = seed_catalog(app, creators=4, posts_per_creator=3)
    with TestClient(app) as client:
        viewer = register(client, "unattributed_viewer")
        feed = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 2},
        )
        assert feed.status_code == 200, feed.text
        session_id = feed.json()["session_id"]
        with app.state.testing_session() as db:
            owners = {
                row.username: row.id
                for row in db.query(User).filter(User.username.in_(["creator_2", "creator_3"]))
            }
        target = next(post for post in posts if post.owner_id == owners["creator_3"])
        other = next(post for post in posts if post.owner_id == owners["creator_2"])
        liked = client.put(f"/api/posts/{target.id}/like", headers=csrf_headers(client))
        assert liked.status_code == 200, liked.text

        actor = service.actor_identity(viewer["id"], None)

        def context():
            with app.state.testing_session() as db:
                session = db.get(RecommendationSession, session_id)
                return service._pipeline_context(
                    db,
                    actor=actor,
                    session=session,
                    surface=session.surface,
                    seed_post_id=None,
                    allowed_post_ids=None,
                    manual_order=None,
                )

        assert context().session_creator_affinity[owners["creator_3"]] == 2.0

        with app.state.testing_session() as db:
            other_session = service._new_session(
                db,
                actor=actor,
                surface="for_you",
                seed_post_id=None,
                filters={"other": True},
                algorithm_version="test",
            )
            db.add(
                EngagementEvent(
                    event_type="like",
                    user_id=viewer["id"],
                    post_id=other.id,
                    recommendation_session_id=other_session.id,
                    source="reels",
                    client_event_id="other-session-like",
                )
            )
            db.commit()
        assert owners["creator_2"] not in context().session_creator_affinity


def test_catalog_base_carries_text_and_location(app):
    posts = seed_catalog(app, creators=1, posts_per_creator=2)
    with app.state.testing_session() as db:
        first = db.get(Post, posts[0].id)
        first.title = "Sunset ride"
        first.caption = "#motorbike over Hanoi"
        # Hanoi is not in CITY_COORDS, so the reel carries its own lat/lon.
        first.location = {"city": "Hanoi", "country": "Vietnam", "lat": 21.0285, "lon": 105.8542}
        db.commit()
        service._catalog_base_cache["entry"] = (None, ())
        items = {item.post_id: item for item in service._catalog_base(db)}
    item = items[posts[0].id]
    assert {"sunset", "ride", "motorbike", "hanoi"} <= set(item.text_tokens)
    assert item.location.slug == "hanoi--vietnam"
    assert item.location.coords == (21.0285, 105.8542)
    assert items[posts[1].id].location is None


def test_text_related_works_on_page_two_when_seed_was_delivered(app):
    posts = seed_catalog(app, creators=3, posts_per_creator=3)
    captions = [
        "saigon night market neon", "night market neon lights", "night market food stalls",
        "mountain hiking sunrise", "coffee brewing morning", "guitar practice session",
        "beach volleyball summer", "city skyline timelapse", "forest waterfall drone",
    ]
    with app.state.testing_session() as db:
        for post, caption in zip(posts, captions):
            db.get(Post, post.id).caption = caption
            db.get(Post, post.id).title = ""
        db.commit()
        service._catalog_base_cache["entry"] = (None, ())
    seed = posts[0]
    with TestClient(app) as client:
        viewer = register(client, "text_viewer")
        params = {"folder": "ALL FOLDERS", "sort": "newest", "post": seed.id, "limit": 2}
        first = client.get("/api/reels/feed", params=params)
        assert first.status_code == 200, first.text
        body = first.json()
        assert body["items"][0]["post_id"] == seed.id and body["next_cursor"]
        second = client.get("/api/reels/feed", params={**params, "cursor": body["next_cursor"]})
        assert second.status_code == 200, second.text
        actor = service.actor_identity(viewer["id"], None)
        with app.state.testing_session() as db:
            session = db.get(RecommendationSession, body["session_id"])
            context = service._pipeline_context(
                db,
                actor=actor,
                session=session,
                surface="related",
                seed_post_id=seed.id,
                allowed_post_ids=None,
                manual_order=None,
            )
    assert seed.id not in context.items
    assert [item.post_id for item, _ in context.seed_items] == [seed.id]
    # Scored against the whole catalog, whichever reels page 0 happened to deliver.
    with app.state.testing_session() as db:
        full = text_scores(list(context.seed_items), service._catalog_index(db), service._catalog_idf(db))
    assert seed.id not in full
    for post in posts[1:3]:
        assert full[post.id][1] == (seed.id,) and full[post.id][0] > 0
    assert posts[3].id not in full
    # The pipeline's own scores are that same result restricted to undelivered reels.
    assert context.text_scores == {k: v for k, v in full.items() if k in context.items}
    hits = {post_id: hit for post_id, hit in TextRelatedSource().generate(context)}
    assert set(hits) == set(context.text_scores) & set(context.items)
    assert all(hit.source == "text_related" and hit.seed_post_ids == (seed.id,) for hit in hits.values())


def _seed_creator_heavy_catalog(app, extra=5, creators=4):
    """Creator X (creator_0) with 7 reels, three other creators with 2 reels each."""
    posts = seed_catalog(app, creators=creators, posts_per_creator=2)
    with app.state.testing_session() as db:
        creator = db.query(User).filter(User.username == "creator_0").one()
        tag = db.query(Tag).filter(Tag.slug == "cinematic").one()
        extra_ids = []
        for number in range(100, 100 + extra):
            path = f"tests/reel-{number}.jpg"
            post = Post(
                owner_id=creator.id,
                media_path=path,
                media_type="image",
                title=f"Reel {number}",
                caption="cinematic test",
                location={},
                source="upload",
                status="published",
                created_at=utcnow() - timedelta(minutes=number),
                view_count=number,
                like_count=1,
            )
            db.add(post)
            db.flush()
            db.add(PostTag(post_id=post.id, tag_id=tag.id))
            extra_ids.append(post.id)
            app.state.scan_rows.append(
                {
                    "rel_path": path,
                    "path": f"output/{path}",
                    "filename": f"reel-{number}.jpg",
                    "folder": "tests",
                    "mtime": 1000 - number,
                    "media_type": "image",
                    "size_human": "1 KB",
                }
            )
        db.commit()
        owner_of = {post.id: post.owner_id for post in db.query(Post).all()}
    newest = max(
        (post for post in posts if post.owner_id == creator.id), key=lambda post: post.created_at
    )
    return creator.id, newest.id, owner_of


def test_related_page_spreads_creator_other_reels(app):
    creator_id, seed_id, owner_of = _seed_creator_heavy_catalog(app)
    with TestClient(app) as client:
        viewer = register(client, "spread_viewer")
        with app.state.testing_session() as db:
            db.add(
                ActorCreatorAffinity(
                    actor_key=f"u:{viewer['id']}",
                    user_id=viewer["id"],
                    creator_id=creator_id,
                    score=60.0,
                )
            )
            db.commit()
        related = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "newest", "post": seed_id, "limit": 8},
        )
        assert related.status_code == 200, related.text
        body = related.json()
        ids = [item["post_id"] for item in body["items"]]
        assert ids[0] == seed_id
        owners = [owner_of[post_id] for post_id in ids]
        x_count = owners.count(creator_id)
        assert x_count > 3, owners
        assert any(owner != creator_id for owner in owners)
        back_to_back = sum(1 for a, b in zip(owners, owners[1:]) if a == b == creator_id)
        assert back_to_back < x_count - 1, owners
        with app.state.testing_session() as db:
            impressions = (
                db.query(RecommendationImpression)
                .filter(RecommendationImpression.session_id == body["session_id"])
                .all()
            )
        assert any(
            owner_of[row.post_id] == creator_id
            and any(source["name"] == "creator_other_reels" for source in row.provenance["sources"])
            for row in impressions
            if row.post_id != seed_id
        )
        # Guard: no seed on for_you keeps the hard cap of 3 per creator.
        feed = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 8},
        )
        assert feed.status_code == 200, feed.text
        feed_owners = [owner_of[item["post_id"]] for item in feed.json()["items"]]
        assert max(feed_owners.count(owner) for owner in set(feed_owners)) <= 3, feed_owners


def test_algorithm_version_bump_restarts_session(app):
    seed_catalog(app)
    with TestClient(app) as client:
        first = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 4},
        )
        assert first.status_code == 200, first.text
        first_body = first.json()
        with app.state.testing_session() as db:
            db.get(RecommendationSession, first_body["session_id"]).algorithm_version = "reels-heuristic-v1"
            db.commit()
        second = client.get(
            "/api/reels/feed",
            params={
                "folder": "ALL FOLDERS",
                "sort": "for_you",
                "limit": 4,
                "cursor": first_body["next_cursor"],
            },
        )
        assert second.status_code == 200, second.text
        assert second.json()["restarted"] is True
        with app.state.testing_session() as db:
            replacement = db.get(RecommendationSession, second.json()["session_id"])
            assert replacement.restart_reason == "algorithm_version_changed"


def test_related_later_pages_keep_seed_creator_uncapped(app):
    creator_id, seed_id, owner_of = _seed_creator_heavy_catalog(app, extra=16, creators=9)
    with TestClient(app) as client:
        viewer = register(client, "later_viewer")
        with app.state.testing_session() as db:
            for post in db.query(Post).filter(Post.owner_id == creator_id):
                post.like_count, post.view_count = 5000, 50000
            service._catalog_base_cache["entry"] = (None, ())
            db.add(
                ActorCreatorAffinity(
                    actor_key=f"u:{viewer['id']}",
                    user_id=viewer["id"],
                    creator_id=creator_id,
                    score=60.0,
                )
            )
            db.commit()
        params = {"folder": "ALL FOLDERS", "sort": "newest", "post": seed_id, "limit": 8}
        first = client.get("/api/reels/feed", params=params)
        assert first.status_code == 200, first.text
        second = client.get("/api/reels/feed", params={**params, "cursor": first.json()["next_cursor"]})
        assert second.status_code == 200, second.text
        owners = [owner_of[item["post_id"]] for item in second.json()["items"]]
        assert second.json()["items"] and owners.count(creator_id) > 3, ["X" if o == creator_id else "o" for o in owners]
        feed = client.get(
            "/api/reels/feed", params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": 8}
        )
        feed_owners = [owner_of[item["post_id"]] for item in feed.json()["items"]]
        assert max(feed_owners.count(owner) for owner in set(feed_owners)) <= 3, feed_owners


def test_catalog_extras_survive_cap_and_replay(app, monkeypatch):
    from server.social.recommendations import actor_identity, get_reel_page

    posts = seed_catalog(app, creators=2, posts_per_creator=3)
    oldest_id = min(posts, key=lambda post: post.created_at).id
    with app.state.testing_session() as db:
        oldest = db.get(Post, oldest_id)
        oldest.view_count = oldest.like_count = 0  # seeded engagement grows with age; make it weakest
        db.commit()
    monkeypatch.setattr(service, "MAX_CATALOG_SIZE", 3)
    service._catalog_base_cache["entry"] = (None, ())
    actor = actor_identity(None, "extras-probe")
    kwargs = dict(actor=actor, allowed_post_ids=None, excluded_post_ids=set(), surface="for_you")
    with app.state.testing_session() as db:
        capped = service._catalog(db, **kwargs)
        assert len(capped) == 3 and oldest_id not in capped
        with_extra = service._catalog(db, **kwargs, extra_post_ids=frozenset({oldest_id}))
        assert set(with_extra) == set(capped) | {oldest_id}
        assert len(service._catalog(db, **kwargs, capped=False)) == 6

        filters = {"folder": "ALL FOLDERS", "limit": 1}
        recorded, cursor, page_cursor = [], None, None
        while True:
            page = get_reel_page(
                db, actor=actor, surface="for_you", filters=filters, cursor=cursor,
                limit=1, extra_post_ids=frozenset({oldest_id}),
            )
            recorded.append((page_cursor, tuple(item.target_id for item in page.items)))
            if not page.has_more:
                break
            page_cursor = cursor = page.next_cursor
        extra_page = next(i for i, (_, ids) in enumerate(recorded) if oldest_id in ids)
        assert extra_page > 0

        for page_cursor, ids in recorded[1:]:
            replay = get_reel_page(
                db, actor=actor, surface="for_you", filters=filters, cursor=page_cursor, limit=1
            )
            assert tuple(item.target_id for item in replay.items) == ids


def test_tag_feed_keeps_set_and_orders_by_affinity(app, monkeypatch):
    posts = seed_catalog(app, creators=4, posts_per_creator=3)
    tagged_ids = {post.id for post in posts}
    oldest_owner = min(posts, key=lambda post: post.created_at).owner_id
    with app.state.testing_session() as db:
        for number in (12, 13):
            path = f"tests/reel-{number}.jpg"
            db.add(
                Post(
                    owner_id=oldest_owner,
                    media_path=path,
                    media_type="image",
                    title=f"Reel {number}",
                    caption="plain",
                    location={},
                    source="upload",
                    status="published",
                    created_at=utcnow() - timedelta(minutes=number),
                )
            )
            app.state.scan_rows.append(
                {
                    "rel_path": path,
                    "path": f"output/{path}",
                    "filename": f"reel-{number}.jpg",
                    "folder": "tests",
                    "mtime": 1000 - number,
                    "media_type": "image",
                    "size_human": "1 KB",
                }
            )
        db.commit()
    monkeypatch.setattr(service, "MAX_CATALOG_SIZE", 3)
    service._catalog_base_cache["entry"] = (None, ())
    with TestClient(app) as client:
        viewer = register(client, "tag_feed_viewer")
        with app.state.testing_session() as db:
            db.add(
                ActorCreatorAffinity(
                    actor_key=f"u:{viewer['id']}",
                    user_id=viewer["id"],
                    creator_id=oldest_owner,
                    score=30.0,
                )
            )
            db.commit()
        params = {"folder": "ALL FOLDERS", "tag": "cinematic", "sort": "for_you", "limit": 4}
        pages, cursor = [], None
        while True:
            page_params = dict(params, **({"cursor": cursor} if cursor else {}))
            response = client.get("/api/reels/feed", params=page_params)
            assert response.status_code == 200, response.text
            body = response.json()
            pages.append(body)
            cursor = body["next_cursor"]
            if not cursor:
                break
        ids = [item["post_id"] for body in pages for item in body["items"]]
        assert len(ids) == len(set(ids)) == 12
        assert set(ids) == tagged_ids
        assert pages[0]["items"][0]["creator"]["id"] == oldest_owner
        with app.state.testing_session() as db:
            rows = db.query(RecommendationImpression).all()
        names = {source["name"] for row in rows for source in row.provenance["sources"]}
        assert names.isdisjoint({"fresh_exploration", "global_quality_trending"}), names


def test_author_feed_keeps_newest_order(app):
    posts = seed_catalog(app, creators=4, posts_per_creator=3)
    with app.state.testing_session() as db:
        owner = db.get(User, next(p.owner_id for p in posts if p.title in {"Reel 3", "Reel 4", "Reel 5"}))
        username = owner.username
    expected = [p.id for p in sorted(posts, key=lambda p: p.created_at, reverse=True) if p.owner_id == owner.id]
    assert len(expected) == 3
    with TestClient(app) as client:
        response = client.get(
            "/api/reels/feed",
            params={"folder": "ALL FOLDERS", "author": username, "sort": "for_you", "limit": 12},
        )
        assert response.status_code == 200, response.text
        assert [item["post_id"] for item in response.json()["items"]] == expected


def _seed_following(app, viewer_id, reels, affinity):
    """reels: {key: (creator_key, age)}; affinity: {creator_key: score}. Viewer follows every creator."""
    scan_rows = []
    post_ids, creator_ids = {}, {}
    with app.state.testing_session() as db:
        for key, (creator_key, age) in reels.items():
            if creator_key not in creator_ids:
                creator = User(
                    username=f"fol_{creator_key}",
                    username_norm=f"fol_{creator_key}",
                    display_name=creator_key,
                    account_type="real",
                    status="active",
                )
                db.add(creator)
                db.flush()
                db.add(Follow(follower_id=viewer_id, followee_id=creator.id))
                creator_ids[creator_key] = creator.id
            path = f"tests/fol-{key}.jpg"
            post = Post(
                owner_id=creator_ids[creator_key],
                media_path=path,
                media_type="image",
                title=f"Reel {key}",
                caption="following test",
                location={},
                source="upload",
                status="published",
                created_at=utcnow() - age,
            )
            db.add(post)
            db.flush()
            post_ids[key] = post.id
            scan_rows.append(
                {
                    "rel_path": path,
                    "path": f"output/{path}",
                    "filename": f"fol-{key}.jpg",
                    "folder": "tests",
                    "mtime": 1000 - len(scan_rows),
                    "media_type": "image",
                    "size_human": "1 KB",
                }
            )
        for creator_key, score in affinity.items():
            db.add(
                ActorCreatorAffinity(
                    actor_key=f"u:{viewer_id}",
                    user_id=viewer_id,
                    creator_id=creator_ids[creator_key],
                    score=score,
                )
            )
        db.commit()
    app.state.scan_rows = scan_rows
    service._catalog_base_cache["entry"] = (None, ())
    return post_ids


def _following_ids(client, limit):
    ids, cursor = [], None
    while True:
        params = {"folder": "ALL FOLDERS", "feed": "following", "limit": limit}
        if cursor:
            params["cursor"] = cursor
        response = client.get("/api/reels/feed", params=params)
        assert response.status_code == 200, response.text
        body = response.json()
        ids += [item["post_id"] for item in body["items"]]
        cursor = body["next_cursor"]
        if not cursor:
            return ids


def test_following_blends_recency_and_affinity(app):
    with TestClient(app) as client:
        viewer = register(client, "blend_viewer")
        posts = _seed_following(
            app,
            viewer["id"],
            {
                "A": ("a", timedelta(days=3)),
                "B": ("b", timedelta(hours=1)),
                "C": ("c", timedelta(hours=2)),
                "D": ("d", timedelta(hours=10)),
                "Dw": ("d", timedelta(minutes=30)),
            },
            {"a": 60.0, "c": 12.0, "d": 12.0},
        )
        with app.state.testing_session() as db:
            db.add(
                EngagementEvent(
                    user_id=viewer["id"],
                    post_id=posts["Dw"],
                    event_type="complete",
                    source="test",
                    created_at=utcnow() - timedelta(days=1),
                )
            )
            db.commit()
        ids = _following_ids(client, 2)
        assert sorted(ids) == sorted(posts.values())
        assert ids.index(posts["A"]) < ids.index(posts["B"]), ids
        assert ids.index(posts["C"]) < ids.index(posts["D"]), ids
        assert ids[-1] == posts["Dw"], ids


def test_following_new_reel_not_buried_by_diversity(app):
    with TestClient(app) as client:
        viewer = register(client, "diversity_viewer")
        posts = _seed_following(
            app,
            viewer["id"],
            {
                "A1": ("a", timedelta(hours=1)),
                "A2": ("a", timedelta(hours=2)),
                "B": ("b", timedelta(days=5)),
                "C": ("c", timedelta(days=6)),
            },
            {"a": 10.0, "b": 10.0, "c": 10.0},
        )
        ids = _following_ids(client, 4)
        assert sorted(ids) == sorted(posts.values())
        assert ids[0] == posts["A1"], ids
        assert ids.index(posts["A2"]) < ids.index(posts["C"]), ids


def _add_posts(app, specs):
    """specs: (owner_id, age_days, like_count, view_count) newest-first not required; returns ids in spec order."""
    ids = []
    with app.state.testing_session() as db:
        for number, (owner_id, age_days, likes, views) in enumerate(specs):
            post = Post(
                owner_id=owner_id,
                media_path=f"tests/age-{number}.jpg",
                media_type="image",
                title=f"Age {number}",
                caption="plain",
                location={},
                source="upload",
                status="published",
                created_at=utcnow() - timedelta(days=age_days, minutes=number),
                view_count=views,
                like_count=likes,
            )
            db.add(post)
            db.flush()
            ids.append(post.id)
        db.commit()
    return ids


def _add_creators(app, count):
    ids = []
    with app.state.testing_session() as db:
        for index in range(count):
            creator = User(
                username=f"age_creator_{index}",
                username_norm=f"age_creator_{index}",
                display_name=f"Age Creator {index}",
                account_type="real",
                status="active",
            )
            db.add(creator)
            db.flush()
            ids.append(creator.id)
        db.commit()
    return ids


def test_old_banger_enters_pool_and_can_win(app, monkeypatch):
    from server.social.recommendations import actor_identity, get_reel_page

    owner = _add_creators(app, 1)[0]
    specs = [(owner, 0, 0, 0)] * 10 + [(owner, 730, 300, 5000)]
    ids = _add_posts(app, specs)
    banger = ids[-1]
    with app.state.testing_session() as db:
        db.add(
            PostRecommendationStats(
                post_id=banger, impressions=1000, qualified_views=800, completions=600, likes=300, saves=50
            )
        )
        db.commit()
    monkeypatch.setattr(service, "MAX_CATALOG_SIZE", 4)
    service._catalog_base_cache["entry"] = (None, ())
    actor = actor_identity(None, "banger-probe")
    with app.state.testing_session() as db:
        assert banger in {item.post_id for item in service._catalog_pool_order(db)[:4]}
        catalog = service._catalog(
            db, actor=actor, allowed_post_ids=None, excluded_post_ids=set(), surface="for_you"
        )
        assert banger in catalog
        page = get_reel_page(
            db, actor=actor, surface="for_you", filters={"folder": "ALL FOLDERS", "limit": 4}, cursor=None, limit=4
        )
        assert banger in {item.target_id for item in page.items}


def test_long_tail_post_can_be_recommended(app, monkeypatch):
    from server.social.recommendations import actor_identity, get_reel_page

    a, b, z = _add_creators(app, 3)
    # Newest first by index; the three oldest belong to Z.
    owners = [a, b] * 6 + [z] * 3
    ids = _add_posts(app, [(owner, 0, 0, 0) for owner in owners])
    oldest = ids[-1]
    monkeypatch.setattr(service, "MAX_CATALOG_SIZE", 10)
    service._catalog_base_cache["entry"] = (None, ())
    actor = actor_identity(None, "long-tail-probe")
    with app.state.testing_session() as db:
        db.add(
            ActorCreatorAffinity(
                actor_key=actor.actor_key, anonymous_id="long-tail-probe", creator_id=z, score=40.0
            )
        )
        db.commit()
        assert oldest not in {item.post_id for item in service._catalog_pool_order(db)[:10]}
        context = service._pipeline_context(
            db, actor=actor, session=None, surface="for_you", seed_post_id=None,
            allowed_post_ids=None, manual_order=None,
        )
        assert oldest in context.items
        page = get_reel_page(
            db, actor=actor, surface="for_you", filters={"folder": "ALL FOLDERS", "limit": 15}, cursor=None, limit=15
        )
        assert oldest in {item.target_id for item in page.items}

        monkeypatch.setattr(service, "LONG_TAIL_MAX", 2)
        outside = service._catalog_pool_order(db)[10:]
        assert len(service._long_tail_ids(db, actor=actor, outside=outside, seed_ids=[])) == 2


def test_grid_for_you_puts_affine_creator_first(app):
    posts = seed_catalog(app, creators=4, posts_per_creator=3)
    first_creator = next(post.owner_id for post in posts if post.media_path == "tests/reel-11.jpg")  # oldest creator
    with TestClient(app) as client:
        viewer = register(client, "grid_viewer")
        with app.state.testing_session() as db:
            db.add(
                ActorCreatorAffinity(
                    actor_key=f"u:{viewer['id']}", user_id=viewer["id"], creator_id=first_creator, score=40.0
                )
            )
            db.commit()
        for extra in ({}, {"search": "cinematic"}):
            response = client.get("/api/reels", params={"sort": "for_you", "limit": 24, **extra})
            assert response.status_code == 200, response.text
            items = response.json()["videos"]
            assert len(items) == 12
            assert [item["creator"]["id"] for item in items[:3]] == [first_creator] * 3
        seen, cursor = [], None
        while True:
            params = {"sort": "for_you", "limit": 5, **({"cursor": cursor} if cursor else {})}
            body = client.get("/api/reels", params=params).json()
            seen += [item["post_id"] for item in body["videos"]]
            cursor = body["next_cursor"]
            if not cursor:
                break
        assert len(seen) == len(set(seen)) == 12
        assert {post.id for post in posts} == set(seen)
