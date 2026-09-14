from __future__ import annotations

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.routers import account_safety, messages, packs, reels, social
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import DirectMessage, EngagementEvent, Post, ReelPackItem, ReelPackSave, User


PASSWORD = "correct-horse-battery"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_MESSAGE_ENCRYPTION_KEY", "test-only-message-key-with-at-least-32-chars")
    monkeypatch.setattr(
        auth,
        "PASSWORD_HASHER",
        PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1),
    )
    test_engine = create_engine(
        "sqlite:///" + str(tmp_path / "packs.db"),
        connect_args={"check_same_thread": False},
    )
    testing_session = sessionmaker(bind=test_engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(test_engine)

    application = FastAPI()
    application.include_router(account_safety.router)
    application.include_router(social.router)
    application.include_router(packs.router)
    application.include_router(messages.router)
    application.include_router(reels.router)

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


def register(client: TestClient, username: str, email: str) -> dict:
    response = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "username": username,
            "password": PASSWORD,
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
    return client.request(method, path, headers=csrf_headers(client), json=body)


def create_posts(app: FastAPI, owner_id: str, count: int = 6) -> list[str]:
    with app.state.testing_session() as db:
        owner = db.get(User, owner_id)
        posts = []
        for index in range(count):
            post = Post(
                owner_id=owner_id,
                media_path=f"tests/pack-{owner_id[:5]}-{index}.mp4",
                media_type="video",
                title=f"Pack reel {index + 1}",
                caption="",
                location={"city": "Hanoi", "country": "Vietnam"},
                source="upload",
                status="published",
            )
            db.add(post)
            posts.append(post)
        owner.post_count += count
        db.commit()
        return [post.id for post in posts]


def create_pack(client: TestClient, post_ids: list[str], title: str = "Vietnam highlights") -> dict:
    response = mutate(
        client,
        "POST",
        "/api/packs",
        {
            "title": title,
            "description": "An authored sequence.",
            "visibility": "public",
            "tags": ["travel", "vietnam"],
            "location": {"city": "Hanoi", "country": "Vietnam"},
            "post_ids": post_ids,
            "cover_post_id": post_ids[0],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["pack"]


def test_pack_authoring_publish_discovery_save_progress_and_reorder(app):
    with TestClient(app) as owner_client, TestClient(app) as viewer_client:
        owner = register(owner_client, "pack_owner", "pack-owner@example.com")
        register(viewer_client, "pack_viewer", "pack-viewer@example.com")
        post_ids = create_posts(app, owner["id"])

        pack = create_pack(owner_client, post_ids)
        assert pack["status"] == "draft"
        assert pack["reel_count"] == 6
        assert owner_client.get("/api/packs").json()["items"] == []

        published = mutate(
            owner_client,
            "POST",
            f"/api/packs/{pack['id']}/publish",
            {"expected_revision": pack["revision"]},
        )
        assert published.status_code == 200, published.text
        pack = published.json()["pack"]
        assert pack["status"] == "published"

        discovered = viewer_client.get("/api/packs", params={"search": "Vietnam"})
        assert [row["id"] for row in discovered.json()["items"]] == [pack["id"]]

        saved = mutate(viewer_client, "PUT", f"/api/packs/{pack['id']}/save")
        assert saved.status_code == 200
        assert saved.json()["saved"] is True
        saved_again = mutate(viewer_client, "PUT", f"/api/packs/{pack['id']}/save")
        assert saved_again.status_code == 200
        assert saved_again.json()["saves"] == 1
        removed = mutate(viewer_client, "DELETE", f"/api/packs/{pack['id']}/save")
        assert removed.status_code == 200
        assert removed.json()["saves"] == 0
        removed_again = mutate(viewer_client, "DELETE", f"/api/packs/{pack['id']}/save")
        assert removed_again.status_code == 200
        assert removed_again.json()["saves"] == 0
        saved = mutate(viewer_client, "PUT", f"/api/packs/{pack['id']}/save")
        assert saved.json()["saves"] == 1
        assert viewer_client.get("/api/users/me/saved-packs").json()["items"][0]["id"] == pack["id"]

        detail = viewer_client.get(f"/api/packs/{pack['id']}").json()["pack"]
        first_item = detail["items"][0]
        progress = mutate(
            viewer_client,
            "PUT",
            f"/api/packs/{pack['id']}/progress",
            {"current_item_id": first_item["id"], "position_ms": 4200, "phase": "playing"},
        )
        assert progress.status_code == 200
        assert progress.json()["progress"]["position_ms"] == 4200

        reordered_ids = list(reversed(post_ids))
        edited = mutate(
            owner_client,
            "PATCH",
            f"/api/packs/{pack['id']}",
            {"expected_revision": pack["revision"], "post_ids": reordered_ids},
        )
        assert edited.status_code == 200, edited.text
        edited_pack = edited.json()["pack"]
        stable = {row["post"]["id"]: row["id"] for row in detail["items"]}
        assert {row["post"]["id"]: row["id"] for row in edited_pack["items"]} == stable

        conflict = mutate(
            owner_client,
            "PATCH",
            f"/api/packs/{pack['id']}",
            {"expected_revision": pack["revision"], "title": "Stale edit"},
        )
        assert conflict.status_code == 409

        playback = viewer_client.get("/api/reels/player-inline", params={"pack_id": pack["id"]})
        assert playback.status_code == 200, playback.text
        assert playback.json()["feed"]["surface"] == "pack"
        assert playback.json()["feed"]["has_more"] is False
        assert playback.json()["feed"]["pack_immersive_enabled"] is True


def test_pack_rules_unlisted_sharing_messages_and_reports(app):
    with TestClient(app) as owner_client, TestClient(app) as viewer_client:
        owner = register(owner_client, "pack_sender", "pack-sender@example.com")
        viewer = register(viewer_client, "pack_receiver", "pack-receiver@example.com")
        post_ids = create_posts(app, owner["id"], 7)

        too_short = create_pack(owner_client, post_ids[:4], "Too short")
        rejected = mutate(
            owner_client,
            "POST",
            f"/api/packs/{too_short['id']}/publish",
            {"expected_revision": too_short["revision"]},
        )
        assert rejected.status_code == 422

        pack = create_pack(owner_client, post_ids[:5], "Unlisted pack")
        updated = mutate(
            owner_client,
            "PATCH",
            f"/api/packs/{pack['id']}",
            {"expected_revision": pack["revision"], "visibility": "unlisted"},
        ).json()["pack"]
        published = mutate(
            owner_client,
            "POST",
            f"/api/packs/{pack['id']}/publish",
            {"expected_revision": updated["revision"]},
        ).json()["pack"]

        assert viewer_client.get("/api/packs").json()["items"] == []
        assert viewer_client.get(f"/api/packs/{published['id']}").status_code == 200

        saved = mutate(viewer_client, "PUT", f"/api/packs/{published['id']}/save")
        assert saved.status_code == 200
        assert saved.json()["saves"] == 1
        assert viewer_client.get("/api/users/me/saved-packs").json()["items"][0]["id"] == published["id"]

        first_share = mutate(
            owner_client,
            "POST",
            "/api/messages/share-content",
            {
                "kind": "pack",
                "target_id": published["id"],
                "usernames": [viewer["username"]],
                "note": "Open this pack",
                "client_id": "pack-share-batch-001",
            },
        )
        assert first_share.status_code == 200, first_share.text
        retry = mutate(
            owner_client,
            "POST",
            "/api/messages/share-content",
            {
                "kind": "pack",
                "target_id": published["id"],
                "usernames": [viewer["username"]],
                "note": "Open this pack",
                "client_id": "pack-share-batch-001",
            },
        )
        assert retry.json()["results"][0]["duplicate"] is True

        requests = viewer_client.get("/api/messages/bootstrap", params={"box": "requests"}).json()
        attachment = requests["conversations"][0]["last_message"]
        assert attachment["kind"] == "pack"
        assert attachment["pack"]["id"] == published["id"]
        assert attachment["post"] is None

        event = mutate(
            viewer_client,
            "POST",
            "/api/events",
            {
                "event_type": "pack_item_view",
                "pack_id": published["id"],
                "post_id": post_ids[0],
                "source": "pack",
                "client_event_id": "pack-event-attribution-001",
            },
        )
        assert event.status_code == 200, event.text
        with app.state.testing_session() as db:
            attributed = db.query(EngagementEvent).filter(
                EngagementEvent.client_event_id == "pack-event-attribution-001"
            ).one()
            assert attributed.pack_id == published["id"]
            assert attributed.post_id == post_ids[0]
            assert attributed.source == "pack"

        unpublished_response = mutate(
            owner_client,
            "POST",
            f"/api/packs/{published['id']}/unpublish",
            {"expected_revision": published["revision"]},
        )
        assert unpublished_response.status_code == 200, unpublished_response.text
        unpublished = unpublished_response.json()["pack"]
        assert viewer_client.get("/api/users/me/saved-packs").json()["items"] == []
        tombstone = viewer_client.get("/api/messages/bootstrap", params={"box": "requests"}).json()
        tombstone_message = tombstone["conversations"][0]["last_message"]
        assert tombstone_message["kind"] == "pack"
        assert tombstone_message["pack"] is None
        assert tombstone_message["attachment_unavailable"] is True

        republished_response = mutate(
            owner_client,
            "POST",
            f"/api/packs/{published['id']}/publish",
            {"expected_revision": unpublished["revision"]},
        )
        assert republished_response.status_code == 200, republished_response.text
        published = republished_response.json()["pack"]
        assert viewer_client.get("/api/users/me/saved-packs").json()["items"][0]["id"] == published["id"]
        restored = viewer_client.get("/api/messages/bootstrap", params={"box": "requests"}).json()
        assert restored["conversations"][0]["last_message"]["pack"]["id"] == published["id"]

        reported = mutate(
            viewer_client,
            "POST",
            "/api/reports",
            {"target_type": "pack", "target_id": published["id"], "reason": "spam"},
        )
        assert reported.status_code == 200

        with app.state.testing_session() as db:
            assert db.query(DirectMessage).count() == 1
            assert db.query(ReelPackItem).filter(ReelPackItem.pack_id == published["id"]).count() == 5
            assert db.query(ReelPackSave).filter(ReelPackSave.pack_id == published["id"]).count() == 1


def test_pack_member_validation_and_video_cover_fallback(app):
    with TestClient(app) as owner_client, TestClient(app) as other_client:
        owner = register(owner_client, "pack_validator", "pack-validator@example.com")
        other = register(other_client, "pack_outsider", "pack-outsider@example.com")
        post_ids = create_posts(app, owner["id"], 13)
        other_post_id = create_posts(app, other["id"], 1)[0]

        duplicate = mutate(
            owner_client,
            "POST",
            "/api/packs",
            {"title": "Duplicate", "post_ids": [post_ids[0], post_ids[0]]},
        )
        assert duplicate.status_code == 422
        assert duplicate.json()["detail"]["code"] == "DUPLICATE_PACK_ITEM"

        too_large = mutate(
            owner_client,
            "POST",
            "/api/packs",
            {"title": "Too large", "post_ids": post_ids},
        )
        assert too_large.status_code == 422

        foreign = mutate(
            owner_client,
            "POST",
            "/api/packs",
            {"title": "Foreign", "post_ids": post_ids[:4] + [other_post_id]},
        )
        assert foreign.status_code == 422
        assert foreign.json()["detail"]["code"] == "INVALID_PACK_ITEM"

        pack = create_pack(owner_client, post_ids[:5], "Video-only cover")
        assert not pack["cover_url"] or not pack["cover_url"].casefold().endswith(".mp4")


def test_pack_release_flags_are_independent(app, monkeypatch):
    with TestClient(app) as owner_client, TestClient(app) as viewer_client:
        owner = register(owner_client, "pack_flag_owner", "pack-flag-owner@example.com")
        register(viewer_client, "pack_flag_viewer", "pack-flag-viewer@example.com")
        post_ids = create_posts(app, owner["id"], 5)
        pack = create_pack(owner_client, post_ids, "Flagged pack")
        pack = mutate(
            owner_client,
            "POST",
            f"/api/packs/{pack['id']}/publish",
            {"expected_revision": pack["revision"]},
        ).json()["pack"]

        monkeypatch.setenv("SX_REEL_PACK_DISCOVERY_ENABLED", "0")
        assert viewer_client.get("/api/packs").json() == {"items": [], "next_offset": None, "total": 0}
        assert viewer_client.get(f"/api/packs/{pack['id']}").status_code == 200
        assert viewer_client.get(f"/api/users/{owner['username']}/packs").json()["items"] == []
        assert owner_client.get(f"/api/users/{owner['username']}/packs").json()["items"][0]["id"] == pack["id"]

        monkeypatch.setenv("SX_REEL_PACK_IMMERSIVE_ENABLED", "false")
        playback = viewer_client.get("/api/reels/player-inline", params={"pack_id": pack["id"]})
        assert playback.status_code == 200
        assert playback.json()["feed"]["pack_immersive_enabled"] is False

        monkeypatch.setenv("SX_REEL_PACK_CREATION_ENABLED", "off")
        blocked = mutate(owner_client, "POST", "/api/packs", {"title": "Disabled"})
        assert blocked.status_code == 503
        assert blocked.json()["detail"]["code"] == "PACK_CREATION_DISABLED"


def test_pack_search_tag_location_pagination_and_item_timestamps(app):
    with TestClient(app) as owner_client, TestClient(app) as viewer_client:
        owner = register(owner_client, "pack_search_owner", "pack-search-owner@example.com")
        register(viewer_client, "pack_search_viewer", "pack-search-viewer@example.com")
        post_ids = create_posts(app, owner["id"], 5)

        definitions = [
            {
                "title": "Northern Nights",
                "description": "Street food journey after dark.",
                "tags": ["Night Market", "Vietnam"],
                "location": {"city": "Hanoi", "country": "Vietnam"},
            },
            {
                "title": "Coastal Mornings",
                "description": "A quiet route beside the sea.",
                "tags": ["Coast"],
                "location": {"city": "Da Nang", "country": "Vietnam"},
            },
            {
                "title": "Southern Motion",
                "description": "A fast city sequence.",
                "tags": ["City"],
                "location": {"city": "Ho Chi Minh City", "country": "Vietnam"},
            },
        ]
        published_ids = []
        first_pack = None
        for definition in definitions:
            draft = create_pack(owner_client, post_ids, definition["title"])
            updated_response = mutate(
                owner_client,
                "PATCH",
                f"/api/packs/{draft['id']}",
                {
                    "expected_revision": draft["revision"],
                    "description": definition["description"],
                    "tags": definition["tags"],
                    "location": definition["location"],
                },
            )
            assert updated_response.status_code == 200, updated_response.text
            updated = updated_response.json()["pack"]
            published_response = mutate(
                owner_client,
                "POST",
                f"/api/packs/{updated['id']}/publish",
                {"expected_revision": updated["revision"]},
            )
            assert published_response.status_code == 200, published_response.text
            published = published_response.json()["pack"]
            published_ids.append(published["id"])
            if first_pack is None:
                first_pack = published

        assert first_pack is not None
        for query in ("Northern", "street food", owner["username"], "night-market"):
            result = viewer_client.get("/api/packs", params={"search": query}).json()
            assert first_pack["id"] in {row["id"] for row in result["items"]}

        tagged = viewer_client.get("/api/packs", params={"tag": "#NIGHT MARKET"}).json()
        assert [row["id"] for row in tagged["items"]] == [first_pack["id"]]

        for location in ("hanoi--vietnam", "hanoi-vietnam"):
            located = viewer_client.get("/api/packs", params={"location": location}).json()
            assert [row["id"] for row in located["items"]] == [first_pack["id"]]

        first_page = viewer_client.get("/api/packs", params={"offset": 0, "limit": 2}).json()
        second_page = viewer_client.get(
            "/api/packs",
            params={"offset": first_page["next_offset"], "limit": 2},
        ).json()
        assert first_page["total"] == 3
        assert first_page["next_offset"] == 2
        assert second_page["next_offset"] is None
        assert {row["id"] for row in first_page["items"] + second_page["items"]} == set(published_ids)

        detail = viewer_client.get(f"/api/packs/{first_pack['id']}").json()["pack"]
        assert all(item["created_at"] and item["updated_at"] for item in detail["items"])

        stale_delete = mutate(
            owner_client,
            "DELETE",
            f"/api/packs/{first_pack['id']}",
            {"expected_revision": first_pack["revision"] - 1},
        )
        assert stale_delete.status_code == 409
        deleted = mutate(
            owner_client,
            "DELETE",
            f"/api/packs/{first_pack['id']}",
            {"expected_revision": first_pack["revision"]},
        )
        assert deleted.status_code == 200


def test_pack_player_uses_db_fallback_when_scan_misses(app):
    with TestClient(app) as owner_client, TestClient(app) as viewer_client:
        owner = register(owner_client, "pack_fallback_owner", "pack-fallback-owner@example.com")
        register(viewer_client, "pack_fallback_viewer", "pack-fallback-viewer@example.com")
        post_ids = create_posts(app, owner["id"], 5)
        pack = create_pack(owner_client, post_ids, "Fallback pack")
        pack = mutate(
            owner_client,
            "POST",
            f"/api/packs/{pack['id']}/publish",
            {"expected_revision": pack["revision"]},
        ).json()["pack"]
        playback = viewer_client.get("/api/reels/player-inline", params={"pack_id": pack["id"]})
        assert playback.status_code == 200, playback.text
        body = playback.json()
        assert body["count"] == 5
        assert body["feed"]["surface"] == "pack"
        # Items are embedded in the inline scripts as JSON; DB media_paths
        # like tests/pack-*.mp4 are not in output/ scan but must hydrate as
        # available via the DB fallback, not as unavailable tombstones.
        scripts = " ".join(body.get("scripts") or [])
        assert f'"pack_id": "{pack["id"]}"' in scripts or f'"pack_id":"{pack["id"]}"' in scripts
        assert '"available": true' in scripts or '"available":true' in scripts
        assert body["feed"]["pack"]["playable_count"] == 5


def test_pack_draft_share_blocked_and_progress_rejects_unavailable(app):
    with TestClient(app) as owner_client, TestClient(app) as viewer_client:
        owner = register(owner_client, "pack_draft_owner", "pack-draft-owner@example.com")
        viewer = register(viewer_client, "pack_draft_viewer", "pack-draft-viewer@example.com")
        post_ids = create_posts(app, owner["id"], 5)
        pack = create_pack(owner_client, post_ids, "Draft share pack")
        # Draft packs must not be shareable even by the owner (receiver would
        # see an instant tombstone).
        blocked = mutate(
            owner_client,
            "POST",
            "/api/messages/share-content",
            {
                "kind": "pack",
                "target_id": pack["id"],
                "usernames": [viewer["username"]],
                "client_id": "pack-draft-share-001",
            },
        )
        assert blocked.status_code == 422, blocked.text
        assert blocked.json()["detail"]["code"] == "PACK_NOT_PUBLISHED"

        pack = mutate(
            owner_client,
            "POST",
            f"/api/packs/{pack['id']}/publish",
            {"expected_revision": pack["revision"]},
        ).json()["pack"]
        detail = viewer_client.get(f"/api/packs/{pack['id']}").json()["pack"]
        first_item = detail["items"][0]
        # Soft-delete the underlying post so the item becomes unavailable.
        with app.state.testing_session() as db:
            post = db.get(Post, first_item["post"]["id"])
            post.status = "deleted"
            db.commit()
        unavailable = mutate(
            viewer_client,
            "PUT",
            f"/api/packs/{pack['id']}/progress",
            {"current_item_id": first_item["id"], "position_ms": 1000, "phase": "playing"},
        )
        assert unavailable.status_code == 422, unavailable.text
        assert unavailable.json()["detail"]["code"] == "PACK_ITEM_UNAVAILABLE"


def test_pack_delete_accepts_query_revision(app):
    with TestClient(app) as owner_client:
        owner = register(owner_client, "pack_query_delete", "pack-query-delete@example.com")
        post_ids = create_posts(app, owner["id"], 5)
        pack = create_pack(owner_client, post_ids, "Query delete pack")
        headers = csrf_headers(owner_client)
        response = owner_client.request(
            "DELETE",
            f"/api/packs/{pack['id']}?expected_revision={pack['revision']}",
            headers=headers,
        )
        assert response.status_code == 200, response.text


def test_pack_share_metadata_includes_preview(app):
    with TestClient(app) as owner_client, TestClient(app) as viewer_client:
        owner = register(owner_client, "pack_share_owner", "pack-share-owner@example.com")
        register(viewer_client, "pack_share_viewer", "pack-share-viewer@example.com")
        post_ids = create_posts(app, owner["id"], 5)
        pack = create_pack(owner_client, post_ids, "Share preview pack")
        pack = mutate(
            owner_client,
            "POST",
            f"/api/packs/{pack['id']}/publish",
            {"expected_revision": pack["revision"]},
        ).json()["pack"]
        shared = viewer_client.get(f"/api/packs/{pack['id']}/share").json()
        assert shared["kind"] == "pack"
        assert shared["pack_id"] == pack["id"]
        assert shared["canonical_url"].endswith(f"/packs/{pack['id']}")
        assert shared["title"] == "Share preview pack"
        assert shared["creator"]["username"] == owner["username"]
        assert shared["reel_count"] == 5
        assert shared["playable_count"] == 5
        assert shared["needs_repair"] is False
