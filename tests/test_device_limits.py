"""Device identity (sx_device): signup limits and quotas shared per browser."""

from __future__ import annotations

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from server.routers import image, social
from server.social import auth
from server.social.auth import DEVICE_COOKIE, token_hash
from server.social.database import Base, get_db
from server.social.models import AuthSession


PASSWORD = "correct-horse-battery"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    monkeypatch.setenv("SX_REGISTER_DEVICE_HOURLY", "3")
    monkeypatch.setenv("SX_REGISTER_DEVICE_DAILY", "5")
    monkeypatch.setattr("tempfile.tempdir", str(tmp_path))
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "device-limits.db"),
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    for module in (social, image):
        application.include_router(module.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    application.state.Session = Session
    before_stages = set(image.STAGED_UPLOADS)
    yield application
    for stage_id in set(image.STAGED_UPLOADS) - before_stages:
        image.STAGED_UPLOADS.pop(stage_id, None)
    engine.dispose()


def signup(client, username):
    return register_verified(client,
        json={
            "email": f"{username}@example.com",
            "username": username,
            "password": PASSWORD,
            "accept_terms": True,
            "display_name": username,
        },
    )


def upload(client):
    return client.post(
        "/api/image/upload",
        files={"file": ("square.png", b"staged", "image/png")},
        headers={"x-csrf-token": client.cookies.get("echo_csrf")},
    )


def test_fourth_signup_from_one_device_is_limited(app):
    with TestClient(app) as client:
        for index in range(3):
            assert signup(client, f"farm{index}").status_code == 200
        response = signup(client, "farm3")
        assert response.status_code == 429 and response.json()["detail"]["code"] == "RATE_LIMITED"


def test_sixth_signup_from_one_ip_is_limited(app):
    # A fresh cookie jar per signup is a fresh device; the IP limit (5/h) still holds.
    for index in range(5):
        with TestClient(app) as client:
            assert signup(client, f"ip{index}").status_code == 200
    with TestClient(app) as client:
        assert signup(client, "ip5").status_code == 429


def test_a_new_account_on_the_same_device_shares_the_upload_quota(app, monkeypatch):
    monkeypatch.setenv("SX_UPLOAD_HOURLY_MAX", "2")
    monkeypatch.setattr(image, "get_image_dimensions", lambda _path: (1000, 1000))
    with TestClient(app) as client:
        assert signup(client, "first").status_code == 200
        assert upload(client).status_code == 200
        assert upload(client).status_code == 200
        assert signup(client, "second").status_code == 200
        response = upload(client)
        assert response.status_code == 429
    with app.state.Session() as db:
        hashes = {row.device_hash for row in db.query(AuthSession).all()}
    assert len(hashes) == 1 and None not in hashes


def test_a_forged_device_cookie_is_replaced(app):
    with TestClient(app) as client:
        # The domain cookies from the test server get, so the minted one replaces it.
        client.cookies.set(DEVICE_COOKIE, "chosen-id.forged-signature", domain="testserver.local")
        assert signup(client, "forger").status_code == 200
        issued = client.cookies.get(DEVICE_COOKIE)
        assert issued and not issued.startswith("chosen-id.")
    with app.state.Session() as db:
        row = db.query(AuthSession).one()
    assert row.device_hash == token_hash(issued.rpartition(".")[0])
    assert row.device_hash != token_hash("chosen-id")
