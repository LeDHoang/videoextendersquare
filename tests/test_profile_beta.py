from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient
from argon2 import PasswordHasher
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.routers import account_safety, social
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import Follow, Post, Report, User


PASSWORD = "correct-horse-battery"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(
        auth,
        "PASSWORD_HASHER",
        PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1),
    )
    test_engine = create_engine(
        "sqlite:///" + str(tmp_path / "profile-beta.db"),
        connect_args={"check_same_thread": False},
    )
    testing_session = sessionmaker(
        bind=test_engine,
        autoflush=False,
        expire_on_commit=False,
    )
    Base.metadata.create_all(test_engine)

    application = FastAPI()
    application.include_router(account_safety.router)
    application.include_router(social.router)

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


def register(client: TestClient, username: str, email: str, password: str = PASSWORD) -> dict:
    response = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "username": username,
            "password": password,
            "display_name": username.title(),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]


def csrf_headers(client: TestClient) -> dict[str, str]:
    token = client.cookies.get("echo_csrf")
    assert token
    return {"x-csrf-token": token}


def mutate(client: TestClient, method: str, path: str, body: dict | None = None):
    return client.request(
        method,
        path,
        headers=csrf_headers(client),
        json=body,
    )


def create_post(app: FastAPI, owner_id: str, path: str = "tests/profile-image.webp") -> str:
    with app.state.testing_session() as db:
        owner = db.get(User, owner_id)
        post = Post(
            owner_id=owner_id,
            media_path=path,
            media_type="image",
            title="Original title",
            caption="Original caption",
            location={},
            source="upload",
            status="published",
        )
        db.add(post)
        owner.post_count += 1
        db.commit()
        return post.id


def test_registration_login_csrf_and_profile_update(app):
    with TestClient(app) as client:
        user = register(client, "profile_user", "profile@example.com")
        assert user["username"] == "profile_user"
        assert client.cookies.get("echo_session")

        denied = client.patch("/api/users/me", json={"display_name": "No CSRF"})
        assert denied.status_code == 403
        assert denied.json()["detail"]["code"] == "CSRF_FAILED"

        updated = mutate(
            client,
            "PATCH",
            "/api/users/me",
            {"display_name": "Profile User", "bio": "Beta profile", "website": "https://example.com"},
        )
        assert updated.status_code == 200
        assert updated.json()["user"]["bio"] == "Beta profile"

        profile = client.get("/api/users/profile_user")
        assert profile.status_code == 200
        assert profile.json()["user"]["website"] == "https://example.com"

        logged_out = mutate(client, "POST", "/api/auth/logout")
        assert logged_out.status_code == 200
        assert client.get("/api/auth/me").json()["user"] is None

        login = client.post(
            "/api/auth/login",
            json={"identifier": "profile_user", "password": PASSWORD},
        )
        assert login.status_code == 200
        assert login.json()["user"]["username"] == "profile_user"


def test_post_edit_delete_follow_save_and_block_visibility(app):
    with TestClient(app) as owner_client, TestClient(app) as viewer_client:
        owner = register(owner_client, "post_owner", "owner@example.com")
        register(viewer_client, "post_viewer", "viewer@example.com")
        post_id = create_post(app, owner["id"])

        forbidden = mutate(
            viewer_client,
            "PATCH",
            f"/api/posts/{post_id}",
            {"title": "Not mine"},
        )
        assert forbidden.status_code == 403

        edited = mutate(
            owner_client,
            "PATCH",
            f"/api/posts/{post_id}",
            {"title": "Edited title", "caption": "Edited caption", "tags": ["beta", "demo"]},
        )
        assert edited.status_code == 200
        assert edited.json()["post"]["title"] == "Edited title"

        followed = mutate(viewer_client, "PUT", "/api/users/post_owner/follow")
        assert followed.status_code == 200
        assert followed.json()["following"] is True

        saved = mutate(viewer_client, "PUT", f"/api/posts/{post_id}/save")
        assert saved.status_code == 200
        assert saved.json()["saved"] is True
        saved_items = viewer_client.get("/api/users/me/saved").json()["items"]
        assert [item["id"] for item in saved_items] == [post_id]

        reported = mutate(
            viewer_client,
            "POST",
            "/api/reports",
            {
                "target_type": "post",
                "target_id": post_id,
                "reason": "spam",
                "details": "Post report regression",
            },
        )
        assert reported.status_code == 200
        assert reported.json()["report"]["target_id"] == post_id

        self_report = mutate(
            owner_client,
            "POST",
            "/api/reports",
            {"target_type": "post", "target_id": post_id, "reason": "spam"},
        )
        assert self_report.status_code == 422

        blocked = mutate(viewer_client, "PUT", "/api/users/post_owner/block")
        assert blocked.status_code == 200
        assert viewer_client.get("/api/users/post_owner").status_code == 404
        assert viewer_client.get(f"/api/posts/{post_id}").status_code == 404
        assert viewer_client.get("/api/feed").json()["items"] == []
        assert viewer_client.get("/api/users/me/saved").json()["items"] == []

        with app.state.testing_session() as db:
            assert db.query(Follow).count() == 0

        unblocked = mutate(viewer_client, "DELETE", "/api/users/post_owner/block")
        assert unblocked.status_code == 200
        assert viewer_client.get(f"/api/posts/{post_id}").status_code == 200

        deleted = mutate(owner_client, "DELETE", f"/api/posts/{post_id}")
        assert deleted.status_code == 200
        assert owner_client.get(f"/api/posts/{post_id}").status_code == 404


def test_reporting_and_moderation_suspend(app, monkeypatch):
    monkeypatch.setenv("SX_ADMIN_USERS", "admin_user")
    with (
        TestClient(app) as target_client,
        TestClient(app) as reporter_client,
        TestClient(app) as admin_client,
    ):
        target = register(target_client, "reported_user", "reported@example.com")
        register(reporter_client, "reporter_user", "reporter@example.com")
        admin = register(admin_client, "admin_user", "admin@example.com")
        assert admin["can_moderate"] is True

        report_response = mutate(
            reporter_client,
            "POST",
            "/api/reports",
            {
                "target_type": "user",
                "target_id": target["id"],
                "reason": "harassment",
                "details": "Beta moderation test",
            },
        )
        assert report_response.status_code == 200
        report_id = report_response.json()["report"]["id"]

        assert reporter_client.get("/api/moderation/reports").status_code == 403
        queue = admin_client.get("/api/moderation/reports")
        assert queue.status_code == 200
        assert [row["id"] for row in queue.json()["reports"]] == [report_id]

        moderated = mutate(
            admin_client,
            "PATCH",
            f"/api/moderation/reports/{report_id}",
            {"action": "suspend_user", "resolution": "Suspended for beta review"},
        )
        assert moderated.status_code == 200
        assert moderated.json()["report"]["status"] == "resolved"
        assert target_client.get("/api/auth/me").json()["user"] is None

        with app.state.testing_session() as db:
            assert db.get(User, target["id"]).status == "suspended"
            assert db.get(Report, report_id).moderator_id == admin["id"]


def test_password_reset_then_account_deletion(app, monkeypatch):
    monkeypatch.setenv("SX_PASSWORD_RESET_EXPOSE_TOKEN", "1")
    with TestClient(app) as client:
        user = register(client, "reset_user", "reset@example.com")
        reset_request = client.post(
            "/api/auth/password-reset/request",
            json={"email": "reset@example.com"},
        )
        assert reset_request.status_code == 200
        reset_payload = reset_request.json()
        assert "delivery_configured" not in reset_payload
        token = reset_payload["debug_token"]

        new_password = "new-correct-horse-password"
        confirmed = client.post(
            "/api/auth/password-reset/confirm",
            json={"token": token, "new_password": new_password},
        )
        assert confirmed.status_code == 200
        assert client.get("/api/auth/me").json()["user"] is None

        old_login = client.post(
            "/api/auth/login",
            json={"identifier": "reset_user", "password": PASSWORD},
        )
        assert old_login.status_code == 401
        new_login = client.post(
            "/api/auth/login",
            json={"identifier": "reset_user", "password": new_password},
        )
        assert new_login.status_code == 200

        deleted = mutate(
            client,
            "DELETE",
            "/api/users/me",
            {"current_password": new_password, "confirmation": "DELETE"},
        )
        assert deleted.status_code == 200
        assert client.get("/api/auth/me").json()["user"] is None
        assert client.get("/api/users/reset_user").status_code == 404

        with app.state.testing_session() as db:
            deleted_user = db.get(User, user["id"])
            assert deleted_user.status == "deleted"
            assert deleted_user.email is None
            assert deleted_user.password_hash is None
