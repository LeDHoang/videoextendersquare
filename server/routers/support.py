"""Support inbox: public request form (signed in or out) and the moderator queue.

Requests can be filed signed out because suspended accounts cannot sign in and
must still be able to appeal. ``report_content`` requests with a canonical link
become real Reports when the requester is signed in; signed-out links stay on
the request and a moderator files them from the inbox with one click.
"""

from __future__ import annotations

import uuid
from typing import Literal
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from server.routers.account_safety import REPORT_REASONS, fail, file_report
from server.social.auth import (
    AuthContext,
    get_optional_auth,
    keyed_hash,
    normalize_email,
    rate_limiter,
    request_identity,
    require_moderator,
    require_moderator_csrf,
    validate_csrf,
    validate_origin,
)
from server.social.database import get_db
from server.social.email import send_support_notification
from server.social.models import Post, ReelPack, Report, SupportRequest, User, utcnow
from server.social.staff import record_action

router = APIRouter(tags=["support"])

SUPPORT_CATEGORIES = ("appeal", "copyright", "privacy", "account", "bug", "report_content", "other")
SUPPORT_STATUSES = ("open", "in_progress", "closed")
IP_LIMIT_PER_HOUR = 5
USER_LIMIT_PER_HOUR = 10


class SupportCreateRequest(BaseModel):
    category: Literal["appeal", "copyright", "privacy", "account", "bug", "report_content", "other"]
    email: EmailStr | None = None
    subject: str = Field(default="", max_length=120)
    body: str = Field(default="", max_length=4000)
    link: str = Field(default="", max_length=500)
    reason: str = "other"
    # Honeypot: hidden from people, filled by naive bots.
    website: str = ""


class SupportUpdateRequest(BaseModel):
    status: Literal["open", "in_progress", "closed"] | None = None
    note: str | None = Field(default=None, max_length=1000)


def parse_target_link(db: Session, link: str) -> tuple[str, str] | None:
    """Map a canonical ECHO link to an existing ``(target_type, target_id)``.

    Accepts ``/reels?post=<id>``, ``/packs/<id>`` and ``/profile/<username>``,
    as a path or a full URL. Returns None for anything else or a missing target.
    """
    parts = urlsplit((link or "").strip())
    segments = [segment for segment in parts.path.split("/") if segment]
    if segments == ["reels"]:
        post_id = (parse_qs(parts.query).get("post") or [""])[0].strip()
        post = db.get(Post, post_id) if post_id else None
        if post and post.deleted_at is None and post.status != "deleted":
            return "post", post.id
    elif len(segments) == 2 and segments[0] == "packs":
        pack = db.get(ReelPack, segments[1])
        if pack and pack.deleted_at is None and pack.status != "deleted":
            return "pack", pack.id
    elif len(segments) == 2 and segments[0] == "profile":
        user = db.query(User).filter(
            User.username_norm == segments[1].strip().casefold(),
            User.status == "active",
        ).first()
        if user:
            return "user", user.id
    return None


def report_reason(value: str) -> str:
    reason = (value or "").strip().casefold()
    return reason if reason in REPORT_REASONS else "other"


def serialize_support(db: Session, row: SupportRequest) -> dict:
    user = db.get(User, row.user_id) if row.user_id else None
    handler = db.get(User, row.handled_by_id) if row.handled_by_id else None
    report = db.get(Report, row.report_id) if row.report_id else None
    return {
        "id": row.id,
        "category": row.category,
        "status": row.status,
        "username": user.username if user else None,
        "email": row.email,
        "subject": row.subject,
        "body": row.body,
        "link": row.link,
        "report_id": row.report_id,
        "report_status": report.status if report else None,
        "can_file_report": bool(row.link) and row.report_id is None and parse_target_link(db, row.link) is not None,
        "moderator_note": row.moderator_note,
        "handled_by": handler.username if handler else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.post("/api/support", status_code=202)
def create_support_request(
    req: SupportCreateRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    context: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    # Signed in: the session's CSRF token. Signed out: the same origin check as
    # the anonymous password-reset request.
    if context is not None:
        validate_csrf(request, context)
    else:
        validate_origin(request)
    if req.website.strip():
        return JSONResponse({"id": str(uuid.uuid4()), "status": "open"}, status_code=202)

    email = normalize_email(str(req.email)) if req.email else None
    if context is None and not email:
        fail(422, "EMAIL_REQUIRED", "Add an email address so we can reply.", "email")
    subject = " ".join(req.subject.split())
    body = req.body.strip()
    link = req.link.strip()
    if not body and not (req.category == "report_content" and link):
        fail(422, "BODY_REQUIRED", "Describe what you need help with.", "body")

    ip_hash = keyed_hash(f"support-ip:{request_identity(request)}")
    if context is None:
        rate_limiter.check(db, f"support-ip:{ip_hash}", IP_LIMIT_PER_HOUR, 60 * 60)
    else:
        rate_limiter.check(db, f"support-user:{context.user.id}", USER_LIMIT_PER_HOUR, 60 * 60)

    request_id = str(uuid.uuid4())
    report_id = None
    if req.category == "report_content":
        target = parse_target_link(db, link)
        if target is None:
            fail(
                422,
                "INVALID_REPORT_LINK",
                "Paste a link to an existing post, Reel Pack or profile.",
                "link",
            )
        if context is not None:
            details = f"Support request {request_id}: {subject or body}"
            report, _duplicate = file_report(db, context.user, target[0], target[1], report_reason(req.reason), details)
            report_id = report.id

    row = SupportRequest(
        id=request_id,
        category=req.category,
        status="open",
        user_id=context.user.id if context else None,
        email=email,
        subject=subject[:120],
        body=body[:4000],
        link=link[:500],
        report_id=report_id,
        ip_hash=ip_hash,
    )
    db.add(row)
    db.commit()
    background_tasks.add_task(send_support_notification, row.id, row.category, row.subject)
    return {"id": row.id, "status": row.status, "report_id": report_id}


@router.get("/api/moderation/support")
def list_support_requests(
    status: str = "open",
    limit: int = 50,
    context: AuthContext = Depends(require_moderator),
    db: Session = Depends(get_db),
):
    del context
    query = db.query(SupportRequest)
    if status != "all":
        if status not in SUPPORT_STATUSES:
            fail(422, "INVALID_STATUS", "Choose a valid status.", "status")
        query = query.filter(SupportRequest.status == status)
    rows = query.order_by(SupportRequest.created_at.asc()).limit(max(1, min(limit, 100))).all()
    return {"requests": [serialize_support(db, row) for row in rows]}


def get_support_request(db: Session, request_id: str) -> SupportRequest:
    row = db.get(SupportRequest, request_id)
    if not row:
        fail(404, "SUPPORT_REQUEST_NOT_FOUND", "Support request not found.")
    return row


@router.patch("/api/moderation/support/{request_id}")
def update_support_request(
    request_id: str,
    req: SupportUpdateRequest,
    context: AuthContext = Depends(require_moderator_csrf),
    db: Session = Depends(get_db),
):
    row = get_support_request(db, request_id)
    if req.status is not None:
        row.status = req.status
    if req.note is not None:
        row.moderator_note = req.note.strip()[:1000]
    row.handled_by_id = context.user.id
    row.updated_at = utcnow()
    record_action(
        db, context.user, "support.update", "support", row.id,
        reason=req.note or "",
        details={"status": req.status} if req.status is not None else None,
    )
    db.commit()
    return {"request": serialize_support(db, row)}


@router.post("/api/moderation/support/{request_id}/file-report")
def file_support_report(
    request_id: str,
    context: AuthContext = Depends(require_moderator_csrf),
    db: Session = Depends(get_db),
):
    row = get_support_request(db, request_id)
    if row.report_id:
        fail(409, "REPORT_ALREADY_FILED", "A report was already filed for this request.")
    target = parse_target_link(db, row.link)
    if target is None:
        fail(422, "INVALID_REPORT_LINK", "The link does not point to an existing post, Reel Pack or profile.")
    details = f"Support request {row.id}: {row.subject or row.body}"
    report, _duplicate = file_report(db, context.user, target[0], target[1], "other", details)
    row.report_id = report.id
    if row.status == "open":
        row.status = "in_progress"
    row.handled_by_id = context.user.id
    row.updated_at = utcnow()
    record_action(db, context.user, "support.file_report", "support", row.id, report_id=report.id)
    db.commit()
    return {"request": serialize_support(db, row), "report_id": report.id}
