from __future__ import annotations

from datetime import timedelta

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.routers import rewards, social
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import Post, RecommendationImpression, RecommendationRequest, RecommendationSession, utcnow


PASSWORD = "correct-horse-battery"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_REEL_REWARDS_ENABLED", "1")
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "rewards.db"),
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    application.include_router(social.router)
    application.include_router(rewards.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    application.state.testing_session = Session
    yield application
    engine.dispose()


def register(client, username):
    response = client.post(
        "/api/auth/register",
        json={
            "email": f"{username}@example.com",
            "username": username,
            "password": PASSWORD,
            "display_name": username,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]


def csrf_headers(client):
    return {"x-csrf-token": client.cookies.get("echo_csrf")}


def test_reward_claim_requires_auth_and_accepts_server_attributed_foreground_event(app):
    with TestClient(app) as anonymous:
        response = anonymous.post(
            "/api/rewards/reels/claim",
            json={"post_id": "post", "recommendation_impression_id": "impression"},
        )
        assert response.status_code == 401

    with TestClient(app) as owner_client, TestClient(app) as viewer_client:
        owner = register(owner_client, "reward_api_owner")
        viewer = register(viewer_client, "reward_api_viewer")
        with app.state.testing_session() as db:
            post = Post(owner_id=owner["id"], media_path="api-reward.jpg", media_type="image", title="")
            db.add(post)
            db.flush()
            session = RecommendationSession(
                actor_key=f"u:{viewer['id']}", user_id=viewer["id"], surface="reels",
                filter_hash="api", filters={}, algorithm_version="test",
                expires_at=utcnow() + timedelta(hours=1),
            )
            db.add(session)
            db.flush()
            request = RecommendationRequest(session_id=session.id, page_index=0, requested_count=1, returned_count=1)
            db.add(request)
            db.flush()
            impression = RecommendationImpression(
                request_id=request.id, session_id=session.id, post_id=post.id, position=0,
                primary_source="test", reason_key="test", provenance={},
                first_visible_at=utcnow() - timedelta(seconds=4),
            )
            db.add(impression)
            db.commit()
            post_id = post.id
            impression_id = impression.id

        event_response = viewer_client.post(
            "/api/events",
            headers=csrf_headers(viewer_client),
            json={
                "event_type": "reward_eligible",
                "post_id": post_id,
                "watch_ms": 3000,
                "foreground_ms": 3000,
                "duration_ms": 3000,
                "watch_ratio": 1,
                "source": "reels",
                "client_event_id": "reward-api-event",
                "recommendation_impression_id": impression_id,
                "context": {"media_type": "image", "reward_threshold_ms": 3000},
            },
        )
        assert event_response.status_code == 200, event_response.text
        claim = viewer_client.post(
            "/api/rewards/reels/claim",
            headers=csrf_headers(viewer_client),
            json={"post_id": post_id, "recommendation_impression_id": impression_id},
        )
        assert claim.status_code == 200, claim.text
        assert claim.json()["progress"] == 1
        assert claim.json()["credit_awarded"] is False
