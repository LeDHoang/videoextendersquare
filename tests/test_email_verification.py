"""Sign-up needs a verified email (migration 20261022_0016) plus Turnstile and a honeypot.

Registration creates a ``pending`` user and no session; only the emailed link
activates the account and signs the person in.
"""
from __future__ import annotations

from datetime import timedelta
from pathlib import Path

from alembic import command
from alembic.config import Config
from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

from server import security_headers
from server.routers import social
from server.social import auth, turnstile
from server.social.database import Base, get_db
from server.social.models import EmailVerificationToken, User, utcnow

REPO = Path(__file__).resolve().parents[1]
PASSWORD = "correct-horse-battery-99"


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(
        auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1)
    )
    monkeypatch.setattr(social, "REGISTRATION_ENABLED", True)
    monkeypatch.setenv("SX_REGISTRATION_ENABLED", "1")
    monkeypatch.delenv("SX_REGISTRATION_ALLOWLIST", raising=False)
    monkeypatch.delenv("SX_TURNSTILE_SECRET", raising=False)
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(social, "send_verification_email", lambda to, token: sent.append((to, token)) or True)
    engine = sa.create_engine(
        "sqlite:///" + str(tmp_path / "verify.db"), connect_args={"check_same_thread": False}
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
        yield client, Session, sent
    engine.dispose()


def _register(client, username="newbie", email=None, **extra):
    payload = {
        "email": email or f"{username}@example.com",
        "username": username,
        "password": PASSWORD,
        "accept_terms": True,
        **extra,
    }
    return client.post("/api/auth/register", json=payload)


def _verify(client, token):
    return client.post("/api/auth/verify-email", json={"token": token})


def _login(client, identifier, password=PASSWORD):
    return client.post("/api/auth/login", json={"identifier": identifier, "password": password})


def _status(Session, username):
    with Session() as db:
        user = db.query(User).filter(User.username_norm == username).first()
        return user.status if user else None


def _expire_tokens(Session, username):
    with Session() as db:
        user = db.query(User).filter(User.username_norm == username).one()
        db.query(EmailVerificationToken).filter(EmailVerificationToken.user_id == user.id).update(
            {EmailVerificationToken.expires_at: utcnow() - timedelta(minutes=1)}
        )
        db.commit()


def test_register_creates_pending_user_and_no_session(env):
    client, Session, sent = env
    response = _register(client)
    assert response.status_code == 202, response.text
    assert response.json()["verification_sent"] is True
    assert not client.cookies.get("echo_session")
    assert not client.cookies.get("echo_csrf")
    assert client.get("/api/auth/me").json() == {"user": None}
    assert _status(Session, "newbie") == "pending"
    assert [to for to, _ in sent] == ["newbie@example.com"]
    assert sent[0][1] == response.json()["debug_token"]


def test_debug_token_hidden_without_dev_switch(env, monkeypatch):
    client, _Session, _sent = env
    monkeypatch.setenv("SX_PASSWORD_RESET_EXPOSE_TOKEN", "0")
    response = _register(client)
    assert response.status_code == 202
    assert response.json() == {"verification_sent": True}


def test_login_refused_before_verification_then_works_after(env):
    client, _Session, _sent = env
    token = _register(client).json()["debug_token"]
    refused = _login(client, "newbie")
    assert refused.status_code == 401
    assert refused.json()["detail"]["code"] == "INVALID_CREDENTIALS"
    assert _login(client, "newbie@example.com").status_code == 401
    assert _verify(client, token).status_code == 200
    client.cookies.clear()
    assert _login(client, "newbie").status_code == 200


def test_verify_link_activates_account_and_signs_in(env):
    client, Session, _sent = env
    token = _register(client).json()["debug_token"]
    response = _verify(client, token)
    assert response.status_code == 200, response.text
    assert response.json()["user"]["username"] == "newbie"
    assert client.cookies.get("echo_session") and client.cookies.get("echo_csrf")
    assert client.get("/api/auth/me").json()["user"]["username"] == "newbie"
    assert _status(Session, "newbie") == "active"


@pytest.mark.parametrize("kind", ["wrong", "used", "expired", "empty"])
def test_bad_tokens_are_rejected(env, kind):
    client, Session, _sent = env
    token = _register(client).json()["debug_token"]
    if kind == "wrong":
        token = "not-a-real-token"
    elif kind == "empty":
        token = ""
    elif kind == "used":
        assert _verify(client, token).status_code == 200
        client.cookies.clear()
    else:
        _expire_tokens(Session, "newbie")
    response = _verify(client, token)
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "INVALID_VERIFICATION_TOKEN"
    assert not client.cookies.get("echo_session")
    if kind != "used":
        assert _status(Session, "newbie") == "pending"


def test_verify_email_is_rate_limited(env):
    client, _Session, _sent = env
    codes = [_verify(client, f"guess-{i}").status_code for i in range(13)]
    assert codes[:12] == [400] * 12
    assert codes[12] == 429


def test_login_rate_limit_switch(env, monkeypatch):
    client, _Session, _sent = env
    codes = [_login(client, "nobody", "wrong").status_code for _ in range(11)]
    assert codes[:10] == [401] * 10
    assert codes[10] == 429
    monkeypatch.setenv("SX_LOGIN_RATE_LIMIT", "0")
    assert _login(client, "nobody", "wrong").status_code == 401


def test_resend_answers_the_same_for_unknown_email(env):
    client, _Session, sent = env
    _register(client)
    sent.clear()
    known = client.post("/api/auth/resend-verification", json={"email": "newbie@example.com"})
    unknown = client.post("/api/auth/resend-verification", json={"email": "nobody@example.com"})
    assert known.status_code == unknown.status_code == 202
    assert known.json()["verification_sent"] is unknown.json()["verification_sent"] is True
    assert "debug_token" not in unknown.json()
    assert [to for to, _ in sent] == ["newbie@example.com"]


def test_resend_retires_older_links(env):
    client, _Session, _sent = env
    first = _register(client).json()["debug_token"]
    second = client.post("/api/auth/resend-verification", json={"email": "newbie@example.com"}).json()["debug_token"]
    assert first != second
    assert _verify(client, first).status_code == 400
    assert _verify(client, second).status_code == 200


def test_resend_ignores_active_accounts(env):
    client, _Session, sent = env
    assert _verify(client, _register(client).json()["debug_token"]).status_code == 200
    sent.clear()
    response = client.post("/api/auth/resend-verification", json={"email": "newbie@example.com"})
    assert response.status_code == 202
    assert "debug_token" not in response.json()
    assert sent == []


def test_resend_is_rate_limited_per_account(env):
    client, _Session, _sent = env
    _register(client)
    codes = [
        client.post("/api/auth/resend-verification", json={"email": "newbie@example.com"}).status_code
        for _ in range(4)
    ]
    assert codes == [202, 202, 202, 429]


def test_unexpired_pending_user_blocks_reregistration(env):
    client, _Session, _sent = env
    _register(client)
    assert _register(client).status_code == 409
    other_email = _register(client, "newbie", email="else@example.com")
    assert other_email.status_code == 409
    assert other_email.json()["detail"]["code"] == "USERNAME_TAKEN"


def test_expired_pending_user_is_replaced(env):
    client, Session, _sent = env
    old = _register(client).json()["debug_token"]
    _expire_tokens(Session, "newbie")
    replaced = _register(client, "newbie2", email="newbie@example.com")
    assert replaced.status_code == 202, replaced.text
    with Session() as db:
        assert db.query(User).count() == 1
        assert db.query(User).one().username_norm == "newbie2"
    assert _verify(client, old).status_code == 400
    assert _verify(client, replaced.json()["debug_token"]).status_code == 200


def test_active_account_is_never_replaced(env):
    client, _Session, _sent = env
    assert _verify(client, _register(client).json()["debug_token"]).status_code == 200
    client.cookies.clear()
    response = _register(client, "other", email="newbie@example.com")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "EMAIL_TAKEN"


def test_verification_ttl_comes_from_env(env, monkeypatch):
    client, Session, _sent = env
    monkeypatch.setenv("SX_EMAIL_VERIFY_TTL_MIN", "5")
    _register(client)
    with Session() as db:
        row = db.query(EmailVerificationToken).one()
        remaining = row.expires_at.replace(tzinfo=row.expires_at.tzinfo or utcnow().tzinfo) - utcnow()
        assert timedelta(minutes=3) < remaining <= timedelta(minutes=5)


def test_allowlisted_invite_still_verifies(env, monkeypatch):
    client, Session, _sent = env
    monkeypatch.setenv("SX_REGISTRATION_ENABLED", "0")
    monkeypatch.setenv("SX_REGISTRATION_ALLOWLIST", "invited@example.com")
    response = _register(client, "invited", email="Invited@Example.com")
    assert response.status_code == 202
    assert not client.cookies.get("echo_session")
    assert _status(Session, "invited") == "pending"
    assert _login(client, "invited").status_code == 401
    assert _verify(client, response.json()["debug_token"]).status_code == 200
    assert _status(Session, "invited") == "active"


def test_honeypot_gets_fake_success_and_creates_nothing(env):
    client, Session, sent = env
    response = _register(client, website="https://spam.example")
    assert response.status_code == 202
    assert response.json() == {"verification_sent": True}
    assert sent == []
    with Session() as db:
        assert db.query(User).count() == 0
        assert db.query(EmailVerificationToken).count() == 0


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


@pytest.fixture
def turnstile_on(monkeypatch):
    monkeypatch.setenv("SX_TURNSTILE_SECRET", "test-secret")
    calls: list[dict] = []

    def fake_post(url, data=None, timeout=None):
        calls.append({"url": url, "data": dict(data), "timeout": timeout})
        return _FakeResponse({"success": data["response"] == "good-token"})

    monkeypatch.setattr(turnstile.httpx, "post", fake_post)
    return calls


def test_turnstile_missing_or_bad_token_is_refused(env, turnstile_on):
    client, Session, _sent = env
    for extra in ({}, {"turnstile_token": ""}, {"turnstile_token": "bad-token"}):
        response = _register(client, **extra)
        assert response.status_code == 400, response.text
        assert response.json()["detail"]["code"] == "BOT_CHECK_FAILED"
    with Session() as db:
        assert db.query(User).count() == 0


def test_turnstile_good_token_passes_with_secret_and_ip(env, turnstile_on):
    client, _Session, _sent = env
    response = _register(client, turnstile_token="good-token")
    assert response.status_code == 202, response.text
    call = turnstile_on[-1]
    assert call["url"] == turnstile.SITEVERIFY_URL
    assert call["data"]["secret"] == "test-secret"
    assert call["data"]["response"] == "good-token"
    assert call["timeout"] == 5.0


def test_turnstile_outage_fails_closed(env, turnstile_on, monkeypatch):
    client, _Session, _sent = env

    def boom(*args, **kwargs):
        raise httpx.ConnectTimeout("down")

    monkeypatch.setattr(turnstile.httpx, "post", boom)
    response = _register(client, turnstile_token="good-token")
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BOT_CHECK_FAILED"


def test_turnstile_skipped_when_secret_unset(env, monkeypatch):
    client, _Session, _sent = env

    def never(*args, **kwargs):
        raise AssertionError("siteverify must not be called without a secret")

    monkeypatch.setattr(turnstile.httpx, "post", never)
    assert _register(client).status_code == 202


def test_turnstile_boot_warning(monkeypatch, caplog):
    monkeypatch.delenv("SX_TURNSTILE_SECRET", raising=False)
    with caplog.at_level("WARNING", logger="server.turnstile"):
        turnstile.log_turnstile_status()
    assert "SX_TURNSTILE_SECRET" in caplog.text


def test_csp_allows_turnstile(monkeypatch):
    policy = security_headers.build_policy("n0nce", "enforce")
    directives = {part.split(" ", 1)[0]: part for part in policy.split("; ")}
    assert "https://challenges.cloudflare.com" in directives["script-src"]
    assert "https://challenges.cloudflare.com" in directives["frame-src"]


def test_config_exposes_site_key(monkeypatch):
    from server.routers import config

    app = FastAPI()
    app.include_router(config.router)
    monkeypatch.setenv("SX_TURNSTILE_SITE_KEY", "0xSITE")
    with TestClient(app) as client:
        assert client.get("/api/config").json()["turnstile_site_key"] == "0xSITE"
    monkeypatch.delenv("SX_TURNSTILE_SITE_KEY")
    with TestClient(app) as client:
        assert client.get("/api/config").json()["turnstile_site_key"] == ""


@pytest.mark.parametrize("index", [0, 1])
def test_migration_round_trip(tmp_path, monkeypatch, index):
    urls = ["sqlite:///" + str(tmp_path / "migrate.db")]
    import os

    if os.environ.get("SX_TEST_POSTGRES_URL"):
        urls.append(os.environ["SX_TEST_POSTGRES_URL"])
    if index >= len(urls):
        pytest.skip("SX_TEST_POSTGRES_URL is not set")
    url = urls[index]
    monkeypatch.setenv("DATABASE_URL", url)
    config = Config()
    config.set_main_option("script_location", str(REPO / "migrations"))
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    engine = sa.create_engine(url)
    if engine.dialect.name == "postgresql":
        # Other Postgres tests create tables with create_all on the same database.
        with engine.begin() as conn:
            conn.execute(sa.text("DROP SCHEMA public CASCADE; CREATE SCHEMA public"))
    try:
        command.upgrade(config, "20261021_0015")
        assert "email_verification_tokens" not in sa.inspect(engine).get_table_names()
        command.upgrade(config, "20261022_0016")
        columns = {c["name"] for c in sa.inspect(engine).get_columns("email_verification_tokens")}
        assert {"user_id", "token_hash", "expires_at", "used_at"} <= columns
        command.downgrade(config, "20261021_0015")
        assert "email_verification_tokens" not in sa.inspect(engine).get_table_names()
        command.upgrade(config, "head")
    finally:
        engine.dispose()
