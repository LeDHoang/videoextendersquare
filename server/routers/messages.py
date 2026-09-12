"""Encrypted direct messaging, requests, realtime events, GIFs, and reel sharing."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request as UrlRequest, urlopen

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from cryptography.exceptions import InvalidTag
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from server.social.auth import AuthContext, aware, public_user, rate_limiter, require_auth, require_auth_csrf
from server.social.database import SessionLocal, get_db
from server.social.message_crypto import (
    MessageCryptoConfigurationError,
    decrypt_payload,
    encrypt_payload,
    message_aad,
)
from server.social.models import (
    Conversation,
    ConversationMember,
    DirectMessage,
    Follow,
    MessageEvent,
    Post,
    User,
    utcnow,
)
from server.social.safety import users_blocked
from server.social.services import get_post_by_reference, post_card, record_event


router = APIRouter(prefix="/api/messages", tags=["messages"])
MESSAGE_KINDS = {"text", "emote", "gif", "reel"}
CURATED_EMOTES = ["👍", "❤️", "😂", "😮", "😢", "😡", "🔥", "👏", "🎉", "💯", "🙌", "👀"]
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,64}$")
EVENT_RETENTION_DAYS = 30


class ConversationCreateRequest(BaseModel):
    username: str = Field(min_length=3, max_length=30)


class MessageCreateRequest(BaseModel):
    kind: Literal["text", "emote", "gif", "reel"] = "text"
    text: str = ""
    emote: str = ""
    gif_url: str = ""
    gif_preview_url: str = ""
    gif_title: str = ""
    post_id: str | None = None
    client_id: str | None = Field(default=None, max_length=64)


class DirectMessageRequest(MessageCreateRequest):
    username: str = Field(min_length=3, max_length=30)


class ShareReelRequest(BaseModel):
    post_id: str
    usernames: list[str] = Field(min_length=1, max_length=10)
    note: str = Field(default="", max_length=500)
    client_id: str = Field(min_length=8, max_length=64)


class ReadRequest(BaseModel):
    message_id: str | None = None


def fail(status: int, code: str, message: str, field: str | None = None):
    detail = {"code": code, "message": message}
    if field:
        detail["field"] = field
    raise HTTPException(status_code=status, detail=detail)


def require_messaging_user(user: User) -> None:
    if user.status != "active" or user.account_type in {"demo", "system"}:
        fail(403, "MESSAGING_UNAVAILABLE", "This account cannot use direct messaging.")


def direct_key(first_user_id: str, second_user_id: str) -> str:
    return ":".join(sorted((first_user_id, second_user_id)))


def encode_cursor(created_at: datetime, row_id: str) -> str:
    raw = json.dumps(
        {"created_at": created_at.isoformat(), "id": row_id},
        separators=(",", ":"),
    ).encode()
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(value: str | None) -> tuple[datetime, str] | None:
    if not value:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode())
        created_at = datetime.fromisoformat(str(payload["created_at"]).replace("Z", "+00:00"))
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        return created_at, str(payload["id"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        fail(422, "INVALID_CURSOR", "The message cursor is invalid.")


def member_context(
    db: Session,
    conversation_id: str,
    user_id: str,
) -> tuple[Conversation, ConversationMember, ConversationMember, User]:
    member = db.query(ConversationMember).filter(
        ConversationMember.conversation_id == conversation_id,
        ConversationMember.user_id == user_id,
    ).first()
    if not member:
        fail(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")
    conversation = db.get(Conversation, conversation_id)
    other_member = db.query(ConversationMember).filter(
        ConversationMember.conversation_id == conversation_id,
        ConversationMember.user_id != user_id,
    ).first()
    other_user = db.get(User, other_member.user_id) if other_member else None
    if not conversation or conversation.kind != "direct" or not other_member or not other_user:
        fail(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")
    return conversation, member, other_member, other_user


def participant_card(user: User, viewer_id: str) -> dict:
    if user.status != "active":
        return {
            "id": user.id,
            "username": user.username,
            "display_name": "Unavailable account",
            "avatar_url": None,
            "avatar_color": "#6B7280",
            "account_type": user.account_type,
            "status": user.status,
            "is_me": False,
        }
    return {**public_user(user, viewer_id=viewer_id), "status": user.status}


def message_payload(message: DirectMessage) -> tuple[dict, bool]:
    if message.deleted_at is not None:
        return {}, False
    try:
        return decrypt_payload(
            message.payload_ciphertext,
            aad=message_aad(message.id, message.conversation_id, message.sender_id, message.kind),
        ), False
    except (MessageCryptoConfigurationError, InvalidTag, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return {"text": "[Encrypted message unavailable]"}, True


def can_view_shared_post(db: Session, post: Post | None, viewer_id: str) -> bool:
    return bool(
        post
        and post.deleted_at is None
        and post.status == "published"
        and post.owner
        and post.owner.status == "active"
        and not users_blocked(db, viewer_id, post.owner_id)
    )


def serialize_message(
    db: Session,
    message: DirectMessage,
    viewer_id: str,
    other_member: ConversationMember | None = None,
) -> dict:
    deleted = message.deleted_at is not None
    content, encryption_unavailable = message_payload(message)
    shared_post = None
    attachment_unavailable = False
    if message.kind == "reel" and message.post_id and not deleted:
        post = get_post_by_reference(db, post_id=message.post_id)
        if can_view_shared_post(db, post, viewer_id):
            shared_post = post_card(post, db, viewer_id)
        else:
            attachment_unavailable = True
    read_by_recipient = False
    if message.sender_id == viewer_id and other_member and other_member.last_read_at:
        marker = (aware(other_member.last_read_at), other_member.last_read_message_id or "")
        read_by_recipient = marker >= (aware(message.created_at), message.id)
    display_text = content.get("text") or content.get("emote") or ""
    return {
        "id": message.id,
        "conversation_id": message.conversation_id,
        "sender_id": message.sender_id,
        "kind": "deleted" if deleted else message.kind,
        "content": {} if deleted else content,
        "text": "" if deleted else str(display_text),
        "post_id": None if deleted else message.post_id,
        "post": shared_post,
        "attachment_unavailable": attachment_unavailable,
        "encryption_unavailable": encryption_unavailable,
        "deleted": deleted,
        "can_delete": message.sender_id == viewer_id and not deleted,
        "can_report": message.sender_id != viewer_id and not deleted,
        "read_by_recipient": read_by_recipient,
        "created_at": message.created_at.isoformat() if message.created_at else None,
    }


def unread_for_member(db: Session, member: ConversationMember) -> int:
    query = db.query(DirectMessage.id).filter(
        DirectMessage.conversation_id == member.conversation_id,
        DirectMessage.sender_id != member.user_id,
        DirectMessage.deleted_at.is_(None),
    )
    if member.last_read_at:
        query = query.filter(
            or_(
                DirectMessage.created_at > member.last_read_at,
                and_(
                    DirectMessage.created_at == member.last_read_at,
                    DirectMessage.id > (member.last_read_message_id or ""),
                ),
            )
        )
    return query.count()


def conversation_box(conversation: Conversation, user_id: str) -> str | None:
    if conversation.state == "active":
        return "inbox"
    if conversation.state == "pending":
        return "inbox" if conversation.requester_id == user_id else "requests"
    return None


def serialize_conversation(
    db: Session,
    conversation: Conversation,
    member: ConversationMember,
    other_member: ConversationMember,
    other_user: User,
) -> dict:
    last_message = None
    if conversation.latest_message_id:
        last_message = db.get(DirectMessage, conversation.latest_message_id)
    if not last_message:
        last_message = db.query(DirectMessage).filter(
            DirectMessage.conversation_id == conversation.id,
        ).order_by(DirectMessage.created_at.desc(), DirectMessage.id.desc()).first()
    blocked = users_blocked(db, member.user_id, other_user.id)
    incoming_request = conversation.state == "pending" and conversation.requester_id != member.user_id
    return {
        "id": conversation.id,
        "kind": conversation.kind,
        "state": conversation.state,
        "box": conversation_box(conversation, member.user_id),
        "requester_id": conversation.requester_id,
        "is_request": incoming_request,
        "can_accept": incoming_request and not blocked,
        "can_decline": incoming_request and not blocked,
        "participant": participant_card(other_user, member.user_id),
        "blocked": blocked,
        "can_message": (
            conversation.state != "declined"
            and not (conversation.state == "pending" and conversation.requester_id == member.user_id and last_message)
            and other_user.status == "active"
            and other_user.account_type not in {"demo", "system"}
            and not blocked
        ),
        "unread_count": unread_for_member(db, member),
        "last_message": serialize_message(db, last_message, member.user_id, other_member) if last_message else None,
        "created_at": conversation.created_at.isoformat() if conversation.created_at else None,
        "updated_at": conversation.updated_at.isoformat() if conversation.updated_at else None,
        "accepted_at": conversation.accepted_at.isoformat() if conversation.accepted_at else None,
        "declined_at": conversation.declined_at.isoformat() if conversation.declined_at else None,
    }


def validate_client_id(value: str | None) -> str | None:
    client_id = value.strip() if value else None
    if client_id and not CLIENT_ID_RE.fullmatch(client_id):
        fail(422, "INVALID_CLIENT_ID", "The message client id is invalid.", "client_id")
    return client_id


def allowed_gif_hosts() -> set[str]:
    return {
        value.strip().casefold()
        for value in os.environ.get(
            "SX_TENOR_ALLOWED_HOSTS",
            "media.tenor.com,media1.tenor.com",
        ).split(",")
        if value.strip()
    }


def normalize_gif_url(value: str, field: str) -> str:
    cleaned = str(value or "").strip()
    if len(cleaned) > 2048:
        fail(422, "INVALID_GIF_URL", "GIF links are limited to 2,048 characters.", field)
    parsed = urlsplit(cleaned)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.hostname.casefold() not in allowed_gif_hosts()
    ):
        fail(422, "INVALID_GIF_URL", "Choose a GIF returned by the configured provider.", field)
    return cleaned


def normalize_message_content(req: MessageCreateRequest) -> dict:
    text = str(req.text or "").strip()
    if req.kind == "text":
        if not text:
            fail(422, "MESSAGE_REQUIRED", "Enter a message.", "text")
        if len(text) > 2000:
            fail(422, "MESSAGE_TOO_LONG", "Messages are limited to 2,000 characters.", "text")
        return {"text": text}
    if req.kind == "emote":
        emote = str(req.emote or text).strip()
        if emote not in CURATED_EMOTES:
            fail(422, "INVALID_EMOTE", "Choose a curated emote.", "emote")
        return {"emote": emote}
    if req.kind == "gif":
        url = normalize_gif_url(req.gif_url or text, "gif_url")
        preview_url = normalize_gif_url(req.gif_preview_url or url, "gif_preview_url")
        return {
            "url": url,
            "preview_url": preview_url,
            "title": str(req.gif_title or "").strip()[:200],
            "provider": "tenor",
        }
    if len(text) > 500:
        fail(422, "MESSAGE_TOO_LONG", "Reel notes are limited to 500 characters.", "text")
    return {"text": text}


def recipient_follows_sender(db: Session, recipient_id: str, sender_id: str) -> bool:
    return bool(db.query(Follow.id).filter(
        Follow.follower_id == recipient_id,
        Follow.followee_id == sender_id,
    ).first())


def target_user(db: Session, username: str, sender: User) -> User:
    require_messaging_user(sender)
    target = db.query(User).filter(
        User.username_norm == username.strip().casefold(),
        User.status == "active",
    ).first()
    if not target or target.account_type in {"demo", "system"}:
        fail(404, "USER_NOT_FOUND", "Profile not found.")
    if target.id == sender.id:
        fail(422, "SELF_MESSAGE", "You cannot message yourself.")
    if users_blocked(db, sender.id, target.id):
        fail(403, "MESSAGING_BLOCKED", "Messaging is unavailable between these accounts.")
    return target


def get_or_create_conversation(db: Session, sender: User, target: User) -> Conversation:
    key = direct_key(sender.id, target.id)
    conversation = db.query(Conversation).filter(Conversation.direct_key == key).first()
    if conversation:
        return conversation
    now = utcnow()
    state = "active" if recipient_follows_sender(db, target.id, sender.id) else "pending"
    conversation = Conversation(
        kind="direct",
        direct_key=key,
        requester_id=sender.id,
        state=state,
        accepted_at=now if state == "active" else None,
        created_at=now,
        updated_at=now,
    )
    db.add(conversation)
    db.flush()
    db.add_all([
        ConversationMember(conversation_id=conversation.id, user_id=sender.id, joined_at=now, last_read_at=now),
        ConversationMember(conversation_id=conversation.id, user_id=target.id, joined_at=now, last_read_at=now),
    ])
    db.flush()
    return conversation


def emit_event(
    db: Session,
    conversation: Conversation,
    event_type: str,
    message_id: str | None = None,
    recipients: list[str] | None = None,
) -> None:
    recipient_ids = recipients or [member.user_id for member in conversation.members]
    now = utcnow()
    for recipient_id in set(recipient_ids):
        db.add(MessageEvent(
            recipient_id=recipient_id,
            conversation_id=conversation.id,
            message_id=message_id,
            event_type=event_type,
            created_at=now,
        ))


def send_into_conversation(
    db: Session,
    conversation: Conversation,
    sender: User,
    req: MessageCreateRequest,
    *,
    apply_rate_limits: bool = True,
) -> tuple[DirectMessage, bool]:
    conversation, member, other_member, other_user = member_context(db, conversation.id, sender.id)
    require_messaging_user(sender)
    require_messaging_user(other_user)
    if users_blocked(db, sender.id, other_user.id):
        fail(403, "MESSAGING_BLOCKED", "Messaging is unavailable between these accounts.")
    if conversation.state == "declined":
        fail(409, "REQUEST_DECLINED", "This message request is closed.")
    if apply_rate_limits:
        rate_limiter.check(db, f"message-send-minute:{sender.id}", 60, 60)
        rate_limiter.check(db, f"message-send-day:{sender.id}", 500, 24 * 60 * 60)

    client_id = validate_client_id(req.client_id)
    if client_id:
        existing = db.query(DirectMessage).filter(
            DirectMessage.sender_id == sender.id,
            DirectMessage.client_id == client_id,
        ).first()
        if existing:
            if existing.conversation_id != conversation.id:
                fail(409, "CLIENT_ID_CONFLICT", "This message id was already used.")
            return existing, True

    existing_count = db.query(DirectMessage.id).filter(
        DirectMessage.conversation_id == conversation.id,
    ).count()
    auto_accepted = False
    if conversation.state == "pending":
        if sender.id == conversation.requester_id and existing_count:
            fail(409, "REQUEST_PENDING", "Wait for this message request to be accepted.")
        if sender.id != conversation.requester_id:
            conversation.state = "active"
            conversation.accepted_at = utcnow()
            conversation.declined_at = None
            auto_accepted = True

    content = normalize_message_content(req)
    post = None
    if req.kind == "reel":
        if not req.post_id:
            fail(422, "REEL_REQUIRED", "Choose a reel to share.", "post_id")
        post = get_post_by_reference(db, post_id=req.post_id)
        if not can_view_shared_post(db, post, sender.id):
            fail(404, "POST_NOT_FOUND", "Reel not found.")
    elif req.post_id:
        fail(422, "UNEXPECTED_POST", "Only reel messages can include a post.", "post_id")

    now = utcnow()
    message_id = str(uuid.uuid4())
    try:
        ciphertext = encrypt_payload(
            content,
            aad=message_aad(message_id, conversation.id, sender.id, req.kind),
        )
    except MessageCryptoConfigurationError:
        fail(503, "MESSAGE_ENCRYPTION_UNAVAILABLE", "Direct messaging encryption is not configured.")
    row = DirectMessage(
        id=message_id,
        conversation_id=conversation.id,
        sender_id=sender.id,
        kind=req.kind,
        payload_ciphertext=ciphertext,
        post_id=post.id if post else None,
        client_id=client_id,
        created_at=now,
    )
    db.add(row)
    # Flush the message before emitting events that reference it: when the
    # parent conversation is also dirty in the same flush, the unit of work
    # can otherwise attempt the message_events INSERT before the
    # direct_messages INSERT, violating the message_id foreign key.
    db.flush()
    conversation.latest_message_id = row.id
    conversation.updated_at = now
    member.last_read_at = now
    member.last_read_message_id = row.id
    if auto_accepted:
        emit_event(db, conversation, "request.accepted")
    emit_event(db, conversation, "message.created", row.id)
    if post:
        record_event(
            db,
            event_type="reel_share_message",
            post_id=post.id,
            user_id=sender.id,
            source="messages",
            context={"conversation_id": conversation.id},
            client_event_id=f"share:{row.id}",
        )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if client_id:
            existing = db.query(DirectMessage).filter(
                DirectMessage.sender_id == sender.id,
                DirectMessage.client_id == client_id,
            ).first()
            if existing and existing.conversation_id == conversation.id:
                return existing, True
        raise
    db.refresh(row)
    return row, False


def conversation_rows(db: Session, user_id: str, box: str, cursor: str | None, limit: int):
    query = db.query(Conversation, ConversationMember).join(
        ConversationMember,
        ConversationMember.conversation_id == Conversation.id,
    ).filter(ConversationMember.user_id == user_id)
    if box == "requests":
        query = query.filter(Conversation.state == "pending", Conversation.requester_id != user_id)
    else:
        query = query.filter(or_(
            Conversation.state == "active",
            and_(Conversation.state == "pending", Conversation.requester_id == user_id),
        ))
    decoded = decode_cursor(cursor)
    if decoded:
        created_at, conversation_id = decoded
        query = query.filter(or_(
            Conversation.updated_at < created_at,
            and_(Conversation.updated_at == created_at, Conversation.id < conversation_id),
        ))
    return query.order_by(Conversation.updated_at.desc(), Conversation.id.desc()).limit(limit + 1).all()


def serialize_conversation_rows(db: Session, rows, user_id: str) -> list[dict]:
    conversations = []
    for conversation, member in rows:
        other_member = db.query(ConversationMember).filter(
            ConversationMember.conversation_id == conversation.id,
            ConversationMember.user_id != user_id,
        ).first()
        other_user = db.get(User, other_member.user_id) if other_member else None
        if other_member and other_user and not users_blocked(db, user_id, other_user.id):
            conversations.append(serialize_conversation(db, conversation, member, other_member, other_user))
    return conversations


def unread_totals(db: Session, user_id: str) -> dict:
    totals = {"inbox": 0, "requests": 0}
    rows = db.query(Conversation, ConversationMember).join(
        ConversationMember,
        ConversationMember.conversation_id == Conversation.id,
    ).filter(
        ConversationMember.user_id == user_id,
        Conversation.state.in_(["active", "pending"]),
    ).all()
    for conversation, member in rows:
        other_id = db.query(ConversationMember.user_id).filter(
            ConversationMember.conversation_id == conversation.id,
            ConversationMember.user_id != user_id,
        ).scalar()
        if other_id and not users_blocked(db, user_id, other_id):
            box = conversation_box(conversation, user_id)
            if box:
                totals[box] += unread_for_member(db, member)
    totals["total"] = totals["inbox"] + totals["requests"]
    return totals


@router.get("/capabilities")
def capabilities():
    return {
        "message_kinds": sorted(MESSAGE_KINDS),
        "curated_emotes": CURATED_EMOTES,
        "limits": {
            "text_characters": 2000,
            "reel_note_characters": 500,
            "share_recipients": 10,
            "history_page": 100,
        },
        "encryption": {
            "at_rest": True,
            "end_to_end": False,
            "disclosure": "Messages are encrypted at rest on the server; this is not end-to-end encryption.",
        },
        "gifs": {"available": bool(os.environ.get("SX_TENOR_API_KEY", "").strip()), "provider": "Tenor"},
    }


@router.get("/bootstrap")
def bootstrap(
    box: Literal["inbox", "requests"] = "inbox",
    cursor: str | None = None,
    limit: int = 30,
    context: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
):
    require_messaging_user(context.user)
    bounded = max(1, min(int(limit), 50))
    rows = conversation_rows(db, context.user.id, box, cursor, bounded)
    has_more = len(rows) > bounded
    page = rows[:bounded]
    event_cursor = db.query(func.max(MessageEvent.id)).filter(
        MessageEvent.recipient_id == context.user.id,
    ).scalar() or 0
    return {
        "box": box,
        "conversations": serialize_conversation_rows(db, page, context.user.id),
        "unread": unread_totals(db, context.user.id),
        "event_cursor": event_cursor,
        "next_cursor": encode_cursor(page[-1][0].updated_at, page[-1][0].id) if has_more and page else None,
    }


@router.get("/unread-count")
def unread_count(
    context: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
):
    totals = unread_totals(db, context.user.id)
    return {"unread_count": totals["total"], **totals}


@router.get("/conversations")
def list_conversations(
    box: Literal["inbox", "requests"] = "inbox",
    cursor: str | None = None,
    limit: int = 30,
    context: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
):
    return bootstrap(box=box, cursor=cursor, limit=limit, context=context, db=db)


@router.post("/conversations")
def create_conversation(
    req: ConversationCreateRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    rate_limiter.check(db, f"message-conversation:{context.user.id}", 30, 60 * 60)
    target = target_user(db, req.username, context.user)
    conversation = get_or_create_conversation(db, context.user, target)
    db.commit()
    values = member_context(db, conversation.id, context.user.id)
    return {"conversation": serialize_conversation(db, *values)}


@router.post("/direct")
def send_direct_message(
    req: DirectMessageRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    rate_limiter.check(db, f"message-conversation:{context.user.id}", 30, 60 * 60)
    rate_limiter.check(db, f"message-send-minute:{context.user.id}", 60, 60)
    rate_limiter.check(db, f"message-send-day:{context.user.id}", 500, 24 * 60 * 60)
    target = target_user(db, req.username, context.user)
    try:
        conversation = get_or_create_conversation(db, context.user, target)
    except IntegrityError:
        db.rollback()
        conversation = db.query(Conversation).filter(
            Conversation.direct_key == direct_key(context.user.id, target.id),
        ).first()
        if not conversation:
            raise
    row, duplicate = send_into_conversation(
        db,
        conversation,
        context.user,
        req,
        apply_rate_limits=False,
    )
    values = member_context(db, conversation.id, context.user.id)
    return {
        "conversation": serialize_conversation(db, *values),
        "message": serialize_message(db, row, context.user.id, values[2]),
        "duplicate": duplicate,
    }


@router.get("/conversations/{conversation_id}/messages")
def list_messages(
    conversation_id: str,
    before: str | None = None,
    after: str | None = None,
    limit: int = 50,
    context: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
):
    if before and after:
        fail(422, "INVALID_CURSOR", "Use either before or after, not both.")
    conversation, member, other_member, other_user = member_context(db, conversation_id, context.user.id)
    if users_blocked(db, context.user.id, other_user.id):
        fail(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")
    bounded = max(1, min(int(limit), 100))
    query = db.query(DirectMessage).filter(DirectMessage.conversation_id == conversation.id)
    cursor = decode_cursor(after or before)
    if cursor:
        created_at, message_id = cursor
        if after:
            query = query.filter(or_(
                DirectMessage.created_at > created_at,
                and_(DirectMessage.created_at == created_at, DirectMessage.id > message_id),
            )).order_by(DirectMessage.created_at.asc(), DirectMessage.id.asc())
        else:
            query = query.filter(or_(
                DirectMessage.created_at < created_at,
                and_(DirectMessage.created_at == created_at, DirectMessage.id < message_id),
            )).order_by(DirectMessage.created_at.desc(), DirectMessage.id.desc())
    else:
        query = query.order_by(DirectMessage.created_at.desc(), DirectMessage.id.desc())
    rows = query.limit(bounded + 1).all()
    has_more = len(rows) > bounded
    rows = rows[:bounded]
    if not after:
        rows.reverse()
    return {
        "conversation": serialize_conversation(db, conversation, member, other_member, other_user),
        "messages": [serialize_message(db, row, context.user.id, other_member) for row in rows],
        "next_before": encode_cursor(rows[0].created_at, rows[0].id) if has_more and rows and not after else None,
        "encryption": {"at_rest": True, "end_to_end": False},
    }


@router.post("/conversations/{conversation_id}/messages")
def send_message(
    conversation_id: str,
    req: MessageCreateRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    conversation, _member, other_member, _other_user = member_context(db, conversation_id, context.user.id)
    row, duplicate = send_into_conversation(db, conversation, context.user, req)
    return {"message": serialize_message(db, row, context.user.id, other_member), "duplicate": duplicate}


def decide_request(db: Session, conversation_id: str, user_id: str, decision: str) -> dict:
    conversation, member, other_member, other_user = member_context(db, conversation_id, user_id)
    if users_blocked(db, user_id, other_user.id):
        fail(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")
    if conversation.state != "pending" or conversation.requester_id == user_id:
        fail(409, "REQUEST_NOT_PENDING", "This conversation is not an incoming request.")
    now = utcnow()
    conversation.state = decision
    conversation.updated_at = now
    if decision == "active":
        conversation.accepted_at = now
        conversation.declined_at = None
        event_type = "request.accepted"
    else:
        conversation.declined_at = now
        event_type = "request.declined"
    emit_event(db, conversation, event_type)
    db.commit()
    return {"conversation": serialize_conversation(db, conversation, member, other_member, other_user)}


@router.post("/conversations/{conversation_id}/accept")
def accept_request(
    conversation_id: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    return decide_request(db, conversation_id, context.user.id, "active")


@router.post("/conversations/{conversation_id}/decline")
def decline_request(
    conversation_id: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    return decide_request(db, conversation_id, context.user.id, "declined")


@router.post("/conversations/{conversation_id}/read")
def mark_read(
    conversation_id: str,
    req: ReadRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    conversation, member, other_member, _other_user = member_context(db, conversation_id, context.user.id)
    if req.message_id:
        target = db.query(DirectMessage).filter(
            DirectMessage.id == req.message_id,
            DirectMessage.conversation_id == conversation.id,
        ).first()
    else:
        target = db.query(DirectMessage).filter(
            DirectMessage.conversation_id == conversation.id,
        ).order_by(DirectMessage.created_at.desc(), DirectMessage.id.desc()).first()
    if req.message_id and not target:
        fail(404, "MESSAGE_NOT_FOUND", "Message not found.")
    changed = False
    if target:
        current_marker = (
            aware(member.last_read_at) if member.last_read_at else datetime.min.replace(tzinfo=timezone.utc),
            member.last_read_message_id or "",
        )
        target_marker = (aware(target.created_at), target.id)
        if target_marker > current_marker:
            member.last_read_at = target.created_at
            member.last_read_message_id = target.id
            emit_event(db, conversation, "conversation.read", target.id, [other_member.user_id])
            db.commit()
            changed = True
    return {"ok": True, "changed": changed, "unread_count": unread_for_member(db, member)}


@router.delete("/{message_id}")
def delete_message(
    message_id: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    row = db.get(DirectMessage, message_id)
    if not row:
        fail(404, "MESSAGE_NOT_FOUND", "Message not found.")
    conversation, _member, _other_member, _other_user = member_context(db, row.conversation_id, context.user.id)
    if row.sender_id != context.user.id:
        fail(403, "MESSAGE_FORBIDDEN", "Only the sender can delete this message.")
    if row.deleted_at is None:
        row.deleted_at = utcnow()
        conversation.updated_at = utcnow()
        emit_event(db, conversation, "message.deleted", row.id)
        db.commit()
    return {"ok": True}


@router.get("/events")
async def message_events(
    request: Request,
    after: int = 0,
    context: AuthContext = Depends(require_auth),
):
    require_messaging_user(context.user)
    header_cursor = request.headers.get("last-event-id", "").strip()
    if header_cursor:
        try:
            after = max(after, int(header_cursor))
        except ValueError:
            pass
    user_id = context.user.id

    async def stream():
        cursor = max(0, int(after))
        idle_ticks = 0
        while not await request.is_disconnected():
            with SessionLocal() as event_db:
                rows = event_db.query(MessageEvent).filter(
                    MessageEvent.recipient_id == user_id,
                    MessageEvent.id > cursor,
                ).order_by(MessageEvent.id.asc()).limit(100).all()
                payloads = [
                    {
                        "id": row.id,
                        "type": row.event_type,
                        "conversation_id": row.conversation_id,
                        "message_id": row.message_id,
                        "created_at": row.created_at.isoformat() if row.created_at else None,
                    }
                    for row in rows
                ]
            if payloads:
                idle_ticks = 0
                for payload in payloads:
                    cursor = payload["id"]
                    yield (
                        f"id: {cursor}\n"
                        f"event: {payload['type']}\n"
                        f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"
                    )
            else:
                idle_ticks += 1
                if idle_ticks >= 15:
                    idle_ticks = 0
                    yield ": keep-alive\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/gifs/search")
def search_gifs(
    q: str,
    limit: int = 20,
    context: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
):
    require_messaging_user(context.user)
    query = str(q or "").strip()
    if not query:
        fail(422, "GIF_QUERY_REQUIRED", "Enter a GIF search.", "q")
    api_key = os.environ.get("SX_TENOR_API_KEY", "").strip()
    if not api_key:
        fail(503, "GIF_SEARCH_UNAVAILABLE", "GIF search is not configured.")
    rate_limiter.check(db, f"message-gif:{context.user.id}", 60, 60 * 60)
    bounded = max(1, min(int(limit), 30))
    params = urlencode({
        "q": query[:100],
        "key": api_key,
        "client_key": os.environ.get("SX_TENOR_CLIENT_KEY", "echo_reels"),
        "limit": bounded,
        "contentfilter": "medium",
        "media_filter": "gif,tinygif",
    })
    provider_request = UrlRequest(
        "https://tenor.googleapis.com/v2/search?" + params,
        headers={"Accept": "application/json", "User-Agent": "ECHO/2.0"},
    )
    try:
        with urlopen(provider_request, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
        fail(502, "GIF_PROVIDER_FAILED", "GIF search is temporarily unavailable.")
    results = []
    for item in payload.get("results", [])[:bounded]:
        formats = item.get("media_formats") or {}
        full = formats.get("gif") or {}
        preview = formats.get("tinygif") or full
        try:
            url = normalize_gif_url(full.get("url", ""), "gif_url")
            preview_url = normalize_gif_url(preview.get("url", url), "gif_preview_url")
        except HTTPException:
            continue
        results.append({
            "id": str(item.get("id") or ""),
            "title": str(item.get("content_description") or item.get("title") or "GIF")[:200],
            "url": url,
            "preview_url": preview_url,
            "provider": "tenor",
        })
    return {"results": results, "next": payload.get("next"), "attribution": "Powered by Tenor"}


@router.post("/share-reel")
def share_reel(
    req: ShareReelRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    require_messaging_user(context.user)
    base_client_id = validate_client_id(req.client_id)
    post = get_post_by_reference(db, post_id=req.post_id)
    if not can_view_shared_post(db, post, context.user.id):
        fail(404, "POST_NOT_FOUND", "Reel not found.")
    normalized = []
    seen = set()
    for raw in req.usernames:
        username = str(raw or "").strip().casefold()
        if username and username not in seen:
            seen.add(username)
            normalized.append(username)
    if not normalized or len(normalized) > 10:
        fail(422, "INVALID_RECIPIENTS", "Choose between 1 and 10 recipients.", "usernames")
    rate_limiter.check(db, f"message-share:{context.user.id}", 20, 60 * 60)
    results = []
    for username in normalized:
        recipient_client_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"echo-share:{base_client_id}:{username}"))
        try:
            target = target_user(db, username, context.user)
            conversation = get_or_create_conversation(db, context.user, target)
            message_req = MessageCreateRequest(
                kind="reel",
                text=req.note,
                post_id=post.id,
                client_id=recipient_client_id,
            )
            row, duplicate = send_into_conversation(
                db,
                conversation,
                context.user,
                message_req,
                apply_rate_limits=False,
            )
            results.append({
                "username": target.username,
                "ok": True,
                "conversation_id": conversation.id,
                "message_id": row.id,
                "duplicate": duplicate,
            })
        except HTTPException as exc:
            db.rollback()
            detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
            results.append({
                "username": username,
                "ok": False,
                "code": detail.get("code", "SHARE_FAILED"),
                "message": detail.get("message", "Could not share this reel."),
            })
    return {
        "post_id": post.id,
        "results": results,
        "succeeded": sum(1 for row in results if row["ok"]),
        "failed": sum(1 for row in results if not row["ok"]),
    }


def cleanup_message_events() -> int:
    cutoff = utcnow() - timedelta(days=EVENT_RETENTION_DAYS)
    with SessionLocal() as db:
        deleted = db.query(MessageEvent).filter(MessageEvent.created_at < cutoff).delete(
            synchronize_session=False
        )
        db.commit()
        return int(deleted or 0)
