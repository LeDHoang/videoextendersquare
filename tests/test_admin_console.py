"""Staff console (migration 20261022_0017): /api/admin routes, report claims and the audit log.

The migration round trip runs on SQLite always, and on PostgreSQL too when
SX_TEST_POSTGRES_URL is set (that database must be disposable).
"""
from __future__ import annotations

from datetime import timedelta
import os
from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config
from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from server.routers import account_safety, admin, social, support
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import AuthSession, Comment, Post, ReelPack, ReelPackItem, Report, StaffAction, User, utcnow

REPO = Path(__file__).resolve().parents[1]
PASSWORD = "correct-horse-battery-99"
REASON = {"reason": "staff test"}


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(
        auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1)
    )
    monkeypatch.setattr(social, "REGISTRATION_ENABLED", True)
    monkeypatch.setenv("SX_REGISTRATION_ENABLED", "1")
    monkeypatch.delenv("SX_REGISTRATION_ALLOWLIST", raising=False)
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.setenv("SX_ADMIN_USERS", "admin_user")
    monkeypatch.setenv("SX_MODERATOR_USERS", "mod_user")
    monkeypatch.setattr(support, "send_support_notification", lambda *args: None)
    deleted_media: list = []
    monkeypatch.setattr(admin.media_store, "delete_paths", lambda paths: deleted_media.extend(paths) or 0)
    republished_media: list = []
    monkeypatch.setattr(admin.media_store, "republish_paths", lambda paths: republished_media.extend(paths) or 0)
    engine = sa.create_engine(
        "sqlite:///" + str(tmp_path / "admin.db"), connect_args={"check_same_thread": False}
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    for module in (account_safety, admin, social, support):
        application.include_router(module.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    application.state.Session = Session
    application.state.deleted_media = deleted_media
    application.state.republished_media = republished_media
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


def code(response) -> str:
    return response.json()["detail"]["code"]


def actions(app: FastAPI) -> list[tuple]:
    with app.state.Session() as db:
        rows = db.query(StaffAction).order_by(StaffAction.created_at, StaffAction.id).all()
        return [(row.action, row.target_type, row.target_id, row.report_id) for row in rows]


def create_post(app: FastAPI, owner_id: str, title: str = "Sunset") -> str:
    with app.state.Session() as db:
        post = Post(
            owner_id=owner_id, media_path=f"tests/{uuid4()}.webp", media_type="image",
            title=title, caption="", location={}, source="upload", status="published",
        )
        db.add(post)
        db.get(User, owner_id).post_count = 1
        db.commit()
        return post.id


def create_pack(app: FastAPI, owner_id: str) -> str:
    with app.state.Session() as db:
        pack = ReelPack(owner_id=owner_id, title="Alps trip", status="published")
        db.add(pack)
        db.commit()
        return pack.id


@pytest.fixture
def staff(app):
    with (
        TestClient(app) as admin_client,
        TestClient(app) as mod_client,
        TestClient(app) as user_client,
        TestClient(app) as other_client,
    ):
        yield {
            "admin": (admin_client, register(admin_client, "admin_user")),
            "mod": (mod_client, register(mod_client, "mod_user")),
            "user": (user_client, register(user_client, "target_user")),
            "other": (other_client, register(other_client, "other_user")),
        }


def test_routes_are_guarded_by_role(app, staff):
    admin_client, _ = staff["admin"]
    mod_client, _ = staff["mod"]
    user_client, target = staff["user"]
    with TestClient(app) as anonymous:
        assert anonymous.get("/api/admin/users").status_code == 401
    assert user_client.get("/api/admin/users").status_code == 403
    assert user_client.get("/api/admin/content").status_code == 403
    assert mod_client.get("/api/admin/users").status_code == 200
    assert mod_client.get("/api/admin/content").status_code == 200
    assert mod_client.get("/api/admin/audit").status_code == 403
    assert admin_client.get("/api/admin/audit").status_code == 200
    uid = target["id"]
    for method, path, body in [
        ("POST", f"/api/admin/users/{uid}/reinstate", REASON),
        ("PUT", f"/api/admin/users/{uid}/role", {"role": "moderator", **REASON}),
        ("POST", f"/api/admin/users/{uid}/delete", {"confirm_username": "target_user", **REASON}),
        ("POST", f"/api/admin/users/{uid}/credits", {"amount": 5, "request_id": "abcdefgh", **REASON}),
    ]:
        assert mutate(mod_client, method, path, body).status_code == 403, path
    # CSRF header is required on mutations.
    assert admin_client.post(f"/api/admin/users/{uid}/suspend", json=REASON).status_code == 403


def test_user_search_matches_username_email_and_id_and_pages(app, staff):
    mod_client, _ = staff["mod"]
    _, target = staff["user"]
    # Inserted directly: signup is rate limited per IP.
    with app.state.Session() as db:
        db.add_all([User(username=f"pager_{index}", username_norm=f"pager_{index}") for index in range(4)])
        db.commit()
    found = mod_client.get("/api/admin/users", params={"q": "@TARGET_u"}).json()["items"]
    assert [row["username"] for row in found] == ["target_user"]
    assert found[0]["email"] == "target_user@example.com" and found[0]["status"] == "active"
    assert mod_client.get("/api/admin/users", params={"q": "other_user@example"}).json()["items"][0]["username"] == "other_user"
    assert mod_client.get("/api/admin/users", params={"q": target["id"]}).json()["items"][0]["id"] == target["id"]
    # LIKE wildcards are matched literally.
    assert mod_client.get("/api/admin/users", params={"q": "%"}).json()["items"] == []

    seen, cursor = [], None
    while True:
        page = mod_client.get("/api/admin/users", params={"q": "pager_", "limit": 3, "cursor": cursor}).json()
        seen += [row["username"] for row in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert sorted(seen) == [f"pager_{index}" for index in range(4)]
    admins = mod_client.get("/api/admin/users", params={"role": "admin"}).json()["items"]
    assert [row["username"] for row in admins] == ["admin_user"]


def test_moderator_suspends_directly_with_protections(app, staff):
    admin_client, admin_user = staff["admin"]
    mod_client, mod_user = staff["mod"]
    user_client, target = staff["user"]

    refused = mutate(mod_client, "POST", f"/api/admin/users/{target['id']}/suspend", {"reason": "x"})
    assert refused.status_code == 422 and code(refused) == "REASON_REQUIRED"
    assert code(mutate(mod_client, "POST", f"/api/admin/users/{admin_user['id']}/suspend", REASON)) == "ADMIN_PROTECTED"
    assert mutate(admin_client, "POST", f"/api/admin/users/{mod_user['id']}/suspend", REASON).status_code == 200
    # The admin just suspended the moderator; reinstate before going on.
    assert mutate(admin_client, "POST", f"/api/admin/users/{mod_user['id']}/reinstate", REASON).status_code == 200
    with TestClient(app) as relogin:
        assert relogin.post("/api/auth/login", json={"identifier": "mod_user", "password": PASSWORD}).status_code == 200
        with TestClient(app) as second_mod:
            register(second_mod, "mod_two")
            with app.state.Session() as db:
                db.query(User).filter(User.username == "mod_two").one().role = "moderator"
                db.commit()
            assert code(mutate(second_mod, "POST", f"/api/admin/users/{mod_user['id']}/suspend", REASON)) == "MODERATOR_PROTECTED"

        suspended = mutate(relogin, "POST", f"/api/admin/users/{target['id']}/suspend", {"reason": "spam wave"})
        assert suspended.status_code == 200, suspended.text
        assert suspended.json()["user"]["status"] == "suspended"
        assert user_client.get("/api/auth/me").json()["user"] is None
        again = mutate(relogin, "POST", f"/api/admin/users/{target['id']}/suspend", REASON)
        assert again.status_code == 409 and code(again) == "ACCOUNT_NOT_ACTIVE"

    reinstated = mutate(admin_client, "POST", f"/api/admin/users/{target['id']}/reinstate", {"reason": "appeal upheld"})
    assert reinstated.status_code == 200 and reinstated.json()["user"]["status"] == "active"
    assert code(mutate(admin_client, "POST", f"/api/admin/users/{target['id']}/reinstate", REASON)) == "ACCOUNT_NOT_SUSPENDED"
    logged = [row[0] for row in actions(app) if row[2] == target["id"]]
    assert logged == ["user.suspend", "user.reinstate"]
    with app.state.Session() as db:
        row = db.query(StaffAction).filter(StaffAction.action == "user.suspend", StaffAction.target_id == target["id"]).one()
        assert row.reason == "spam wave" and db.get(User, row.actor_id).username == "mod_user"


def test_sign_out_revokes_sessions_and_protects_staff_from_moderators(app, staff):
    admin_client, _ = staff["admin"]
    mod_client, _ = staff["mod"]
    user_client, target = staff["user"]
    _, admin_user = staff["admin"]
    assert code(mutate(mod_client, "POST", f"/api/admin/users/{admin_user['id']}/sign-out", REASON)) == "STAFF_PROTECTED"
    signed_out = mutate(mod_client, "POST", f"/api/admin/users/{target['id']}/sign-out", REASON)
    assert signed_out.status_code == 200 and signed_out.json()["revoked_sessions"] >= 1
    assert user_client.get("/api/auth/me").json()["user"] is None
    with app.state.Session() as db:
        assert db.query(AuthSession).filter(AuthSession.user_id == target["id"], AuthSession.revoked_at.is_(None)).count() == 0
        assert db.get(User, target["id"]).status == "active"
    detail = admin_client.get(f"/api/admin/users/{target['id']}").json()
    assert detail["active_sessions"] == 0
    assert detail["history"][0]["action"] == "user.sign_out"
    assert detail["history"][0]["details"]["sessions"] >= 1


def test_roles_live_in_the_db_and_env_is_a_floor(app, staff):
    admin_client, admin_user = staff["admin"]
    mod_client, mod_user = staff["mod"]
    _, target = staff["user"]
    path = f"/api/admin/users/{target['id']}/role"

    promoted = mutate(admin_client, "PUT", path, {"role": "moderator", "reason": "new team member"})
    assert promoted.status_code == 200 and promoted.json()["user"]["role"] == "moderator"
    # Login used to recompute the role from env and would drop it back to "user".
    with TestClient(app) as relogin:
        login = relogin.post("/api/auth/login", json={"identifier": "target_user", "password": PASSWORD})
        assert login.status_code == 200
        assert relogin.get("/api/admin/users").status_code == 200
    # Unchanged role: no audit row.
    assert mutate(admin_client, "PUT", path, {"role": "moderator", **REASON}).status_code == 200
    assert [row[0] for row in actions(app)].count("user.role") == 1

    floor = mutate(admin_client, "PUT", f"/api/admin/users/{mod_user['id']}/role", {"role": "user", **REASON})
    assert floor.status_code == 409 and code(floor) == "ROLE_FROM_ENV"
    raised = mutate(admin_client, "PUT", f"/api/admin/users/{mod_user['id']}/role", {"role": "admin", **REASON})
    assert raised.status_code == 200
    self_change = mutate(admin_client, "PUT", f"/api/admin/users/{admin_user['id']}/role", {"role": "user", **REASON})
    assert self_change.status_code == 422 and code(self_change) == "SELF_ROLE_CHANGE"
    with app.state.Session() as db:
        row = db.query(StaffAction).filter(StaffAction.action == "user.role").first()
        assert row.details == {"from": "user", "to": "moderator"}


def test_content_search_remove_and_restore(app, staff, tmp_path, monkeypatch):
    admin_client, _ = staff["admin"]
    mod_client, _ = staff["mod"]
    user_client, target = staff["user"]
    post_id = create_post(app, target["id"], title="Sunset over 100% lake")
    pack_id = create_pack(app, target["id"])
    comment = mutate(user_client, "POST", f"/api/posts/{post_id}/comments", {"text": "nice view"})
    assert comment.status_code == 200, comment.text
    comment_id = comment.json()["id"]

    posts = mod_client.get("/api/admin/content", params={"type": "post", "q": "100%"}).json()["items"]
    assert [row["id"] for row in posts] == [post_id] and posts[0]["owner"] == "target_user"
    assert posts[0]["link"] == f"/reels?post={post_id}"
    comments = mod_client.get("/api/admin/content", params={"type": "comment", "owner": "@target_user"}).json()["items"]
    assert [row["id"] for row in comments] == [comment_id]
    assert mod_client.get("/api/admin/content", params={"type": "message"}).status_code == 422

    removed = mutate(mod_client, "POST", f"/api/admin/content/comment/{comment_id}/remove", {"reason": "harassment"})
    assert removed.status_code == 200 and removed.json()["item"]["removed"] is True
    with app.state.Session() as db:
        assert db.get(Post, post_id).comment_count == 0
    again = mutate(mod_client, "POST", f"/api/admin/content/comment/{comment_id}/remove", REASON)
    assert again.status_code == 409 and code(again) == "CONTENT_ALREADY_REMOVED"
    assert mutate(mod_client, "POST", f"/api/admin/content/comment/{comment_id}/restore", REASON).status_code == 403
    restored = mutate(admin_client, "POST", f"/api/admin/content/comment/{comment_id}/restore", {"reason": "mistake"})
    assert restored.status_code == 200 and restored.json()["item"]["removed"] is False
    with app.state.Session() as db:
        assert db.get(Post, post_id).comment_count == 1
    assert code(mutate(admin_client, "POST", f"/api/admin/content/comment/{comment_id}/restore", REASON)) == "CONTENT_NOT_REMOVED"

    assert mutate(mod_client, "POST", f"/api/admin/content/pack/{pack_id}/remove", REASON).status_code == 200
    pack = mutate(admin_client, "POST", f"/api/admin/content/pack/{pack_id}/restore", REASON).json()["item"]
    assert pack["status"] == "draft" and pack["removed"] is False

    assert mutate(mod_client, "POST", f"/api/admin/content/post/{post_id}/remove", REASON).status_code == 200
    assert app.state.deleted_media, "post media are deleted after commit"
    with app.state.Session() as db:
        assert db.get(Post, post_id).status == "deleted"
        assert db.get(User, target["id"]).post_count == 0
    removed_only = mod_client.get("/api/admin/content", params={"type": "post", "status": "removed"}).json()["items"]
    assert [row["id"] for row in removed_only] == [post_id]

    # The kept local original is what makes a post restorable.
    monkeypatch.chdir(tmp_path)
    missing = mutate(admin_client, "POST", f"/api/admin/content/post/{post_id}/restore", REASON)
    assert missing.status_code == 409 and code(missing) == "MEDIA_MISSING"
    with app.state.Session() as db:
        original = tmp_path / "output" / db.get(Post, post_id).media_path
    original.parent.mkdir(parents=True)
    original.write_bytes(b"webp")
    restored_post = mutate(admin_client, "POST", f"/api/admin/content/post/{post_id}/restore", REASON)
    assert restored_post.status_code == 200, restored_post.text
    assert restored_post.json()["item"]["status"] == "published"
    assert app.state.republished_media, "post media are uploaded again"
    with app.state.Session() as db:
        assert db.get(Post, post_id).deleted_at is None
        assert db.get(User, target["id"]).post_count == 1

    assert [row[0] for row in actions(app)] == [
        "content.remove", "content.restore", "content.remove", "content.restore", "content.remove", "content.restore",
    ]


def test_author_deleted_content_cannot_be_restored(app, staff):
    admin_client, _ = staff["admin"]
    _, target = staff["user"]
    pack_id = create_pack(app, target["id"])
    with app.state.Session() as db:
        pack = db.get(ReelPack, pack_id)
        pack.status, pack.deleted_at = "deleted", utcnow()
        db.commit()
    refused = mutate(admin_client, "POST", f"/api/admin/content/pack/{pack_id}/restore", REASON)
    assert refused.status_code == 409 and code(refused) == "NOT_REMOVED_BY_STAFF"


def test_credit_adjustments_are_idempotent_and_audited(app, staff):
    admin_client, _ = staff["admin"]
    mod_client, _ = staff["mod"]
    _, target = staff["user"]
    path = f"/api/admin/users/{target['id']}/credits"
    assert code(mutate(admin_client, "POST", path, {"amount": 0, "request_id": "req-00001", **REASON})) == "INVALID_AMOUNT"
    assert code(mutate(admin_client, "POST", path, {"amount": 10_001, "request_id": "req-00001", **REASON})) == "INVALID_AMOUNT"
    assert code(mutate(admin_client, "POST", path, {"amount": 5, "request_id": "short", **REASON})) == "INVALID_REQUEST_ID"

    granted = mutate(admin_client, "POST", path, {"amount": 50, "request_id": "req-grant-1", "reason": "goodwill"})
    assert granted.status_code == 200, granted.text
    assert granted.json()["applied"] is True
    start = granted.json()["wallet"]["available_credits"]
    retried = mutate(admin_client, "POST", path, {"amount": 50, "request_id": "req-grant-1", "reason": "goodwill"})
    assert retried.json()["applied"] is False and retried.json()["wallet"]["available_credits"] == start
    debited = mutate(admin_client, "POST", path, {"amount": -20, "request_id": "req-debit-1", **REASON})
    assert debited.json()["applied"] is True and debited.json()["wallet"]["available_credits"] == start - 20

    detail = admin_client.get(f"/api/admin/users/{target['id']}").json()
    ledger = detail["credits"]["ledger"]
    assert [(row["source"], row["delta_available"]) for row in ledger[:2]] == [("admin", -20), ("admin", 50)]
    assert "credits" not in mod_client.get(f"/api/admin/users/{target['id']}").json()
    credit_rows = [row for row in actions(app) if row[0] == "user.credits"]
    assert len(credit_rows) == 2


def test_admin_deletes_an_account_with_confirmation(app, staff):
    admin_client, admin_user = staff["admin"]
    user_client, target = staff["user"]
    post_id = create_post(app, target["id"])
    path = f"/api/admin/users/{target['id']}/delete"
    assert code(mutate(admin_client, "POST", path, {"confirm_username": "nope", **REASON})) == "CONFIRMATION_REQUIRED"
    assert code(mutate(admin_client, "POST", f"/api/admin/users/{admin_user['id']}/delete", {"confirm_username": "admin_user", **REASON})) == "SELF_DELETE"

    deleted = mutate(admin_client, "POST", path, {"confirm_username": "@Target_User", "reason": "legal request"})
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["user"]["status"] == "deleted"
    assert user_client.get("/api/auth/me").json()["user"] is None
    with app.state.Session() as db:
        user = db.get(User, target["id"])
        assert user.username != "target_user" and user.email != "target_user@example.com"
        assert db.get(Post, post_id).status == "deleted"
        row = db.query(StaffAction).filter(StaffAction.action == "user.delete").one()
        assert row.target_id == target["id"] and row.details == {}
        assert "target_user" not in (row.reason + str(row.details))
    assert code(mutate(admin_client, "POST", path, {"confirm_username": "x", **REASON})) == "ACCOUNT_DELETED"


def file_report(client: TestClient, target_id: str) -> str:
    report = mutate(client, "POST", "/api/reports", {"target_type": "user", "target_id": target_id, "reason": "spam"})
    assert report.status_code == 200, report.text
    return report.json()["report"]["id"]


def test_report_claims_block_other_moderators_until_released_or_stale(app, staff):
    admin_client, _ = staff["admin"]
    mod_client, _ = staff["mod"]
    _, target = staff["user"]
    other_client, _ = staff["other"]
    report_id = file_report(other_client, target["id"])
    with TestClient(app) as second_mod:
        register(second_mod, "mod_two")
        with app.state.Session() as db:
            db.query(User).filter(User.username == "mod_two").one().role = "moderator"
            db.commit()

        claimed = mutate(mod_client, "POST", f"/api/moderation/reports/{report_id}/claim")
        assert claimed.status_code == 200 and claimed.json()["report"]["claimed_by"] == "mod_user"
        # Re-claiming your own claim refreshes it.
        assert mutate(mod_client, "POST", f"/api/moderation/reports/{report_id}/claim").status_code == 200
        conflict = mutate(second_mod, "POST", f"/api/moderation/reports/{report_id}/claim")
        assert conflict.status_code == 409 and conflict.json()["detail"]["claimed_by"] == "mod_user"
        blocked = mutate(second_mod, "PATCH", f"/api/moderation/reports/{report_id}", {"action": "dismiss", "force": True})
        assert blocked.status_code == 409 and code(blocked) == "REPORT_CLAIMED"
        assert code(mutate(second_mod, "DELETE", f"/api/moderation/reports/{report_id}/claim")) == "REPORT_CLAIMED"

        # A claim older than 30 minutes is free to take.
        with app.state.Session() as db:
            db.get(Report, report_id).claimed_at = utcnow() - timedelta(minutes=31)
            db.commit()
        taken = mutate(second_mod, "POST", f"/api/moderation/reports/{report_id}/claim")
        assert taken.status_code == 200 and taken.json()["report"]["claimed_by"] == "mod_two"
        released = mutate(second_mod, "DELETE", f"/api/moderation/reports/{report_id}/claim")
        assert released.json()["report"]["claimed_by"] is None

        assert mutate(mod_client, "POST", f"/api/moderation/reports/{report_id}/claim").status_code == 200
        forced = mutate(admin_client, "PATCH", f"/api/moderation/reports/{report_id}", {"action": "dismiss", "force": True})
        assert forced.status_code == 200, forced.text
        history = forced.json()["report"]["history"]
        assert [row["action"] for row in history] == [
            "report.claim", "report.claim", "report.claim", "report.release", "report.claim", "report.dismiss",
        ]
        assert history[-1]["actor"] == "admin_user"
        assert history[-1]["details"] == {"forced_claim_of": "mod_user"}
        assert forced.json()["report"]["claimed_by"] is None
        late = mutate(mod_client, "PATCH", f"/api/moderation/reports/{report_id}", {"action": "resolve"})
        assert late.status_code == 409 and code(late) == "REPORT_ALREADY_REVIEWED"


def test_reports_carry_a_preview_of_their_target(app, staff):
    mod_client, _ = staff["mod"]
    user_client, target = staff["user"]
    other_client, _ = staff["other"]
    post_id = create_post(app, target["id"], title="Lake")
    comment_id = mutate(user_client, "POST", f"/api/posts/{post_id}/comments", {"text": "rude words"}).json()["id"]
    reported = mutate(other_client, "POST", "/api/reports", {
        "target_type": "comment", "target_id": comment_id, "reason": "harassment", "details": "Insults me under my reel",
    }).json()["report"]
    assert reported["details"] == "Insults me under my reel"
    comment = reported["target"]
    assert comment["author"] == "target_user" and comment["link"] == f"/reels?post={post_id}"
    assert comment["post"]["title"] == "Lake" and comment["post"]["poster_url"]
    post_report = mutate(other_client, "POST", "/api/reports", {"target_type": "post", "target_id": post_id, "reason": "spam"})
    post = post_report.json()["report"]["target"]
    assert post["owner"] == "target_user" and post["removed"] is False and post["preview_url"]

    report_id = post_report.json()["report"]["id"]
    removed = mutate(mod_client, "PATCH", f"/api/moderation/reports/{report_id}", {"action": "remove_content"})
    post = removed.json()["report"]["target"]
    # Removed media are unpublished: no URL to load.
    assert post["removed"] is True and "preview_url" not in post
    assert post["link"] == f"/reels?post={post_id}"
    user_report = file_report(other_client, target["id"])
    listed = {row["id"]: row for row in mod_client.get("/api/moderation/reports", params={"status": "all"}).json()["reports"]}
    assert listed[user_report]["target"]["link"] == "/profile/target_user"


def test_pack_reports_preview_the_cover_and_first_reels(app, staff):
    _, target = staff["user"]
    other_client, _ = staff["other"]
    pack_id = create_pack(app, target["id"])
    post_ids = [create_post(app, target["id"], title=f"Stop {index}") for index in range(6)]
    with app.state.Session() as db:
        for position, post_id in enumerate(post_ids):
            db.add(ReelPackItem(pack_id=pack_id, post_id=post_id, position=position))
        db.get(ReelPack, pack_id).cover_post_id = post_ids[3]
        db.commit()
    reported = mutate(other_client, "POST", "/api/reports", {"target_type": "pack", "target_id": pack_id, "reason": "spam"})
    pack = reported.json()["report"]["target"]
    assert pack["owner"] == "target_user" and pack["item_count"] == 6
    assert [item["title"] for item in pack["items"]] == ["Stop 3", "Stop 0", "Stop 1", "Stop 2"]
    assert all(item["preview_url"] and item["link"] == f"/reels?post={item['id']}" for item in pack["items"])


def test_report_and_support_actions_are_audited_with_report_ids(app, staff):
    admin_client, _ = staff["admin"]
    mod_client, _ = staff["mod"]
    _, target = staff["user"]
    other_client, _ = staff["other"]
    report_id = file_report(other_client, target["id"])
    suspended = mutate(mod_client, "PATCH", f"/api/moderation/reports/{report_id}", {"action": "suspend_user"})
    assert suspended.status_code == 200, suspended.text
    reinstated = mutate(admin_client, "PATCH", f"/api/moderation/reports/{report_id}", {"action": "reinstate_user"})
    assert reinstated.status_code == 200
    history = reinstated.json()["report"]["history"]
    assert [(row["action"], row["actor"]) for row in history] == [
        ("user.suspend", "mod_user"), ("user.reinstate", "admin_user"),
    ]

    request = mutate(other_client, "POST", "/api/support", {"category": "bug", "subject": "Broken", "body": "It broke."})
    assert request.status_code == 202, request.text
    request_id = request.json()["id"]
    patched = mutate(mod_client, "PATCH", f"/api/moderation/support/{request_id}", {"status": "closed", "moderator_note": "fixed"})
    assert patched.status_code == 200, patched.text
    logged = actions(app)
    assert ("user.suspend", "user", target["id"], report_id) in logged
    assert ("user.reinstate", "user", target["id"], report_id) in logged
    assert ("support.update", "support", request_id, None) in logged

    audit = admin_client.get("/api/admin/audit", params={"target_id": target["id"]}).json()["items"]
    assert [(row["action"], row["target_label"]) for row in audit] == [
        ("user.reinstate", "target_user"), ("user.suspend", "target_user"),
    ]
    by_actor = admin_client.get("/api/admin/audit", params={"actor": "mod_user"}).json()["items"]
    assert {row["actor"] for row in by_actor} == {"mod_user"}
    detail = mod_client.get(f"/api/admin/users/{target['id']}").json()
    assert detail["reports_against"][0]["id"] == report_id
    assert [row["action"] for row in detail["history"]] == ["user.reinstate", "user.suspend"]


def test_staff_actions_are_immutable(app, staff):
    mod_client, _ = staff["mod"]
    _, target = staff["user"]
    mutate(mod_client, "POST", f"/api/admin/users/{target['id']}/sign-out", REASON)
    with app.state.Session() as db:
        row = db.query(StaffAction).first()
        row.reason = "edited"
        with pytest.raises(ValueError):
            db.commit()
        db.rollback()
        db.delete(db.query(StaffAction).first())
        with pytest.raises(ValueError):
            db.commit()


def _alembic(url: str, monkeypatch) -> Config:
    monkeypatch.setenv("DATABASE_URL", url)
    config = Config()
    config.set_main_option("script_location", str(REPO / "migrations"))
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return config


@pytest.mark.parametrize("index", [0, 1])
def test_staff_console_migration_round_trip(tmp_path, monkeypatch, index):
    urls = ["sqlite:///" + str(tmp_path / "migrate.db")]
    if os.environ.get("SX_TEST_POSTGRES_URL"):
        urls.append(os.environ["SX_TEST_POSTGRES_URL"])
    if index >= len(urls):
        pytest.skip("SX_TEST_POSTGRES_URL is not set")
    config = _alembic(urls[index], monkeypatch)
    engine = sa.create_engine(urls[index])
    try:
        command.upgrade(config, "20261022_0016")
        assert "staff_actions" not in sa.inspect(engine).get_table_names()
        command.upgrade(config, "20261022_0017")
        inspector = sa.inspect(engine)
        assert "staff_actions" in inspector.get_table_names()
        assert {"claimed_by_id", "claimed_at"} <= {column["name"] for column in inspector.get_columns("reports")}
        command.downgrade(config, "20261022_0016")
        inspector = sa.inspect(engine)
        assert "staff_actions" not in inspector.get_table_names()
        assert "claimed_by_id" not in {column["name"] for column in inspector.get_columns("reports")}
        command.upgrade(config, "head")
    finally:
        engine.dispose()
