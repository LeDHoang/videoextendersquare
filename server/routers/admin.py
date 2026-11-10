"""Staff console API: user and content lookup, direct actions, credits and the audit log.

Moderators look up users and content, suspend, sign out, remove and block tags.
Admins also reinstate, change roles, delete accounts, adjust credits, restore
content, purge a removed post's media, unblock tags, set the alert sensitivity
and read the audit log. Every change needs a reason and writes a staff_actions
row in the same transaction.
"""

from __future__ import annotations

import mimetypes
import os
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from server import alert_sensitivity, kill_switch, media_store, metrics, upload_log
from server.billing.service import debit_credits, get_wallet, grant_credits, list_transactions
from server.jobs import job_manager
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
    PostTag,
    ReelPack,
    ReelPackTag,
    Report,
    StaffAction,
    StripePurchase,
    SupportRequest,
    Tag,
    UploadTrace,
    User,
    utcnow,
)
from server.social.services import decode_cursor, encode_cursor, post_media_files, tag_slug
from server.social.staff import (
    CONTENT_MODELS,
    PURGE_ACTION,
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


class SwitchesRequest(ReasonRequest):
    free: bool
    paid: bool
    # Also stop queued and running jobs the new state no longer allows.
    cancel_running: bool = False


class SensitivityRequest(ReasonRequest):
    # One step per group, 0 (very relaxed) to 4 (very strict).
    community: int
    abuse: int


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


@router.get("/switches")
def get_switches(context: AuthContext = Depends(require_admin), db: Session = Depends(get_db)):
    del context
    return {"switches": kill_switch.state(db)}


@router.put("/switches")
def set_switches(
    req: SwitchesRequest,
    context: AuthContext = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    reason = staff_reason(db, context.user, req.reason)
    before = kill_switch.state(db)
    after = kill_switch.set_state(db, context.user, free=req.free, paid=req.paid)
    # Commit before cancelling: a cancel releases billing in its own session,
    # and the audit row (immutable) records how many jobs it stopped.
    db.commit()
    cancelled = 0
    if req.cancel_running and not (after["free"] and after["paid"]):
        message = "Cancelled: processing was paused by staff."
        cancelled = job_manager.cancel_where(lambda rec: not after["paid"] or not rec.paid, message)
    record_action(
        db, context.user, "system.kill_switch", "system", kill_switch.KEY,
        reason=reason, details={"before": before, "after": after, "cancelled": cancelled},
    )
    db.commit()
    return {"switches": after, "cancelled": cancelled}


def sensitivity_payload(db: Session) -> dict:
    return {
        "sensitivity": alert_sensitivity.state(db),
        "labels": list(alert_sensitivity.LABELS),
        "limits": metrics.alert_limits(db),
    }


@router.get("/alert-sensitivity")
def get_alert_sensitivity(context: AuthContext = Depends(require_moderator), db: Session = Depends(get_db)):
    """The alert sensitivity of each group and the limits it gives right now."""
    del context
    return sensitivity_payload(db)


@router.put("/alert-sensitivity")
def set_alert_sensitivity(
    req: SensitivityRequest,
    context: AuthContext = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    reason = staff_reason(db, context.user, req.reason)
    steps = {"community": req.community, "abuse": req.abuse}
    if not all(0 <= step < len(alert_sensitivity.FACTORS) for step in steps.values()):
        fail(422, "INVALID_SENSITIVITY", f"Choose a step from 0 to {len(alert_sensitivity.FACTORS) - 1}.")
    before = alert_sensitivity.state(db)
    after = alert_sensitivity.set_state(db, context.user, steps)
    record_action(
        db, context.user, "system.alert_sensitivity", "system", alert_sensitivity.KEY,
        reason=reason, details={"before": before, "after": after},
    )
    db.commit()
    return sensitivity_payload(db)


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
    remove_target(db, content_type, content_id)
    record_action(db, context.user, REMOVE_ACTION, content_type, content_id, reason=reason)
    db.commit()
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
    media_files = restore_target(db, content_type, content_id)
    record_action(db, context.user, "content.restore", content_type, content_id, reason=reason)
    # Upload before commit: a restored post must never point at missing media.
    try:
        media_store.republish_paths(media_files)
    except media_store.MediaStoreError:
        db.rollback()
        fail(503, "MEDIA_STORE_UNAVAILABLE", "The post's media could not be published again. Try later.")
    db.commit()
    media_store.drop_local(media_files)
    return {"item": serialize_content(db, content_type, get_content(db, content_type, content_id))}


@router.post("/content/post/{content_id}/purge")
def purge_post_media(
    content_id: str,
    req: ReasonRequest,
    context: AuthContext = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    """Delete a removed post's media from the bucket and this disk (illegal content, legal and privacy requests).

    It cannot be undone and the post cannot be restored afterwards. The edge can
    serve a cached copy for up to a day: the response lists every URL to purge there.
    """
    reason = staff_reason(db, context.user, req.reason)
    post = get_content(db, "post", content_id)
    if post.deleted_at is None:
        fail(409, "CONTENT_NOT_REMOVED", "Remove the post before purging its media.")
    local_files = post_media_files([post])
    rels = set(post.media_files or {})
    rels.update(rel for rel in map(media_store.rel_path, local_files) if rel)
    try:
        deleted = media_store.delete(rels, strict=True)
    except media_store.MediaStoreError:
        fail(503, "MEDIA_STORE_UNAVAILABLE", "The post's media could not be deleted from the bucket. Try later.")
    for path in local_files:
        path.unlink(missing_ok=True)
    record_action(
        db, context.user, PURGE_ACTION, "post", post.id,
        reason=reason, details={"objects": deleted},
    )
    db.commit()
    return {
        "item": serialize_content(db, "post", post),
        "deleted": deleted,
        "urls": sorted(media_store.public_url(rel) for rel in rels if media_store.is_published(rel)),
    }


def serialize_tag(db: Session, tag: Tag) -> dict:
    return {
        "slug": tag.slug,
        "name": tag.name,
        "blocked": tag.blocked_at is not None,
        "blocked_at": iso(tag.blocked_at),
        "post_count": db.query(func.count()).select_from(PostTag).join(Post, Post.id == PostTag.post_id).filter(
            PostTag.tag_id == tag.id, Post.deleted_at.is_(None),
        ).scalar(),
        "pack_count": db.query(func.count()).select_from(ReelPackTag).join(ReelPack, ReelPack.id == ReelPackTag.pack_id).filter(
            ReelPackTag.tag_id == tag.id, ReelPack.deleted_at.is_(None),
        ).scalar(),
        "created_at": iso(tag.created_at),
    }


@router.get("/tags")
def search_tags(
    q: str = "",
    status: Literal["all", "live", "blocked"] = "all",
    cursor: str | None = None,
    limit: int = 25,
    context: AuthContext = Depends(require_moderator),
    db: Session = Depends(get_db),
):
    del context
    query = db.query(Tag)
    term = tag_slug(q)
    if term:
        query = query.filter(Tag.slug.contains(term, autoescape=True))
    if status == "live":
        query = query.filter(Tag.blocked_at.is_(None))
    elif status == "blocked":
        query = query.filter(Tag.blocked_at.is_not(None))
    return keyset_page(query, Tag, cursor, limit, lambda row: serialize_tag(db, row))


def tag_or_422(value: str) -> str:
    slug = tag_slug(value)
    if not slug:
        fail(422, "INVALID_TAG", "Enter a tag.")
    return slug


@router.post("/tags/{tag_name}/block")
def block_tag(
    tag_name: str,
    req: ReasonRequest,
    context: AuthContext = Depends(require_moderator_csrf),
    db: Session = Depends(get_db),
):
    """Hide a tag from posts, packs, search and its own page, and refuse it on new posts.

    A tag nobody has used yet can be blocked too, so a known bad tag never appears.
    """
    reason = staff_reason(db, context.user, req.reason)
    slug = tag_or_422(tag_name)
    tag = db.query(Tag).filter(Tag.slug == slug).first()
    if tag is None:
        tag = Tag(slug=slug, name=slug)
        db.add(tag)
    elif tag.blocked_at is not None:
        fail(409, "TAG_ALREADY_BLOCKED", "This tag is already blocked.")
    tag.blocked_at = utcnow()
    record_action(db, context.user, "tag.block", "tag", slug, reason=reason)
    db.commit()
    return {"tag": serialize_tag(db, tag)}


@router.post("/tags/{tag_name}/unblock")
def unblock_tag(
    tag_name: str,
    req: ReasonRequest,
    context: AuthContext = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    """Bring a blocked tag back: posts and packs that carried it show it again."""
    reason = staff_reason(db, context.user, req.reason)
    slug = tag_or_422(tag_name)
    tag = db.query(Tag).filter(Tag.slug == slug).first()
    if tag is None:
        fail(404, "TAG_NOT_FOUND", "Tag not found.")
    if tag.blocked_at is None:
        fail(409, "TAG_NOT_BLOCKED", "This tag is not blocked.")
    tag.blocked_at = None
    record_action(db, context.user, "tag.unblock", "tag", slug, reason=reason)
    db.commit()
    return {"tag": serialize_tag(db, tag)}


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


@router.get("/upload-logs/{post_id}")
def upload_log_for_post(post_id: str, context: AuthContext = Depends(require_moderator)):
    """The upload trace of a post: each step from staging to the background encodes, with timing and errors."""
    del context
    if not upload_log.enabled():
        fail(503, "UPLOAD_LOGS_OFF", "Upload logging is not configured (R2_LOG_BUCKET).")
    try:
        trace = upload_log.read_by_post(post_id)
    except Exception:
        fail(503, "UPLOAD_LOGS_UNAVAILABLE", "The upload log bucket could not be read. Try later.")
    if trace is None:
        fail(404, "UPLOAD_LOG_NOT_FOUND", "No upload log for this post.")
    return trace


UPLOAD_LOG_SORTS = {
    "created_at": UploadTrace.created_at,
    "updated_at": UploadTrace.updated_at,
    "process_ms": UploadTrace.process_ms,
    "cost": UploadTrace.cost,
    "size_bytes": UploadTrace.size_bytes,
}
UPLOAD_LOG_STATUSES = sorted(set(upload_log.STATUS_BY_EVENT.values()))


def serialize_upload_trace(row: UploadTrace, usernames: dict[str, str]) -> dict:
    return {
        "id": row.id,
        "user_id": row.user_id,
        "username": usernames.get(row.user_id or ""),
        "kind": row.kind,
        "filename": row.filename,
        "status": row.status,
        "job_id": row.job_id,
        "post_id": row.post_id,
        "size_bytes": row.size_bytes,
        "process_ms": row.process_ms,
        "cost": row.cost,
        "error": row.error,
        "event_count": row.event_count,
        "file_count": row.file_count,
        "created_at": iso(row.created_at),
        "updated_at": iso(row.updated_at),
    }


def _usernames(db: Session, user_ids) -> dict[str, str]:
    ids = {user_id for user_id in user_ids if user_id}
    if not ids:
        return {}
    return dict(db.query(User.id, User.username).filter(User.id.in_(ids)).all())


@router.get("/upload-logs")
def list_upload_logs(
    q: str = "",
    user: str = "",
    status: str = "",
    kind: Literal["", "video", "image"] = "",
    sort: Literal["created_at", "updated_at", "process_ms", "cost", "size_bytes"] = "created_at",
    order: Literal["desc", "asc"] = "desc",
    cursor: str | None = None,
    limit: int = 25,
    context: AuthContext = Depends(require_moderator),
    db: Session = Depends(get_db),
):
    """Uploads from the trace index, filtered and sorted. The cursor is a plain offset:
    sorts other than time make keyset paging awkward, and staff lists stay small."""
    del context
    limit = max(1, min(int(limit), 50))
    offset = int(cursor) if cursor and cursor.isdigit() else 0
    query = db.query(UploadTrace)
    term = q.strip()
    if term:
        query = query.filter(or_(
            UploadTrace.id == term,
            UploadTrace.job_id == term,
            UploadTrace.post_id == term,
            UploadTrace.filename.icontains(term, autoescape=True),
        ))
    if user.strip():
        user_ids = select(User.id).where(User.username_norm == user.strip().lstrip("@").casefold())
        query = query.filter(UploadTrace.user_id.in_(user_ids))
    if status:
        query = query.filter(UploadTrace.status == status)
    if kind:
        query = query.filter(UploadTrace.kind == kind)
    column = UPLOAD_LOG_SORTS[sort]
    ordered = column.desc() if order == "desc" else column.asc()
    rows = (
        query.order_by(ordered.nulls_last(), UploadTrace.id.desc() if order == "desc" else UploadTrace.id.asc())
        .offset(offset).limit(limit + 1).all()
    )
    more = len(rows) > limit
    rows = rows[:limit]
    usernames = _usernames(db, (row.user_id for row in rows))
    return {
        "items": [serialize_upload_trace(row, usernames) for row in rows],
        "next_cursor": str(offset + limit) if more else None,
        "statuses": UPLOAD_LOG_STATUSES,
    }


@router.get("/upload-logs/trace/{trace_id}")
def upload_log_detail(
    trace_id: str,
    context: AuthContext = Depends(require_moderator),
    db: Session = Depends(get_db),
):
    """One upload: its index row, every event from R2, a signed link to its copied source,
    and the public link to its job result (gone once the ``jobs/`` lifecycle rule deletes it)."""
    del context
    if not upload_log.enabled():
        fail(503, "UPLOAD_LOGS_OFF", "Upload logging is not configured (R2_LOG_BUCKET).")
    row = db.get(UploadTrace, trace_id)
    try:
        trace = upload_log.read_trace(trace_id)
    except Exception:
        fail(503, "UPLOAD_LOGS_UNAVAILABLE", "The upload log bucket could not be read. Try later.")
    if trace is None and row is None:
        fail(404, "UPLOAD_LOG_NOT_FOUND", "No upload log with this id.")
    files = []
    for event in (trace or {}).get("events", []):
        if event.get("event") != "attachment" or not event.get("key"):
            continue
        try:
            url = upload_log.file_url(event["key"])
        except Exception:
            url = None
        files.append({
            "role": event.get("role"),
            "filename": event.get("filename"),
            "size_bytes": event.get("size_bytes"),
            "content_type": event.get("content_type"),
            "url": url,
            "expired": False,
        })
    completed = [
        event for event in (trace or {}).get("events", [])
        if event.get("event") == "process_complete" and event.get("result_key")
    ]
    if completed:
        event = completed[-1]
        key = event["result_key"]
        age = datetime.now(timezone.utc) - datetime.fromisoformat(event["at"])
        expired = age > timedelta(days=upload_log.JOB_RESULT_DAYS)
        files.append({
            "role": "result",
            "filename": key.rsplit("/", 1)[-1],
            "size_bytes": None,
            "content_type": mimetypes.guess_type(key)[0],
            "url": None if expired else media_store.public_url(key),
            "expired": expired,
        })
    usernames = _usernames(db, [row.user_id] if row else [])
    return {
        "summary": serialize_upload_trace(row, usernames) if row else None,
        "trace": trace,
        "files": files,
    }
