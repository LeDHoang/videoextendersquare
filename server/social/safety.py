"""Blocking and moderation helpers shared by social routes."""

from __future__ import annotations

from sqlalchemy import or_
from sqlalchemy.orm import Session

from .database import SessionLocal
from .models import Follow, Post, User, UserBlock


def blocked_user_ids(db: Session, user_id: str | None) -> set[str]:
    if not user_id:
        return set()
    rows = db.query(UserBlock.blocker_id, UserBlock.blocked_id).filter(
        or_(UserBlock.blocker_id == user_id, UserBlock.blocked_id == user_id)
    ).all()
    result: set[str] = set()
    for blocker_id, blocked_id in rows:
        result.add(blocked_id if blocker_id == user_id else blocker_id)
    result.discard(user_id)
    return result


def users_blocked(db: Session, first_user_id: str | None, second_user_id: str | None) -> bool:
    if not first_user_id or not second_user_id or first_user_id == second_user_id:
        return False
    return db.query(UserBlock.id).filter(
        or_(
            (UserBlock.blocker_id == first_user_id) & (UserBlock.blocked_id == second_user_id),
            (UserBlock.blocker_id == second_user_id) & (UserBlock.blocked_id == first_user_id),
        )
    ).first() is not None


def remove_relationships(db: Session, first_user_id: str, second_user_id: str) -> None:
    db.query(Follow).filter(
        or_(
            (Follow.follower_id == first_user_id) & (Follow.followee_id == second_user_id),
            (Follow.follower_id == second_user_id) & (Follow.followee_id == first_user_id),
        )
    ).delete(synchronize_session=False)


def recompute_follow_counts(db: Session, user_ids: set[str]) -> None:
    for user_id in user_ids:
        user = db.get(User, user_id)
        if not user:
            continue
        user.follower_count = db.query(Follow.id).filter(Follow.followee_id == user_id).count()
        user.following_count = db.query(Follow.id).filter(Follow.follower_id == user_id).count()


def unavailable_media_paths_for_viewer(viewer_id: str | None) -> set[str]:
    """Paths hidden because content is deleted, its owner is inactive, or users blocked each other."""
    with SessionLocal() as db:
        query = db.query(Post.media_path).join(User, User.id == Post.owner_id).filter(
            or_(Post.status != "published", Post.deleted_at.is_not(None), User.status != "active")
        )
        hidden = blocked_user_ids(db, viewer_id)
        if hidden:
            query = query.union(db.query(Post.media_path).filter(Post.owner_id.in_(hidden)))
        return {row[0] for row in query.all()}
