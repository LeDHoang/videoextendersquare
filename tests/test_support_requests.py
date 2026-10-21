"""Support inbox (migration 20261021_0015): public form, moderator queue, report wiring.

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

from verified_signup import register_verified
from server.routers import account_safety, social, support
from server.social import auth, email as email_module
from server.social.database import Base, get_db
from server.social.models import Post, Report, SupportRequest, User

REPO = Path(__file__).resolve().parents[1]
PASSWORD = "correct-horse-battery-99"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(
        auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1)
    )
    monkeypatch.setattr(social, "REGISTRATION_ENABLED", True)
    monkeypatch.setenv("SX_REGISTRATION_ENABLED", "1")
    monkeypatch.delenv("SX_REGISTRATION_ALLOWLIST", raising=False)
    monkeypatch.delenv("SX_SUPPORT_EMAIL", raising=False)
    monkeypatch.setenv("SX_ADMIN_USERS", "admin_user")
    monkeypatch.setenv("SX_MODERATOR_USERS", "mod_user")
    sent: list[tuple] = []
    monkeypatch.setattr(support, "send_support_notification", lambda *args: sent.append(args))
    engine = sa.create_engine(
        "sqlite:///" + str(tmp_path / "support.db"), connect_args={"check_same_thread": False}
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    application.include_router(account_safety.router)
    application.include_router(social.router)
    application.include_router(support.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    application.state.Session = Session
    application.state.sent = sent
    yield application
    engine.dispose()


def register(client: TestClient, username: str) -> dict:
    response = register_verified(client,
        json={
            "email": f"{username}@example.com",
            "username": username,
            "password": PASSWORD,
            "accept_terms": True,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]


def mutate(client: TestClient, method: str, path: str, body: dict | None = None):
    return client.request(method, path, headers={"x-csrf-token": client.cookies.get("echo_csrf")}, json=body)


def create_post(app: FastAPI, owner_id: str) -> str:
    with app.state.Session() as db:
        post = Post(
            owner_id=owner_id,
            media_path="tests/support.webp",
            media_type="image",
            title="Reported",
            caption="",
            location={},
            source="upload",
            status="published",
        )
        db.add(post)
        db.commit()
        return post.id


def test_signed_out_request_needs_an_email(app):
    with TestClient(app) as client:
        response = client.post("/api/support", json={"category": "appeal", "body": "Please review my suspension."})
        assert response.status_code == 422
        assert response.json()["detail"]["field"] == "email"
        ok = client.post(
            "/api/support",
            json={"category": "appeal", "email": "me@example.com", "subject": "Appeal", "body": "Please review."},
        )
        assert ok.status_code == 202, ok.text
    with app.state.Session() as db:
        row = db.get(SupportRequest, ok.json()["id"])
        assert row.email == "me@example.com" and row.user_id is None
        assert row.ip_hash and "testclient" not in row.ip_hash


def test_signed_out_request_from_foreign_origin_is_denied(app):
    with TestClient(app) as client:
        response = client.post(
            "/api/support",
            headers={"origin": "https://evil.example"},
            json={"category": "other", "email": "me@example.com", "body": "hi"},
        )
        assert response.status_code == 403


def test_honeypot_drops_the_request_but_answers_202(app):
    with TestClient(app) as client:
        response = client.post(
            "/api/support",
            json={"category": "other", "email": "bot@example.com", "body": "buy now", "website": "http://spam"},
        )
        assert response.status_code == 202
        assert response.json()["id"]
    with app.state.Session() as db:
        assert db.query(SupportRequest).count() == 0
    assert app.state.sent == []


def test_rate_limit_returns_429(app):
    with TestClient(app) as client:
        payload = {"category": "bug", "email": "me@example.com", "body": "It broke."}
        codes = [client.post("/api/support", json=payload).status_code for _ in range(support.IP_LIMIT_PER_HOUR + 1)]
        assert codes[:-1] == [202] * support.IP_LIMIT_PER_HOUR
        assert codes[-1] == 429


def test_signed_in_user_rate_limit_returns_429(app):
    with TestClient(app) as client:
        register(client, "busy_user")
        payload = {"category": "bug", "body": "It broke."}
        codes = [mutate(client, "POST", "/api/support", payload).status_code for _ in range(support.USER_LIMIT_PER_HOUR + 1)]
        assert codes[-1] == 429 and codes[:-1] == [202] * support.USER_LIMIT_PER_HOUR


def test_signed_in_report_content_creates_a_report(app):
    with TestClient(app) as owner_client, TestClient(app) as client:
        owner = register(owner_client, "post_owner")
        reporter = register(client, "reporter")
        post_id = create_post(app, owner["id"])
        response = mutate(
            client,
            "POST",
            "/api/support",
            {"category": "report_content", "link": f"https://echo.example/reels?post={post_id}", "body": "Stolen video."},
        )
        assert response.status_code == 202, response.text
        report_id = response.json()["report_id"]
        assert report_id
        profile = mutate(client, "POST", "/api/support", {"category": "report_content", "link": "/profile/post_owner"})
        assert profile.status_code == 202, profile.text
    with app.state.Session() as db:
        report = db.get(Report, report_id)
        assert (report.target_type, report.target_id, report.reporter_id) == ("post", post_id, reporter["id"])
        assert db.get(SupportRequest, response.json()["id"]).report_id == report_id
        assert db.get(Report, profile.json()["report_id"]).target_type == "user"


@pytest.mark.parametrize("link", ["", "https://example.com/elsewhere", "/reels?post=missing", "/packs/nope", "/profile/ghost"])
def test_bad_report_link_returns_422(app, link):
    with TestClient(app) as client:
        register(client, "linker")
        response = mutate(client, "POST", "/api/support", {"category": "report_content", "link": link, "body": "x"})
        assert response.status_code == 422
        assert response.json()["detail"]["field"] == "link"


def test_signed_out_report_link_is_kept_and_filed_by_a_moderator(app):
    with TestClient(app) as owner_client, TestClient(app) as anon, TestClient(app) as mod_client:
        owner = register(owner_client, "post_owner")
        register(mod_client, "mod_user")
        post_id = create_post(app, owner["id"])
        response = anon.post(
            "/api/support",
            json={"category": "report_content", "email": "a@example.com", "link": f"/reels?post={post_id}", "body": "bad"},
        )
        assert response.status_code == 202, response.text
        request_id = response.json()["id"]
        assert response.json()["report_id"] is None
        with app.state.Session() as db:
            assert db.query(Report).count() == 0

        queue = mod_client.get("/api/moderation/support").json()["requests"]
        assert queue[0]["can_file_report"] is True
        filed = mutate(mod_client, "POST", f"/api/moderation/support/{request_id}/file-report")
        assert filed.status_code == 200, filed.text
        assert filed.json()["request"]["status"] == "in_progress"
        again = mutate(mod_client, "POST", f"/api/moderation/support/{request_id}/file-report")
        assert again.status_code == 409
    with app.state.Session() as db:
        report = db.get(Report, filed.json()["report_id"])
        assert report.target_id == post_id


def test_moderators_list_and_patch_others_get_403(app):
    with TestClient(app) as anon, TestClient(app) as user_client, TestClient(app) as mod_client:
        register(user_client, "plain_user")
        moderator = register(mod_client, "mod_user")
        request_id = anon.post(
            "/api/support", json={"category": "privacy", "email": "p@example.com", "subject": "Data", "body": "Export"}
        ).json()["id"]

        assert anon.get("/api/moderation/support").status_code == 401
        assert user_client.get("/api/moderation/support").status_code == 403
        assert mutate(user_client, "PATCH", f"/api/moderation/support/{request_id}", {"status": "closed"}).status_code == 403
        assert mutate(user_client, "POST", f"/api/moderation/support/{request_id}/file-report").status_code == 403

        listed = mod_client.get("/api/moderation/support?status=open")
        assert listed.status_code == 200
        assert [row["id"] for row in listed.json()["requests"]] == [request_id]
        assert listed.json()["requests"][0]["body"] == "Export"

        patched = mutate(
            mod_client, "PATCH", f"/api/moderation/support/{request_id}", {"status": "closed", "note": "Sent export"}
        )
        assert patched.status_code == 200, patched.text
        body = patched.json()["request"]
        assert (body["status"], body["moderator_note"], body["handled_by"]) == ("closed", "Sent export", "mod_user")
        assert mod_client.get("/api/moderation/support?status=open").json()["requests"] == []
        assert len(mod_client.get("/api/moderation/support?status=all").json()["requests"]) == 1
    with app.state.Session() as db:
        assert db.get(SupportRequest, request_id).handled_by_id == moderator["id"]


def test_notification_is_queued_for_each_request(app):
    with TestClient(app) as client:
        response = client.post(
            "/api/support", json={"category": "copyright", "email": "c@example.com", "subject": "Mine", "body": "secret"}
        )
        assert response.status_code == 202
    assert app.state.sent == [(response.json()["id"], "copyright", "Mine")]


def test_support_notification_sends_without_body_and_skips_when_unset(monkeypatch):
    delivered = []
    monkeypatch.setattr(email_module, "_deliver", lambda message: delivered.append(message) or True)
    monkeypatch.setenv("SX_PUBLIC_URL", "https://echo.example")

    monkeypatch.delenv("SX_SUPPORT_EMAIL", raising=False)
    assert email_module.send_support_notification("req-1", "appeal", "Please") is False
    assert delivered == []

    monkeypatch.setenv("SX_SUPPORT_EMAIL", "support@echo.example")
    assert email_module.send_support_notification("req-1", "appeal", "Please\nreview") is True
    message = delivered[0]
    assert message["To"] == "support@echo.example"
    assert "appeal" in message["Subject"] and "\n" not in message["Subject"]
    content = message.get_content()
    assert "req-1" in content and "https://echo.example/moderation?tab=support" in content


def test_support_notification_failure_is_logged_not_raised(monkeypatch, caplog):
    def boom(message):
        raise OSError("smtp down")

    monkeypatch.setattr(email_module, "_deliver", boom)
    monkeypatch.setenv("SX_SUPPORT_EMAIL", "support@echo.example")
    assert email_module.send_support_notification("req-2", "bug", "x") is False
    assert "req-2" in caplog.text


def _suspend_via_report(app, admin_client, reporter_client, target_id) -> str:
    report = mutate(
        reporter_client, "POST", "/api/reports", {"target_type": "user", "target_id": target_id, "reason": "spam"}
    )
    assert report.status_code == 200, report.text
    report_id = report.json()["report"]["id"]
    suspended = mutate(admin_client, "PATCH", f"/api/moderation/reports/{report_id}", {"action": "suspend_user"})
    assert suspended.status_code == 200, suspended.text
    return report_id


def test_reinstate_user_is_admin_only_and_refuses_deleted_accounts(app):
    with (
        TestClient(app) as target_client,
        TestClient(app) as reporter_client,
        TestClient(app) as admin_client,
        TestClient(app) as mod_client,
    ):
        target = register(target_client, "appealer")
        register(reporter_client, "reporter")
        register(admin_client, "admin_user")
        register(mod_client, "mod_user")
        report_id = _suspend_via_report(app, admin_client, reporter_client, target["id"])
        path = f"/api/moderation/reports/{report_id}"

        assert mutate(mod_client, "PATCH", path, {"action": "reinstate_user"}).status_code == 403
        assert mutate(reporter_client, "PATCH", path, {"action": "reinstate_user"}).status_code == 403
        reinstated = mutate(admin_client, "PATCH", path, {"action": "reinstate_user", "resolution": "Appeal upheld"})
        assert reinstated.status_code == 200, reinstated.text
        assert "Appeal upheld" in reinstated.json()["report"]["resolution"]
        with app.state.Session() as db:
            assert db.get(User, target["id"]).status == "active"
        # Not suspended any more: nothing to undo.
        assert mutate(admin_client, "PATCH", path, {"action": "reinstate_user"}).status_code == 409

        with app.state.Session() as db:
            db.get(User, target["id"]).status = "deleted"
            db.commit()
        refused = mutate(admin_client, "PATCH", path, {"action": "reinstate_user"})
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "ACCOUNT_DELETED"
        with app.state.Session() as db:
            assert db.get(User, target["id"]).status == "deleted"


def _alembic(url: str, monkeypatch) -> Config:
    monkeypatch.setenv("DATABASE_URL", url)
    config = Config()
    config.set_main_option("script_location", str(REPO / "migrations"))
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return config


@pytest.mark.parametrize("index", [0, 1])
def test_support_requests_migration_round_trip(tmp_path, monkeypatch, index):
    urls = ["sqlite:///" + str(tmp_path / "migrate.db")]
    if os.environ.get("SX_TEST_POSTGRES_URL"):
        urls.append(os.environ["SX_TEST_POSTGRES_URL"])
    if index >= len(urls):
        pytest.skip("SX_TEST_POSTGRES_URL is not set")
    config = _alembic(urls[index], monkeypatch)
    engine = sa.create_engine(urls[index])
    try:
        command.upgrade(config, "20261020_0014")
        assert "support_requests" not in sa.inspect(engine).get_table_names()
        command.upgrade(config, "20261021_0015")
        columns = {column["name"] for column in sa.inspect(engine).get_columns("support_requests")}
        assert {"category", "status", "user_id", "email", "report_id", "ip_hash", "moderator_note", "handled_by_id"} <= columns
        command.downgrade(config, "20261020_0014")
        assert "support_requests" not in sa.inspect(engine).get_table_names()
        command.upgrade(config, "head")
    finally:
        engine.dispose()
