"""Rate limits, validation and contribution caps on /api/events and /api/posts/{id}/view."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from server.social.models import (
    ActorItemAffinity,
    CoWatchPair,
    EngagementEvent,
    ItemSimilarity,
    Post,
    PostRecommendationStats,
)

from test_recommendations import app, seed_catalog  # noqa: F401  (reuses the app fixture)


@pytest.fixture(autouse=True)
def roomy_event_limits(monkeypatch):
    monkeypatch.setenv("SX_EVENT_RPM", "100000")


def feed_items(client: TestClient, limit: int = 4) -> list[dict]:
    response = client.get("/api/reels/feed", params={"folder": "ALL FOLDERS", "sort": "for_you", "limit": limit})
    assert response.status_code == 200, response.text
    return response.json()["items"]


def view(client: TestClient, post_id: str, **body):
    payload = {"watch_ms": 8000, "duration_ms": 10000, "source": "reels"}
    payload.update(body)
    return client.post(f"/api/posts/{post_id}/view", json=payload)


def test_view_rate_limit_per_actor(app, monkeypatch):
    monkeypatch.setenv("SX_EVENT_RPM", "5")
    post = seed_catalog(app, creators=1, posts_per_creator=1)[0]
    with TestClient(app) as client:
        codes = [view(client, post.id).status_code for _ in range(6)]
    assert codes == [200] * 5 + [429]


def test_events_rate_limit_per_actor(app, monkeypatch):
    monkeypatch.setenv("SX_EVENT_RPM", "4")
    post = seed_catalog(app, creators=1, posts_per_creator=1)[0]
    with TestClient(app) as client:
        codes = [
            client.post("/api/events", json={"event_type": "impression", "post_id": post.id}).status_code
            for _ in range(5)
        ]
    assert codes == [200] * 4 + [429]


def test_rate_limit_per_ip_across_fresh_anonymous_ids(app, monkeypatch):
    monkeypatch.setenv("SX_EVENT_RPM", "2")  # per-IP limit is 5x = 10
    post = seed_catalog(app, creators=1, posts_per_creator=1)[0]
    codes = []
    with TestClient(app) as client:
        for _ in range(11):
            client.cookies.clear()
            codes.append(
                client.post("/api/events", json={"event_type": "impression", "post_id": post.id}).status_code
            )
    assert codes == [200] * 10 + [429]


def test_playback_numbers_clamped_to_server_duration(app):
    post = seed_catalog(app, creators=1, posts_per_creator=1)[0]
    with app.state.testing_session() as db:
        db.get(Post, post.id).duration_ms = 10000
        db.commit()
    with TestClient(app) as client:
        response = view(
            client,
            post.id,
            watch_ms=10**9,
            foreground_ms=10**9,
            position_ms=10**9,
            duration_ms=1,
            watch_ratio=3.0,
            client_event_id="clamp-1",
        )
        assert response.status_code == 200, response.text
    with app.state.testing_session() as db:
        event = db.query(EngagementEvent).filter(EngagementEvent.client_event_id == "clamp-1").one()
        assert event.watch_ms == event.foreground_ms == event.position_ms == 40000
        assert event.duration_ms == 10000
        assert event.watch_ratio == pytest.approx(4.0)


def test_unknown_duration_capped_at_thirty_minutes(app):
    post = seed_catalog(app, creators=1, posts_per_creator=1)[0]
    with TestClient(app) as client:
        response = view(client, post.id, watch_ms=10**9, duration_ms=10**9, client_event_id="clamp-2")
        assert response.status_code == 200, response.text
    with app.state.testing_session() as db:
        event = db.query(EngagementEvent).filter(EngagementEvent.client_event_id == "clamp-2").one()
        assert event.watch_ms == 30 * 60 * 1000
        assert event.duration_ms == 30 * 60 * 1000


def test_qualification_uses_clamped_watch(app):
    post = seed_catalog(app, creators=1, posts_per_creator=1)[0]
    with app.state.testing_session() as db:
        row = db.get(Post, post.id)
        row.media_type = "video"
        row.duration_ms = 500  # ceiling 2000ms < 3000ms qualification threshold
        db.commit()
    with TestClient(app) as client:
        response = view(client, post.id, watch_ms=10**9, client_event_id="clamp-3")
        assert response.status_code == 200, response.text
        assert response.json()["counted"] is False
    with app.state.testing_session() as db:
        event = db.query(EngagementEvent).filter(EngagementEvent.client_event_id == "clamp-3").one()
        assert event.event_type == "playback"


def test_negative_and_nan_numbers_rejected(app):
    post = seed_catalog(app, creators=1, posts_per_creator=1)[0]
    with TestClient(app) as client:
        assert view(client, post.id, watch_ms=-1).status_code == 422
        assert view(client, post.id, position_ms=-5).status_code == 422
        nan = client.post(
            f"/api/posts/{post.id}/view",
            content='{"watch_ms": 5, "watch_ratio": NaN}',
            headers={"Content-Type": "application/json"},
        )
        assert nan.status_code == 422
        event = client.post(
            "/api/events",
            json={"event_type": "impression", "post_id": post.id, "foreground_ms": -1},
        )
        assert event.status_code == 422


@pytest.mark.parametrize(
    "bad",
    [
        {f"k{i}": i for i in range(17)},
        {"blob": "x" * 3000},
        {"nested": {"a": 1}},
        {"items": [1, 2, 3]},
    ],
)
def test_oversized_or_non_scalar_context_rejected(app, bad):
    post = seed_catalog(app, creators=1, posts_per_creator=1)[0]
    with TestClient(app) as client:
        for field in ("context", "playback_quality"):
            response = client.post(
                "/api/events",
                json={"event_type": "impression", "post_id": post.id, field: bad},
            )
            assert response.status_code == 422
            assert "EVENT_CONTEXT_TOO_LARGE" in response.text
            response = view(client, post.id, **{field: bad})
            assert response.status_code == 422
            assert "EVENT_CONTEXT_TOO_LARGE" in response.text


def test_small_scalar_context_accepted(app):
    post = seed_catalog(app, creators=1, posts_per_creator=1)[0]
    with TestClient(app) as client:
        response = view(
            client,
            post.id,
            context={"media_type": "video", "index": 3, "flag": True, "none": None},
            playback_quality={"dropped_frames": 0, "total_frames": 240},
        )
    assert response.status_code == 200, response.text


def test_replayed_attributed_views_contribute_once(app):
    seed_catalog(app, creators=3, posts_per_creator=2)
    with TestClient(app) as client:
        first, second = feed_items(client)[:2]
        for index in range(50):
            for item in (first, second):
                response = view(
                    client,
                    item["post_id"],
                    client_event_id=f"replay-{item['post_id'][:6]}-{index}",
                    recommendation_impression_id=item["recommendation"]["impression_id"],
                )
                assert response.status_code == 200, response.text
    with app.state.testing_session() as db:
        for item in (first, second):
            affinity = db.query(ActorItemAffinity).filter(ActorItemAffinity.post_id == item["post_id"]).one()
            assert affinity.qualified_watches == 1
            assert affinity.positive_count == 1
            stats = db.get(PostRecommendationStats, item["post_id"])
            assert stats.qualified_views == 1
            assert stats.total_watch_ms == 8000
        assert db.query(CoWatchPair).count() == 1
        assert db.query(ItemSimilarity).filter(ItemSimilarity.method == "co_watch").count() == 2
        support = {row.support for row in db.query(ItemSimilarity).all()}
        assert support == {1}


def test_unattributed_replays_bounded_per_day(app, monkeypatch):
    monkeypatch.setenv("SX_EVENT_DAILY_CAP", "2")
    post = seed_catalog(app, creators=1, posts_per_creator=1)[0]
    with TestClient(app) as client:
        for index in range(50):
            response = view(client, post.id, client_event_id=f"noimp-{index}")
            assert response.status_code == 200, response.text
    with app.state.testing_session() as db:
        affinity = db.query(ActorItemAffinity).filter(ActorItemAffinity.post_id == post.id).one()
        assert affinity.qualified_watches == 2
        assert db.get(PostRecommendationStats, post.id).qualified_views == 2
        # Every event row is still stored; only the aggregates are capped.
        assert db.query(EngagementEvent).filter(EngagementEvent.post_id == post.id).count() == 50


def test_repeated_non_view_events_are_capped(app, monkeypatch):
    monkeypatch.setenv("SX_EVENT_DAILY_CAP", "3")
    post = seed_catalog(app, creators=1, posts_per_creator=1)[0]
    with TestClient(app) as client:
        for _ in range(30):
            assert client.post("/api/events", json={"event_type": "share_sent", "post_id": post.id}).status_code == 200
    with app.state.testing_session() as db:
        assert db.get(PostRecommendationStats, post.id).shares == 3
        affinity = db.query(ActorItemAffinity).filter(ActorItemAffinity.post_id == post.id).one()
        assert affinity.positive_count == 3


def test_fabricated_impression_ids_record_without_attribution(app):
    seed_catalog(app, creators=3, posts_per_creator=2)
    with TestClient(app) as victim:
        victim_item = feed_items(victim)[0]
    with TestClient(app) as attacker:
        own_items = feed_items(attacker)
        other_post = next(i for i in own_items if i["post_id"] != own_items[0]["post_id"])
        cases = {
            "unknown": ("00000000-0000-0000-0000-000000000000", own_items[0]["post_id"]),
            "foreign": (victim_item["recommendation"]["impression_id"], victim_item["post_id"]),
            "wrong-post": (own_items[0]["recommendation"]["impression_id"], other_post["post_id"]),
        }
        for name, (impression_id, post_id) in cases.items():
            response = view(
                attacker,
                post_id,
                client_event_id=f"fab-{name}",
                recommendation_impression_id=impression_id,
            )
            assert response.status_code == 200, response.text
            event_response = attacker.post(
                "/api/events",
                json={
                    "event_type": "skip",
                    "post_id": post_id,
                    "client_event_id": f"fab-skip-{name}",
                    "recommendation_impression_id": impression_id,
                },
            )
            assert event_response.status_code == 200, event_response.text
    with app.state.testing_session() as db:
        for name in cases:
            for prefix in ("fab", "fab-skip"):
                event = db.query(EngagementEvent).filter(EngagementEvent.client_event_id == f"{prefix}-{name}").one()
                assert event.recommendation_impression_id is None


def test_valid_impression_attribution_still_recorded(app):
    seed_catalog(app, creators=3, posts_per_creator=2)
    with TestClient(app) as client:
        item = feed_items(client)[0]
        response = view(
            client,
            item["post_id"],
            client_event_id="valid-attr",
            recommendation_impression_id=item["recommendation"]["impression_id"],
        )
        assert response.status_code == 200, response.text
    with app.state.testing_session() as db:
        event = db.query(EngagementEvent).filter(EngagementEvent.client_event_id == "valid-attr").one()
        assert event.recommendation_impression_id == item["recommendation"]["impression_id"]
