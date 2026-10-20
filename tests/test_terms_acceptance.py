"""Signup must record Terms acceptance; migration 20261020_0014 adds the columns.

The migration round trip runs on SQLite always, and on PostgreSQL too when
SX_TEST_POSTGRES_URL is set (that database must be disposable).
"""
from __future__ import annotations

import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

from server.routers import social
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import User

REPO = Path(__file__).resolve().parents[1]
REVISION = "20261020_0014"
PREVIOUS = "20261015_0013"
PASSWORD = "correct-horse-battery-99"


@pytest.fixture
def client_and_session(tmp_path, monkeypatch):
    monkeypatch.setattr(
        auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1)
    )
    monkeypatch.setattr(social, "REGISTRATION_ENABLED", True)
    monkeypatch.setenv("SX_REGISTRATION_ENABLED", "1")
    monkeypatch.delenv("SX_REGISTRATION_ALLOWLIST", raising=False)
    engine = sa.create_engine(
        "sqlite:///" + str(tmp_path / "terms.db"), connect_args={"check_same_thread": False}
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    application.include_router(social.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    with TestClient(application) as client:
        yield client, Session
    engine.dispose()


def _register(client, username, **extra):
    payload = {"email": f"{username}@example.com", "username": username, "password": PASSWORD, **extra}
    return client.post("/api/auth/register", json=payload)


@pytest.mark.parametrize("extra", [{}, {"accept_terms": False}, {"accept_terms": "yes"}, {"accept_terms": 1}])
def test_register_without_explicit_acceptance_is_rejected(client_and_session, extra):
    client, Session = client_and_session
    response = _register(client, "no_terms", **extra)
    assert response.status_code in {400, 422}, response.text
    if response.status_code == 400:
        assert response.json()["detail"]["code"] == "TERMS_NOT_ACCEPTED"
        assert response.json()["detail"]["field"] == "accept_terms"
    with Session() as db:
        assert db.query(User).count() == 0


def test_register_records_terms_version_and_time(client_and_session):
    client, Session = client_and_session
    response = _register(client, "agreed_user", accept_terms=True)
    assert response.status_code == 200, response.text
    with Session() as db:
        user = db.query(User).filter(User.username_norm == "agreed_user").one()
        assert user.terms_version == social.TERMS_VERSION
        assert user.terms_accepted_at is not None


def _alembic(url: str, monkeypatch) -> Config:
    # migrations/env.py prefers DATABASE_URL over the ini url; no ini file so
    # env.py does not run fileConfig and disable loggers other tests capture.
    monkeypatch.setenv("DATABASE_URL", url)
    config = Config()
    config.set_main_option("script_location", str(REPO / "migrations"))
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return config


def _user_columns(engine) -> set[str]:
    return {column["name"] for column in sa.inspect(engine).get_columns("users")}


@pytest.mark.parametrize("index", [0, 1])
def test_terms_acceptance_migration_round_trip(tmp_path, monkeypatch, index):
    urls = ["sqlite:///" + str(tmp_path / "migrate.db")]
    if os.environ.get("SX_TEST_POSTGRES_URL"):
        urls.append(os.environ["SX_TEST_POSTGRES_URL"])
    if index >= len(urls):
        pytest.skip("SX_TEST_POSTGRES_URL is not set")
    config = _alembic(urls[index], monkeypatch)
    engine = sa.create_engine(urls[index])
    try:
        command.upgrade(config, PREVIOUS)
        assert "terms_version" not in _user_columns(engine)
        command.upgrade(config, REVISION)
        assert {"terms_version", "terms_accepted_at"} <= _user_columns(engine)
        command.downgrade(config, PREVIOUS)
        assert not {"terms_version", "terms_accepted_at"} & _user_columns(engine)
        command.upgrade(config, "head")
    finally:
        engine.dispose()
