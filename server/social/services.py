"""Shared social-domain queries and serialization helpers."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session, joinedload, selectinload

from .auth import avatar_url, public_user
from .models import (
    Comment,
    CommentLike,
    EngagementEvent,
    Follow,
    Post,
    PostLike,
    PostSave,
    PostTag,
    Tag,
    User,
    utcnow,
)


def normalize_media_path(value: str) -> str:
    return str(value or "").strip().replace(chr(92), "/")


def tag_slug(value: str) -> str:
    cleaned = str(value or "").casefold().lstrip("#")
    return re.sub(r"[^\w]+|_+", "-", cleaned, flags=re.UNICODE).strip("-")[:60]


def username_from_label(label: str) -> str:
    value = re.sub(r"[^a-z0-9_]+", "_", str(label or "").strip().casefold()).strip("_")
    if len(value) < 3:
        value = f"demo_{value or 'user'}"
    return value[:30]


def unique_demo_username(db: Session, label: str) -> str:
    base = username_from_label(label)
    candidate = base
    index = 2
    while db.query(User.id).filter(User.username_norm == candidate).first():
        suffix = f"_{index}"
        candidate = base[: 30 - len(suffix)] + suffix
        index += 1
    return candidate


def ensure_demo_user(db: Session, label: str, avatar_color: str = "#FF3B1F") -> User:
    display_name = str(label or "ECHO Archive").strip()[:60] or "ECHO Archive"
    preferred = username_from_label(display_name)
    existing = db.query(User).filter(User.username_norm == preferred).first()
    if existing and existing.account_type in {"demo", "system"}:
        return existing
    username = unique_demo_username(db, display_name)
    user = User(
        id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"echo-demo-user:{username}")),
        username=username,
        username_norm=username,
        display_name=display_name,
        avatar_color=(avatar_color or "#FF3B1F")[:16],
        account_type="system" if username == "echo_archive" else "demo",
        status="active",
    )
    db.add(user)
    db.flush()
    return user


def sync_post_tags(db: Session, post: Post, values: list[str]) -> None:
    normalized: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in values[:5]:
        slug = tag_slug(raw)
        if not slug or slug in seen:
            continue
        seen.add(slug)
        normalized.append((slug, str(raw).strip().lstrip("#").casefold()[:60] or slug))

    post.tags.clear()
    db.flush()
    for slug, name in normalized:
        tag = db.query(Tag).filter(Tag.slug == slug).first()
        if not tag:
            tag = Tag(slug=slug, name=name)
            db.add(tag)
            db.flush()
        post.tags.append(PostTag(tag_id=tag.id))


def parse_datetime(value, fallback: datetime | None = None) -> datetime:
    if isinstance(value, datetime):
        return value
    if value:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed
        except (TypeError, ValueError):
            pass
    return fallback or utcnow()


def get_post_by_reference(
    db: Session,
    *,
    post_id: str | None = None,
    media_path: str | None = None,
    include_deleted: bool = False,
) -> Post | None:
    query = db.query(Post).options(joinedload(Post.owner), selectinload(Post.tags).selectinload(PostTag.tag))
    if post_id:
        query = query.filter(Post.id == post_id)
    elif media_path:
        query = query.filter(Post.media_path == normalize_media_path(media_path))
    else:
        return None
    if not include_deleted:
        query = query.filter(Post.deleted_at.is_(None), Post.status == "published")
    return query.first()


def post_tags(post: Post) -> list[str]:
    return [link.tag.name for link in post.tags if link.tag]


def serialize_creator(user: User, viewer_id: str | None, following_ids: set[str] | None = None) -> dict:
    following = bool(following_ids and user.id in following_ids)
    return public_user(user, viewer_id=viewer_id, is_following=following)


def serialize_comment(
    comment: Comment,
    viewer_id: str | None = None,
    liked_ids: set[str] | None = None,
) -> dict:
    author = comment.author
    timestamp = None if comment.timestamp_ms is None else round(comment.timestamp_ms / 1000, 2)
    return {
        "id": comment.id,
        "post_id": comment.post_id,
        "video_path": comment.post.media_path if getattr(comment, "post", None) else None,
        "timestamp": timestamp,
        "author_id": author.id,
        "author_name": author.username,
        "author_display_name": author.display_name,
        "author_avatar": (author.display_name or author.username or "?")[:1].upper(),
        "author_avatar_url": avatar_url(author),
        "avatar_color": author.avatar_color,
        "text": comment.text,
        "likes": comment.like_count,
        "liked_by_me": bool(liked_ids and comment.id in liked_ids),
        "can_delete": viewer_id == comment.author_id,
        "created_at": comment.created_at.isoformat() if comment.created_at else None,
    }


def reel_records(paths: list[str], viewer_id: str | None = None, include_comments: bool = True) -> dict[str, dict]:
    if not paths:
        return {}
    from .database import SessionLocal

    normalized = [normalize_media_path(path) for path in paths]
    with SessionLocal() as db:
        from .safety import blocked_user_ids

        hidden_ids = blocked_user_ids(db, viewer_id)
        posts = (
            db.query(Post)
            .join(User, User.id == Post.owner_id)
            .options(
                joinedload(Post.owner),
                selectinload(Post.tags).selectinload(PostTag.tag),
            )
            .filter(
                Post.media_path.in_(normalized),
                Post.status == "published",
                Post.deleted_at.is_(None),
                User.status == "active",
            )
            .all()
        )
        if hidden_ids:
            posts = [post for post in posts if post.owner_id not in hidden_ids]
        post_ids = [post.id for post in posts]
        liked_posts: set[str] = set()
        saved_posts: set[str] = set()
        following_ids: set[str] = set()
        liked_comments: set[str] = set()
        if viewer_id and post_ids:
            liked_posts = {
                row[0]
                for row in db.query(PostLike.post_id)
                .filter(PostLike.user_id == viewer_id, PostLike.post_id.in_(post_ids))
                .all()
            }
            saved_posts = {
                row[0]
                for row in db.query(PostSave.post_id)
                .filter(PostSave.user_id == viewer_id, PostSave.post_id.in_(post_ids))
                .all()
            }
            owner_ids = {post.owner_id for post in posts}
            following_ids = {
                row[0]
                for row in db.query(Follow.followee_id)
                .filter(Follow.follower_id == viewer_id, Follow.followee_id.in_(owner_ids))
                .all()
            }

        comments_by_post: dict[str, list[Comment]] = {}
        if include_comments and post_ids:
            comments = (
                db.query(Comment)
                .join(User, User.id == Comment.author_id)
                .options(joinedload(Comment.author), joinedload(Comment.post))
                .filter(Comment.post_id.in_(post_ids), Comment.deleted_at.is_(None), User.status == "active")
                .order_by(Comment.created_at.asc())
                .all()
            )
            if hidden_ids:
                comments = [comment for comment in comments if comment.author_id not in hidden_ids]
            for comment in comments:
                comments_by_post.setdefault(comment.post_id, []).append(comment)
            if viewer_id and comments:
                comment_ids = [comment.id for comment in comments]
                liked_comments = {
                    row[0]
                    for row in db.query(CommentLike.comment_id)
                    .filter(CommentLike.user_id == viewer_id, CommentLike.comment_id.in_(comment_ids))
                    .all()
                }

        records: dict[str, dict] = {}
        for post in posts:
            creator = serialize_creator(post.owner, viewer_id, following_ids)
            records[post.media_path] = {
                "post_id": post.id,
                "title": post.title,
                "caption": post.caption,
                "tags": post_tags(post),
                "location": post.location or {},
                "source": post.source,
                "created_at": post.created_at.isoformat() if post.created_at else "",
                "likes": post.like_count,
                "views": post.view_count,
                "comments_count": post.comment_count,
                "saves": post.save_count,
                "author_name": post.owner.username,
                "author_avatar": (post.owner.display_name or post.owner.username or "?")[:1].upper(),
                "author_avatar_url": avatar_url(post.owner),
                "creator": creator,
                "viewer_state": {
                    "liked": post.id in liked_posts,
                    "saved": post.id in saved_posts,
                    "following_creator": post.owner_id in following_ids,
                    "can_edit": viewer_id == post.owner_id,
                },
                "liked_by_me": post.id in liked_posts,
                "saved_by_me": post.id in saved_posts,
                "comments": [
                    serialize_comment(comment, viewer_id, liked_comments)
                    for comment in comments_by_post.get(post.id, [])
                ],
            }
        return records


def metadata_for_paths(paths: list[str]) -> dict[str, dict]:
    records = reel_records(paths, include_comments=False)
    return {
        path: {
            "post_id": row["post_id"],
            "title": row["title"],
            "caption": row["caption"],
            "tags": row["tags"],
            "location": row["location"],
            "author_name": row["author_name"],
            "source": row["source"],
            "created_at": row["created_at"],
            "likes": row["likes"],
            "views": row["views"],
            "liked_by_me": False,
        }
        for path, row in records.items()
    }


def create_or_update_post(
    db: Session,
    *,
    media_path: str,
    media_type: str,
    owner: User,
    title: str = "",
    caption: str = "",
    tags: list[str] | None = None,
    location: dict | None = None,
    source: str = "upload",
    created_at: datetime | None = None,
    legacy_likes: int = 0,
    legacy_views: int = 0,
    stable_legacy_id: bool = False,
) -> Post:
    normalized_path = normalize_media_path(media_path)
    post = db.query(Post).filter(Post.media_path == normalized_path).first()
    created = created_at or utcnow()
    if not post:
        post = Post(
            id=(
                str(uuid.uuid5(uuid.NAMESPACE_URL, f"echo-legacy-post:{normalized_path}"))
                if stable_legacy_id
                else str(uuid.uuid4())
            ),
            owner_id=owner.id,
            media_path=normalized_path,
            media_type=media_type if media_type in {"image", "video"} else "video",
            created_at=created,
        )
        db.add(post)
        owner.post_count = max(0, int(owner.post_count or 0) + 1)
    post.owner_id = owner.id
    post.media_type = media_type if media_type in {"image", "video"} else "video"
    post.title = str(title or "")[:100]
    post.caption = str(caption or "")[:2200]
    post.location = dict(location or {})
    post.source = str(source or "upload")[:32]
    post.status = "published"
    post.deleted_at = None
    post.legacy_like_count = max(0, int(legacy_likes or 0))
    post.legacy_view_count = max(0, int(legacy_views or 0))
    real_likes = db.query(PostLike).filter(PostLike.post_id == post.id).count() if post.id else 0
    post.like_count = post.legacy_like_count + real_likes
    post.view_count = max(post.view_count or 0, post.legacy_view_count)
    db.flush()
    sync_post_tags(db, post, list(tags or []))
    db.flush()
    return post


def shared_preview_urls(post: Post) -> dict:
    """Lightweight preview/poster URLs for inline playback (chat embeds, etc.).

    Falls back to the full media URL when no transcoded preview exists yet.
    """
    from server import media as media_service

    url = f"/media/{post.media_path}"
    if post.media_type == "image":
        return {"preview_url": url, "poster_url": url}
    try:
        source = Path("output") / post.media_path
        root = Path("output").resolve()

        def sibling_url(path: Path) -> str | None:
            try:
                if path.exists() and path.stat().st_size > 0:
                    return f"/media/{path.resolve().relative_to(root).as_posix()}"
            except (OSError, ValueError):
                return None
            return None

        preview = sibling_url(media_service.explore_preview_path(str(source)))
        poster = sibling_url(media_service.explore_poster_path(str(source)))
    except Exception:
        preview = None
        poster = None
    return {"preview_url": preview or url, "poster_url": poster}


def post_card(post: Post, db: Session, viewer_id: str | None = None) -> dict:
    liked = False
    saved = False
    following = False
    if viewer_id:
        liked = db.query(PostLike.id).filter(PostLike.user_id == viewer_id, PostLike.post_id == post.id).first() is not None
        saved = db.query(PostSave.id).filter(PostSave.user_id == viewer_id, PostSave.post_id == post.id).first() is not None
        following = db.query(Follow.id).filter(Follow.follower_id == viewer_id, Follow.followee_id == post.owner_id).first() is not None
    creator = public_user(post.owner, viewer_id=viewer_id, is_following=following)
    card = {
        "id": post.id,
        "post_id": post.id,
        "path": post.media_path,
        "media_type": post.media_type,
        "url": f"/media/{post.media_path}",
        "title": post.title,
        "caption": post.caption,
        "tags": post_tags(post),
        "location": post.location or {},
        "source": post.source,
        "likes": post.like_count,
        "views": post.view_count,
        "comments_count": post.comment_count,
        "saves": post.save_count,
        "author_name": post.owner.username,
        "creator": creator,
        "liked_by_me": liked,
        "saved_by_me": saved,
        "viewer_state": {
            "liked": liked,
            "saved": saved,
            "following_creator": following,
            "can_edit": viewer_id == post.owner_id,
        },
        "created_at": post.created_at.isoformat() if post.created_at else None,
    }
    card.update(shared_preview_urls(post))
    return card


def encode_cursor(post: Post) -> str:
    raw = json.dumps(
        {"created_at": post.created_at.isoformat(), "id": post.id},
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(value: str | None) -> tuple[datetime, str] | None:
    if not value:
        return None
    try:
        padded = value + "=" * (-len(value) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        return parse_datetime(data["created_at"]), str(data["id"])
    except Exception:
        return None


def apply_cursor(query, cursor: str | None):
    decoded = decode_cursor(cursor)
    if not decoded:
        return query
    created_at, post_id = decoded
    return query.filter(
        or_(
            Post.created_at < created_at,
            and_(Post.created_at == created_at, Post.id < post_id),
        )
    )


def record_event(
    db: Session,
    *,
    event_type: str,
    post_id: str | None = None,
    user_id: str | None = None,
    anonymous_id: str | None = None,
    source: str = "unknown",
    watch_ms: int | None = None,
    position_ms: int | None = None,
    completed: bool = False,
    context: dict | None = None,
    client_event_id: str | None = None,
) -> EngagementEvent | None:
    event_type = str(event_type or "").strip().casefold()
    if not event_type:
        return None
    if client_event_id:
        existing = db.query(EngagementEvent.id).filter(EngagementEvent.client_event_id == client_event_id[:64]).first()
        if existing:
            return None
    row = EngagementEvent(
        client_event_id=client_event_id[:64] if client_event_id else None,
        user_id=user_id,
        anonymous_id=anonymous_id,
        post_id=post_id,
        event_type=event_type[:40],
        source=str(source or "unknown")[:40],
        watch_ms=max(0, int(watch_ms)) if watch_ms is not None else None,
        position_ms=max(0, int(position_ms)) if position_ms is not None else None,
        completed=bool(completed),
        context=dict(context or {}),
    )
    db.add(row)
    return row


def viewer_key(user_id: str | None, anonymous_hash: str) -> str:
    if user_id:
        return f"u:{user_id}"
    return "a:" + hashlib.sha256(anonymous_hash.encode("utf-8")).hexdigest()[:48]


def scoped_media_paths(
    *,
    viewer_id: str | None = None,
    feed: str | None = None,
    author: str | None = None,
) -> list[str] | None:
    """Return an ordered media-path allowlist for a creator or Following feed."""
    if not feed and not author:
        return None
    from .database import SessionLocal

    with SessionLocal() as db:
        query = db.query(Post).join(User, User.id == Post.owner_id).filter(
            Post.status == "published",
            Post.deleted_at.is_(None),
            User.status == "active",
        )
        if author:
            query = query.filter(User.username_norm == str(author).strip().casefold())
        if feed == "following":
            if not viewer_id:
                return []
            followed = db.query(Follow.followee_id).filter(Follow.follower_id == viewer_id)
            query = query.filter(or_(Post.owner_id == viewer_id, Post.owner_id.in_(followed)))
        elif feed and feed != "discover":
            return []
        return [row[0] for row in query.with_entities(Post.media_path).order_by(Post.created_at.desc(), Post.id.desc()).all()]
