"""Account recovery, blocking, reporting, moderation, and account deletion APIs."""

from __future__ import annotations

import logging
import os
import secrets
import uuid
from datetime import timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from cryptography.exceptions import InvalidTag
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, literal, or_
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
from server.settings import env_int
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
    CreditLedgerEntry,
    Conversation,
    ConversationMember,
    DirectMessage,
    EngagementEvent,
    FalCredential,
    Follow,
    MessageEvent,
    PasswordResetToken,
    Post,
    PostLike,
    PostSave,
    ReelPack,
    ReelPackItem,
    ReelPackSave,
    Report,
    StaffAction,
    SupportRequest,
    User,
    UserBlock,
    utcnow,
)
from server.social.safety import recompute_follow_counts, remove_relationships
from server.social.services import shared_preview_urls
from server.social.staff import (
    REMOVE_ACTION,
    record_action,
    reinstate_user,
    remove_target,
    suspend_user,
    target_owner,
)

router = APIRouter(tags=["account-safety"])
logger = logging.getLogger(__name__)
REPORT_REASONS = {"spam", "harassment", "hate", "sexual", "violence", "impersonation", "privacy", "other"}
# A claim lapses after this, so a report a moderator walked away from is not stuck.
CLAIM_TTL = timedelta(minutes=30)


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
    target_type: Literal["user", "post", "pack", "comment", "message"]
    target_id: str
    reason: str
    details: str = ""


class ModerationRequest(BaseModel):
    action: Literal["dismiss", "resolve", "remove_content", "suspend_user", "reinstate_user"]
    resolution: str = ""
    # Admins may act on a report another moderator has claimed; the override is audited.
    force: bool = False


def get_active_user(db: Session, username: str) -> User:
    user = db.query(User).filter(User.username_norm == username.strip().casefold(), User.status == "active").first()
    if not user:
        fail(404, "USER_NOT_FOUND", "Profile not found.")
    return user


def claim_holder(report: Report) -> str | None:
    """The id of the moderator holding a live claim on an open report, else None."""
    if report.status != "open" or not report.claimed_by_id or not report.claimed_at:
        return None
    claimed_at = report.claimed_at
    if claimed_at.tzinfo is None:
        claimed_at = claimed_at.replace(tzinfo=timezone.utc)
    return report.claimed_by_id if claimed_at > utcnow() - CLAIM_TTL else None


def report_history(db: Session, report_id: str) -> list[dict]:
    rows = db.query(StaffAction).filter(StaffAction.report_id == report_id).order_by(
        StaffAction.created_at.asc(), StaffAction.id.asc()
    ).all()
    history = []
    for row in rows:
        actor = db.get(User, row.actor_id) if row.actor_id else None
        history.append({
            "action": row.action,
            "actor": actor.username if actor else None,
            "reason": row.reason,
            "details": row.details or {},
            "created_at": row.created_at.isoformat() if row.created_at else None,
        })
    return history


# Member reels shown on a reported pack's card.
PACK_PREVIEW_ITEMS = 4


def post_preview(post: Post) -> dict:
    """What staff need to see a reported post: its media while live, and where it plays."""
    removed = post.deleted_at is not None
    preview = {"media_type": post.media_type, "link": f"/reels?post={post.id}", "removed": removed}
    if not removed:
        # Removed media are unpublished, so their URLs would not load.
        preview.update(shared_preview_urls(post))
    return preview


def serialize_report(db: Session, report: Report) -> dict:
    reporter = db.get(User, report.reporter_id) if report.reporter_id else None
    moderator = db.get(User, report.moderator_id) if report.moderator_id else None
    holder_id = claim_holder(report)
    holder = db.get(User, holder_id) if holder_id else None
    target = {}
    if report.target_type == "user":
        user = db.get(User, report.target_id)
        if user:
            target = {
                "username": user.username,
                "display_name": user.display_name,
                "status": user.status,
                "link": f"/profile/{user.username}",
            }
    elif report.target_type == "post":
        post = db.get(Post, report.target_id)
        if post:
            owner = db.get(User, post.owner_id)
            target = {
                "title": post.title,
                "caption": post.caption,
                "owner_id": post.owner_id,
                "owner": owner.username if owner else None,
                "status": post.status,
                **post_preview(post),
            }
    elif report.target_type == "pack":
        pack = db.get(ReelPack, report.target_id)
        if pack:
            owner = db.get(User, pack.owner_id)
            member_ids = [
                row[0]
                for row in db.query(ReelPackItem.post_id)
                .filter(ReelPackItem.pack_id == pack.id, ReelPackItem.post_id.isnot(None))
                .order_by(ReelPackItem.position)
                .all()
            ]
            # Cover first, then pack order: the reels a viewer meets first.
            if pack.cover_post_id in member_ids:
                member_ids.remove(pack.cover_post_id)
                member_ids.insert(0, pack.cover_post_id)
            members = [db.get(Post, post_id) for post_id in member_ids[:PACK_PREVIEW_ITEMS]]
            target = {
                "title": pack.title,
                "description": pack.description,
                "owner_id": pack.owner_id,
                "owner": owner.username if owner else None,
                "status": pack.status,
                "visibility": pack.visibility,
                "link": f"/packs/{pack.id}",
                "removed": pack.deleted_at is not None,
                "item_count": len(member_ids),
                "items": [{"id": post.id, "title": post.title, **post_preview(post)} for post in members if post],
            }
    elif report.target_type == "comment":
        comment = db.get(Comment, report.target_id)
        if comment:
            author = db.get(User, comment.author_id)
            post = db.get(Post, comment.post_id)
            target = {
                "text": comment.text,
                "author_id": comment.author_id,
                "author": author.username if author else None,
                "deleted": comment.deleted_at is not None,
                "removed": comment.deleted_at is not None,
                "link": f"/reels?post={comment.post_id}",
                # The post the comment sits under, for context.
                "post": {"title": post.title, **post_preview(post)} if post else None,
            }
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
        "handled_by": moderator.username if moderator else None,
        "claimed_by": holder.username if holder else None,
        "claimed_at": report.claimed_at.isoformat() if holder and report.claimed_at else None,
        "history": report_history(db, report.id),
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


def file_report(
    db: Session,
    reporter: User,
    target_type: str,
    target_id: str,
    reason: str,
    details: str = "",
) -> tuple[Report, bool]:
    """Validate a report target and create an open Report (shared with the support inbox).

    Returns ``(report, duplicate)``; an open report by the same reporter on the
    same target is returned instead of a new row. Raises HTTP errors via fail().
    """
    reason = reason.strip().casefold()
    if reason not in REPORT_REASONS:
        fail(422, "INVALID_REPORT_REASON", "Choose a valid report reason.", "reason")
    target_id = target_id.strip()
    if target_type == "user":
        target = db.get(User, target_id)
        if not target or target.status == "deleted":
            fail(404, "REPORT_TARGET_NOT_FOUND", "The reported profile no longer exists.")
        target_owner_id = target.id
    elif target_type == "post":
        target = db.get(Post, target_id)
        if not target or target.deleted_at is not None:
            fail(404, "REPORT_TARGET_NOT_FOUND", "The reported post no longer exists.")
        target_owner_id = target.owner_id
    elif target_type == "pack":
        target = db.get(ReelPack, target_id)
        if not target or target.deleted_at is not None or target.status == "deleted":
            fail(404, "REPORT_TARGET_NOT_FOUND", "The reported Reel Pack no longer exists.")
        target_owner_id = target.owner_id
    elif target_type == "comment":
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
            ConversationMember.user_id == reporter.id,
        ).first()
        if not member:
            fail(404, "REPORT_TARGET_NOT_FOUND", "The reported message no longer exists.")
        target_owner_id = target.sender_id
    if target_owner_id == reporter.id:
        fail(422, "SELF_REPORT", "You cannot report your own content.")
    existing = db.query(Report).filter(
        Report.reporter_id == reporter.id,
        Report.target_type == target_type,
        Report.target_id == target_id,
        Report.status == "open",
    ).first()
    if existing:
        return existing, True

    report_id = str(uuid.uuid4())
    evidence_ciphertext = None
    if target_type == "message":
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
                    "pack_id": target.pack_id,
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
        reporter_id=reporter.id,
        target_type=target_type,
        target_id=target_id,
        reason=reason,
        details=(details or "").strip()[:500],
        evidence_ciphertext=evidence_ciphertext,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report, False


@router.post("/api/reports")
def create_report(
    req: ReportCreateRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    rate_limiter.check(db, f"report:{context.user.id}", 20, 60 * 60)
    report, duplicate = file_report(db, context.user, req.target_type, req.target_id, req.reason, req.details)
    return {"report": serialize_report(db, report), "duplicate": duplicate}


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


STATS_WINDOWS = {"24h": timedelta(hours=24), "7d": timedelta(days=7)}
SPIKE_FACTOR = 3


def _spike(current: int, previous: int, floor: int) -> bool:
    """A metric spikes when it is at least 3x the previous window and above the noise floor."""
    return current >= floor and current >= SPIKE_FACTOR * previous


def _windowed(count_query, now, delta, floor: int) -> dict:
    """count_query(start, end) -> int. Returns the current and previous window and a spike flag."""
    current = int(count_query(now - delta, now) or 0)
    previous = int(count_query(now - 2 * delta, now - delta) or 0)
    return {"current": current, "previous": previous, "spike": _spike(current, previous, floor)}


@router.get("/api/moderation/stats")
def moderation_stats(
    context: AuthContext = Depends(require_moderator),
    db: Session = Depends(get_db),
):
    """Operations overview: each metric for the last 24 h and 7 d against the period before it."""
    del context
    from server.metrics import alert_limits
    from server.routers.health import disk_status

    now = utcnow()
    floor = env_int("SX_MOD_SPIKE_MIN", 10, minimum=1)

    def between(model_column, *filters):
        def run(start, end):
            return db.query(func.count()).select_from(model_column.class_).filter(
                model_column > start, model_column <= end, *filters
            ).scalar()
        return run

    def captured(start, end):
        total = db.query(func.coalesce(func.sum(-CreditLedgerEntry.delta_reserved), 0)).filter(
            CreditLedgerEntry.entry_type == "capture",
            CreditLedgerEntry.created_at > start,
            CreditLedgerEntry.created_at <= end,
        ).scalar()
        return total

    windows = {}
    for label, delta in STATS_WINDOWS.items():
        start = now - delta
        by_reason = dict(
            db.query(Report.reason, func.count()).filter(Report.created_at > start).group_by(Report.reason).all()
        )
        by_status = dict(
            db.query(Report.status, func.count()).filter(Report.created_at > start).group_by(Report.status).all()
        )
        top_senders = (
            db.query(User.username, func.count(DirectMessage.id).label("sent"))
            .join(User, User.id == DirectMessage.sender_id)
            .filter(DirectMessage.created_at > start)
            .group_by(User.username)
            .order_by(func.count(DirectMessage.id).desc(), User.username.asc())
            .limit(5)
            .all()
        )
        windows[label] = {
            "reports": {
                **_windowed(between(Report.created_at), now, delta, floor),
                "by_reason": by_reason,
                "by_status": by_status,
            },
            "registrations": {
                "active": _windowed(between(User.created_at, User.status == "active"), now, delta, floor),
                "pending": _windowed(between(User.created_at, User.status == "pending"), now, delta, floor),
            },
            "messages": {
                **_windowed(between(DirectMessage.created_at), now, delta, floor),
                "top_senders": [{"username": name, "sent": int(sent)} for name, sent in top_senders],
            },
            "posts": _windowed(between(Post.created_at), now, delta, floor),
            "credits_captured": _windowed(captured, now, delta, floor),
            "support_requests": _windowed(between(SupportRequest.created_at), now, delta, floor),
        }
    return {
        "generated_at": now.isoformat(),
        "spike_floor": floor,
        "open_reports": db.query(func.count(Report.id)).filter(Report.status == "open").scalar(),
        "open_support_requests": db.query(func.count(SupportRequest.id)).filter(SupportRequest.status == "open").scalar(),
        "queue_limits": {key: alert_limits()[key] for key in ("open_reports", "open_support_requests")},
        "windows": windows,
        "disk": disk_status(),
    }


HOURLY_SPAN_H = 14 * 24


@router.get("/api/moderation/stats/hourly")
def moderation_stats_hourly(
    context: AuthContext = Depends(require_moderator),
    db: Session = Depends(get_db),
):
    """The stats metrics per UTC hour for the last 14 days, oldest first; the last hour is still running.

    Fourteen days cover the 7-day window and the 7 days before it. Buckets follow hour boundaries,
    so their sums can differ slightly from the rolling windows in /api/moderation/stats.
    """
    del context
    end = utcnow().replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    start = end - timedelta(hours=HOURLY_SPAN_H)

    def hourly(column, *filters, amount=None):
        counts = [0] * HOURLY_SPAN_H
        rows = db.query(column, literal(1) if amount is None else amount).filter(column >= start, *filters)
        for created_at, value in rows:
            if created_at.tzinfo is None:  # SQLite hands back naive UTC
                created_at = created_at.replace(tzinfo=timezone.utc)
            index = int((created_at - start).total_seconds() // 3600)
            if 0 <= index < HOURLY_SPAN_H:
                counts[index] += int(value or 0)
        return counts

    return {
        "start": start.isoformat(),
        "hours": HOURLY_SPAN_H,
        "series": {
            "reports": hourly(Report.created_at),
            "support_requests": hourly(SupportRequest.created_at),
            "posts": hourly(Post.created_at),
            "signups": hourly(User.created_at, User.status == "active"),
            "unverified": hourly(User.created_at, User.status == "pending"),
            "messages": hourly(DirectMessage.created_at),
            "credits_captured": hourly(
                CreditLedgerEntry.created_at, CreditLedgerEntry.entry_type == "capture",
                amount=-CreditLedgerEntry.delta_reserved,
            ),
        },
    }


def get_report(db: Session, report_id: str) -> Report:
    report = db.get(Report, report_id)
    if not report:
        fail(404, "REPORT_NOT_FOUND", "Report not found.")
    return report


def claimed_conflict(db: Session, holder_id: str):
    holder = db.get(User, holder_id)
    raise HTTPException(status_code=409, detail={
        "code": "REPORT_CLAIMED",
        "message": f"@{holder.username if holder else 'another moderator'} is working on this report.",
        "claimed_by": holder.username if holder else None,
    })


@router.post("/api/moderation/reports/{report_id}/claim")
def claim_report(
    report_id: str,
    context: AuthContext = Depends(require_moderator_csrf),
    db: Session = Depends(get_db),
):
    report = get_report(db, report_id)
    if report.status != "open":
        fail(409, "REPORT_ALREADY_REVIEWED", "This report has already been reviewed.")
    now = utcnow()
    # Compare-and-swap: take the claim only while it is free, stale, or already ours.
    claimed = db.query(Report).filter(
        Report.id == report.id,
        Report.status == "open",
        or_(
            Report.claimed_by_id.is_(None),
            Report.claimed_at.is_(None),
            Report.claimed_at <= now - CLAIM_TTL,
            Report.claimed_by_id == context.user.id,
        ),
    ).update({Report.claimed_by_id: context.user.id, Report.claimed_at: now}, synchronize_session=False)
    if not claimed:
        db.rollback()
        db.refresh(report)
        holder_id = claim_holder(report)
        if not holder_id:
            fail(409, "REPORT_ALREADY_REVIEWED", "This report has already been reviewed.")
        claimed_conflict(db, holder_id)
    record_action(db, context.user, "report.claim", "report", report.id, report_id=report.id)
    db.commit()
    db.refresh(report)
    return {"report": serialize_report(db, report)}


@router.delete("/api/moderation/reports/{report_id}/claim")
def release_report(
    report_id: str,
    context: AuthContext = Depends(require_moderator_csrf),
    db: Session = Depends(get_db),
):
    report = get_report(db, report_id)
    holder_id = claim_holder(report)
    if holder_id and holder_id != context.user.id and context.user.role != "admin":
        claimed_conflict(db, holder_id)
    if report.claimed_by_id:
        report.claimed_by_id = None
        report.claimed_at = None
        record_action(db, context.user, "report.release", "report", report.id, report_id=report.id)
        db.commit()
    return {"report": serialize_report(db, report)}


@router.patch("/api/moderation/reports/{report_id}")
def moderate_report(
    report_id: str,
    req: ModerationRequest,
    context: AuthContext = Depends(require_moderator_csrf),
    db: Session = Depends(get_db),
):
    report = get_report(db, report_id)
    if req.action == "reinstate_user":
        return reinstate_reported_user(db, report, req, context)
    if report.status != "open":
        fail(409, "REPORT_ALREADY_REVIEWED", "This report has already been reviewed.")
    if req.action == "remove_content" and report.target_type == "user":
        fail(422, "INVALID_MODERATION_ACTION", "User reports do not have removable content.")
    holder_id = claim_holder(report)
    forced_from = None
    if holder_id and holder_id != context.user.id:
        if not (req.force and context.user.role == "admin"):
            claimed_conflict(db, holder_id)
        holder = db.get(User, holder_id)
        forced_from = holder.username if holder else holder_id

    target_type, target_id = report.target_type, report.target_id
    target_user = target_owner(db, target_type, target_id)
    resolution = (req.resolution.strip() or req.action.replace("_", " "))[:500]
    # Compare-and-swap: when two moderators act at once, only the first changes the report.
    reviewed = db.query(Report).filter(Report.id == report.id, Report.status == "open").update({
        Report.status: "dismissed" if req.action == "dismiss" else "resolved",
        Report.resolution: resolution,
        Report.moderator_id: context.user.id,
        Report.reviewed_at: utcnow(),
    }, synchronize_session=False)
    if not reviewed:
        fail(409, "REPORT_ALREADY_REVIEWED", "This report has already been reviewed.")
    db.expire(report)

    audit = (f"report.{req.action}", "report", report.id)
    if req.action == "remove_content":
        remove_target(db, target_type, target_id)
        audit = (REMOVE_ACTION, target_type, target_id)
    elif req.action == "suspend_user":
        if not target_user:
            fail(404, "REPORT_TARGET_NOT_FOUND", "The reported user no longer exists.")
        suspend_user(db, context.user, target_user)
        audit = ("user.suspend", "user", target_user.id)
    record_action(
        db, context.user, *audit,
        reason=resolution,
        report_id=report.id,
        details={"forced_claim_of": forced_from} if forced_from else None,
    )
    db.commit()
    return {"report": serialize_report(db, report)}


def reinstate_reported_user(db: Session, report: Report, req: ModerationRequest, context: AuthContext) -> dict:
    """Undo a suspension after an appeal. Admin-only; works on reviewed reports too."""
    if context.user.role != "admin":
        fail(403, "ADMIN_REQUIRED", "Only an administrator can reinstate an account.")
    target_user = target_owner(db, report.target_type, report.target_id)
    if not target_user:
        fail(404, "REPORT_TARGET_NOT_FOUND", "The reported user no longer exists.")
    reinstate_user(target_user)
    note = (req.resolution.strip() or "reinstated user")[:500]
    if report.status == "open":
        report.status = "resolved"
        report.reviewed_at = utcnow()
        report.moderator_id = context.user.id
    report.resolution = (f"{report.resolution} | {note}" if report.resolution else note)[:500]
    record_action(db, context.user, "user.reinstate", "user", target_user.id, reason=note, report_id=report.id)
    db.commit()
    logger.info("Admin %s reinstated user %s via report %s", context.user.id, target_user.id, report.id)
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
    erase_account(db, context.user)
    response = JSONResponse({"ok": True})
    clear_auth_cookies(response)
    return response


def erase_account(db: Session, user: User) -> None:
    """Anonymize an account and remove its content, then commit. Ledger rows are kept as legal records."""
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
    saved_pack_ids = {row[0] for row in db.query(ReelPackSave.pack_id).filter(ReelPackSave.user_id == user.id).all()}
    liked_comment_ids = {
        row[0] for row in db.query(CommentLike.comment_id).filter(CommentLike.user_id == user.id).all()
    }
    db.query(PostLike).filter(PostLike.user_id == user.id).delete(synchronize_session=False)
    db.query(PostSave).filter(PostSave.user_id == user.id).delete(synchronize_session=False)
    db.query(ReelPackSave).filter(ReelPackSave.user_id == user.id).delete(synchronize_session=False)
    db.query(CommentLike).filter(CommentLike.user_id == user.id).delete(synchronize_session=False)

    authored_comments = db.query(Comment).filter(Comment.author_id == user.id, Comment.deleted_at.is_(None)).all()
    affected_comment_posts = {comment.post_id for comment in authored_comments}
    for comment in authored_comments:
        comment.deleted_at = now

    db.query(Post).filter(Post.owner_id == user.id, Post.deleted_at.is_(None)).update(
        {Post.status: "deleted", Post.deleted_at: now}, synchronize_session=False
    )
    db.query(ReelPack).filter(ReelPack.owner_id == user.id, ReelPack.deleted_at.is_(None)).update(
        {ReelPack.status: "deleted", ReelPack.deleted_at: now}, synchronize_session=False
    )
    db.query(UserBlock).filter(or_(UserBlock.blocker_id == user.id, UserBlock.blocked_id == user.id)).delete(
        synchronize_session=False
    )
    db.query(PasswordResetToken).filter(PasswordResetToken.user_id == user.id).delete(synchronize_session=False)
    # Encrypted BYOK credentials must not survive account closure: unlike
    # financial ledger rows (retained as legal records), a usable third-party
    # API key has no retention basis once the account is gone.
    db.query(FalCredential).filter(FalCredential.user_id == user.id).delete(synchronize_session=False)
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
    for pack_id in saved_pack_ids:
        pack = db.get(ReelPack, pack_id)
        if pack:
            pack.save_count = db.query(ReelPackSave.id).filter(ReelPackSave.pack_id == pack_id).count()

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
