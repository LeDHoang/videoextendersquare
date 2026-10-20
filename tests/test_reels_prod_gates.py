"""Reels gates: explore-preview sign-in and scope, debug routes hidden in production."""

from __future__ import annotations

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.routers import reels, social
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import Post


PASSWORD = "correct-horse-battery"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "reels-gates.db"),
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    application.include_router(social.router)
    application.include_router(reels.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    application.state.Session = Session
    generated = []

    def fake_gen(rel, layout="mono"):
        generated.append(rel)
        return rel, f"/media/{rel}-preview", f"/media/{rel}-poster", None

    monkeypatch.setattr(reels, "_gen_explore_assets", fake_gen)
    application.state.generated = generated
    yield application
    engine.dispose()


def register(client, username):
    response = client.post(
        "/api/auth/register",
        json={
            "email": f"{username}@example.com",
            "username": username,
            "password": PASSWORD,
            "accept_terms": True,
            "display_name": username,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]


def csrf_headers(client):
    return {"x-csrf-token": client.cookies.get("echo_csrf")}


def add_post(app, owner_id, rel, **fields):
    with app.state.Session() as db:
        db.add(Post(owner_id=owner_id, media_path=rel, media_type="video", **fields))
        db.commit()


def test_explore_preview_needs_sign_in_and_csrf(app):
    with TestClient(app) as anonymous, TestClient(app) as client:
        assert anonymous.post("/api/reels/explore-preview", json=["uploads/a.mp4"]).status_code == 401
        register(client, "preview_csrf")
        assert client.post("/api/reels/explore-preview", json=["uploads/a.mp4"]).status_code == 403
        assert app.state.generated == []


def test_explore_preview_only_transcodes_live_posts_in_production(app, monkeypatch):
    monkeypatch.setenv("SX_ENV", "production")
    with TestClient(app) as client:
        user = register(client, "preview_prod")
        add_post(app, user["id"], "uploads/live.mp4")
        add_post(app, user["id"], "uploads/gone.mp4", status="deleted")
        response = client.post(
            "/api/reels/explore-preview",
            json=["uploads/live.mp4", "uploads/gone.mp4", "testpipeline/loose.mp4"],
            headers=csrf_headers(client),
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert list(body["generated"]) == ["uploads/live.mp4"]
        assert sorted(item["path"] for item in body["failed"]) == ["testpipeline/loose.mp4", "uploads/gone.mp4"]
        assert app.state.generated == ["uploads/live.mp4"]


def test_explore_preview_keeps_loose_files_in_dev(app, monkeypatch):
    monkeypatch.delenv("SX_ENV", raising=False)
    with TestClient(app) as client:
        register(client, "preview_dev")
        response = client.post("/api/reels/explore-preview", json=["testpipeline/loose.mp4"], headers=csrf_headers(client))
        assert response.status_code == 200, response.text
        assert app.state.generated == ["testpipeline/loose.mp4"]


def test_explore_preview_is_rate_limited(app, monkeypatch):
    monkeypatch.setattr(reels, "EXPLORE_PREVIEW_PER_MINUTE", 2)
    with TestClient(app) as client:
        register(client, "preview_burst")
        for _ in range(2):
            assert client.post("/api/reels/explore-preview", json=[], headers=csrf_headers(client)).status_code == 200
        refused = client.post("/api/reels/explore-preview", json=[], headers=csrf_headers(client))
        assert refused.status_code == 429


@pytest.mark.parametrize(
    "method,url",
    [("post", "/api/reels/diag"), ("get", "/api/reels/diag"), ("get", "/api/reels/vr-video-path-ab")],
)
def test_debug_routes_are_hidden_in_production(app, monkeypatch, method, url):
    monkeypatch.setenv("SX_ENV", "production")
    with TestClient(app) as client:
        kwargs = {"json": {"fps": 72}} if method == "post" else {}
        assert getattr(client, method)(url, **kwargs).status_code == 404


def test_diag_still_works_in_dev(app, monkeypatch):
    monkeypatch.delenv("SX_ENV", raising=False)
    with TestClient(app) as client:
        assert client.post("/api/reels/diag", json={"fps": 72}).json() == {"ok": True}
        assert client.get("/api/reels/diag").json()["fps"] == 72
