"""Account recovery, blocking, reporting, moderation, and account deletion APIs."""

from __future__ import annotations

import logging
import os
import secrets
import uuid
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from cryptography.exceptions import InvalidTag
from pydantic import BaseModel, EmailStr
from sqlalchemy import or_
from sqlalchemy.orm import Session

from server.social.auth import (
    AuthContext,
    clear_auth_cookies,
    hash_password,
    normalize_email,
    rate_limiter,
    request_identity,
    require_auth,
    require_auth_csrf,
    require_moderator,
    require_moderator_csrf,
    token_hash,
    validate_origin,
    validate_password,
    verify_password,
)
from server.social.database import get_db
from server.social.email import send_password_reset_email
from server.social.message_crypto import (
    MessageCryptoConfigurationError,
    decrypt_payload,
    encrypt_payload,
    message_aad,
    report_aad,
)
from server.social.models import (
    AuthSession,
    Comment,
    CommentLike,
    Conversation,
    ConversationMember,
    DirectMessage,
    EngagementEvent,
    Follow,
    MessageEvent,
    PasswordResetToken,
    Post,
    PostLike,
    PostSave,
    Report,
    User,
    UserBlock,
    utcnow,
)
from server.social.safety import recompute_follow_counts, remove_relationships

router = APIRouter(tags=["account-safety"])
logger = logging.getLogger(__name__)
REPORT_REASONS = {"spam", "harassment", "hate", "sexual", "violence", "impersonation", "privacy", "other"}


def fail(status: int, code: str, message: str, field: str | None = None):
    from fastapi import HTTPException

    detail = {"code": code, "message": message}
    if field:
        detail["field"] = field
    raise HTTPException(status_code=status, detail=detail)


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetConfirm(BaseModel):
    token: str
    new_password: str


class AccountDeleteRequest(BaseModel):
    current_password: str
    confirmation: str


class ReportCreateRequest(BaseModel):
    target_type: Literal["user", "post", "comment", "message"]
    target_id: str
    reason: str
    details: str = ""


class ModerationRequest(BaseModel):
    action: Literal["dismiss", "resolve", "remove_content", "suspend_user"]
    resolution: str = ""


def get_active_user(db: Session, username: str) -> User:
    user = db.query(User).filter(User.username_norm == username.strip().casefold(), User.status == "active").first()
    if not user:
        fail(404, "USER_NOT_FOUND", "Profile not found.")
    return user


def serialize_report(db: Session, report: Report) -> dict:
    reporter = db.get(User, report.reporter_id) if report.reporter_id else None
    target = {}
    if report.target_type == "user":
        user = db.get(User, report.target_id)
        if user:
            target = {"username": user.username, "display_name": user.display_name, "status": user.status}
    elif report.target_type == "post":
        post = db.get(Post, report.target_id)
        if post:
            target = {"title": post.title, "owner_id": post.owner_id, "status": post.status}
    elif report.target_type == "comment":
        comment = db.get(Comment, report.target_id)
        if comment:
            target = {"text": comment.text, "author_id": comment.author_id, "deleted": comment.deleted_at is not None}
    elif report.target_type == "message":
        target = {"unavailable": True}
        if report.evidence_ciphertext:
            try:
                target = decrypt_payload(
                    report.evidence_ciphertext,
                    aad=report_aad(report.id, report.target_id),
                )
            except (MessageCryptoConfigurationError, InvalidTag, ValueError, UnicodeDecodeError):
                target = {"unavailable": True, "reason": "Encrypted evidence cannot be read."}
    return {
        "id": report.id,
        "reporter": reporter.username if reporter else None,
        "target_type": report.target_type,
        "target_id": report.target_id,
        "target": target,
        "reason": report.reason,
        "details": report.details,
        "status": report.status,
        "resolution": report.resolution,
        "created_at": report.created_at.isoformat() if report.created_at else None,
        "reviewed_at": report.reviewed_at.isoformat() if report.reviewed_at else None,
    }


@router.post("/api/auth/password-reset/request")
def request_password_reset(req: PasswordResetRequest, request: Request, db: Session = Depends(get_db)):
    validate_origin(request)
    identity = request_identity(request)
    email = normalize_email(str(req.email))
    rate_limiter.check(db, f"password-reset-ip:{identity}", 8, 60 * 60)
    rate_limiter.check(db, f"password-reset-account:{email}", 3, 60 * 60)

    user = db.query(User).filter(
        User.email_norm == email,
        User.status == "active",
        User.account_type == "real",
    ).first()
    debug_token = None
    if user:
        now = utcnow()
        db.query(PasswordResetToken).filter(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.used_at.is_(None),
        ).update({PasswordResetToken.used_at: now}, synchronize_session=False)
        raw_token = secrets.token_urlsafe(40)
        db.add(
            PasswordResetToken(
                user_id=user.id,
                token_hash=token_hash(raw_token),
                expires_at=now + timedelta(minutes=30),
            )
        )
        db.commit()
        try:
            send_password_reset_email(user.email or email, raw_token)
        except Exception:
            logger.exception("Password reset email delivery failed")
        if os.environ.get("SX_PASSWORD_RESET_EXPOSE_TOKEN", "0").lower() in {"1", "true", "yes"}:
            debug_token = raw_token

    payload = {
        "ok": True,
        "message": "If that email belongs to an active account, a reset link has been sent.",
    }
    if debug_token:
        payload["debug_token"] = debug_token
    return payload


@router.post("/api/auth/password-reset/confirm")
def confirm_password_reset(req: PasswordResetConfirm, request: Request, db: Session = Depends(get_db)):
    validate_origin(request)
    rate_limiter.check(db, f"password-reset-confirm:{request_identity(request)}", 12, 15 * 60)
    raw_token = str(req.token or "").strip()
    new_password = validate_password(req.new_password)
    row = db.query(PasswordResetToken).filter(
        PasswordResetToken.token_hash == token_hash(raw_token),
        PasswordResetToken.used_at.is_(None),
        PasswordResetToken.expires_at > utcnow(),
    ).first()
    if not row:
        fail(400, "INVALID_RESET_TOKEN", "This password reset link is invalid or expired.")
    user = db.get(User, row.user_id)
    if not user or user.status != "active":
        fail(400, "INVALID_RESET_TOKEN", "This password reset link is invalid or expired.")

    user.password_hash = hash_password(new_password)
    row.used_at = utcnow()
    db.query(AuthSession).filter(
        AuthSession.user_id == user.id,
        AuthSession.revoked_at.is_(None),
    ).update({AuthSession.revoked_at: utcnow()}, synchronize_session=False)
    db.commit()
    response = JSONResponse({"ok": True})
    clear_auth_cookies(response)
    return response


@router.put("/api/users/{username}/block")
def block_user(
    username: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    target = get_active_user(db, username)
    if target.id == context.user.id:
        fail(422, "SELF_BLOCK", "You cannot block yourself.")
    rate_limiter.check(db, f"block:{context.user.id}", 60, 60)
    row = db.query(UserBlock).filter(
        UserBlock.blocker_id == context.user.id,
        UserBlock.blocked_id == target.id,
    ).first()
    if not row:
        db.add(UserBlock(blocker_id=context.user.id, blocked_id=target.id))
        remove_relationships(db, context.user.id, target.id)
        db.flush()
        recompute_follow_counts(db, {context.user.id, target.id})
        conversation = db.query(Conversation).filter(
            Conversation.direct_key == ":".join(sorted((context.user.id, target.id)))
        ).first()
        if conversation:
            now = utcnow()
            for recipient_id in (context.user.id, target.id):
                db.add(MessageEvent(
                    recipient_id=recipient_id,
                    conversation_id=conversation.id,
                    event_type="conversation.blocked",
                    created_at=now,
                ))
        db.commit()
    return {"blocked": True, "username": target.username}


@router.delete("/api/users/{username}/block")
def unblock_user(
    username: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    target = get_active_user(db, username)
    db.query(UserBlock).filter(
        UserBlock.blocker_id == context.user.id,
        UserBlock.blocked_id == target.id,
    ).delete(synchronize_session=False)
    db.commit()
    return {"blocked": False, "username": target.username}


@router.get("/api/users/me/blocked")
def list_blocked_users(
    context: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
):
    rows = db.query(UserBlock, User).join(User, UserBlock.blocked_id == User.id).filter(
        UserBlock.blocker_id == context.user.id
    ).order_by(UserBlock.created_at.desc()).all()
    return {
        "users": [
            {
                "id": user.id,
                "username": user.username,
                "display_name": user.display_name,
                "avatar_url": f"/avatars/{user.avatar_path}" if user.avatar_path else None,
            }
            for _block, user in rows
        ]
    }


@router.post("/api/reports")
def create_report(
    req: ReportCreateRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    rate_limiter.check(db, f"report:{context.user.id}", 20, 60 * 60)
    reason = req.reason.strip().casefold()
    if reason not in REPORT_REASONS:
        fail(422, "INVALID_REPORT_REASON", "Choose a valid report reason.", "reason")
    target_id = req.target_id.strip()
    if req.target_type == "user":
        target = db.get(User, target_id)
        if not target or target.status == "deleted":
            fail(404, "REPORT_TARGET_NOT_FOUND", "The reported profile no longer exists.")
        target_owner_id = target.id
    elif req.target_type == "post":
        target = db.get(Post, target_id)
        if not target or target.deleted_at is not None:
            fail(404, "REPORT_TARGET_NOT_FOUND", "The reported post no longer exists.")
        target_owner_id = target.owner_id
    elif req.target_type == "comment":
        target = db.get(Comment, target_id)
        if not target or target.deleted_at is not None:
            fail(404, "REPORT_TARGET_NOT_FOUND", "The reported comment no longer exists.")

        target_owner_id = target.author_id
    else:
        target = db.get(DirectMessage, target_id)
        if not target or target.deleted_at is not None:
            fail(404, "REPORT_TARGET_NOT_FOUND", "The reported message no longer exists.")
        member = db.query(ConversationMember).filter(
            ConversationMember.conversation_id == target.conversation_id,
            ConversationMember.user_id == context.user.id,
        ).first()
        if not member:
            fail(404, "REPORT_TARGET_NOT_FOUND", "The reported message no longer exists.")
        target_owner_id = target.sender_id
    if target_owner_id == context.user.id:
        fail(422, "SELF_REPORT", "You cannot report your own content.")
    existing = db.query(Report).filter(
        Report.reporter_id == context.user.id,
        Report.target_type == req.target_type,
        Report.target_id == target_id,
        Report.status == "open",
    ).first()
    if existing:
        return {"report": serialize_report(db, existing), "duplicate": True}

    report_id = str(uuid.uuid4())
    evidence_ciphertext = None
    if req.target_type == "message":
        try:
            content = decrypt_payload(
                target.payload_ciphertext,
                aad=message_aad(target.id, target.conversation_id, target.sender_id, target.kind),
            )
            evidence_ciphertext = encrypt_payload(
                {
                    "message_id": target.id,
                    "conversation_id": target.conversation_id,
                    "sender_id": target.sender_id,
                    "kind": target.kind,
                    "content": content,
                    "post_id": target.post_id,
                    "created_at": target.created_at.isoformat() if target.created_at else None,
                },
                aad=report_aad(report_id, target.id),
            )
        except MessageCryptoConfigurationError:
            fail(503, "MESSAGE_ENCRYPTION_UNAVAILABLE", "Direct messaging encryption is not configured.")
        except (InvalidTag, ValueError, UnicodeDecodeError):
            fail(409, "MESSAGE_EVIDENCE_UNAVAILABLE", "The message evidence could not be captured.")
    report = Report(
        id=report_id,
        reporter_id=context.user.id,
        target_type=req.target_type,
        target_id=target_id,
        reason=reason,
        details=req.details.strip()[:500],
        evidence_ciphertext=evidence_ciphertext,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return {"report": serialize_report(db, report), "duplicate": False}


@router.get("/api/moderation/reports")
def list_reports(
    status: str = "open",
    limit: int = 50,
    context: AuthContext = Depends(require_moderator),
    db: Session = Depends(get_db),
):
    del context
    query = db.query(Report)
    if status != "all":
        query = query.filter(Report.status == status)
    rows = query.order_by(Report.created_at.asc()).limit(max(1, min(limit, 100))).all()
    return {"reports": [serialize_report(db, row) for row in rows]}


@router.patch("/api/moderation/reports/{report_id}")
def moderate_report(
    report_id: str,
    req: ModerationRequest,
    context: AuthContext = Depends(require_moderator_csrf),
    db: Session = Depends(get_db),
):
    report = db.get(Report, report_id)
    if not report:
        fail(404, "REPORT_NOT_FOUND", "Report not found.")
    if report.status != "open":
        fail(409, "REPORT_ALREADY_REVIEWED", "This report has already been reviewed.")
    if req.action == "remove_content" and report.target_type == "user":
        fail(422, "INVALID_MODERATION_ACTION", "User reports do not have removable content.")

    target_user = None
    if report.target_type == "user":
        target_user = db.get(User, report.target_id)
    elif report.target_type == "post":
        post = db.get(Post, report.target_id)
        target_user = db.get(User, post.owner_id) if post else None
        if req.action == "remove_content" and post and post.deleted_at is None:
            post.status = "deleted"
            post.deleted_at = utcnow()
            if target_user:
                target_user.post_count = max(0, int(target_user.post_count or 0) - 1)
    elif report.target_type == "comment":
        comment = db.get(Comment, report.target_id)
        target_user = db.get(User, comment.author_id) if comment else None
        if req.action == "remove_content" and comment and comment.deleted_at is None:
            comment.deleted_at = utcnow()
            post = db.get(Post, comment.post_id)
            if post:
                post.comment_count = max(0, int(post.comment_count or 0) - 1)
    elif report.target_type == "message":
        message = db.get(DirectMessage, report.target_id)
        target_user = db.get(User, message.sender_id) if message else None
        if req.action == "remove_content" and message and message.deleted_at is None:
            message.deleted_at = utcnow()
            conversation = db.get(Conversation, message.conversation_id)
            if conversation:
                conversation.updated_at = utcnow()
                member_ids = db.query(ConversationMember.user_id).filter(
                    ConversationMember.conversation_id == conversation.id,
                ).all()
                for (recipient_id,) in member_ids:
                    db.add(MessageEvent(
                        recipient_id=recipient_id,
                        conversation_id=conversation.id,
                        message_id=message.id,
                        event_type="message.deleted",
                    ))

    if req.action == "suspend_user":
        if not target_user:
            fail(404, "REPORT_TARGET_NOT_FOUND", "The reported user no longer exists.")
        if target_user.role == "admin":
            fail(403, "ADMIN_PROTECTED", "Administrators cannot be suspended here.")
        if target_user.id == context.user.id:
            fail(422, "SELF_SUSPENSION", "You cannot suspend your own account.")
        if context.user.role != "admin" and target_user.role == "moderator":
            fail(403, "MODERATOR_PROTECTED", "Only an administrator can suspend a moderator.")
        target_user.status = "suspended"
        db.query(AuthSession).filter(
            AuthSession.user_id == target_user.id,
            AuthSession.revoked_at.is_(None),
        ).update({AuthSession.revoked_at: utcnow()}, synchronize_session=False)

    report.status = "dismissed" if req.action == "dismiss" else "resolved"
    report.resolution = (req.resolution.strip() or req.action.replace("_", " "))[:500]
    report.moderator_id = context.user.id
    report.reviewed_at = utcnow()
    db.commit()
    return {"report": serialize_report(db, report)}


@router.delete("/api/users/me")
def delete_account(
    req: AccountDeleteRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    if req.confirmation != "DELETE":
        fail(422, "CONFIRMATION_REQUIRED", 'Type "DELETE" to confirm account deletion.', "confirmation")
    if not verify_password(context.user.password_hash, req.current_password):
        fail(400, "INVALID_PASSWORD", "Current password is incorrect.", "current_password")
    rate_limiter.check(db, f"delete-account:{context.user.id}", 3, 24 * 60 * 60)

    user = context.user
    old_avatar = user.avatar_path
    now = utcnow()

    follow_rows = db.query(Follow.follower_id, Follow.followee_id).filter(
        or_(Follow.follower_id == user.id, Follow.followee_id == user.id)
    ).all()
    affected_users = {value for row in follow_rows for value in row if value != user.id}
    db.query(Follow).filter(or_(Follow.follower_id == user.id, Follow.followee_id == user.id)).delete(
        synchronize_session=False
    )

    liked_post_ids = {row[0] for row in db.query(PostLike.post_id).filter(PostLike.user_id == user.id).all()}
    saved_post_ids = {row[0] for row in db.query(PostSave.post_id).filter(PostSave.user_id == user.id).all()}
    liked_comment_ids = {
        row[0] for row in db.query(CommentLike.comment_id).filter(CommentLike.user_id == user.id).all()
    }
    db.query(PostLike).filter(PostLike.user_id == user.id).delete(synchronize_session=False)
    db.query(PostSave).filter(PostSave.user_id == user.id).delete(synchronize_session=False)
    db.query(CommentLike).filter(CommentLike.user_id == user.id).delete(synchronize_session=False)

    authored_comments = db.query(Comment).filter(Comment.author_id == user.id, Comment.deleted_at.is_(None)).all()
    affected_comment_posts = {comment.post_id for comment in authored_comments}
    for comment in authored_comments:
        comment.deleted_at = now

    db.query(Post).filter(Post.owner_id == user.id, Post.deleted_at.is_(None)).update(
        {Post.status: "deleted", Post.deleted_at: now}, synchronize_session=False
    )
    db.query(UserBlock).filter(or_(UserBlock.blocker_id == user.id, UserBlock.blocked_id == user.id)).delete(
        synchronize_session=False
    )
    db.query(PasswordResetToken).filter(PasswordResetToken.user_id == user.id).delete(synchronize_session=False)
    db.query(Report).filter(Report.reporter_id == user.id).update(
        {Report.reporter_id: None}, synchronize_session=False
    )
    db.query(EngagementEvent).filter(EngagementEvent.user_id == user.id).update(
        {EngagementEvent.user_id: None}, synchronize_session=False
    )
    db.query(AuthSession).filter(AuthSession.user_id == user.id).update(
        {AuthSession.revoked_at: now}, synchronize_session=False
    )
    db.flush()

    recompute_follow_counts(db, affected_users)
    for post_id in liked_post_ids | saved_post_ids | affected_comment_posts:
        post = db.get(Post, post_id)
        if not post:
            continue
        if post_id in liked_post_ids:
            post.like_count = int(post.legacy_like_count or 0) + db.query(PostLike.id).filter(PostLike.post_id == post_id).count()
        if post_id in saved_post_ids:
            post.save_count = db.query(PostSave.id).filter(PostSave.post_id == post_id).count()
        if post_id in affected_comment_posts:
            post.comment_count = db.query(Comment.id).filter(
                Comment.post_id == post_id, Comment.deleted_at.is_(None)
            ).count()
    for comment_id in liked_comment_ids:
        comment = db.get(Comment, comment_id)
        if comment:
            comment.like_count = int(comment.legacy_like_count or 0) + db.query(CommentLike.id).filter(
                CommentLike.comment_id == comment_id
            ).count()

    tombstone = "deleted_" + user.id.replace("-", "")[:12]
    user.email = None
    user.email_norm = None
    user.username = tombstone
    user.username_norm = tombstone
    user.password_hash = None
    user.display_name = "Deleted user"
    user.bio = ""
    user.website = ""
    user.avatar_path = None
    user.account_type = "deleted"
    user.role = "user"
    user.status = "deleted"
    user.post_count = 0
    user.follower_count = 0
    user.following_count = 0
    db.commit()

    if old_avatar:
        from pathlib import Path

        try:
            (Path("data/avatars") / old_avatar).unlink(missing_ok=True)
        except OSError:
            pass

    response = JSONResponse({"ok": True})
    clear_auth_cookies(response)
    return response
