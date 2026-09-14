"""First-class Reel Pack authoring, discovery, saving, and progress APIs."""

from __future__ import annotations

import os
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import case, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from server.features import reel_pack_features
from server.social.auth import AuthContext, get_optional_auth, normalize_username, public_user, require_auth, require_auth_csrf
from server.social.database import get_db
from server.social.models import (
    Comment,
    Follow,
    Post,
    ReelPack,
    ReelPackItem,
    ReelPackLike,
    ReelPackProgress,
    ReelPackSave,
    ReelPackTag,
    Tag,
    User,
    utcnow,
)
from server.social.safety import blocked_user_ids, users_blocked
from server.social.services import post_card, record_event, tag_slug


router = APIRouter(tags=["packs"])
PACK_MIN_PUBLISHED_ITEMS = 3
PACK_MAX_ITEMS = 30
PACK_VISIBILITIES = {"public", "unlisted"}
PACK_PHASES = {"intro", "playing", "complete"}


class PackCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    visibility: Literal["public", "unlisted"] = "public"
    cover_post_id: str | None = None
    location: dict = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list, max_length=5)
    post_ids: list[str] = Field(default_factory=list, max_length=PACK_MAX_ITEMS)


class PackUpdateRequest(BaseModel):
    expected_revision: int = Field(ge=1)
    title: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    visibility: Literal["public", "unlisted"] | None = None
    cover_post_id: str | None = None
    location: dict | None = None
    tags: list[str] | None = Field(default=None, max_length=5)
    post_ids: list[str] | None = Field(default=None, max_length=PACK_MAX_ITEMS)


class PackRevisionRequest(BaseModel):
    expected_revision: int = Field(ge=1)


class PackProgressRequest(BaseModel):
    current_item_id: str | None = None
    position_ms: int = Field(default=0, ge=0)
    phase: Literal["intro", "playing", "complete"] = "playing"


def fail(status: int, code: str, message: str, field: str | None = None):
    detail = {"code": code, "message": message}
    if field:
        detail["field"] = field
    raise HTTPException(status_code=status, detail=detail)


def viewer_id(context: AuthContext | None) -> str | None:
    return context.user.id if isinstance(context, AuthContext) else None


def pack_query(db: Session):
    return db.query(ReelPack).options(
        joinedload(ReelPack.owner),
        joinedload(ReelPack.cover_post).joinedload(Post.owner),
        selectinload(ReelPack.items).joinedload(ReelPackItem.post).joinedload(Post.owner),
        selectinload(ReelPack.items)
        .joinedload(ReelPackItem.post)
        .selectinload(Post.tags),
        selectinload(ReelPack.tags).joinedload(ReelPackTag.tag),
    )


def active_item(item: ReelPackItem) -> bool:
    post = item.post
    return bool(
        post
        and post.deleted_at is None
        and post.status == "published"
        and post.owner
        and post.owner.status == "active"
    )


def member_available_for_viewer(
    db: Session,
    item: ReelPackItem,
    viewer_id: str | None,
    blocked_owner_ids: set[str] | None = None,
) -> bool:
    """Post-level availability scoped to the viewer: a member reel whose
    creator blocks the viewer (or is blocked by them) renders as a
    tombstone for that viewer without leaking the post payload."""
    if not active_item(item):
        return False
    if not viewer_id or not item.post or not item.post.owner_id:
        return True
    if blocked_owner_ids is None:
        blocked_owner_ids = blocked_user_ids(db, viewer_id)
    return item.post.owner_id not in blocked_owner_ids


def playable_items(pack: ReelPack) -> list[ReelPackItem]:
    return [item for item in sorted(pack.items, key=lambda row: row.position) if active_item(item)]


def can_view_pack(db: Session, pack: ReelPack | None, user_id: str | None) -> bool:
    if not pack or pack.deleted_at is not None or pack.status == "deleted":
        return False
    if user_id == pack.owner_id:
        return True
    return bool(
        pack.status == "published"
        and pack.visibility in PACK_VISIBILITIES
        and pack.owner
        and pack.owner.status == "active"
        and not (user_id and users_blocked(db, user_id, pack.owner_id))
        and playable_items(pack)
    )


def get_pack_for_viewer(db: Session, pack_id: str, user_id: str | None) -> ReelPack:
    pack = pack_query(db).filter(ReelPack.id == pack_id).first()
    if not can_view_pack(db, pack, user_id):
        fail(404, "PACK_NOT_FOUND", "Reel Pack not found.")
    return pack


def get_owned_pack(db: Session, pack_id: str, user_id: str) -> ReelPack:
    pack = pack_query(db).filter(
        ReelPack.id == pack_id,
        ReelPack.deleted_at.is_(None),
        ReelPack.status != "deleted",
    ).first()
    if not pack:
        fail(404, "PACK_NOT_FOUND", "Reel Pack not found.")
    if pack.owner_id != user_id:
        fail(403, "PACK_FORBIDDEN", "Only the pack creator can change this Reel Pack.")
    return pack


def pack_tags(pack: ReelPack) -> list[str]:
    return [link.tag.name for link in pack.tags if link.tag]


def discovery_slug(value: str) -> str:
    return re.sub(r"[^\w]+|_+", "-", str(value or "").casefold()).strip("-")


def sync_pack_tags(db: Session, pack: ReelPack, values: list[str]) -> None:
    normalized: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in list(values or [])[:5]:
        slug = tag_slug(raw)
        if not slug or slug in seen:
            continue
        seen.add(slug)
        # Preserve display case for UI; slug carries the normalized identity.
        display = str(raw).strip().lstrip("#")[:60] or slug
        normalized.append((slug, display))
    pack.tags.clear()
    db.flush()
    for slug, name in normalized:
        tag = db.query(Tag).filter(Tag.slug == slug).first()
        if not tag:
            tag = Tag(slug=slug, name=name)
            db.add(tag)
            try:
                db.flush()
            except IntegrityError:
                # Concurrent creator won the tag-creation race; reuse theirs.
                db.rollback()
                tag = db.query(Tag).filter(Tag.slug == slug).first()
                if not tag:
                    raise
        pack.tags.append(ReelPackTag(tag_id=tag.id))


def validate_posts(db: Session, owner_id: str, post_ids: list[str]) -> list[Post]:
    """Collections may mix reels from any creator. Membership requires a
    currently published reel from an active owner that the pack creator
    can view (no block in either direction)."""
    normalized = [str(value or "").strip() for value in post_ids if str(value or "").strip()]
    if len(normalized) != len(set(normalized)):
        fail(422, "DUPLICATE_PACK_ITEM", "A Reel Pack cannot contain the same reel twice.", "post_ids")
    if len(normalized) > PACK_MAX_ITEMS:
        fail(422, "PACK_TOO_LARGE", f"A Reel Pack can contain at most {PACK_MAX_ITEMS} reels.", "post_ids")
    if not normalized:
        return []
    rows = db.query(Post).options(joinedload(Post.owner), selectinload(Post.tags)).filter(Post.id.in_(normalized)).all()
    by_id = {post.id: post for post in rows}
    invalid = [
        post_id
        for post_id in normalized
        if post_id not in by_id
        or by_id[post_id].deleted_at is not None
        or by_id[post_id].status != "published"
        or not by_id[post_id].owner
        or by_id[post_id].owner.status != "active"
        or users_blocked(db, owner_id, by_id[post_id].owner_id)
    ]
    if invalid:
        fail(
            422,
            "INVALID_PACK_ITEM",
            "Packs may only contain public reels that are currently available.",
            "post_ids",
        )
    return [by_id[post_id] for post_id in normalized]


def replace_items(db: Session, pack: ReelPack, post_ids: list[str]) -> None:
    posts = validate_posts(db, pack.owner_id, post_ids)
    existing = {item.post_id: item for item in pack.items if item.post_id}
    retained_ids = {post.id for post in posts}
    for item in list(pack.items):
        if item.post_id not in retained_ids:
            db.delete(item)
        else:
            item.position = item.position + 1000
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        fail(409, "PACK_REVISION_CONFLICT", "This Reel Pack changed elsewhere. Reload it before saving again.", "post_ids")
    for position, post in enumerate(posts):
        item = existing.get(post.id)
        if item is None:
            item = ReelPackItem(pack_id=pack.id, post_id=post.id, position=position)
            pack.items.append(item)
        else:
            # Re-fetch from session after potential rollback above.
            item.position = position
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        fail(409, "PACK_REVISION_CONFLICT", "This Reel Pack changed elsewhere. Reload it before saving again.", "post_ids")
    if pack.cover_post_id and pack.cover_post_id not in retained_ids:
        pack.cover_post_id = None


def claim_revision(db: Session, pack: ReelPack, expected: int) -> None:
    expected = int(expected)
    if int(pack.revision or 1) != expected:
        fail(
            409,
            "PACK_REVISION_CONFLICT",
            "This Reel Pack changed elsewhere. Reload it before saving again.",
            "expected_revision",
        )
    changed_at = utcnow()
    updated = db.query(ReelPack).filter(
        ReelPack.id == pack.id,
        ReelPack.owner_id == pack.owner_id,
        ReelPack.deleted_at.is_(None),
        ReelPack.status != "deleted",
        ReelPack.revision == expected,
    ).update(
        {
            ReelPack.revision: expected + 1,
            ReelPack.updated_at: changed_at,
        },
        synchronize_session=False,
    )
    if updated != 1:
        db.rollback()
        fail(
            409,
            "PACK_REVISION_CONFLICT",
            "This Reel Pack changed elsewhere. Reload it before saving again.",
            "expected_revision",
        )
    pack.revision = expected + 1
    pack.updated_at = changed_at


def cover_cards(pack: ReelPack, db: Session, user_id: str | None, blocked_owner_ids: set[str] | None = None) -> list[dict]:
    rows: list[Post] = []
    if (
        pack.cover_post
        and pack.cover_post_id
        and any(
            item.post_id == pack.cover_post_id
            and member_available_for_viewer(db, item, user_id, blocked_owner_ids)
            for item in pack.items
        )
    ):
        rows.append(pack.cover_post)
    for item in sorted(pack.items, key=lambda row: row.position):
        if not item.post:
            continue
        if not member_available_for_viewer(db, item, user_id, blocked_owner_ids):
            continue
        if item.post.id in {post.id for post in rows}:
            continue
        rows.append(item.post)
        if len(rows) >= 4:
            break
    return [post_card(post, db, user_id) for post in rows]


def progress_card(db: Session, pack: ReelPack, user_id: str | None) -> dict | None:
    if not user_id:
        return None
    row = db.query(ReelPackProgress).filter(
        ReelPackProgress.user_id == user_id,
        ReelPackProgress.pack_id == pack.id,
    ).first()
    if not row:
        return None
    ordered = sorted(pack.items, key=lambda item: item.position)
    index = next((index for index, item in enumerate(ordered) if item.id == row.current_item_id), 0)
    return {
        "current_item_id": row.current_item_id,
        "item_index": index,
        "position_ms": max(0, int(row.position_ms or 0)),
        "phase": row.phase if row.phase in PACK_PHASES else "intro",
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def pack_comment_count(
    db: Session,
    pack: ReelPack,
    user_id: str | None,
    blocked_owner_ids: set[str] | None = None,
) -> int:
    """Collections surface a read-only comment counter: the number of live
    comments across the member reels the viewer can currently see. Comments
    by creators the viewer blocks (or is blocked by) are excluded, matching
    how the reels feed hides them."""
    post_ids = [
        item.post_id
        for item in pack.items
        if item.post_id and member_available_for_viewer(db, item, user_id, blocked_owner_ids)
    ]
    if not post_ids:
        return 0
    query = db.query(func.count(Comment.id)).filter(
        Comment.post_id.in_(post_ids),
        Comment.deleted_at.is_(None),
    )
    if blocked_owner_ids:
        query = query.filter(~Comment.author_id.in_(blocked_owner_ids))
    return int(query.scalar() or 0)


def serialize_pack(
    db: Session,
    pack: ReelPack,
    user_id: str | None = None,
    *,
    include_items: bool = False,
) -> dict:
    saved = bool(
        user_id
        and db.query(ReelPackSave.id).filter(
            ReelPackSave.user_id == user_id,
            ReelPackSave.pack_id == pack.id,
        ).first()
    )
    following = bool(
        user_id
        and db.query(Follow.id).filter(
            Follow.follower_id == user_id,
            Follow.followee_id == pack.owner_id,
        ).first()
    )
    liked = bool(
        user_id
        and db.query(ReelPackLike.id).filter(
            ReelPackLike.user_id == user_id,
            ReelPackLike.pack_id == pack.id,
        ).first()
    )
    active = playable_items(pack)
    hidden_owners = blocked_user_ids(db, user_id) if user_id else set()
    covers = cover_cards(pack, db, user_id, hidden_owners)
    cover = covers[0] if covers else None
    cover_url = None
    if cover:
        # Video preview URLs point at MP4 files and are not valid <img>
        # sources. Only use a real poster for video; image reels can safely
        # use their image media as the pack cover.
        cover_url = cover.get("poster_url")
        if not cover_url and cover.get("media_type") == "image":
            cover_url = cover.get("preview_url") or cover.get("url")
    payload = {
        "id": pack.id,
        "kind": "pack",
        "title": pack.title,
        "description": pack.description,
        "status": pack.status,
        "visibility": pack.visibility,
        "creator": public_user(pack.owner, viewer_id=user_id, is_following=following),
        "cover_post_id": pack.cover_post_id,
        "cover_url": cover_url,
        "cover_items": covers,
        "location": pack.location or {},
        "tags": pack_tags(pack),
        "reel_count": len(pack.items),
        "playable_count": len(active),
        "needs_repair": pack.status == "published" and len(active) < PACK_MIN_PUBLISHED_ITEMS,
        "saves": max(0, int(pack.save_count or 0)),
        "saved_by_me": saved,
        "likes": max(0, int(pack.like_count or 0)),
        "views": max(0, int(pack.view_count or 0)),
        "comments": pack_comment_count(db, pack, user_id, hidden_owners),
        "liked_by_me": liked,
        "viewer_state": {
            "saved": saved,
            "liked": liked,
            "can_edit": user_id == pack.owner_id,
        },
        "revision": max(1, int(pack.revision or 1)),
        "created_at": pack.created_at.isoformat() if pack.created_at else None,
        "updated_at": pack.updated_at.isoformat() if pack.updated_at else None,
    }
    if include_items:
        payload["items"] = [
            {
                "id": item.id,
                "position": item.position,
                "available": member_available_for_viewer(db, item, user_id, hidden_owners),
                "created_at": item.created_at.isoformat() if item.created_at else None,
                "updated_at": item.updated_at.isoformat() if item.updated_at else None,
                "post": (
                    post_card(item.post, db, user_id)
                    if member_available_for_viewer(db, item, user_id, hidden_owners)
                    else None
                ),
            }
            for item in sorted(pack.items, key=lambda row: row.position)
        ]
        payload["progress"] = progress_card(db, pack, user_id)
    return payload


def list_visible_packs(
    db: Session,
    user_id: str | None,
    *,
    owner_id: str | None = None,
    include_owner_private: bool = False,
    allow_unlisted: bool = False,
    saved_by: str | None = None,
    search: str = "",
    tag: str = "",
    location: str = "",
) -> list[ReelPack]:
    query = pack_query(db).join(User, User.id == ReelPack.owner_id).filter(
        ReelPack.deleted_at.is_(None),
        ReelPack.status != "deleted",
        User.status == "active",
    )
    if owner_id:
        query = query.filter(ReelPack.owner_id == owner_id)
    if saved_by:
        query = query.join(ReelPackSave, ReelPackSave.pack_id == ReelPack.id).filter(
            ReelPackSave.user_id == saved_by
        )
    if not include_owner_private:
        query = query.filter(ReelPack.status == "published")
        if not allow_unlisted:
            query = query.filter(ReelPack.visibility == "public")
    key = str(search or "").strip().casefold().lstrip("#")
    hidden = blocked_user_ids(db, user_id)
    if hidden:
        query = query.filter(~ReelPack.owner_id.in_(hidden))
    rows = query.order_by(ReelPack.updated_at.desc(), ReelPack.id.desc()).all()
    wanted_tag = tag_slug(tag)
    location_key = str(location or "").strip().casefold()
    result = []
    for pack in rows:
        if not can_view_pack(db, pack, user_id):
            continue
        if not include_owner_private and not allow_unlisted and len(playable_items(pack)) < PACK_MIN_PUBLISHED_ITEMS:
            continue
        if key:
            searchable_values = [
                pack.title or "",
                pack.description or "",
                pack.owner.username if pack.owner else "",
                pack.owner.display_name if pack.owner else "",
                *pack_tags(pack),
                *(str(value or "") for value in (pack.location or {}).values()),
            ]
            searchable = " ".join(searchable_values).casefold()
            slug_searchable = " ".join(discovery_slug(value) for value in searchable_values)
            if key not in searchable and discovery_slug(key) not in slug_searchable:
                continue
        if wanted_tag and wanted_tag not in {tag_slug(value) for value in pack_tags(pack)}:
            continue
        if location_key:
            location_text = " ".join(str(value or "") for value in (pack.location or {}).values()).casefold()
            if location_key not in location_text and tag_slug(location_key) not in tag_slug(location_text):
                continue
        result.append(pack)
    return result


@router.get("/api/packs")
def list_packs(
    search: str = "",
    tag: str = "",
    location: str = "",
    owner: str = "",
    offset: int = 0,
    limit: int = 24,
    context: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    if not reel_pack_features()["discovery"]:
        return {"items": [], "next_offset": None, "total": 0}
    user_id = viewer_id(context)
    owner_id = None
    if owner:
        owner_row = db.query(User).filter(
            User.username_norm == normalize_username(owner),
            User.status == "active",
        ).first()
        if not owner_row or (user_id and users_blocked(db, user_id, owner_row.id)):
            return {"items": [], "next_offset": None, "total": 0}
        owner_id = owner_row.id
    rows = list_visible_packs(
        db,
        user_id,
        owner_id=owner_id,
        search=search,
        tag=tag,
        location=location,
    )
    bounded = max(1, min(int(limit), 50))
    start = max(0, int(offset))
    page = rows[start : start + bounded]
    return {
        "items": [serialize_pack(db, pack, user_id) for pack in page],
        "next_offset": start + bounded if start + bounded < len(rows) else None,
        "total": len(rows),
    }


@router.post("/api/packs")
def create_pack(
    req: PackCreateRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    if not reel_pack_features()["creation"]:
        fail(503, "PACK_CREATION_DISABLED", "Creating Reel Packs is temporarily unavailable.")
    title = req.title.strip()
    if not title:
        fail(422, "PACK_TITLE_REQUIRED", "Enter a title for this Reel Pack.", "title")
    posts = validate_posts(db, context.user.id, req.post_ids)
    if req.cover_post_id and req.cover_post_id not in {post.id for post in posts}:
        fail(422, "INVALID_PACK_COVER", "The cover must be one of the pack's reels.", "cover_post_id")
    pack = ReelPack(
        owner_id=context.user.id,
        title=title,
        description=req.description.strip(),
        visibility=req.visibility,
        cover_post_id=req.cover_post_id,
        location=dict(req.location or {}),
        status="draft",
        revision=1,
    )
    db.add(pack)
    db.flush()
    replace_items(db, pack, [post.id for post in posts])
    sync_pack_tags(db, pack, req.tags)
    record_event(db, event_type="pack_create", pack_id=pack.id, user_id=context.user.id, source="pack_editor")
    db.commit()
    db.expire_all()
    pack = get_owned_pack(db, pack.id, context.user.id)
    return {"pack": serialize_pack(db, pack, context.user.id, include_items=True)}


@router.get("/api/users/me/packs")
def my_packs(
    context: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
):
    rows = list_visible_packs(
        db,
        context.user.id,
        owner_id=context.user.id,
        include_owner_private=True,
    )
    return {"items": [serialize_pack(db, pack, context.user.id) for pack in rows]}


@router.get("/api/users/me/saved-packs")
def saved_packs(
    offset: int = 0,
    limit: int = 24,
    context: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
):
    rows = list_visible_packs(
        db,
        context.user.id,
        saved_by=context.user.id,
        allow_unlisted=True,
    )
    bounded = max(1, min(int(limit), 50))
    start = max(0, int(offset))
    page = rows[start : start + bounded]
    return {
        "items": [serialize_pack(db, pack, context.user.id) for pack in page],
        "next_offset": start + bounded if start + bounded < len(rows) else None,
    }


@router.get("/api/users/{username}/packs")
def user_packs(
    username: str,
    context: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    user_id = viewer_id(context)
    owner = db.query(User).filter(
        User.username_norm == normalize_username(username),
        User.status == "active",
    ).first()
    if not owner or (user_id and users_blocked(db, user_id, owner.id)):
        fail(404, "USER_NOT_FOUND", "Profile not found.")
    if not reel_pack_features()["discovery"] and user_id != owner.id:
        return {"items": []}
    rows = list_visible_packs(
        db,
        user_id,
        owner_id=owner.id,
        include_owner_private=user_id == owner.id,
    )
    return {"items": [serialize_pack(db, pack, user_id) for pack in rows]}


@router.get("/api/packs/{pack_id}")
def get_pack(
    pack_id: str,
    context: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    user_id = viewer_id(context)
    pack = get_pack_for_viewer(db, pack_id, user_id)
    return {"pack": serialize_pack(db, pack, user_id, include_items=True)}


@router.patch("/api/packs/{pack_id}")
def update_pack(
    pack_id: str,
    req: PackUpdateRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    pack = get_owned_pack(db, pack_id, context.user.id)
    claim_revision(db, pack, req.expected_revision)
    fields_set = getattr(req, "model_fields_set", None)
    if fields_set is None:
        fields_set = getattr(req, "__fields_set__", set())
    if req.title is not None:
        title = req.title.strip()
        if not title:
            fail(422, "PACK_TITLE_REQUIRED", "Enter a title for this Reel Pack.", "title")
        pack.title = title
    if req.description is not None:
        pack.description = req.description.strip()
    if req.visibility is not None:
        pack.visibility = req.visibility
    if req.location is not None:
        pack.location = dict(req.location)
    if req.tags is not None:
        sync_pack_tags(db, pack, req.tags)
    if req.post_ids is not None:
        replace_items(db, pack, req.post_ids)
    if "cover_post_id" in fields_set:
        member_ids = {item.post_id for item in pack.items if item.post_id}
        if req.cover_post_id and req.cover_post_id not in member_ids:
            fail(422, "INVALID_PACK_COVER", "The cover must be one of the pack's reels.", "cover_post_id")
        pack.cover_post_id = req.cover_post_id
    if pack.status == "published" and len(playable_items(pack)) < PACK_MIN_PUBLISHED_ITEMS:
        # Preserve the live URL, but discovery automatically hides the pack
        # until the creator repairs it.
        pass
    record_event(db, event_type="pack_update", pack_id=pack.id, user_id=context.user.id, source="pack_editor")
    db.commit()
    db.expire_all()
    pack = get_owned_pack(db, pack.id, context.user.id)
    return {"pack": serialize_pack(db, pack, context.user.id, include_items=True)}


@router.delete("/api/packs/{pack_id}")
def delete_pack(
    pack_id: str,
    req: PackRevisionRequest | None = None,
    expected_revision: int | None = None,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    # Some proxies/clients drop DELETE bodies; accept ?expected_revision=
    # as a fallback so deletes do not 422 spuriously.
    revision = req.expected_revision if req and req.expected_revision else expected_revision
    if not revision:
        fail(422, "PACK_REVISION_REQUIRED", "Reload the Pack and retry the delete.", "expected_revision")
    pack = get_owned_pack(db, pack_id, context.user.id)
    claim_revision(db, pack, int(revision))
    pack.status = "deleted"
    pack.deleted_at = utcnow()
    record_event(db, event_type="pack_delete", pack_id=pack.id, user_id=context.user.id, source="pack_editor")
    db.commit()
    return {"ok": True}


@router.post("/api/packs/{pack_id}/publish")
def publish_pack(
    pack_id: str,
    req: PackRevisionRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    pack = get_owned_pack(db, pack_id, context.user.id)
    claim_revision(db, pack, req.expected_revision)
    count = len(playable_items(pack))
    if count < PACK_MIN_PUBLISHED_ITEMS or count > PACK_MAX_ITEMS:
        fail(
            422,
            "PACK_SIZE_INVALID",
            f"Publishing requires {PACK_MIN_PUBLISHED_ITEMS}–{PACK_MAX_ITEMS} available reels.",
        )
    pack.status = "published"
    record_event(db, event_type="pack_publish", pack_id=pack.id, user_id=context.user.id, source="pack_editor")
    db.commit()
    db.expire_all()
    pack = get_owned_pack(db, pack.id, context.user.id)
    return {"pack": serialize_pack(db, pack, context.user.id, include_items=True)}


@router.post("/api/packs/{pack_id}/unpublish")
def unpublish_pack(
    pack_id: str,
    req: PackRevisionRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    pack = get_owned_pack(db, pack_id, context.user.id)
    claim_revision(db, pack, req.expected_revision)
    pack.status = "draft"
    record_event(db, event_type="pack_unpublish", pack_id=pack.id, user_id=context.user.id, source="pack_editor")
    db.commit()
    db.expire_all()
    pack = get_owned_pack(db, pack.id, context.user.id)
    return {"pack": serialize_pack(db, pack, context.user.id, include_items=True)}


class PackItemAddRequest(BaseModel):
    post_id: str
    expected_revision: int | None = Field(default=None, ge=1)


@router.post("/api/packs/{pack_id}/items")
def add_pack_item(
    pack_id: str,
    req: PackItemAddRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    """Append one public reel to the pack creator's collection (save-to-
    collection flow). Idempotent on duplicates; optional stale-revision 409."""
    pack = get_owned_pack(db, pack_id, context.user.id)
    if any(item.post_id == req.post_id for item in pack.items if item.post_id):
        return {"pack": serialize_pack(db, pack, context.user.id, include_items=True), "added": False}
    if len(pack.items) >= PACK_MAX_ITEMS:
        fail(422, "PACK_TOO_LARGE", f"A Reel Pack can contain at most {PACK_MAX_ITEMS} reels.", "post_id")
    posts = validate_posts(db, context.user.id, [req.post_id])
    claim_revision(db, pack, req.expected_revision or pack.revision)
    next_position = max((item.position for item in pack.items), default=-1) + 1
    pack.items.append(ReelPackItem(pack_id=pack.id, post_id=posts[0].id, position=next_position))
    record_event(db, event_type="pack_update", pack_id=pack.id, user_id=context.user.id, source="collection_add")
    db.commit()
    db.expire_all()
    pack = get_owned_pack(db, pack.id, context.user.id)
    return {"pack": serialize_pack(db, pack, context.user.id, include_items=True), "added": True}


@router.delete("/api/packs/{pack_id}/items/{post_id}")
def remove_pack_item(
    pack_id: str,
    post_id: str,
    expected_revision: int | None = None,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    pack = get_owned_pack(db, pack_id, context.user.id)
    item = next((row for row in pack.items if row.post_id == post_id), None)
    if not item:
        fail(404, "PACK_ITEM_NOT_FOUND", "That reel is not part of this Reel Pack.", "post_id")
    claim_revision(db, pack, expected_revision or pack.revision)
    if pack.cover_post_id == post_id:
        pack.cover_post_id = None
    db.delete(item)
    record_event(db, event_type="pack_update", pack_id=pack.id, user_id=context.user.id, source="collection_remove")
    db.commit()
    db.expire_all()
    pack = get_owned_pack(db, pack.id, context.user.id)
    return {"pack": serialize_pack(db, pack, context.user.id, include_items=True), "removed": True}


def set_pack_save(db: Session, pack: ReelPack, user_id: str, enabled: bool) -> dict:
    pack_id = pack.id
    changed = False
    if enabled:
        existing = db.query(ReelPackSave.id).filter(
            ReelPackSave.user_id == user_id,
            ReelPackSave.pack_id == pack_id,
        ).first()
        if not existing:
            db.add(ReelPackSave(user_id=user_id, pack_id=pack_id))
            try:
                db.flush()
                changed = True
            except IntegrityError:
                # Unique race vs FK failure (pack deleted concurrently) share
                # this path. Roll back, then distinguish: if the pack is gone,
                # surface 404; if the save now exists, another request won.
                db.rollback()
                live = db.query(ReelPack.id).filter(
                    ReelPack.id == pack_id,
                    ReelPack.deleted_at.is_(None),
                    ReelPack.status != "deleted",
                ).first()
                if not live:
                    fail(404, "PACK_NOT_FOUND", "Reel Pack not found.")
                already = db.query(ReelPackSave.id).filter(
                    ReelPackSave.user_id == user_id,
                    ReelPackSave.pack_id == pack_id,
                ).first()
                if not already:
                    # FK violation for another reason — do not misreport as
                    # saved; surface as not-found to avoid leaking internals.
                    fail(404, "PACK_NOT_FOUND", "Reel Pack not found.")
        if changed:
            db.query(ReelPack).filter(ReelPack.id == pack_id).update(
                {ReelPack.save_count: ReelPack.save_count + 1},
                synchronize_session=False,
            )
            record_event(db, event_type="pack_save", pack_id=pack_id, user_id=user_id, source="pack")
    else:
        changed = bool(
            db.query(ReelPackSave).filter(
                ReelPackSave.user_id == user_id,
                ReelPackSave.pack_id == pack_id,
            ).delete(synchronize_session=False)
        )
        if changed:
            db.query(ReelPack).filter(ReelPack.id == pack_id).update(
                {
                    ReelPack.save_count: case(
                        (ReelPack.save_count > 0, ReelPack.save_count - 1),
                        else_=0,
                    )
                },
                synchronize_session=False,
            )
            record_event(db, event_type="pack_unsave", pack_id=pack_id, user_id=user_id, source="pack")
    db.commit()
    saved = bool(
        db.query(ReelPackSave.id).filter(
            ReelPackSave.user_id == user_id,
            ReelPackSave.pack_id == pack_id,
        ).first()
    )
    saves = db.query(ReelPack.save_count).filter(ReelPack.id == pack_id).scalar() or 0
    return {"pack_id": pack_id, "saves": max(0, int(saves)), "saved": saved, "saved_by_me": saved}


@router.put("/api/packs/{pack_id}/save")
def save_pack(
    pack_id: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    return set_pack_save(db, get_pack_for_viewer(db, pack_id, context.user.id), context.user.id, True)


@router.delete("/api/packs/{pack_id}/save")
def unsave_pack(
    pack_id: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    return set_pack_save(db, get_pack_for_viewer(db, pack_id, context.user.id), context.user.id, False)


def pack_like_card(db: Session, pack_id: str, user_id: str) -> dict:
    likes = db.query(ReelPack.like_count).filter(ReelPack.id == pack_id).scalar() or 0
    liked = bool(
        db.query(ReelPackLike.id).filter(
            ReelPackLike.user_id == user_id,
            ReelPackLike.pack_id == pack_id,
        ).first()
    )
    return {"pack_id": pack_id, "likes": max(0, int(likes)), "liked_by_me": liked}


@router.put("/api/packs/{pack_id}/like")
def like_pack(
    pack_id: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    pack = get_pack_for_viewer(db, pack_id, context.user.id)
    existing = db.query(ReelPackLike.id).filter(
        ReelPackLike.user_id == context.user.id,
        ReelPackLike.pack_id == pack.id,
    ).first()
    if not existing:
        db.add(ReelPackLike(user_id=context.user.id, pack_id=pack.id))
        try:
            db.flush()
            pack.like_count = max(0, int(pack.like_count or 0)) + 1
            db.commit()
        except IntegrityError:
            # Double-tap raced with another request; the like already exists.
            db.rollback()
    return pack_like_card(db, pack.id, context.user.id)


@router.delete("/api/packs/{pack_id}/like")
def unlike_pack(
    pack_id: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    pack = get_pack_for_viewer(db, pack_id, context.user.id)
    existing = db.query(ReelPackLike).filter(
        ReelPackLike.user_id == context.user.id,
        ReelPackLike.pack_id == pack.id,
    ).first()
    if existing:
        db.delete(existing)
        pack.like_count = max(0, int(pack.like_count or 0) - 1)
        db.commit()
    return pack_like_card(db, pack.id, context.user.id)


@router.put("/api/packs/{pack_id}/progress")
def update_progress(
    pack_id: str,
    req: PackProgressRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    pack = get_pack_for_viewer(db, pack_id, context.user.id)
    item = None
    if req.current_item_id:
        item = next((row for row in pack.items if row.id == req.current_item_id), None)
        if not item:
            fail(422, "PACK_ITEM_NOT_FOUND", "That item is not part of this Reel Pack.", "current_item_id")
        if not member_available_for_viewer(db, item, context.user.id):
            fail(422, "PACK_ITEM_UNAVAILABLE", "That reel is currently unavailable in this pack.", "current_item_id")
    row = db.query(ReelPackProgress).filter(
        ReelPackProgress.user_id == context.user.id,
        ReelPackProgress.pack_id == pack.id,
    ).first()
    if not row:
        row = ReelPackProgress(user_id=context.user.id, pack_id=pack.id)
        db.add(row)
        try:
            db.flush()
        except IntegrityError:
            # Timed and immediate progress writes can overlap when XR exits.
            # Keep one row and let the newest request update it. FK failure
            # (pack deleted concurrently) must not become a 500 via .one().
            db.rollback()
            try:
                pack = get_pack_for_viewer(db, pack_id, context.user.id)
            except HTTPException:
                fail(404, "PACK_NOT_FOUND", "Reel Pack not found.")
            row = db.query(ReelPackProgress).filter(
                ReelPackProgress.user_id == context.user.id,
                ReelPackProgress.pack_id == pack.id,
            ).first()
            if row is None:
                fail(404, "PACK_NOT_FOUND", "Reel Pack not found.")
    row.current_item_id = item.id if item else None
    row.position_ms = min(int(req.position_ms), 24 * 60 * 60 * 1000)
    row.phase = req.phase
    row.updated_at = utcnow()
    db.commit()
    return {"pack_id": pack.id, "progress": progress_card(db, pack, context.user.id)}


@router.get("/api/packs/{pack_id}/share")
def pack_share(
    pack_id: str,
    request: Request,
    context: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    user_id = viewer_id(context)
    pack = get_pack_for_viewer(db, pack_id, user_id)
    configured = os.environ.get("SX_PUBLIC_URL", "").strip().rstrip("/")
    public_root = configured or str(request.base_url).rstrip("/")
    canonical_url = f"{public_root}/packs/{pack.id}"
    card = serialize_pack(db, pack, user_id)
    return {
        "kind": "pack",
        "pack_id": pack.id,
        "canonical_url": canonical_url,
        "title": pack.title,
        "share_text": f"{pack.title} — Reel Pack on ECHO",
        "creator": card.get("creator"),
        "reel_count": card.get("reel_count", 0),
        "playable_count": card.get("playable_count", 0),
        "cover_url": card.get("cover_url"),
        "cover_items": card.get("cover_items", [])[:4],
        "needs_repair": card.get("needs_repair", False),
    }
