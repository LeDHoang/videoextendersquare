"""Edge-cache headers: anonymous list responses are public for s-maxage, signed-in ones private."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

with patch("dotenv.load_dotenv"):
    from server import app as app_module
from server.edge_cache import EDGE_CACHEABLE_PATHS
from server.routers import reels
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import User
from server.social.services import create_or_update_post
from verified_signup import register_verified

PUBLIC = "public, max-age=0, s-maxage=30"
PRIVATE = "private, no-store"
ROUTES = sorted(EDGE_CACHEABLE_PATHS)
POSTED = "uploads/posted.png"
ITEM = {
    "rel_path": POSTED,
    "path": f"output/{POSTED}",
    "filename": "posted.png",
    "folder": "uploads",
    "size_human": "1 KB",
    "mtime": 1,
    "media_type": "image",
}


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("SX_ENV", raising=False)
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setattr(app_module, "mount_spa", lambda *_: None)
    monkeypatch.setattr(reels.SM, "scan_output_media", lambda _root: [])
    monkeypatch.setattr(reels, "post_media_items", lambda _db=None: [dict(ITEM)])
    monkeypatch.setattr(reels, "slide_media_paths", lambda _db=None: set())
    monkeypatch.setattr(reels, "META_FILE", tmp_path / "reels_meta.json")
    monkeypatch.setattr(reels, "COMMENTS_FILE", tmp_path / "reels_comments.json")
    monkeypatch.setattr(reels, "_recommendation_feed_data", lambda **_: {"items": []})

    engine = create_engine("sqlite:///" + str(tmp_path / "edge.db"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with Session() as db:
        db.add(User(id="ann", username="ann", username_norm="ann", display_name="ann", status="active"))
        db.flush()
        create_or_update_post(db, media_path=POSTED, media_type="image", owner=db.get(User, "ann"), title="posted")
        db.commit()

    def override_get_db():
        with Session() as db:
            yield db

    application = app_module.create_app()
    application.dependency_overrides[get_db] = override_get_db
    reels.invalidate_scan_cache()
    yield application
    reels.invalidate_scan_cache()
    engine.dispose()


@pytest.fixture
def anonymous(app):
    return TestClient(app)


@pytest.fixture
def signed_in(app):
    client = TestClient(app)
    response = register_verified(client, json={
        "email": "viewer@example.com",
        "username": "viewer",
        "password": "correct-horse-battery",
        "accept_terms": True,
        "display_name": "viewer",
    })
    assert response.status_code == 200, response.text
    assert client.cookies.get(auth.SESSION_COOKIE)
    return client


def _vary(response) -> set[str]:
    return {value.strip().lower() for value in response.headers.get("vary", "").split(",") if value.strip()}


@pytest.mark.parametrize("path", ROUTES)
def test_anonymous_response_is_public_for_the_edge(anonymous, path):
    response = anonymous.get(path)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == PUBLIC
    assert "cookie" in _vary(response)
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize("path", ROUTES)
def test_signed_in_response_is_private(signed_in, path):
    response = signed_in.get(path)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == PRIVATE
    assert "cookie" in _vary(response)


@pytest.mark.parametrize("path", ROUTES)
def test_any_session_cookie_counts_as_signed_in(anonymous, path):
    # The edge sees only that the cookie is there, not whether it is valid.
    anonymous.cookies.set(auth.SESSION_COOKIE, "expired-or-forged")
    response = anonymous.get(path)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == PRIVATE


@pytest.mark.parametrize("path", ROUTES)
def test_anonymous_body_does_not_vary_by_headers_or_other_cookies(anonymous, path):
    plain = anonymous.get(path)
    anonymous.cookies.set(auth.ANON_COOKIE, "another-anonymous-browser")
    anonymous.cookies.set(auth.CSRF_COOKIE, "x")
    other = anonymous.get(
        path,
        headers={"Accept-Language": "vi-VN,vi;q=0.9", "User-Agent": "OculusBrowser", "X-Forwarded-For": "203.0.113.9"},
    )
    assert other.headers["cache-control"] == PUBLIC
    assert other.content == plain.content


def test_anonymous_reels_list_has_no_viewer_state(anonymous):
    videos = anonymous.get("/api/reels").json()["videos"]
    assert [video["path"] for video in videos] == [POSTED]
    assert videos[0]["liked_by_me"] is False and videos[0]["saved_by_me"] is False
    assert videos[0]["viewer_state"] == {"liked": False, "saved": False, "following_creator": False, "can_edit": False}


@pytest.mark.parametrize("url, status", [
    ("/api/reels?feed=following", 401),
    ("/api/reels?post=missing", 404),
])
def test_anonymous_errors_are_not_cacheable(anonymous, url, status):
    response = anonymous.get(url)
    assert response.status_code == status
    assert response.headers["cache-control"] == PRIVATE


def test_refresh_is_not_cacheable(anonymous):
    response = anonymous.get("/api/reels?refresh=true")
    assert response.status_code == 200
    assert response.headers["cache-control"] == PRIVATE


@pytest.mark.parametrize("path", ["/api/reels/feed", "/api/reels/tags/posted", "/api/reels/locations/activity"])
def test_neighbouring_routes_are_unchanged(anonymous, path):
    response = anonymous.get(path)
    assert response.headers.get("cache-control") != PUBLIC


def test_anonymous_grid_for_you_is_shared_and_cacheable(anonymous, app):
    first = anonymous.get("/api/reels?sort=for_you&limit=24")
    other = TestClient(app)
    other.cookies.set(auth.ANON_COOKIE, "another-anonymous-browser")
    second = other.get("/api/reels?sort=for_you&limit=24")
    assert first.status_code == second.status_code == 200, first.text
    assert first.content == second.content
    assert POSTED in first.text
    for response in (first, second):
        assert response.headers["cache-control"] == PUBLIC
        assert "set-cookie" not in response.headers
