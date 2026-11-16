from __future__ import annotations

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from server.routers import account_safety, messages, packs, reels, social
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import Post, User
from server.social.services import create_or_update_post


PASSWORD = "correct-horse-battery"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_MESSAGE_ENCRYPTION_KEY", "test-only-message-key-with-at-least-32-chars")
    monkeypatch.setattr(
        auth,
        "PASSWORD_HASHER",
        PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1),
    )
    test_engine = create_engine(
        "sqlite:///" + str(tmp_path / "private.db"),
        connect_args={"check_same_thread": False},
    )
    testing_session = sessionmaker(bind=test_engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(test_engine)

    application = FastAPI()
    application.include_router(account_safety.router)
    application.include_router(social.router)
    application.include_router(packs.router)
    application.include_router(messages.router)
    application.include_router(reels.router)

    def override_get_db():
        db = testing_session()
        try:
            yield db
        finally:
            db.close()

    application.dependency_overrides[get_db] = override_get_db
    application.state.testing_session = testing_session
    yield application
    Base.metadata.drop_all(test_engine)
    test_engine.dispose()


def register(client: TestClient, username: str, email: str) -> dict:
    response = register_verified(client,
        json={
            "email": email,
            "username": username,
            "password": PASSWORD,
            "accept_terms": True,
            "display_name": username.title(),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]


def csrf_headers(client: TestClient) -> dict[str, str]:
    token = client.cookies.get("echo_csrf")
    assert token
    return {"x-csrf-token": token}


def make_post(app: FastAPI, owner_id: str, name: str, *, visibility: str = "public", tags=()) -> Post:
    with app.state.testing_session() as db:
        owner = db.get(User, owner_id)
        post = create_or_update_post(
            db,
            media_path=f"uploads/{name}.mp4",
            media_type="video",
            owner=owner,
            tags=list(tags),
            visibility=visibility,
        )
        db.commit()
        return post


def stored_visibility(app: FastAPI, post_id: str) -> str:
    with app.state.testing_session() as db:
        return db.get(Post, post_id).visibility


def test_patch_switches_visibility_both_ways(app):
    with TestClient(app) as alice:
        user = register(alice, "alice", "alice@example.com")
        post = make_post(app, user["id"], "switch")
        r = alice.patch(f"/api/posts/{post.id}", json={"visibility": "private"}, headers=csrf_headers(alice))
        assert r.status_code == 200 and r.json()["post"]["visibility"] == "private"
        assert stored_visibility(app, post.id) == "private"
        r = alice.patch(f"/api/posts/{post.id}", json={"visibility": "public"}, headers=csrf_headers(alice))
        assert r.json()["post"]["visibility"] == "public"
        assert stored_visibility(app, post.id) == "public"


def test_patch_without_visibility_keeps_it(app):
    with TestClient(app) as alice:
        user = register(alice, "alice", "alice@example.com")
        post = make_post(app, user["id"], "keep", visibility="private")
        r = alice.patch(f"/api/posts/{post.id}", json={"title": "x"}, headers=csrf_headers(alice))
        assert r.status_code == 200 and r.json()["post"]["visibility"] == "private"
        assert stored_visibility(app, post.id) == "private"


def test_only_the_owner_changes_visibility(app):
    with TestClient(app) as alice, TestClient(app) as bob:
        user = register(alice, "alice", "alice@example.com")
        register(bob, "bob", "bob@example.com")
        post = make_post(app, user["id"], "owned")
        r = bob.patch(f"/api/posts/{post.id}", json={"visibility": "private"}, headers=csrf_headers(bob))
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "FORBIDDEN"
        assert stored_visibility(app, post.id) == "public"


def test_unknown_visibility_is_refused(app):
    with TestClient(app) as alice:
        user = register(alice, "alice", "alice@example.com")
        post = make_post(app, user["id"], "bad")
        r = alice.patch(f"/api/posts/{post.id}", json={"visibility": "friends"}, headers=csrf_headers(alice))
        assert r.status_code == 422
        assert stored_visibility(app, post.id) == "public"


def test_reimport_keeps_a_private_post_private(app):
    with TestClient(app) as alice:
        user = register(alice, "alice", "alice@example.com")
        post = make_post(app, user["id"], "reimport", visibility="private")
        with app.state.testing_session() as db:
            owner = db.get(User, user["id"])
            create_or_update_post(db, media_path="uploads/reimport.mp4", media_type="video", owner=owner)
            db.commit()
        assert stored_visibility(app, post.id) == "private"


def test_invalid_visibility_argument_raises(app):
    with TestClient(app) as alice:
        user = register(alice, "alice", "alice@example.com")
        with app.state.testing_session() as db:
            owner = db.get(User, user["id"])
            with pytest.raises(ValueError):
                create_or_update_post(
                    db, media_path="uploads/x.mp4", media_type="video", owner=owner, visibility="friends"
                )
