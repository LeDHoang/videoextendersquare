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
from server.social.models import Follow, Post, PostTag, Report, Tag, User, UserBlock


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


def test_saved_posts_are_private_to_their_owner(app):
    with (
        TestClient(app) as owner_client,
        TestClient(app) as viewer_client,
        TestClient(app) as anon_client,
    ):
        owner = register(owner_client, "saved_owner", "saved-owner@example.com")
        register(viewer_client, "saved_viewer", "saved-viewer@example.com")
        post_id = create_post(app, owner["id"])
        assert mutate(viewer_client, "PUT", f"/api/posts/{post_id}/save").status_code == 200

        # The saver sees their own bookmark.
        mine = viewer_client.get("/api/users/me/saved").json()["items"]
        assert [item["id"] for item in mine] == [post_id]

        # Anonymous visitors cannot read any saved list.
        assert anon_client.get("/api/users/me/saved").status_code == 401

        # Another account only ever receives its own (empty) saved list.
        assert owner_client.get("/api/users/me/saved").json()["items"] == []

        # There is no per-username saved route, so a saver's list cannot be
        # requested by naming them.
        for client in (owner_client, anon_client):
            assert client.get("/api/users/saved_viewer/saved").status_code in {404, 405}
            assert client.get("/api/users/saved_viewer/saved-packs").status_code in {404, 405}

        # Profile and posts payloads never leak what a user saved.
        profile = anon_client.get("/api/users/saved_viewer").json()["user"]
        assert "saved" not in profile and "saved_count" not in profile
        posts = anon_client.get("/api/users/saved_viewer/posts").json()["items"]
        assert posts == []
        owner_posts = anon_client.get("/api/users/saved_owner/posts").json()["items"]
        assert owner_posts[0]["viewer_state"]["saved"] is False
        assert owner_posts[0]["saved_by_me"] is False


def test_profile_stats_top_tags_and_post_sorting(app):
    with TestClient(app) as owner_client, TestClient(app) as viewer_client:
        owner = register(owner_client, "stats_owner", "stats-owner@example.com")
        register(viewer_client, "stats_viewer", "stats-viewer@example.com")
        low = create_post(app, owner["id"], "tests/stats-low.webp")
        high = create_post(app, owner["id"], "tests/stats-high.webp")
        with app.state.testing_session() as db:
            db.get(Post, low).like_count = 2
            db.get(Post, low).view_count = 90
            db.get(Post, high).like_count = 7
            db.get(Post, high).view_count = 10
            neon, retro = Tag(name="neon", slug="neon"), Tag(name="retro", slug="retro")
            db.add_all([neon, retro])
            db.flush()
            db.add_all([
                PostTag(post_id=low, tag_id=neon.id),
                PostTag(post_id=high, tag_id=neon.id),
                PostTag(post_id=high, tag_id=retro.id),
            ])
            db.commit()

        profile = viewer_client.get("/api/users/stats_owner").json()["user"]
        assert profile["like_count"] == 9
        assert [(t["slug"], t["count"]) for t in profile["top_tags"]] == [("neon", 2), ("retro", 1)]

        def ids(sort, **extra):
            body = viewer_client.get("/api/users/stats_owner/posts", params={"sort": sort, **extra}).json()
            return [item["id"] for item in body["items"]], body["next_cursor"]

        assert ids("likes")[0] == [high, low]
        assert ids("views")[0] == [low, high]
        assert set(ids("bogus-sort")[0]) == {low, high}

        first_page, cursor = ids("likes", limit=1)
        assert first_page == [high] and cursor == "o:1"
        second_page, cursor = ids("likes", limit=1, cursor=cursor)
        assert second_page == [low] and cursor is None


def test_profile_website_accepts_bare_domains_and_rejects_unsafe_values(app):
    with TestClient(app) as client:
        register(client, "site_user", "site@example.com")

        def patch(website, bio="#tagged bio"):
            return mutate(client, "PATCH", "/api/users/me", {"bio": bio, "website": website})

        ok = patch("test.com")
        assert ok.status_code == 200, ok.text
        assert ok.json()["user"]["website"] == "https://test.com"
        assert ok.json()["user"]["bio"] == "#tagged bio"
        assert patch("www.test.com/me?x=1").json()["user"]["website"] == "https://www.test.com/me?x=1"
        assert patch("http://plain.example.org").json()["user"]["website"] == "http://plain.example.org"
        assert patch("  https://padded.dev  ").json()["user"]["website"] == "https://padded.dev"
        assert patch("").json()["user"]["website"] == ""

        for bad in ["javascript:alert(1)", "ftp://files.example.com", "data:text/html,x", "localhost", "has space.com", "test.com:99999", "https://"]:
            rejected = patch(bad, bio="should not be saved")
            assert rejected.status_code == 422, bad
            assert rejected.json()["detail"]["code"] == "INVALID_WEBSITE"
        # A rejected request must not partially apply.
        assert client.get("/api/users/site_user").json()["user"]["bio"] == "#tagged bio"


def test_editing_bio_hashtags_persists_across_saves_and_reads(app):
    with TestClient(app) as client, TestClient(app) as anon:
        register(client, "bio_editor", "bio-editor@example.com")

        def save(bio, website="https://keep.example.com"):
            response = mutate(client, "PATCH", "/api/users/me", {"bio": bio, "website": website})
            assert response.status_code == 200, response.text
            return response.json()["user"]

        assert save("intro\n#test\n#test")["bio"] == "intro\n#test\n#test"
        # Editing a hashtag in place must replace it, not be ignored.
        assert save("intro\n#test2\n#test")["bio"] == "intro\n#test2\n#test"
        assert save("intro\n#test2\n#test3")["website"] == "https://keep.example.com"

        for reader in (client, anon):
            assert reader.get("/api/users/bio_editor").json()["user"]["bio"] == "intro\n#test2\n#test3"
        assert client.get("/api/auth/me").json()["user"]["bio"] == "intro\n#test2\n#test3"

        # Clearing the bio (and the website) also persists.
        cleared = save("", website="")
        assert cleared["bio"] == "" and cleared["website"] == ""


def test_profile_editor_endpoints_require_the_signed_in_owner(app):
    with TestClient(app) as anon:
        # No session: every settings endpoint is closed (CSRF cookie absent too).
        for method, path, body in [
            ("PATCH", "/api/users/me", {"bio": "hijack"}),
            ("DELETE", "/api/users/me/avatar", None),
            ("PATCH", "/api/auth/password", {"current_password": "x", "new_password": "y" * 12}),
            ("DELETE", "/api/users/me", {"current_password": "x", "confirmation": "DELETE"}),
            ("PUT", "/api/users/anyone/block", None),
        ]:
            response = anon.request(method, path, json=body)
            assert response.status_code in {401, 403}, (method, path, response.status_code)
        assert anon.get("/api/users/me/blocked").status_code == 401
        assert anon.get("/api/users/me/blocked").json()["detail"]["code"] == "AUTH_REQUIRED"

    with TestClient(app) as alice, TestClient(app) as bob:
        register(alice, "alice_owner", "alice-owner@example.com")
        register(bob, "bob_other", "bob-other@example.com")

        # A write always lands on the caller's own account; there is no way to name another.
        assert mutate(bob, "PATCH", "/api/users/me", {"bio": "bob was here"}).status_code == 200
        assert alice.get("/api/users/alice_owner").json()["user"]["bio"] == ""
        assert alice.get("/api/users/bob_other").json()["user"]["bio"] == "bob was here"
        assert bob.patch("/api/users/alice_owner", json={"bio": "x"}).status_code in {404, 405}

        # A CSRF-less write from a signed-in session is refused too.
        assert alice.patch("/api/users/me", json={"bio": "no csrf"}).status_code == 403


def test_restricting_a_handle_from_settings(app):
    with TestClient(app) as client:
        register(client, "blocker_one", "blocker-one@example.com")
        with TestClient(app) as other:
            register(other, "target_two", "target-two@example.com")

        assert mutate(client, "PUT", "/api/users/blocker_one/block").status_code == 422
        assert mutate(client, "PUT", "/api/users/nobody_here/block").status_code == 404

        assert mutate(client, "PUT", "/api/users/target_two/block").json()["blocked"] is True
        # Restricting twice is harmless and the list holds exactly one entry.
        assert mutate(client, "PUT", "/api/users/target_two/block").status_code == 200
        listed = client.get("/api/users/me/blocked").json()["users"]
        assert [entry["username"] for entry in listed] == ["target_two"]

        assert mutate(client, "DELETE", "/api/users/target_two/block").json()["blocked"] is False
        assert client.get("/api/users/me/blocked").json()["users"] == []


def test_blocking_from_settings_cuts_every_tie_both_ways(app):
    with TestClient(app) as alice, TestClient(app) as bob, TestClient(app) as carol:
        alice_user = register(alice, "block_alice", "block-alice@example.com")
        bob_user = register(bob, "block_bob", "block-bob@example.com")
        register(carol, "block_carol", "block-carol@example.com")
        bob_post = create_post(app, bob_user["id"], "tests/block-bob.webp")
        alice_post = create_post(app, alice_user["id"], "tests/block-alice.webp")

        # Follow each other, then alice restricts bob.
        assert mutate(alice, "PUT", "/api/users/block_bob/follow").status_code == 200
        assert mutate(bob, "PUT", "/api/users/block_alice/follow").status_code == 200
        assert alice.get("/api/users/block_bob").json()["user"]["is_following"] is True

        assert mutate(alice, "PUT", "/api/users/block_bob/block").status_code == 200

        # Follows are removed in both directions and the counters follow.
        with app.state.testing_session() as db:
            assert db.query(Follow).count() == 0
            assert db.get(User, alice_user["id"]).follower_count == 0
            assert db.get(User, alice_user["id"]).following_count == 0
            assert db.get(User, bob_user["id"]).follower_count == 0
            assert db.get(User, bob_user["id"]).following_count == 0

        # Neither side can open the other's profile, posts or re-follow.
        for client, other_name, other_post in ((alice, "block_bob", bob_post), (bob, "block_alice", alice_post)):
            assert client.get(f"/api/users/{other_name}").status_code == 404
            assert client.get(f"/api/users/{other_name}/posts").status_code == 404
            assert client.get(f"/api/posts/{other_post}").status_code == 404
            assert mutate(client, "PUT", f"/api/users/{other_name}/follow").status_code == 403

        # A third party is unaffected.
        assert carol.get("/api/users/block_bob").status_code == 200
        assert carol.get(f"/api/posts/{bob_post}").status_code == 200

        # Only the blocker sees the entry; the blocked user has nothing listed.
        assert [u["username"] for u in alice.get("/api/users/me/blocked").json()["users"]] == ["block_bob"]
        assert bob.get("/api/users/me/blocked").json()["users"] == []
        # The blocked user cannot undo the block (their DELETE is on their own, empty row).
        assert mutate(bob, "DELETE", "/api/users/block_alice/block").status_code == 200
        assert alice.get("/api/users/block_bob").status_code == 404

        # Unblocking restores visibility but not the old follows.
        assert mutate(alice, "DELETE", "/api/users/block_bob/block").status_code == 200
        assert alice.get("/api/users/block_bob").json()["user"]["is_following"] is False
        assert bob.get("/api/users/block_alice").status_code == 200
        assert alice.get(f"/api/posts/{bob_post}").status_code == 200


def test_account_deletion_from_settings_is_guarded_and_thorough(app):
    with TestClient(app) as victim, TestClient(app) as friend, TestClient(app) as fan, TestClient(app) as anon:
        user = register(victim, "doomed_user", "doomed@example.com")
        register(friend, "friend_user", "friend@example.com")
        register(fan, "fan_user", "fan@example.com")
        friend_id = friend.get("/api/auth/me").json()["user"]["id"]
        fan_id = fan.get("/api/auth/me").json()["user"]["id"]
        post_id = create_post(app, user["id"])
        friend_post = create_post(app, friend_id, "tests/friend.webp")
        assert mutate(fan, "PUT", "/api/users/doomed_user/follow").status_code == 200
        assert mutate(victim, "PUT", "/api/users/fan_user/follow").status_code == 200
        assert mutate(fan, "PUT", f"/api/posts/{post_id}/like").status_code == 200
        assert mutate(victim, "PUT", "/api/users/friend_user/block").status_code == 200
        with app.state.testing_session() as db:
            assert db.get(User, fan_id).follower_count == 1 and db.get(User, fan_id).following_count == 1
        mutate(victim, "PATCH", "/api/users/me", {"bio": "bye"})

        # Every guard refuses without touching the account.
        wrong_password = mutate(victim, "DELETE", "/api/users/me", {"current_password": "not-it-at-all", "confirmation": "DELETE"})
        assert wrong_password.status_code == 400
        assert wrong_password.json()["detail"]["code"] == "INVALID_PASSWORD"
        wrong_token = mutate(victim, "DELETE", "/api/users/me", {"current_password": PASSWORD, "confirmation": "delete"})
        assert wrong_token.status_code == 422
        no_token = mutate(victim, "DELETE", "/api/users/me", {"current_password": PASSWORD})
        assert no_token.status_code == 422
        assert victim.request("DELETE", "/api/users/me", json={"current_password": PASSWORD, "confirmation": "DELETE"}).status_code == 403
        assert fan.get("/api/users/doomed_user").status_code == 200  # still alive after all refusals

        # Another signed-in user can only ever delete themselves.
        assert mutate(fan, "DELETE", "/api/users/me", {"current_password": PASSWORD + "x", "confirmation": "DELETE"}).status_code == 400
        assert fan.get("/api/users/doomed_user").status_code == 200

        stale_cookies = dict(victim.cookies)
        done = mutate(victim, "DELETE", "/api/users/me", {"current_password": PASSWORD, "confirmation": "DELETE"})
        assert done.status_code == 200 and done.json() == {"ok": True}

        # Session is gone, cookies cleared, and the old cookie no longer works.
        assert victim.get("/api/auth/me").json()["user"] is None
        anon.cookies.update(stale_cookies)
        assert anon.get("/api/auth/me").json()["user"] is None
        assert anon.patch("/api/users/me", json={"bio": "zombie"}, headers={"x-csrf-token": stale_cookies.get("echo_csrf", "")}).status_code in {401, 403}

        # Can't sign back in with either identifier.
        for identifier in ("doomed_user", "doomed@example.com"):
            assert anon.post("/api/auth/login", json={"identifier": identifier, "password": PASSWORD}).status_code == 401

        # Public footprint is gone: profile, posts, follow ties, block rows, counters.
        assert fan.get("/api/users/doomed_user").status_code == 404
        assert fan.get(f"/api/posts/{post_id}").status_code == 404
        assert fan.get(f"/api/posts/{friend_post}").status_code == 200
        # The unrelated account the victim had blocked can see the world normally again.
        assert friend.get("/api/users/fan_user").status_code == 200
        with app.state.testing_session() as db:
            gone = db.get(User, user["id"])
            assert gone.status == "deleted" and gone.email is None and gone.password_hash is None
            assert gone.username.startswith("deleted_") and gone.bio == "" and gone.display_name == "Deleted user"
            assert db.query(Follow).count() == 0
            assert db.query(UserBlock).count() == 0
            assert db.get(User, fan_id).follower_count == 0
            assert db.get(User, fan_id).following_count == 0
            assert db.get(Post, post_id).status == "deleted"

        # The handle and email can be claimed again by a fresh account.
        with TestClient(app) as reborn:
            fresh = register(reborn, "doomed_user", "doomed@example.com")
            assert fresh["id"] != user["id"]
