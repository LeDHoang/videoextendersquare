"""Shared social-domain queries and serialization helpers."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import math
import re
import stat
import uuid
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session, joinedload, selectinload

from server import metrics
from server.media_store import public_url
from .auth import avatar_url, public_user
from .models import (
    Comment,
    CommentLike,
    EngagementEvent,
    Follow,
    Post,
    PostLike,
    PostSave,
    PostSlide,
    PostTag,
    Tag,
    User,
    utcnow,
)


logger = logging.getLogger(__name__)

# Image posts hold this long in the player unless the post sets dwell_ms.
IMAGE_POST_DWELL_MS = 15_000
# A multi-image post carries at most this many images (cover included).
MAX_POST_IMAGES = 10


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


def _session_scope(db: Session | None):
    """The caller's session when given, else a short-lived one of our own.

    Routes pass their request ``db`` so one request holds at most one pooled
    connection; a helper that opens a second session while the request
    session holds the first is a hold-and-wait that deadlocks a busy pool.
    """
    if db is not None:
        return nullcontext(db)
    from .database import SessionLocal

    return SessionLocal()


def reel_records(
    paths: list[str],
    viewer_id: str | None = None,
    include_comments: bool = True,
    db: Session | None = None,
) -> dict[str, dict]:
    if not paths:
        return {}
    normalized = [normalize_media_path(path) for path in paths]
    with _session_scope(db) as db:
        from .safety import blocked_user_ids

        hidden_ids = blocked_user_ids(db, viewer_id)
        posts = (
            db.query(Post)
            .join(User, User.id == Post.owner_id)
            .options(
                joinedload(Post.owner),
                selectinload(Post.tags).selectinload(PostTag.tag),
                selectinload(Post.slides),
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
                .options(joinedload(Comment.author))
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
                "duration_ms": post.duration_ms,
                "width": post.width,
                "height": post.height,
                "stereo_layout": post.stereo_layout or "mono",
                "media_files": post.media_files,
                **post_image_fields(post),
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


def metadata_for_paths(paths: list[str], db: Session | None = None) -> dict[str, dict]:
    records = reel_records(paths, include_comments=False, db=db)
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


def post_media_files(posts) -> list[Path]:
    """Every local file (originals and generated siblings) of *posts*.

    The paths exist or not: a dropped copy lives on in R2 only.
    """
    from server import media as media_service

    files: list[Path] = []
    for post in posts:
        for rel in [post.media_path, *(slide.media_path for slide in post.slides)]:
            if rel:
                files.extend(media_service.derived_files(Path("output") / rel))
    return files


def _output_url(path: Path) -> str | None:
    try:
        return public_url(path.resolve().relative_to(Path('output').resolve()).as_posix())
    except (OSError, ValueError):
        return None


def stereo_fields(media_path: str, layout: str | None, files: dict | None = None) -> dict:
    """Playback fields for a post's stereo layout (docs/stereo-3d-reels.md).

    Mono posts get {"stereo_layout": "mono", "stereo_url": None}. Stereo posts
    also get "url" pointing at the left-eye <stem>-mono rendition every 2D
    surface plays, "stereo_url" at the full stereo file (or its H.264 proxy)
    the VR player samples per eye, and "stereo_crop" when no rendition exists
    yet so 2D shows the raw file cropped to the left eye instead. *files* is
    the post's media record (posts.media_files); without it the disk is read.
    """
    from server import media as media_service

    layout = layout if layout in media_service.STEREO_LAYOUTS else "mono"
    if layout == "mono":
        return {"stereo_layout": "mono", "stereo_url": None, "stereo_crop": False}
    source = Path("output") / media_path
    mono, stereo = media_service.stereo_paths(str(source), files)
    raw_url = public_url(media_path)
    mono_url = _output_url(mono) if mono else None
    return {
        "stereo_layout": layout,
        "url": mono_url or raw_url,
        "stereo_url": _output_url(stereo) or raw_url,
        "stereo_crop": mono_url is None,
    }


def _image_entry(
    media_path: str,
    width: int | None,
    height: int | None,
    layout: str = "mono",
    files: dict | None = None,
) -> dict:
    """One image of an image post as the player needs it.

    For stereo images "url"/"poster_url" are the left-eye rendition and its
    poster, and "stereo_url" is the full stereo still.
    """
    from server import media as media_service

    stereo = stereo_fields(media_path, layout, files)
    url = stereo.get("url") or public_url(media_path)
    poster_url = url
    try:
        source = Path("output") / media_path
        if stereo["stereo_layout"] != "mono" and not stereo["stereo_crop"]:
            source = media_service.mono_sibling_path(str(source))
        poster = Path(media_service.explore_poster_path(str(source)))
        if files is not None:
            # The record only holds posters that were fresh when recorded.
            if media_service.has_media_file(poster, files):
                poster_url = _output_url(poster) or poster_url
        else:
            poster_stat = poster.stat()  # one stat; a missing poster raises and keeps the fallback
            if stat.S_ISREG(poster_stat.st_mode) and poster_stat.st_size > 0 and poster_stat.st_mtime >= source.stat().st_mtime:
                poster_url = _output_url(poster) or poster_url
    except (OSError, ValueError):
        pass
    return {
        "path": media_path,
        "url": url,
        "poster_url": poster_url,
        "width": width,
        "height": height,
        "stereo_layout": stereo["stereo_layout"],
        "stereo_url": stereo["stereo_url"],
        "stereo_crop": stereo["stereo_crop"],
    }


def post_image_fields(post: Post) -> dict:
    """Slideshow fields for an image post: every image in order and the dwell.

    Video posts get an empty image list so callers can branch on media_type.
    Every slide of a stereo post shares the post's stereo layout.
    """
    if post.media_type != "image":
        return {"images": [], "dwell_ms": None}
    layout = post.stereo_layout or "mono"
    files = post.media_files
    images = [_image_entry(post.media_path, post.width, post.height, layout, files)]
    images.extend(_image_entry(slide.media_path, slide.width, slide.height, layout, files) for slide in post.slides)
    return {"images": images, "dwell_ms": int(post.dwell_ms or IMAGE_POST_DWELL_MS)}


def slide_media_paths(db: Session | None = None) -> set[str]:
    """Media paths that are extra slides of some post (never their own tile)."""
    if db is not None:
        return {row[0] for row in db.query(PostSlide.media_path).all()}
    from .database import SessionLocal

    with SessionLocal() as session:
        return {row[0] for row in session.query(PostSlide.media_path).all()}


def published_media_paths(db: Session | None = None) -> set[str]:
    """Primary media paths of every post row (status filtering is per viewer)."""
    if db is not None:
        return {row[0] for row in db.query(Post.media_path).all()}
    from .database import SessionLocal

    with SessionLocal() as session:
        return {row[0] for row in session.query(Post.media_path).all()}


def post_media_items(db: Session | None = None) -> list[dict]:
    """Feed items (the scan_output_media shape) of every post row, newest first.

    Built from each post's media record, so nothing is read from disk. Rows
    without a record (posts.media_files NULL) are listed only while their
    original is on this disk, as the output/ scan did. A recorded item's
    mtime is the post's creation time.
    """
    from server import media as media_service

    if db is None:
        from .database import SessionLocal

        with SessionLocal() as session:
            return post_media_items(session)
    items = []
    columns = (Post.media_path, Post.media_type, Post.media_files, Post.created_at)
    for rel, media_type, files, created_at in db.query(*columns).all():
        path = Path("output") / rel
        if files is not None:
            if rel not in files:
                continue
            size = files[rel].get("bytes")
            created = created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
            mtime = created.timestamp()
        else:
            try:
                st = path.stat()
            except OSError:
                continue
            size, mtime = st.st_size, st.st_mtime
        items.append({
            "path": str(path.resolve()),
            "rel_path": rel,
            "filename": path.name,
            "folder": path.parent.as_posix() if path.parent != Path(".") else "root",
            "size_bytes": size,
            "size_human": media_service.human_bytes(size),
            "mtime": mtime,
            "media_type": media_type,
        })
    items.sort(key=lambda item: item["mtime"], reverse=True)
    return items


def _probe_size(media_path: str) -> tuple[int | None, int | None]:
    from server import media as media_service

    path = Path("output") / media_path
    try:
        if not path.is_file():
            return None, None
    except OSError:
        return None, None
    info = media_service.probe_media_info(str(path)) or {}
    return info.get("width"), info.get("height")


def sync_post_slides(db: Session, post: Post, slide_paths: list[str]) -> None:
    """Replace an image post's extra slides (images after the cover), in order.

    Raises ValueError for a video post with slides, too many images, a
    duplicate, or a file that already belongs to another post.
    """
    normalized = [normalize_media_path(path) for path in slide_paths]
    if normalized and post.media_type != "image":
        raise ValueError("Only image posts can have more than one media file.")
    if len(normalized) + 1 > MAX_POST_IMAGES:
        raise ValueError(f"An image post holds at most {MAX_POST_IMAGES} images.")
    if len(set(normalized)) != len(normalized) or post.media_path in normalized:
        raise ValueError("An image post cannot repeat the same image.")
    if normalized:
        taken_by_post = db.query(Post.id).filter(Post.media_path.in_(normalized)).first()
        taken_by_slide = (
            db.query(PostSlide.post_id)
            .filter(PostSlide.media_path.in_(normalized), PostSlide.post_id != post.id)
            .first()
        )
        if taken_by_post or taken_by_slide:
            raise ValueError("An image already belongs to another post.")
    post.slides.clear()
    db.flush()
    for position, media_path in enumerate(normalized, start=1):
        width, height = _probe_size(media_path)
        post.slides.append(PostSlide(position=position, media_path=media_path, width=width, height=height))
    db.flush()


def record_media_files(post: Post, *, reset: bool = False) -> None:
    """Record the post's local files (cover, slides, derived siblings) in post.media_files.

    Merges into the existing record, so a file whose local copy is gone (it
    lives on in R2) stays recorded. *reset* starts over for a new or
    replaced original, but only when that original is on disk.
    """
    from server import media as media_service

    found: dict[str, dict] = {}
    for rel in [post.media_path, *(slide.media_path for slide in post.slides)]:
        found.update(media_service.local_media_files(Path("output") / rel))
    if reset and post.media_path in found:
        post.media_files = found
    elif found:
        post.media_files = {**(post.media_files or {}), **found}


def rerecord_media_files(db: Session, media_paths) -> None:
    """Merge newly built siblings into the record of the posts whose cover is in *media_paths*.

    Locks and re-reads the rows (Postgres) so two builders of one post cannot
    drop each other's entries. The caller commits.
    """
    paths = sorted({normalize_media_path(path) for path in media_paths if path})
    if not paths:
        return
    for post in db.query(Post).filter(Post.media_path.in_(paths)).with_for_update().populate_existing().all():
        record_media_files(post)


def apply_media_info(post: Post) -> None:
    """Fill duration/size from the media file, keeping old values if the probe fails."""
    from server import media as media_service

    path = Path("output") / post.media_path
    try:
        if not path.is_file():
            return
    except OSError:
        return
    info = media_service.probe_media_info(str(path))
    if not info:
        return
    post.width = info["width"]
    post.height = info["height"]
    # Stills have no meaningful runtime (ffprobe reports a 40ms placeholder for some).
    post.duration_ms = info["duration_ms"] if post.media_type == "video" else None


# Files that could not be probed in this process, keyed by (post id, mtime, size),
# so a corrupt file is not re-probed on every housekeeping pass. A replaced file
# gets a new key and is tried again.
_media_probe_failed: set[tuple[str, int, int]] = set()


def backfill_media_info(session_factory=None, limit: int | None = 500) -> int:
    """Retroactively fill duration/size for posts whose media is now on disk.

    Looks for posts missing their size (or, for video, their runtime) whose file
    exists under ./output, probes them, and stores the result. Files that are
    not there are skipped without being remembered, so media that shows up later
    (a restored volume, a synced folder) is picked up on the next pass. Returns
    how many posts were updated. Safe to run repeatedly and from several workers.
    """
    if session_factory is None:
        from .database import SessionLocal as session_factory

    updated = 0
    with session_factory() as db:
        candidates = (
            db.query(Post.id, Post.media_path)
            .filter(or_(Post.width.is_(None), and_(Post.media_type == "video", Post.duration_ms.is_(None))))
            .order_by(Post.created_at.desc())
            .all()
        )
        pending = 0
        for post_id, media_path in candidates:
            if limit is not None and updated >= limit:
                break
            path = Path("output") / media_path
            try:
                stat = path.stat()
            except OSError:
                continue
            key = (post_id, stat.st_mtime_ns, stat.st_size)
            if key in _media_probe_failed:
                continue
            post = db.get(Post, post_id)
            if post is None:
                continue
            apply_media_info(post)
            if post.width is None and post.duration_ms is None:
                _media_probe_failed.add(key)
                continue
            updated += 1
            pending += 1
            if pending >= 25:
                db.commit()
                pending = 0
        db.commit()
    return updated


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
    slide_paths: list[str] | None = None,
    stereo_layout: str | None = None,
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
    if stereo_layout is not None:
        post.stereo_layout = stereo_layout if stereo_layout in {"mono", "sbs", "tb"} else "mono"
    elif not post.stereo_layout:
        post.stereo_layout = "mono"
    apply_media_info(post)
    post.legacy_like_count = max(0, int(legacy_likes or 0))
    post.legacy_view_count = max(0, int(legacy_views or 0))
    real_likes = db.query(PostLike).filter(PostLike.post_id == post.id).count() if post.id else 0
    post.like_count = post.legacy_like_count + real_likes
    post.view_count = max(post.view_count or 0, post.legacy_view_count)
    db.flush()
    sync_post_tags(db, post, list(tags or []))
    if slide_paths is not None or post.media_type != "image":
        sync_post_slides(db, post, list(slide_paths or []))
    record_media_files(post, reset=True)
    db.flush()
    return post


def shared_preview_urls(post: Post) -> dict:
    """Lightweight preview/poster URLs for inline playback (chat embeds, etc.).

    Falls back to the full media URL when no transcoded preview exists yet.
    """
    from server import media as media_service

    url = public_url(post.media_path)
    files = post.media_files
    stereo = stereo_fields(post.media_path, post.stereo_layout, files)
    if post.media_type == "image":
        if stereo["stereo_layout"] != "mono":
            cover = _image_entry(post.media_path, post.width, post.height, stereo["stereo_layout"], files)
            return {"preview_url": cover["url"], "poster_url": cover["poster_url"]}
        return {"preview_url": url, "poster_url": url}
    try:
        source = Path("output") / post.media_path
        if stereo["stereo_layout"] != "mono" and not stereo["stereo_crop"]:
            # Grid assets of a stereo video come from its left-eye rendition.
            source = media_service.mono_sibling_path(str(source))
            url = stereo["url"]
        root = Path("output").resolve()

        def sibling_url(path: Path) -> str | None:
            try:
                if media_service.has_media_file(path, files):
                    return public_url(path.resolve().relative_to(root).as_posix())
            except (OSError, ValueError):
                return None
            return None

        preview = sibling_url(media_service.explore_preview_path(str(source)))
        poster = sibling_url(media_service.explore_poster_path(str(source)))
    except Exception:
        preview = None
        poster = None
    return {"preview_url": preview or url, "poster_url": poster}


def viewer_post_state(db: Session, viewer_id: str, posts: list[Post]) -> tuple[set[str], set[str], set[str]]:
    """Liked post ids, saved post ids and followed owner ids for a page of posts.

    Three queries for the whole page, so a list endpoint does not run three
    per card.
    """
    post_ids = [post.id for post in posts]
    owner_ids = {post.owner_id for post in posts}
    if not post_ids:
        return set(), set(), set()
    liked = {
        row[0]
        for row in db.query(PostLike.post_id)
        .filter(PostLike.user_id == viewer_id, PostLike.post_id.in_(post_ids))
        .all()
    }
    saved = {
        row[0]
        for row in db.query(PostSave.post_id)
        .filter(PostSave.user_id == viewer_id, PostSave.post_id.in_(post_ids))
        .all()
    }
    following = {
        row[0]
        for row in db.query(Follow.followee_id)
        .filter(Follow.follower_id == viewer_id, Follow.followee_id.in_(owner_ids))
        .all()
    }
    return liked, saved, following


def post_card(
    post: Post,
    db: Session,
    viewer_id: str | None = None,
    state: tuple[set[str], set[str], set[str]] | None = None,
) -> dict:
    liked = False
    saved = False
    following = False
    if viewer_id:
        liked_ids, saved_ids, following_ids = state if state is not None else viewer_post_state(db, viewer_id, [post])
        liked = post.id in liked_ids
        saved = post.id in saved_ids
        following = post.owner_id in following_ids
    creator = public_user(post.owner, viewer_id=viewer_id, is_following=following)
    card = {
        "id": post.id,
        "post_id": post.id,
        "path": post.media_path,
        "media_type": post.media_type,
        "url": public_url(post.media_path),
        "title": post.title,
        "caption": post.caption,
        "tags": post_tags(post),
        "location": post.location or {},
        "source": post.source,
        "likes": post.like_count,
        "views": post.view_count,
        "comments_count": post.comment_count,
        "saves": post.save_count,
        "duration_ms": post.duration_ms,
        "width": post.width,
        "height": post.height,
        **post_image_fields(post),
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
    card.update(stereo_fields(post.media_path, post.stereo_layout, post.media_files))
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


MAX_UNKNOWN_DURATION_MS = 30 * 60 * 1000
PLAYBACK_LOOP_FACTOR = 4
EVENT_DICT_MAX_BYTES = 2048
EVENT_DICT_MAX_KEYS = 16


def event_dict_is_valid(value: dict | None) -> bool:
    """Context/playback_quality dicts: <=16 keys, scalar values, <=2 KB serialized."""
    if not value:
        return True
    if len(value) > EVENT_DICT_MAX_KEYS:
        return False
    for key, item in value.items():
        if not isinstance(key, str):
            return False
        if item is not None and not isinstance(item, (str, int, float, bool)):
            return False
        if isinstance(item, float) and not math.isfinite(item):
            return False
    try:
        return len(json.dumps(value, ensure_ascii=False).encode("utf-8")) <= EVENT_DICT_MAX_BYTES
    except (TypeError, ValueError):
        return False


def clamp_playback(
    db: Session,
    post_id: str | None,
    *,
    watch_ms: int | None = None,
    foreground_ms: int | None = None,
    duration_ms: int | None = None,
    position_ms: int | None = None,
) -> dict:
    """Bound client-reported playback numbers by the server's known duration.

    The server duration wins over the client's; with none known, durations are
    capped at 30 minutes. Watch/foreground/position may exceed one pass by up
    to 4x to allow loops.
    """
    server_duration = None
    if post_id:
        row = db.query(Post.duration_ms).filter(Post.id == post_id).first()
        if row and row[0] and int(row[0]) > 0:
            server_duration = int(row[0])
    if server_duration:
        duration = server_duration
        ceiling = server_duration * PLAYBACK_LOOP_FACTOR
    else:
        duration = min(max(0, int(duration_ms)), MAX_UNKNOWN_DURATION_MS) if duration_ms is not None else None
        ceiling = MAX_UNKNOWN_DURATION_MS

    def bound(value):
        return None if value is None else max(0, min(int(value), ceiling))

    return {
        "watch_ms": bound(watch_ms),
        "foreground_ms": bound(foreground_ms),
        "duration_ms": duration,
        "position_ms": bound(position_ms),
        "server_duration": server_duration is not None,
    }


def record_event(
    db: Session,
    *,
    event_type: str,
    post_id: str | None = None,
    pack_id: str | None = None,
    user_id: str | None = None,
    anonymous_id: str | None = None,
    source: str = "unknown",
    watch_ms: int | None = None,
    foreground_ms: int | None = None,
    duration_ms: int | None = None,
    watch_ratio: float | None = None,
    position_ms: int | None = None,
    completed: bool = False,
    navigation_reason: str | None = None,
    playback_quality: dict | None = None,
    client_occurred_at: datetime | None = None,
    recommendation_impression_id: str | None = None,
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
    recommendation_request_id = None
    recommendation_session_id = None
    if recommendation_impression_id:
        from .recommendations.events import RecommendationAttributionError, resolve_attribution

        try:
            impression, duplicate = resolve_attribution(
                db,
                impression_id=recommendation_impression_id,
                user_id=user_id,
                anonymous_id=anonymous_id,
                post_id=post_id,
                event_type=event_type,
                context=dict(context or {}),
            )
        except RecommendationAttributionError as exc:
            metrics.incr("rec_attribution_failed")
            # Fail open: attribution is enrichment, never a reason to reject
            # the underlying action (like/follow/feedback). Record the event
            # unattributed so engagement is never lost to a stale client id.
            logger.warning(
                "recommendation attribution failed open: impression=%s event=%s error=%s",
                str(recommendation_impression_id)[:8],
                event_type,
                exc,
            )
            recommendation_impression_id = None
        else:
            if duplicate:
                return None
            recommendation_impression_id = impression.id
            recommendation_request_id = impression.request_id
            recommendation_session_id = impression.session_id
    clamped = clamp_playback(
        db,
        post_id,
        watch_ms=watch_ms,
        foreground_ms=foreground_ms,
        duration_ms=duration_ms,
        position_ms=position_ms,
    )
    bounded_duration = clamped["duration_ms"]
    bounded_watch = clamped["watch_ms"]
    foreground_ms = clamped["foreground_ms"]
    position_ms = clamped["position_ms"]
    if clamped["server_duration"] and bounded_duration and bounded_watch is not None:
        # The client's ratio is untrusted when the server knows the duration.
        watch_ratio = bounded_watch / bounded_duration
    elif watch_ratio is None and bounded_duration and bounded_watch is not None:
        watch_ratio = bounded_watch / bounded_duration
    bounded_ratio = max(0.0, min(4.0, float(watch_ratio))) if watch_ratio is not None else None
    row = EngagementEvent(
        client_event_id=client_event_id[:64] if client_event_id else None,
        user_id=user_id,
        anonymous_id=anonymous_id,
        post_id=post_id,
        pack_id=pack_id,
        recommendation_impression_id=recommendation_impression_id,
        recommendation_request_id=recommendation_request_id,
        recommendation_session_id=recommendation_session_id,
        event_type=event_type[:40],
        source=str(source or "unknown")[:40],
        watch_ms=bounded_watch,
        foreground_ms=foreground_ms if foreground_ms is not None else bounded_watch,
        duration_ms=bounded_duration,
        watch_ratio=bounded_ratio,
        position_ms=position_ms,
        completed=bool(completed),
        navigation_reason=str(navigation_reason or "")[:32] or None,
        playback_quality=dict(playback_quality or {}),
        client_occurred_at=client_occurred_at,
        schema_version=2,
        context=dict(context or {}),
    )
    db.add(row)
    db.flush()
    from .recommendations.events import update_aggregates

    update_aggregates(db, row)
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
    db: Session | None = None,
) -> list[str] | None:
    """Return an ordered media-path allowlist for a creator or Following feed."""
    if not feed and not author:
        return None
    with _session_scope(db) as db:
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
