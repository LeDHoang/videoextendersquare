from __future__ import annotations

import json
import re
import threading
from datetime import timedelta

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import joinedload, sessionmaker

from server.routers import reels, social
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import (
    ActorCreatorAffinity,
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


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(
        auth,
        "PASSWORD_HASHER",
        PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1),
    )
    test_engine = create_engine(
        "sqlite:///" + str(tmp_path / "recommendations.db"),
        connect_args={"check_same_thread": False},
    )
    testing_session = sessionmaker(bind=test_engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(test_engine)

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

    monkeypatch.setattr(reels, "unavailable_media_paths_for_viewer", lambda _viewer_id: set())
    monkeypatch.setattr(reels, "_scan_cached", lambda: list(application.state.scan_rows))

    def payload(items, _codec, tunnel="", viewer_id=None):
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
    response = client.post(
        "/api/auth/register",
        json={
            "email": f"{username}@example.com",
            "username": username,
            "password": PASSWORD,
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
            r"const initialFeedState = (.*?);\n\s*const feedParams =",
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


def test_concurrent_affinity_upsert_dedupes(app):
    """Simultaneous view+like style writers create exactly one affinity row."""
    from server.social.models import ActorCreatorAffinity
    from server.social.recommendations.events import get_or_create

    seed_catalog(app, creators=2, posts_per_creator=1)
    errors = []

    def worker():
        db = app.state.testing_session()
        try:
            row = get_or_create(
                db,
                ActorCreatorAffinity,
                ActorCreatorAffinity.actor_key == "u:race-affinity",
                ActorCreatorAffinity.creator_id == "creator-race",
                actor_key="u:race-affinity",
                creator_id="creator-race",
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
                ActorCreatorAffinity.creator_id == "creator-race",
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
