"""Model-info lookups need sign-in, and fal.ai fetches are rate-limited per user."""

from __future__ import annotations

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from server.routers import model_info, social
from server.social import auth
from server.social.database import Base, get_db


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "model-info.db"),
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    application.include_router(social.router)
    application.include_router(model_info.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    fetched = []

    def fake_fetch(model, kind):
        fetched.append((model, kind))
        return {"model": model, "kind": kind, "found": True}

    monkeypatch.setattr(model_info, "_cache", {})
    monkeypatch.setattr(model_info, "_fetch_model_info", fake_fetch)
    application.state.fetched = fetched
    yield application
    engine.dispose()


def register(client, username):
    response = register_verified(client,
        json={
            "email": f"{username}@example.com",
            "username": username,
            "password": "correct-horse-battery",
            "accept_terms": True,
            "display_name": username,
        },
    )
    assert response.status_code == 200, response.text


def test_model_info_requires_sign_in(app):
    with TestClient(app) as client:
        response = client.get("/api/config/model-info", params={"model": "fal-ai/foo/bar"})
        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "AUTH_REQUIRED"
        assert app.state.fetched == []


def test_model_info_serves_signed_in_users_from_cache(app):
    with TestClient(app) as client:
        register(client, "mina")
        first = client.get("/api/config/model-info", params={"model": "fal-ai/foo/bar", "kind": "outpaint"})
        second = client.get("/api/config/model-info", params={"model": "fal-ai/foo/bar", "kind": "outpaint"})
        assert first.status_code == 200, first.text
        assert first.json()["from_cache"] is False
        assert second.status_code == 200
        assert second.json()["from_cache"] is True
        assert app.state.fetched == [("fal-ai/foo/bar", "outpaint")]


def test_model_info_rate_limits_fetches_per_user(app):
    with TestClient(app) as mina, TestClient(app) as omar:
        register(mina, "mina")
        register(omar, "omar")
        for i in range(model_info.MODEL_INFO_FETCHES_PER_MINUTE):
            assert mina.get("/api/config/model-info", params={"model": f"fal-ai/m/{i}"}).status_code == 200
        limited = mina.get("/api/config/model-info", params={"model": "fal-ai/m/next"})
        assert limited.status_code == 429
        assert limited.json()["detail"]["code"] == "RATE_LIMITED"
        # Cached answers cost no fetch, and the limit is per user.
        assert mina.get("/api/config/model-info", params={"model": "fal-ai/m/0"}).status_code == 200
        assert omar.get("/api/config/model-info", params={"model": "fal-ai/m/next"}).status_code == 200
        assert len(app.state.fetched) == model_info.MODEL_INFO_FETCHES_PER_MINUTE + 1


def test_model_info_cache_is_bounded(app, monkeypatch):
    monkeypatch.setattr(model_info, "_CACHE_MAX_ENTRIES", 3)
    monkeypatch.setattr(model_info, "MODEL_INFO_FETCHES_PER_MINUTE", 100)
    with TestClient(app) as client:
        register(client, "cache_cap")
        for index in range(5):
            assert client.get("/api/config/model-info", params={"model": f"fal-ai/m{index}"}).status_code == 200
        assert sorted(model_info._cache) == ["fal-ai/m2|upscale", "fal-ai/m3|upscale", "fal-ai/m4|upscale"]


def test_model_info_refuses_unknown_kinds_and_long_ids(app):
    with TestClient(app) as client:
        register(client, "cache_inputs")
        assert client.get("/api/config/model-info", params={"model": "fal-ai/a", "kind": "bogus"}).status_code == 422
        assert client.get("/api/config/model-info", params={"model": "a" * 301}).status_code == 422
        assert app.state.fetched == []


def test_model_info_accepts_a_pasted_playground_url(app):
    with TestClient(app) as client:
        register(client, "cache_url")
        url = "https://fal.ai/models/fal-ai/foo/bar/playground?share=abc#x"
        assert client.get("/api/config/model-info", params={"model": url, "kind": "outpaint"}).status_code == 200
        assert app.state.fetched == [("fal-ai/foo/bar/playground", "outpaint")]


def test_model_info_caches_each_casing_on_its_own(app):
    with TestClient(app) as client:
        register(client, "cache_case")
        client.get("/api/config/model-info", params={"model": "fal-ai/Foo"})
        client.get("/api/config/model-info", params={"model": "fal-ai/foo"})
        assert app.state.fetched == [("fal-ai/Foo", "upscale"), ("fal-ai/foo", "upscale")]
