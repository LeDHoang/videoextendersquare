"""One-time import from the original reel metadata/comment JSON files."""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import joinedload

from server import media as media_service

from .database import SessionLocal
from .models import Comment, DataMigration, Post, User
from .services import (
    create_or_update_post,
    ensure_demo_user,
    normalize_media_path,
    parse_datetime,
)

OUTPUT_DIR = Path("output")
META_FILE = OUTPUT_DIR / "reels_meta.json"
COMMENTS_FILE = OUTPUT_DIR / "reels_comments.json"
MIGRATION_KEY = "legacy-social-json-v1"


def _read_json(path: Path, fallback):
    if not path.exists():
        return fallback
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, type(fallback)) else fallback
    except Exception:
        return fallback


def _backup(path: Path) -> None:
    if not path.exists():
        return
    backup = path.with_name(path.stem + ".legacy-backup" + path.suffix)
    if not backup.exists():
        shutil.copy2(path, backup)


def import_legacy_social(force: bool = False) -> dict:
    """Import current media and JSON engagement once, transactionally."""
    with SessionLocal() as db:
        marker = db.get(DataMigration, MIGRATION_KEY)
        if marker and not force:
            return dict(marker.details or {})

        metadata = _read_json(META_FILE, {})
        comments = _read_json(COMMENTS_FILE, {})
        raw_media = media_service.scan_output_media(str(OUTPUT_DIR))
        archive = ensure_demo_user(db, "echo_archive")
        post_by_path: dict[str, Post] = {}

        imported_posts = 0
        imported_comments = 0
        demo_users: set[str] = {archive.id}

        for item in raw_media:
            rel_path = normalize_media_path(item.get("rel_path", ""))
            if not rel_path:
                continue
            meta = metadata.get(rel_path)
            if not isinstance(meta, dict):
                meta = metadata.get(Path(rel_path).name, {})
            if not isinstance(meta, dict):
                meta = {}
            author_label = str(meta.get("author_name") or "echo_archive")
            owner = archive if author_label == "echo_archive" else ensure_demo_user(db, author_label)
            demo_users.add(owner.id)
            mtime = item.get("mtime")
            fallback_dt = (
                datetime.fromtimestamp(float(mtime), tz=timezone.utc)
                if mtime
                else None
            )
            post = create_or_update_post(
                db,
                media_path=rel_path,
                media_type=item.get("media_type", "video"),
                owner=owner,
                title=meta.get("title", ""),
                caption=meta.get("caption", ""),
                tags=list(meta.get("tags") or []),
                location=dict(meta.get("location") or {}),
                source=meta.get("source") or "legacy",
                created_at=parse_datetime(meta.get("created_at"), fallback_dt),
                legacy_likes=max(0, int(meta.get("likes", 0) or 0)),
                legacy_views=max(0, int(meta.get("views", 0) or 0)),
                stable_legacy_id=True,
            )
            post_by_path[rel_path] = post
            imported_posts += 1

        db.flush()

        for raw_path, rows in comments.items():
            path = normalize_media_path(raw_path)
            post = post_by_path.get(path)
            if not post:
                post = db.query(Post).filter(Post.media_path == path).first()
            if not post or not isinstance(rows, list):
                continue
            for row in rows:
                if not isinstance(row, dict):
                    continue
                comment_id = str(row.get("id") or "")[:64]
                if not comment_id or db.get(Comment, comment_id):
                    continue
                author = ensure_demo_user(
                    db,
                    str(row.get("author_name") or "Legacy User"),
                    str(row.get("avatar_color") or "#FF3B1F"),
                )
                demo_users.add(author.id)
                text = str(row.get("text") or "").strip()[:500]
                if not text:
                    continue
                timestamp = row.get("timestamp")
                comment = Comment(
                    id=comment_id,
                    post_id=post.id,
                    author_id=author.id,
                    text=text,
                    timestamp_ms=round(float(timestamp) * 1000) if timestamp is not None else None,
                    legacy_like_count=max(0, int(row.get("likes", 0) or 0)),
                    like_count=max(0, int(row.get("likes", 0) or 0)),
                    created_at=parse_datetime(row.get("created_at")),
                )
                db.add(comment)
                imported_comments += 1

        db.flush()
        posts = db.query(Post).all()
        for post in posts:
            post.comment_count = db.query(Comment.id).filter(
                Comment.post_id == post.id,
                Comment.deleted_at.is_(None),
            ).count()

        users = db.query(User).all()
        for user in users:
            user.post_count = db.query(Post.id).filter(
                Post.owner_id == user.id,
                Post.status == "published",
                Post.deleted_at.is_(None),
            ).count()

        details = {
            "posts": imported_posts,
            "comments": imported_comments,
            "demo_users": len(demo_users),
        }
        if marker:
            marker.details = details
            marker.completed_at = datetime.now(timezone.utc)
        else:
            db.add(DataMigration(key=MIGRATION_KEY, details=details))
        db.commit()

    _backup(META_FILE)
    _backup(COMMENTS_FILE)
    return details
