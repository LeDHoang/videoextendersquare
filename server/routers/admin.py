"""Staff console API: user and content lookup, direct actions, credits and the audit log.

Moderators look up users and content, suspend, sign out and remove. Admins also
reinstate, change roles, delete accounts, adjust credits, restore Reel Packs and
comments, and read the audit log. Every change needs a reason and writes a
staff_actions row in the same transaction.
"""

from __future__ import annotations

import os
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from server import media_store
from server.billing.service import debit_credits, get_wallet, grant_credits, list_transactions
from server.routers.account_safety import erase_account, serialize_report
from server.routers.social import configured_role, role_rank
from server.social.auth import (
    AuthContext,
    public_user,
    rate_limiter,
    require_admin,
    require_admin_csrf,
    require_moderator,
    require_moderator_csrf,
)
from server.social.database import get_db
from server.social.models import (
    AuthSession,
    Comment,
    Post,
    ReelPack,
    Report,
    StaffAction,
    StripePurchase,
    SupportRequest,
    User,
    utcnow,
)
from server.social.services import decode_cursor, encode_cursor
from server.social.staff import (
    CONTENT_MODELS,
    REMOVE_ACTION,
    fail,
    record_action,
    reinstate_user,
    remove_target,
    restore_target,
    revoke_sessions,
    suspend_user,
    target_owner,
)

router = APIRouter(prefix="/api/admin", tags=["admin"])
STAFF_ACTIONS_PER_HOUR = 120
CREDIT_ADJUST_MAX = 10_000
DETAIL_ROWS = 20


class ReasonRequest(BaseModel):
    reason: str = ""


class RoleRequest(ReasonRequest):
    role: Literal["user", "moderator", "admin"]


class DeleteUserRequest(ReasonRequest):
    confirm_username: str = ""


class CreditsRequest(ReasonRequest):
    amount: int
    # Generated when the dialog opens, so a retried submit cannot apply twice.
    request_id: str


def staff_reason(db: Session, actor: User, reason: str) -> str:
    reason = (reason or "").strip()
    if len(reason) < 3:
        fail(422, "REASON_REQUIRED", "Give a reason of at least 3 characters.", "reason")
    rate_limiter.check(db, f"staff:{actor.id}", STAFF_ACTIONS_PER_HOUR, 60 * 60)
    return reason[:500]


def get_user(db: Session, user_id: str) -> User:
    user = db.get(User, user_id)
    if not user:
        fail(404, "USER_NOT_FOUND", "User not found.")
    return user


def keyset_page(query, model, cursor: str | None, limit: int, serialize) -> dict:
    """Newest first, paged by (created_at, id) so rows added meanwhile do not shift the next page."""
    limit = max(1, min(int(limit), 50))
    decoded = decode_cursor(cursor)
    if decoded:
        created_at, row_id = decoded
        query = query.filter(or_(
            model.created_at < created_at,
            and_(model.created_at == created_at, model.id < row_id),
        ))
    rows = query.order_by(model.created_at.desc(), model.id.desc()).limit(limit + 1).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": [serialize(row) for row in rows], "next_cursor": encode_cursor(rows[-1]) if more else None}


def iso(value) -> str | None:
    return value.isoformat() if value else None


def staff_user(user: User) -> dict:
    return {
        **public_user(user),
        "email": user.email,
        "role": user.role,
        "env_role": configured_role(user.email or "", user.username),
        "status": user.status,
        "last_seen_at": iso(user.last_seen_at),
    }


def owned_by(type_column, id_column, user_id: str):
    """Rows (reports, staff actions) whose target is the user or content the user wrote."""
    clauses = [and_(type_column == "user", id_column == user_id)]
    for target_type, (model, owner_field) in CONTENT_MODELS.items():
        owned_ids = select(model.id).where(getattr(model, owner_field) == user_id)
        clauses.append(and_(type_column == target_type, id_column.in_(owned_ids)))
    return or_(*clauses)


def serialize_action(db: Session, row: StaffAction) -> dict:
    actor = db.get(User, row.actor_id) if row.actor_id else None
    target_user = db.get(User, row.target_id) if row.target_type == "user" else None
    return {
        "id": row.id,
        "action": row.action,
        "actor": actor.username if actor else None,
        "target_type": row.target_type,
        "target_id": row.target_id,
        "target_label": target_user.username if target_user else None,
        "report_id": row.report_id,
        "reason": row.reason,
        "details": row.details or {},
        "created_at": iso(row.created_at),
    }


def stripe_payment_url(payment_intent_id: str | None) -> str | None:
    if not payment_intent_id:
        return None
    test_mode = os.environ.get("STRIPE_SECRET_KEY", "").startswith("sk_test")
    return f"https://dashboard.stripe.com/{'test/' if test_mode else ''}payments/{payment_intent_id}"


@router.get("/users")
def search_users(
    q: str = "",
    status: str = "",
    role: str = "",
    cursor: str | None = None,
    limit: int = 25,
    context: AuthContext = Depends(require_moderator),
    db: Session = Depends(get_db),
):
    del context
    query = db.query(User)
    term = q.strip().lstrip("@").casefold()
    if term:
        query = query.filter(or_(
            User.id == term,
            User.username_norm.contains(term, autoescape=True),
            User.email_norm.contains(term, autoescape=True),
        ))
    if status:
        query = query.filter(User.status == status)
    if role:
        query = query.filter(User.role == role)
    return keyset_page(query, User, cursor, limit, staff_user)


@router.get("/users/{user_id}")
def user_detail(
    user_id: str,
    context: AuthContext = Depends(require_moderator),
    db: Session = Depends(get_db),
):
    user = get_user(db, user_id)
    now = utcnow()
    reports = db.query(Report).filter(owned_by(Report.target_type, Report.target_id, user.id)).order_by(
        Report.created_at.desc()
    ).limit(DETAIL_ROWS).all()
    filed = db.query(Report).filter(Report.reporter_id == user.id).order_by(
        Report.created_at.desc()
    ).limit(DETAIL_ROWS).all()
    posts = db.query(Post).filter(Post.owner_id == user.id).order_by(Post.created_at.desc()).limit(DETAIL_ROWS).all()
    support_filter = SupportRequest.user_id == user.id
    if user.email_norm:
        support_filter = or_(support_filter, func.lower(SupportRequest.email) == user.email_norm)
    support = db.query(SupportRequest).filter(support_filter).order_by(
        SupportRequest.created_at.desc()
    ).limit(DETAIL_ROWS).all()
    history = db.query(StaffAction).filter(
        owned_by(StaffAction.target_type, StaffAction.target_id, user.id)
    ).order_by(StaffAction.created_at.desc(), StaffAction.id.desc()).limit(50).all()
    payload = {
        "user": staff_user(user),
        "active_sessions": db.query(func.count(AuthSession.id)).filter(
            AuthSession.user_id == user.id,
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > now,
        ).scalar(),
        "reports_against": [serialize_report(db, row) for row in reports],
        "reports_filed": [
            {
                "id": row.id,
                "target_type": row.target_type,
                "reason": row.reason,
                "status": row.status,
                "created_at": iso(row.created_at),
            }
            for row in filed
        ],
        "posts": [
            {
                "id": post.id,
                "title": post.title,
                "status": post.status,
                "removed": post.deleted_at is not None,
                "created_at": iso(post.created_at),
            }
            for post in posts
        ],
        "support_requests": [
            {
                "id": row.id,
                "category": row.category,
                "status": row.status,
                "subject": row.subject,
                "created_at": iso(row.created_at),
            }
            for row in support
        ],
        "history": [serialize_action(db, row) for row in history],
    }
    if context.user.role == "admin":
        purchases = db.query(StripePurchase).filter(StripePurchase.user_id == user.id).order_by(
            StripePurchase.created_at.desc()
        ).limit(DETAIL_ROWS).all()
        payload["credits"] = {
            "wallet": get_wallet(db, user.id),
            "ledger": list_transactions(db, user.id, limit=DETAIL_ROWS),
            "purchases": [
                {
                    "id": row.id,
                    "pack_id": row.pack_id,
                    "credits": row.credits,
                    "amount_total_cents": row.amount_total_cents,
                    "currency": row.currency,
                    "amount_refunded_cents": row.amount_refunded_cents,
                    "credits_revoked": row.credits_revoked,
                    "status": row.status,
                    "created_at": iso(row.created_at),
                    "stripe_url": stripe_payment_url(row.payment_intent_id),
                }
                for row in purchases
            ],
        }
    return payload


@router.post("/users/{user_id}/suspend")
def suspend_account(
    user_id: str,
    req: ReasonRequest,
    context: AuthContext = Depends(require_moderator_csrf),
    db: Session = Depends(get_db),
):
    reason = staff_reason(db, context.user, req.reason)
    user = get_user(db, user_id)
    if user.status != "active":
        fail(409, "ACCOUNT_NOT_ACTIVE", f"This account is {user.status}; only active accounts can be suspended.")
    suspend_user(db, context.user, user)
    record_action(db, context.user, "user.suspend", "user", user.id, reason=reason)
    db.commit()
    return {"user": staff_user(user)}


@router.post("/users/{user_id}/reinstate")
def reinstate_account(
    user_id: str,
    req: ReasonRequest,
    context: AuthContext = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    reason = staff_reason(db, context.user, req.reason)
    user = get_user(db, user_id)
    reinstate_user(user)
    record_action(db, context.user, "user.reinstate", "user", user.id, reason=reason)
    db.commit()
    return {"user": staff_user(user)}


@router.post("/users/{user_id}/sign-out")
def sign_out_account(
    user_id: str,
    req: ReasonRequest,
    context: AuthContext = Depends(require_moderator_csrf),
    db: Session = Depends(get_db),
):
    reason = staff_reason(db, context.user, req.reason)
    user = get_user(db, user_id)
    if user.role != "user" and context.user.role != "admin":
        fail(403, "STAFF_PROTECTED", "Only an administrator can act on a staff account.")
    revoked = revoke_sessions(db, user.id)
    record_action(db, context.user, "user.sign_out", "user", user.id, reason=reason, details={"sessions": revoked})
    db.commit()
    return {"user": staff_user(user), "revoked_sessions": revoked}


@router.put("/users/{user_id}/role")
def set_role(
    user_id: str,
    req: RoleRequest,
    context: AuthContext = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    reason = staff_reason(db, context.user, req.reason)
    user = get_user(db, user_id)
    if user.id == context.user.id:
        fail(422, "SELF_ROLE_CHANGE", "You cannot change your own role.")
    if user.status == "deleted":
        fail(409, "ACCOUNT_DELETED", "Deleted accounts cannot be given a role.")
    env_role = configured_role(user.email or "", user.username)
    if role_rank(req.role) < role_rank(env_role):
        fail(
            409,
            "ROLE_FROM_ENV",
            f"SX_ADMIN_USERS / SX_MODERATOR_USERS make this account {env_role}. Remove it there first.",
        )
    previous = user.role
    if previous != req.role:
        user.role = req.role
        record_action(
            db, context.user, "user.role", "user", user.id,
            reason=reason, details={"from": previous, "to": req.role},
        )
        db.commit()
    return {"user": staff_user(user)}


@router.post("/users/{user_id}/delete")
def delete_user(
    user_id: str,
    req: DeleteUserRequest,
    context: AuthContext = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    reason = staff_reason(db, context.user, req.reason)
    user = get_user(db, user_id)
    if user.id == context.user.id:
        fail(422, "SELF_DELETE", "Delete your own account from account settings.")
    if user.role == "admin":
        fail(403, "ADMIN_PROTECTED", "Change an administrator's role before deleting the account.")
    if user.status == "deleted":
        fail(409, "ACCOUNT_DELETED", "This account is already deleted.")
    if req.confirm_username.strip().lstrip("@").casefold() != user.username_norm:
        fail(422, "CONFIRMATION_REQUIRED", "Type the username to confirm.", "confirm_username")
    # No username or email in the audit row: erasure would be undone by the log.
    record_action(db, context.user, "user.delete", "user", user.id, reason=reason)
    erase_account(db, user)
    return {"user": staff_user(user)}


@router.post("/users/{user_id}/credits")
def adjust_credits(
    user_id: str,
    req: CreditsRequest,
    context: AuthContext = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    reason = staff_reason(db, context.user, req.reason)
    if req.amount == 0 or abs(req.amount) > CREDIT_ADJUST_MAX:
        fail(422, "INVALID_AMOUNT", f"Enter a nonzero amount up to {CREDIT_ADJUST_MAX:,}.", "amount")
    request_id = req.request_id.strip()
    if not 8 <= len(request_id) <= 64:
        fail(422, "INVALID_REQUEST_ID", "Reopen the dialog and try again.")
    user = get_user(db, user_id)
    if user.status == "deleted":
        fail(409, "ACCOUNT_DELETED", "Deleted accounts cannot receive credits.")
    move = grant_credits if req.amount > 0 else debit_credits
    _account, applied = move(
        db,
        user.id,
        abs(req.amount),
        source="admin",
        idempotency_key=f"admin:{request_id}",
        reference_type="staff_action",
        reference_id=request_id,
        details={"actor": context.user.username, "reason": reason},
    )
    if applied:
        record_action(
            db, context.user, "user.credits", "user", user.id,
            reason=reason, details={"amount": req.amount, "request_id": request_id},
        )
        db.commit()
    return {"applied": applied, "wallet": get_wallet(db, user.id)}


ContentType = Literal["post", "pack", "comment"]


def serialize_content(db: Session, content_type: str, row) -> dict:
    owner = target_owner(db, content_type, row.id)
    item = {
        "type": content_type,
        "id": row.id,
        "owner": owner.username if owner else None,
        "owner_id": owner.id if owner else None,
        "removed": row.deleted_at is not None,
        "created_at": iso(row.created_at),
    }
    if content_type == "post":
        item.update(text=row.title or row.caption[:120], status=row.status, link=f"/reels?post={row.id}")
    elif content_type == "pack":
        item.update(text=row.title, status=row.status, link=f"/packs/{row.id}")
    else:
        item.update(text=row.text, status="removed" if row.deleted_at else "live", link=f"/reels?post={row.post_id}")
    return item


@router.get("/content")
def search_content(
    type: ContentType = "post",
    q: str = "",
    owner: str = "",
    status: Literal["all", "live", "removed"] = "all",
    cursor: str | None = None,
    limit: int = 25,
    context: AuthContext = Depends(require_moderator),
    db: Session = Depends(get_db),
):
    """Direct messages are not listed here: staff see them only through a report."""
    del context
    model, owner_field = CONTENT_MODELS[type]
    query = db.query(model)
    term = q.strip()
    if term:
        text_columns = {
            "post": (Post.title, Post.caption),
            "pack": (ReelPack.title, ReelPack.description),
            "comment": (Comment.text,),
        }[type]
        query = query.filter(or_(
            model.id == term,
            *[column.icontains(term, autoescape=True) for column in text_columns],
        ))
    if owner.strip():
        owner_ids = select(User.id).where(User.username_norm == owner.strip().lstrip("@").casefold())
        query = query.filter(getattr(model, owner_field).in_(owner_ids))
    if status == "live":
        query = query.filter(model.deleted_at.is_(None))
    elif status == "removed":
        query = query.filter(model.deleted_at.is_not(None))
    return keyset_page(query, model, cursor, limit, lambda row: serialize_content(db, type, row))


def get_content(db: Session, content_type: str, content_id: str):
    model, _owner_field = CONTENT_MODELS[content_type]
    row = db.get(model, content_id)
    if not row:
        fail(404, "CONTENT_NOT_FOUND", "Content not found.")
    return row


@router.post("/content/{content_type}/{content_id}/remove")
def remove_content(
    content_type: ContentType,
    content_id: str,
    req: ReasonRequest,
    context: AuthContext = Depends(require_moderator_csrf),
    db: Session = Depends(get_db),
):
    reason = staff_reason(db, context.user, req.reason)
    row = get_content(db, content_type, content_id)
    if row.deleted_at is not None:
        fail(409, "CONTENT_ALREADY_REMOVED", "This content is already removed.")
    _removed, media_files = remove_target(db, content_type, content_id)
    record_action(db, context.user, REMOVE_ACTION, content_type, content_id, reason=reason)
    db.commit()
    media_store.delete_paths(media_files)
    return {"item": serialize_content(db, content_type, row)}


@router.post("/content/{content_type}/{content_id}/restore")
def restore_content(
    content_type: ContentType,
    content_id: str,
    req: ReasonRequest,
    context: AuthContext = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    reason = staff_reason(db, context.user, req.reason)
    restore_target(db, content_type, content_id)
    record_action(db, context.user, "content.restore", content_type, content_id, reason=reason)
    db.commit()
    return {"item": serialize_content(db, content_type, get_content(db, content_type, content_id))}


@router.get("/audit")
def audit_log(
    actor: str = "",
    action: str = "",
    target_type: str = "",
    target_id: str = "",
    cursor: str | None = None,
    limit: int = 50,
    context: AuthContext = Depends(require_admin),
    db: Session = Depends(get_db),
):
    del context
    query = db.query(StaffAction)
    if actor.strip():
        actor_ids = select(User.id).where(User.username_norm == actor.strip().lstrip("@").casefold())
        query = query.filter(StaffAction.actor_id.in_(actor_ids))
    if action:
        query = query.filter(StaffAction.action == action)
    if target_type:
        query = query.filter(StaffAction.target_type == target_type)
    if target_id:
        query = query.filter(StaffAction.target_id == target_id)
    return keyset_page(query, StaffAction, cursor, limit, lambda row: serialize_action(db, row))
