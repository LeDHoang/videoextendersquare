"""Staff actions shared by report review and the admin console, and their audit rows.

The helpers change rows inside the caller's transaction and never commit. A
removal only hides content: a removed post keeps its R2 objects, so a restore
can publish it again.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.orm import Session

from server.social.models import (
    AuthSession,
    Comment,
    Conversation,
    ConversationMember,
    DirectMessage,
    MessageEvent,
    Post,
    ReelPack,
    StaffAction,
    User,
    utcnow,
)
from server.social.services import post_media_files, record_media_files

# Content type -> (model, column holding the author's user id).
CONTENT_MODELS = {
    "post": (Post, "owner_id"),
    "pack": (ReelPack, "owner_id"),
    "comment": (Comment, "author_id"),
    "message": (DirectMessage, "sender_id"),
}
REMOVE_ACTION = "content.remove"


def fail(status: int, code: str, message: str, field: str | None = None):
    detail = {"code": code, "message": message}
    if field:
        detail["field"] = field
    raise HTTPException(status_code=status, detail=detail)


def record_action(
    db: Session,
    actor: User,
    action: str,
    target_type: str,
    target_id: str,
    *,
    reason: str = "",
    report_id: str | None = None,
    details: dict | None = None,
) -> StaffAction:
    row = StaffAction(
        actor_id=actor.id,
        action=action,
        target_type=target_type,
        target_id=str(target_id),
        report_id=report_id,
        reason=(reason or "").strip()[:500],
        details=dict(details or {}),
    )
    db.add(row)
    return row


def target_owner(db: Session, target_type: str, target_id: str) -> User | None:
    """The account behind a target: the user itself, or the author of the content."""
    if target_type == "user":
        return db.get(User, target_id)
    model, owner_field = CONTENT_MODELS[target_type]
    row = db.get(model, target_id)
    return db.get(User, getattr(row, owner_field)) if row else None


def revoke_sessions(db: Session, user_id: str) -> int:
    return db.query(AuthSession).filter(
        AuthSession.user_id == user_id,
        AuthSession.revoked_at.is_(None),
    ).update({AuthSession.revoked_at: utcnow()}, synchronize_session=False)


def suspend_user(db: Session, actor: User, target: User) -> None:
    if target.role == "admin":
        fail(403, "ADMIN_PROTECTED", "Administrators cannot be suspended here.")
    if target.id == actor.id:
        fail(422, "SELF_SUSPENSION", "You cannot suspend your own account.")
    if actor.role != "admin" and target.role == "moderator":
        fail(403, "MODERATOR_PROTECTED", "Only an administrator can suspend a moderator.")
    # A deleted account stays deleted: "suspended" would make it appealable
    # and show its hidden DMs again.
    if target.status != "deleted":
        target.status = "suspended"
    revoke_sessions(db, target.id)


def reinstate_user(target: User) -> None:
    """Only ``suspended`` accounts go back to ``active``; deleted accounts are anonymized and never restored."""
    if target.status == "deleted":
        fail(409, "ACCOUNT_DELETED", "Deleted accounts cannot be reinstated.")
    if target.status != "suspended":
        fail(409, "ACCOUNT_NOT_SUSPENDED", "This account is not suspended.")
    target.status = "active"


def remove_target(db: Session, target_type: str, target_id: str) -> bool:
    """Soft-delete content. Returns False if it was already gone.

    A post's media stays in R2 (the post is only hidden), which lets an admin
    restore it.
    """
    now = utcnow()
    model, _owner_field = CONTENT_MODELS[target_type]
    row = db.get(model, target_id)
    if not row or row.deleted_at is not None:
        return False
    row.deleted_at = now
    if target_type == "post":
        row.status = "deleted"
        owner = db.get(User, row.owner_id)
        if owner:
            owner.post_count = max(0, int(owner.post_count or 0) - 1)
    elif target_type == "pack":
        row.status = "deleted"
    elif target_type == "comment":
        post = db.get(Post, row.post_id)
        if post:
            post.comment_count = max(0, int(post.comment_count or 0) - 1)
    elif target_type == "message":
        conversation = db.get(Conversation, row.conversation_id)
        if conversation:
            conversation.updated_at = now
            member_ids = db.query(ConversationMember.user_id).filter(
                ConversationMember.conversation_id == conversation.id,
            ).all()
            for (recipient_id,) in member_ids:
                db.add(MessageEvent(
                    recipient_id=recipient_id,
                    conversation_id=conversation.id,
                    message_id=row.id,
                    event_type="message.deleted",
                ))
    return True


def restore_target(db: Session, target_type: str, target_id: str) -> list:
    """Undo a staff removal of a post, Reel Pack or comment. Returns media files to republish.

    Content the author deleted themselves, or that went with a deleted account,
    stays deleted: only the latest staff action on the target being a removal
    allows a restore. A post's media files are returned: a post removed while
    removals still deleted its R2 objects kept local copies, which the caller
    uploads again before commit.
    """
    if target_type not in ("post", "pack", "comment"):
        fail(422, "INVALID_CONTENT_TYPE", "Only posts, Reel Packs and comments can be restored.")
    model, owner_field = CONTENT_MODELS[target_type]
    row = db.get(model, target_id)
    if not row:
        fail(404, "CONTENT_NOT_FOUND", "Content not found.")
    if row.deleted_at is None:
        fail(409, "CONTENT_NOT_REMOVED", "This content is not removed.")
    last = db.query(StaffAction.action).filter(
        StaffAction.target_type == target_type,
        StaffAction.target_id == target_id,
        StaffAction.action.in_((REMOVE_ACTION, "content.restore")),
    ).order_by(StaffAction.created_at.desc(), StaffAction.id.desc()).first()
    if not last or last[0] != REMOVE_ACTION:
        fail(409, "NOT_REMOVED_BY_STAFF", "Only content removed by staff can be restored.")
    owner = db.get(User, getattr(row, owner_field))
    if not owner or owner.status == "deleted":
        fail(409, "ACCOUNT_DELETED", "The author's account was deleted.")
    media_files = []
    if target_type == "post":
        media_files = post_media_files([row])
        record_media_files(row)
        # Only the originals are required; generated siblings that are missing get skipped.
        originals = [row.media_path, *(slide.media_path for slide in row.slides)]
        if not all(rel in (row.media_files or {}) for rel in originals if rel):
            fail(409, "MEDIA_MISSING", "The post's media files are no longer stored.")
        row.status = "published"
        owner.post_count = int(owner.post_count or 0) + 1
    elif target_type == "pack":
        # Removal does not keep the previous status; a restored pack comes back
        # as a draft so its owner decides when it is public again.
        row.status = "draft"
    else:
        post = db.get(Post, row.post_id)
        if post:
            post.comment_count = int(post.comment_count or 0) + 1
    row.deleted_at = None
    return media_files
