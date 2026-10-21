from __future__ import annotations

from argon2 import PasswordHasher
from cryptography.exceptions import InvalidTag
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.routers import account_safety, messages, social
from server.social import auth
from server.social.database import Base, get_db
from server.social.message_crypto import (
    MessageCryptoConfigurationError,
    decrypt_payload,
    encrypt_payload,
)
from server.social.models import DirectMessage, MessageEvent, Post, Report, User


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
        "sqlite:///" + str(tmp_path / "messaging.db"),
        connect_args={"check_same_thread": False},
    )
    testing_session = sessionmaker(bind=test_engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(test_engine)

    application = FastAPI()
    application.include_router(account_safety.router)
    application.include_router(social.router)
    application.include_router(messages.router)

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
            "accept_terms": True,
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


def create_post(app: FastAPI, owner_id: str, path: str = "tests/share-reel.mp4") -> str:
    with app.state.testing_session() as db:
        owner = db.get(User, owner_id)
        post = Post(
            owner_id=owner_id,
            media_path=path,
            media_type="video",
            title="Shareable reel",
            caption="",
            location={},
            source="upload",
            status="published",
        )
        db.add(post)
        owner.post_count += 1
        db.commit()
        return post.id


def test_crypto_round_trip_tamper_wrong_aad_and_missing_key(monkeypatch):
    monkeypatch.setenv("SX_MESSAGE_ENCRYPTION_KEY", "test-only-message-key-with-at-least-32-chars")
    envelope = encrypt_payload({"text": "private hello"}, aad=b"message-aad")
    assert envelope.startswith("v1.")
    assert decrypt_payload(envelope, aad=b"message-aad") == {"text": "private hello"}

    with pytest.raises(InvalidTag):
        decrypt_payload(envelope, aad=b"wrong-aad")

    prefix, nonce, ciphertext = envelope.split(".")
    replacement = "A" if ciphertext[0] != "A" else "B"
    with pytest.raises((InvalidTag, ValueError)):
        decrypt_payload(f"{prefix}.{nonce}.{replacement}{ciphertext[1:]}", aad=b"message-aad")

    monkeypatch.delenv("SX_MESSAGE_ENCRYPTION_KEY")
    with pytest.raises(MessageCryptoConfigurationError):
        encrypt_payload({"text": "no key"}, aad=b"message-aad")


def test_request_routing_second_message_block_and_reply_auto_accept(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        alice = register(alice_client, "alice_user", "alice@example.com")
        bob = register(bob_client, "bob_user", "bob@example.com")

        first = mutate(
            alice_client,
            "POST",
            "/api/messages/direct",
            {"username": "bob_user", "kind": "text", "text": "hello", "client_id": "alice-first-001"},
        )
        assert first.status_code == 200, first.text
        conversation_id = first.json()["conversation"]["id"]
        assert first.json()["conversation"]["state"] == "pending"

        blocked_second = mutate(
            alice_client,
            "POST",
            f"/api/messages/conversations/{conversation_id}/messages",
            {"kind": "text", "text": "are you there?", "client_id": "alice-second-01"},
        )
        assert blocked_second.status_code == 409
        assert blocked_second.json()["detail"]["code"] == "REQUEST_PENDING"

        requests = bob_client.get("/api/messages/bootstrap", params={"box": "requests"})
        assert requests.status_code == 200
        assert requests.json()["conversations"][0]["is_request"] is True
        assert requests.json()["unread"]["requests"] == 1

        reply = mutate(
            bob_client,
            "POST",
            f"/api/messages/conversations/{conversation_id}/messages",
            {"kind": "emote", "emote": "👍", "client_id": "bob-reply-0001"},
        )
        assert reply.status_code == 200, reply.text

        inbox = alice_client.get("/api/messages/bootstrap", params={"box": "inbox"}).json()
        assert inbox["conversations"][0]["state"] == "active"
        assert inbox["unread"]["inbox"] == 1

        duplicate = mutate(
            bob_client,
            "POST",
            f"/api/messages/conversations/{conversation_id}/messages",
            {"kind": "emote", "emote": "👍", "client_id": "bob-reply-0001"},
        )
        assert duplicate.status_code == 200
        assert duplicate.json()["duplicate"] is True

        with app.state.testing_session() as db:
            assert db.query(DirectMessage).count() == 2
            alice_events = db.query(MessageEvent).filter(MessageEvent.recipient_id == alice["id"]).all()
            bob_events = db.query(MessageEvent).filter(MessageEvent.recipient_id == bob["id"]).all()
            assert {row.event_type for row in alice_events} >= {"message.created", "request.accepted"}
            assert {row.event_type for row in bob_events} >= {"message.created", "request.accepted"}


def test_followed_recipient_gets_active_conversation_and_batch_share_is_idempotent(app):
    with TestClient(app) as owner_client, TestClient(app) as fan_client, TestClient(app) as third_client:
        owner = register(owner_client, "reel_owner", "owner@example.com")
        register(fan_client, "following_fan", "fan@example.com")
        register(third_client, "third_user", "third@example.com")
        post_id = create_post(app, owner["id"])

        followed = mutate(fan_client, "PUT", "/api/users/reel_owner/follow")
        assert followed.status_code == 200

        shared = mutate(
            owner_client,
            "POST",
            "/api/messages/share-reel",
            {
                "post_id": post_id,
                "usernames": ["following_fan", "missing_user"],
                "note": "watch this",
                "client_id": "share-batch-0001",
            },
        )
        assert shared.status_code == 200, shared.text
        assert shared.json()["succeeded"] == 1
        assert shared.json()["failed"] == 1

        retry = mutate(
            owner_client,
            "POST",
            "/api/messages/share-reel",
            {
                "post_id": post_id,
                "usernames": ["following_fan"],
                "note": "watch this",
                "client_id": "share-batch-0001",
            },
        )
        assert retry.status_code == 200
        assert retry.json()["results"][0]["duplicate"] is True

        fan_inbox = fan_client.get("/api/messages/bootstrap", params={"box": "inbox"}).json()
        assert fan_inbox["conversations"][0]["state"] == "active"
        with app.state.testing_session() as db:
            assert db.query(DirectMessage).count() == 1


def test_message_report_preserves_encrypted_evidence_after_delete(app, monkeypatch):
    monkeypatch.setenv("SX_ADMIN_USERS", "moderator_admin")
    with TestClient(app) as sender_client, TestClient(app) as receiver_client, TestClient(app) as admin_client:
        register(sender_client, "report_sender", "sender@example.com")
        register(receiver_client, "report_receiver", "receiver@example.com")
        register(admin_client, "moderator_admin", "admin@example.com")

        sent = mutate(
            sender_client,
            "POST",
            "/api/messages/direct",
            {
                "username": "report_receiver",
                "kind": "text",
                "text": "evidence body",
                "client_id": "report-message-1",
            },
        ).json()
        message_id = sent["message"]["id"]

        reported = mutate(
            receiver_client,
            "POST",
            "/api/reports",
            {"target_type": "message", "target_id": message_id, "reason": "harassment"},
        )
        assert reported.status_code == 200, reported.text
        report_id = reported.json()["report"]["id"]

        deleted = mutate(sender_client, "DELETE", f"/api/messages/{message_id}")
        assert deleted.status_code == 200

        queue = admin_client.get("/api/moderation/reports")
        assert queue.status_code == 200
        report_payload = next(row for row in queue.json()["reports"] if row["id"] == report_id)
        assert report_payload["target"]["content"]["text"] == "evidence body"

        with app.state.testing_session() as db:
            assert db.get(Report, report_id).evidence_ciphertext.startswith("v1.")
            assert db.get(DirectMessage, message_id).deleted_at is not None


def _open_conversation(alice_client, bob_username="bob_user", text="hello", client_id="open-conv-0001"):
    response = mutate(
        alice_client,
        "POST",
        "/api/messages/direct",
        {"username": bob_username, "kind": "text", "text": text, "client_id": client_id},
    )
    assert response.status_code == 200, response.text
    return response.json()["conversation"]["id"], response.json()["message"]["id"]


def test_conversations_are_private_to_their_two_participants(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client, TestClient(app) as carol_client, TestClient(app) as anonymous:
        register(alice_client, "alice_user", "alice@example.com")
        register(bob_client, "bob_user", "bob@example.com")
        register(carol_client, "carol_user", "carol@example.com")
        conversation_id, message_id = _open_conversation(alice_client)
        base = f"/api/messages/conversations/{conversation_id}"

        # Signed-out visitors get nothing, on every read and write.
        for path in ("/api/messages/bootstrap", "/api/messages/unread-count", f"{base}/messages"):
            assert anonymous.get(path).status_code == 401, path
        assert anonymous.post(f"{base}/messages", json={"kind": "text", "text": "x"}).status_code in {401, 403}

        # A third account cannot read, post into, accept, decline, mark read, or delete.
        assert carol_client.get(f"{base}/messages").status_code == 404
        assert mutate(carol_client, "POST", f"{base}/messages", {"kind": "text", "text": "intruder"}).status_code == 404
        assert mutate(carol_client, "POST", f"{base}/accept").status_code == 404
        assert mutate(carol_client, "POST", f"{base}/decline").status_code == 404
        assert mutate(carol_client, "POST", f"{base}/read", {}).status_code == 404
        assert mutate(carol_client, "DELETE", f"/api/messages/{message_id}").status_code == 404
        assert carol_client.get("/api/messages/bootstrap").json()["conversations"] == []
        assert carol_client.get("/api/messages/bootstrap", params={"box": "requests"}).json()["conversations"] == []

        # Only the sender can delete their own message; the recipient cannot.
        forbidden = mutate(bob_client, "DELETE", f"/api/messages/{message_id}")
        assert forbidden.status_code == 403
        assert forbidden.json()["detail"]["code"] == "MESSAGE_FORBIDDEN"

        # Writes need the owner's CSRF token.
        assert alice_client.post(f"{base}/messages", json={"kind": "text", "text": "no csrf"}).status_code == 403

        with app.state.testing_session() as db:
            assert db.query(DirectMessage).count() == 1


def test_message_validation_self_unknown_user_and_length_limits(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice_user", "alice@example.com")
        register(bob_client, "bob_user", "bob@example.com")

        def direct(**body):
            return mutate(alice_client, "POST", "/api/messages/direct", {"username": "bob_user", "kind": "text", **body})

        assert direct(text="").json()["detail"]["code"] == "MESSAGE_REQUIRED"
        assert direct(text="   \n  ").json()["detail"]["code"] == "MESSAGE_REQUIRED"
        too_long = direct(text="x" * 2001)
        assert too_long.status_code == 422
        assert too_long.json()["detail"]["code"] == "MESSAGE_TOO_LONG"
        bad_emote = direct(kind="emote", emote="🦄", text="")
        assert bad_emote.json()["detail"]["code"] == "INVALID_EMOTE"
        assert direct(kind="text", text="hi", client_id="has spaces!").json()["detail"]["code"] == "INVALID_CLIENT_ID"

        myself = mutate(alice_client, "POST", "/api/messages/direct", {"username": "alice_user", "kind": "text", "text": "me"})
        assert myself.json()["detail"]["code"] == "SELF_MESSAGE"
        ghost = mutate(alice_client, "POST", "/api/messages/direct", {"username": "nobody_here", "kind": "text", "text": "hi"})
        assert ghost.status_code == 404

        # Exactly 2,000 characters is accepted and stored whole (trimmed of surrounding whitespace).
        exact = direct(text="y" * 2000, client_id="exact-2000-001")
        assert exact.status_code == 200, exact.text
        assert exact.json()["message"]["text"] == "y" * 2000

        with app.state.testing_session() as db:
            assert db.query(DirectMessage).count() == 1


def test_decline_closes_the_request_and_blocks_further_sends(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice_user", "alice@example.com")
        register(bob_client, "bob_user", "bob@example.com")
        conversation_id, _ = _open_conversation(alice_client)

        # Only the recipient can decide, and only on a pending incoming request.
        assert mutate(alice_client, "POST", f"/api/messages/conversations/{conversation_id}/accept").json()["detail"]["code"] == "REQUEST_NOT_PENDING"

        declined = mutate(bob_client, "POST", f"/api/messages/conversations/{conversation_id}/decline")
        assert declined.status_code == 200
        assert declined.json()["conversation"]["state"] == "declined"
        assert declined.json()["conversation"]["can_message"] is False

        # The declined request leaves both lists and nobody can send into it.
        assert bob_client.get("/api/messages/bootstrap", params={"box": "requests"}).json()["conversations"] == []
        assert alice_client.get("/api/messages/bootstrap").json()["conversations"] == []
        retry = mutate(
            alice_client,
            "POST",
            f"/api/messages/conversations/{conversation_id}/messages",
            {"kind": "text", "text": "please?", "client_id": "after-decline-1"},
        )
        assert retry.status_code == 409
        assert retry.json()["detail"]["code"] == "REQUEST_DECLINED"


def test_read_receipts_unread_counts_delete_and_history_paging(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice_user", "alice@example.com")
        register(bob_client, "bob_user", "bob@example.com")
        conversation_id, first_id = _open_conversation(alice_client, text="m0", client_id="page-msg-0000")
        base = f"/api/messages/conversations/{conversation_id}"
        assert mutate(bob_client, "POST", f"{base}/accept").status_code == 200
        for index in range(1, 6):
            sender = alice_client if index % 2 else bob_client
            assert mutate(sender, "POST", f"{base}/messages", {"kind": "text", "text": f"m{index}", "client_id": f"page-msg-{index:04d}"}).status_code == 200

        # Newest page first, `next_before` walks back without gaps or repeats.
        page = bob_client.get(f"{base}/messages", params={"limit": 2}).json()
        assert [m["text"] for m in page["messages"]] == ["m4", "m5"]
        older = bob_client.get(f"{base}/messages", params={"limit": 2, "before": page["next_before"]}).json()
        assert [m["text"] for m in older["messages"]] == ["m2", "m3"]
        oldest = bob_client.get(f"{base}/messages", params={"limit": 5, "before": older["next_before"]}).json()
        assert [m["text"] for m in oldest["messages"]] == ["m0", "m1"]
        assert oldest["next_before"] is None
        assert alice_client.get(f"{base}/messages", params={"before": "x", "after": "y"}).status_code == 422

        # Alice's latest message (m5) is unread for Bob until he marks it read.
        assert bob_client.get("/api/messages/unread-count").json()["unread_count"] == 1
        latest = page["messages"][-1]
        assert latest["text"] == "m5" and latest["read_by_recipient"] is False
        assert alice_client.get(f"{base}/messages", params={"limit": 1}).json()["messages"][0]["read_by_recipient"] is False
        read = mutate(bob_client, "POST", f"{base}/read", {"message_id": latest["id"]})
        assert read.json() == {"ok": True, "changed": True, "unread_count": 0}
        assert mutate(bob_client, "POST", f"{base}/read", {"message_id": latest["id"]}).json()["changed"] is False
        assert bob_client.get("/api/messages/unread-count").json()["unread_count"] == 0
        assert alice_client.get(f"{base}/messages", params={"limit": 1}).json()["messages"][0]["read_by_recipient"] is True

        # A message id from another conversation cannot be used as a read marker.
        assert mutate(bob_client, "POST", f"{base}/read", {"message_id": "does-not-exist"}).status_code == 404

        # Deleting keeps the slot (so history order is stable) but clears the content.
        assert mutate(alice_client, "DELETE", f"/api/messages/{first_id}").status_code == 200
        shown = bob_client.get(f"{base}/messages", params={"limit": 100}).json()["messages"]
        deleted = next(m for m in shown if m["id"] == first_id)
        assert deleted["deleted"] is True and deleted["text"] == "" and deleted["content"] == {}
        assert deleted["can_delete"] is False and deleted["can_report"] is False


def test_blocking_ends_messaging_and_hides_the_thread(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice_user", "alice@example.com")
        register(bob_client, "bob_user", "bob@example.com")
        conversation_id, _ = _open_conversation(alice_client)
        assert mutate(bob_client, "POST", f"/api/messages/conversations/{conversation_id}/accept").status_code == 200

        assert mutate(bob_client, "PUT", "/api/users/alice_user/block").status_code == 200

        base = f"/api/messages/conversations/{conversation_id}"
        for client in (alice_client, bob_client):
            assert client.get(f"{base}/messages").status_code == 404
            # A blocked thread disappears from both inboxes and request lists.
            assert client.get("/api/messages/bootstrap").json()["conversations"] == []
            assert client.get("/api/messages/bootstrap", params={"box": "requests"}).json()["conversations"] == []
        blocked_send = mutate(alice_client, "POST", f"{base}/messages", {"kind": "text", "text": "hey", "client_id": "blocked-send-1"})
        assert blocked_send.status_code == 403
        assert blocked_send.json()["detail"]["code"] == "MESSAGING_BLOCKED"
        blocked_direct = mutate(alice_client, "POST", "/api/messages/direct", {"username": "bob_user", "kind": "text", "text": "hey"})
        assert blocked_direct.status_code == 403


def test_conversation_list_pages_with_a_cursor_without_gaps_or_repeats(app):
    with TestClient(app) as alice_client:
        register(alice_client, "alice_user", "alice@example.com")
        senders = []
        # Registration is limited to 5 per IP per hour, so four senders plus Alice.
        for index in range(4):
            client = TestClient(app)
            client.__enter__()
            senders.append(client)
            register(client, f"sender_{index}", f"sender{index}@example.com")
            assert mutate(
                client, "POST", "/api/messages/direct",
                {"username": "alice_user", "kind": "text", "text": f"hello {index}", "client_id": f"page-conv-{index:04d}"},
            ).status_code == 200
        try:
            seen: list[str] = []
            cursor = None
            pages = 0
            while True:
                params = {"box": "requests", "limit": 1}
                if cursor:
                    params["cursor"] = cursor
                page = alice_client.get("/api/messages/bootstrap", params=params).json()
                pages += 1
                seen.extend(row["participant"]["username"] for row in page["conversations"])
                cursor = page["next_cursor"]
                assert len(page["conversations"]) == 1
                if not cursor:
                    break
                assert pages < 10
            # Newest conversation first; every conversation exactly once across 4 pages.
            assert seen == [f"sender_{index}" for index in reversed(range(4))]
            assert pages == 4

            # A garbage cursor is a client error, not a crash or an empty list.
            bad = alice_client.get("/api/messages/bootstrap", params={"box": "requests", "cursor": "not-a-cursor"})
            assert bad.status_code == 422
            assert bad.json()["detail"]["code"] == "INVALID_CURSOR"
            # The inbox box is separate: nothing there, no cursor.
            inbox = alice_client.get("/api/messages/bootstrap", params={"box": "inbox", "limit": 2}).json()
            assert inbox["conversations"] == [] and inbox["next_cursor"] is None
        finally:
            for client in senders:
                client.__exit__(None, None, None)


def test_deleted_account_dms_are_hidden_from_the_other_participant_but_kept(app, monkeypatch):
    monkeypatch.setenv("SX_ADMIN_USERS", "moderator_admin")
    with TestClient(app) as alice_client, TestClient(app) as bob_client, TestClient(app) as admin_client:
        alice = register(alice_client, "alice_user", "alice@example.com")
        bob = register(bob_client, "bob_user", "bob@example.com")
        register(admin_client, "moderator_admin", "admin@example.com")
        conversation_id, _ = _open_conversation(alice_client)
        base = f"/api/messages/conversations/{conversation_id}"
        assert mutate(bob_client, "POST", f"{base}/accept").status_code == 200
        reply = mutate(bob_client, "POST", f"{base}/messages", {"kind": "text", "text": "rude reply", "client_id": "bob-rude-0001"})
        bob_message_id = reply.json()["message"]["id"]
        unread_message = mutate(bob_client, "POST", f"{base}/messages", {"kind": "text", "text": "unread", "client_id": "bob-unread-001"})
        assert unread_message.status_code == 200
        reported = mutate(alice_client, "POST", "/api/reports", {"target_type": "message", "target_id": bob_message_id, "reason": "harassment"})
        assert reported.status_code == 200, reported.text
        report_id = reported.json()["report"]["id"]
        assert alice_client.get("/api/messages/unread-count").json()["unread_count"] == 2

        deleted = mutate(bob_client, "DELETE", "/api/users/me", {"current_password": PASSWORD, "confirmation": "DELETE"})
        assert deleted.status_code == 200, deleted.text

        # Alice no longer sees the conversation, its unread count, or its history.
        inbox = alice_client.get("/api/messages/bootstrap").json()
        assert inbox["conversations"] == [] and inbox["unread"]["total"] == 0
        assert alice_client.get("/api/messages/bootstrap", params={"box": "requests"}).json()["conversations"] == []
        assert alice_client.get("/api/messages/unread-count").json()["unread_count"] == 0
        assert alice_client.get(f"{base}/messages").status_code == 404
        send = mutate(alice_client, "POST", f"{base}/messages", {"kind": "text", "text": "hello?", "client_id": "after-delete-01"})
        assert send.status_code == 404
        assert mutate(alice_client, "POST", f"{base}/read", {}).status_code == 404

        with app.state.testing_session() as db:
            # Rows are kept for moderation; nothing is soft-deleted.
            assert db.query(DirectMessage).filter(DirectMessage.conversation_id == conversation_id).count() == 3
            assert db.query(DirectMessage).filter(DirectMessage.deleted_at.isnot(None)).count() == 0
            # The live stream skips the hidden conversation's events.
            assert db.query(MessageEvent).filter(MessageEvent.recipient_id == alice["id"]).count() > 0
            visible_events = db.query(MessageEvent).filter(
                MessageEvent.recipient_id == alice["id"],
                ~messages.deleted_counterpart_clause(MessageEvent.conversation_id, alice["id"]),
            ).count()
            assert visible_events == 0

        # A moderator can still open and act on the earlier report.
        queue = admin_client.get("/api/moderation/reports")
        assert queue.status_code == 200
        report_payload = next(row for row in queue.json()["reports"] if row["id"] == report_id)
        assert report_payload["target"]["content"]["text"] == "rude reply"
        acted = mutate(
            admin_client,
            "PATCH",
            f"/api/moderation/reports/{report_id}",
            {"action": "suspend_user", "resolution": "Harassment"},
        )
        assert acted.status_code == 200, acted.text
        assert acted.json()["report"]["status"] == "resolved"
        with app.state.testing_session() as db:
            # Moderation never revives a deleted account or its hidden thread.
            assert db.get(User, bob["id"]).status == "deleted"
        assert alice_client.get("/api/messages/bootstrap").json()["conversations"] == []
