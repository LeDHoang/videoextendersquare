from __future__ import annotations

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.billing.service import reel_reward_ip_cap
from server.routers import social
from server.social import auth
from server.social.database import Base, get_db

PASSWORD = "correct-horse-battery-99"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(
        auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1)
    )
    # Ensure the import-time flag starts open; per-test env controls the gate.
    monkeypatch.setattr(social, "REGISTRATION_ENABLED", True)
    monkeypatch.delenv("SX_REGISTRATION_ALLOWLIST", raising=False)
    monkeypatch.setenv("SX_REGISTRATION_ENABLED", "1")
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "registration-allowlist.db"),
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    application.include_router(social.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    yield application
    engine.dispose()


def _register(client, email, username):
    return client.post(
        "/api/auth/register",
        json={"email": email, "username": username, "password": PASSWORD, "accept_terms": True, "display_name": username},
    )


def test_open_registration_allows_anyone(app, monkeypatch):
    monkeypatch.setenv("SX_REGISTRATION_ENABLED", "1")
    monkeypatch.delenv("SX_REGISTRATION_ALLOWLIST", raising=False)
    with TestClient(app) as client:
        response = _register(client, "anyone@example.com", "allow_anyone")
        assert response.status_code == 202, response.text
        assert response.json()["verification_sent"] is True
        assert "echo_session" not in client.cookies


def test_closed_registration_blocks_non_listed(app, monkeypatch):
    monkeypatch.setenv("SX_REGISTRATION_ENABLED", "0")
    monkeypatch.setenv("SX_REGISTRATION_ALLOWLIST", "invited@example.com")
    with TestClient(app) as client:
        response = _register(client, "stranger@example.com", "allow_stranger")
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "REGISTRATION_DISABLED"


def test_closed_registration_allows_listed_case_insensitive(app, monkeypatch):
    monkeypatch.setenv("SX_REGISTRATION_ENABLED", "0")
    monkeypatch.setenv("SX_REGISTRATION_ALLOWLIST", "  Invited@Example.com , other@example.com")
    with TestClient(app) as client:
        response = _register(client, "invited@example.com", "allow_invited")
        assert response.status_code == 202, response.text
        # Invited sign-ups still have to prove the mailbox.
        verified = client.post("/api/auth/verify-email", json={"token": response.json()["debug_token"]})
        assert verified.status_code == 200, verified.text
        assert verified.json()["user"]["username"] == "allow_invited"


def test_closed_with_empty_allowlist_blocks_all(app, monkeypatch):
    monkeypatch.setenv("SX_REGISTRATION_ENABLED", "0")
    monkeypatch.delenv("SX_REGISTRATION_ALLOWLIST", raising=False)
    with TestClient(app) as client:
        response = _register(client, "invited@example.com", "allow_blocked")
        assert response.status_code == 403


def test_registration_allowlist_parsing(monkeypatch):
    monkeypatch.setenv("SX_REGISTRATION_ALLOWLIST", " A@Example.com,, b@example.com ,")
    assert social.registration_allowlist() == {"a@example.com", "b@example.com"}
    assert social.is_registration_allowlisted("A@EXAMPLE.COM") is True
    assert social.is_registration_allowlisted("unknown@example.com") is False


def test_reel_reward_ip_cap_honors_low_values(monkeypatch):
    monkeypatch.setenv("SX_REEL_REWARD_IP_DAILY_CLAIMS", "2")
    assert reel_reward_ip_cap() == 2
    monkeypatch.setenv("SX_REEL_REWARD_IP_DAILY_CLAIMS", "0")
    assert reel_reward_ip_cap() == 1
    monkeypatch.setenv("SX_REEL_REWARD_IP_DAILY_CLAIMS", "not-a-number")
    assert reel_reward_ip_cap() == 50
    monkeypatch.delenv("SX_REEL_REWARD_IP_DAILY_CLAIMS", raising=False)
    assert reel_reward_ip_cap() == 50
