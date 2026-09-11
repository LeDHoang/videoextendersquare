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
