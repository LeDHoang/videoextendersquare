"""Accounts, profiles, feeds, post interactions, search, and event APIs."""

from __future__ import annotations

import base64
import io
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from server import media as media_service
from server.social.auth import (
    AuthContext,
    clear_auth_cookies,
    create_auth_session,
    ensure_anonymous_cookie,
    get_optional_auth,
    hash_password,
    normalize_email,
    normalize_username,
    private_user,
    public_user,
    rate_limiter,
    request_identity,
    require_auth,
    require_auth_csrf,
    set_auth_cookies,
    validate_origin,
    validate_password,
    validate_username,
    verify_password,
)
from server.social.database import get_db
from server.social.models import (
    AuthSession,
    Comment,
    CommentLike,
    Follow,
    Post,
    PostLike,
    PostSave,
    User,
    UserBlock,
    ViewDedup,
    utcnow,
)
from server.social.safety import blocked_user_ids, users_blocked
from server.social.services import (
    apply_cursor,
    create_or_update_post,
    encode_cursor,
    get_post_by_reference,
    post_card,
    record_event,
    serialize_comment,
    sync_post_tags,
    tag_slug,
)

router = APIRouter(tags=["social"])
AVATAR_DIR = Path("data/avatars")
MAX_AVATAR_BYTES = 5 * 1024 * 1024
REGISTRATION_ENABLED = os.environ.get("SX_REGISTRATION_ENABLED", "1").lower() not in {"0", "false", "no"}


def configured_role(email: str, username: str) -> str:
    identities = {email.casefold(), username.casefold()}
    admins = {
        value.strip().casefold()
        for value in os.environ.get("SX_ADMIN_USERS", "").split(",")
        if value.strip()
    }
    moderators = {
        value.strip().casefold()
        for value in os.environ.get("SX_MODERATOR_USERS", "").split(",")
        if value.strip()
    }
    return "admin" if identities & admins else "moderator" if identities & moderators else "user"


def error(status: int, code: str, message: str, field: str | None = None):
    detail = {"code": code, "message": message}
    if field:
        detail["field"] = field
    raise HTTPException(status_code=status, detail=detail)


def auth_user_id(context) -> str | None:
    return context.user.id if isinstance(context, AuthContext) else None


def encode_relationship_cursor(row: Follow) -> str:
    payload = json.dumps(
        {"created_at": row.created_at.isoformat(), "id": row.id},
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def decode_relationship_cursor(value: str | None) -> tuple[datetime, str] | None:
    if not value:
        return None
    try:
        padded = value + "=" * (-len(value) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        created_at = datetime.fromisoformat(str(data["created_at"]).replace("Z", "+00:00"))
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        return created_at, str(data["id"])
    except (KeyError, TypeError, ValueError):
        return None


def relationship_page(
    db: Session,
    *,
    user: User,
    kind: str,
    viewer_id: str | None,
    cursor: str | None,
    limit: int,
) -> dict:
    if kind == "followers":
        query = db.query(Follow, User).join(User, Follow.follower_id == User.id).filter(
            Follow.followee_id == user.id,
            User.status == "active",
        )
    else:
        query = db.query(Follow, User).join(User, Follow.followee_id == User.id).filter(
            Follow.follower_id == user.id,
            User.status == "active",
        )
    decoded = decode_relationship_cursor(cursor)
    hidden_ids = blocked_user_ids(db, viewer_id)
    if hidden_ids:
        query = query.filter(~User.id.in_(hidden_ids))
    if decoded:
        created_at, relationship_id = decoded
        query = query.filter(
            or_(
                Follow.created_at < created_at,
                and_(Follow.created_at == created_at, Follow.id < relationship_id),
            )
        )
    bounded = max(1, min(int(limit), 50))
    rows = query.order_by(Follow.created_at.desc(), Follow.id.desc()).limit(bounded + 1).all()
    has_more = len(rows) > bounded
    rows = rows[:bounded]
    users = [row[1] for row in rows]
    following_ids: set[str] = set()
    if viewer_id and users:
        ids = [candidate.id for candidate in users]
        following_ids = {
            value[0]
            for value in db.query(Follow.followee_id)
            .filter(Follow.follower_id == viewer_id, Follow.followee_id.in_(ids))
            .all()
        }
    return {
        "users": [public_user(candidate, viewer_id, candidate.id in following_ids) for candidate in users],
        "next_cursor": encode_relationship_cursor(rows[-1][0]) if has_more and rows else None,
    }


def get_target_user(db: Session, username: str) -> User:
    user = db.query(User).filter(
        User.username_norm == normalize_username(username),
        User.status == "active",
    ).first()
    if not user:
        error(404, "USER_NOT_FOUND", "Profile not found.")
    return user


def get_target_post(db: Session, post_id: str) -> Post:
    post = get_post_by_reference(db, post_id=post_id)
    if not post:
        error(404, "POST_NOT_FOUND", "Post not found.")
    return post


def relationship_state(db: Session, viewer_id: str | None, target_id: str) -> bool:
    if not viewer_id or viewer_id == target_id:
        return False
    return db.query(Follow.id).filter(
        Follow.follower_id == viewer_id,
        Follow.followee_id == target_id,
    ).first() is not None



def ensure_post_interaction_allowed(db: Session, viewer_id: str | None, post: Post) -> None:
    if post.owner.status != "active" or users_blocked(db, viewer_id, post.owner_id):
        error(404, "POST_NOT_FOUND", "Post not found.")


def get_visible_post(db: Session, post_id: str, viewer_id: str | None) -> Post:
    post = get_target_post(db, post_id)
    ensure_post_interaction_allowed(db, viewer_id, post)
    return post


def get_visible_comment(db: Session, comment_id: str, viewer_id: str | None) -> Comment:
    comment = db.query(Comment).options(joinedload(Comment.author), joinedload(Comment.post)).filter(
        Comment.id == comment_id,
        Comment.deleted_at.is_(None),
    ).first()
    if not comment:
        error(404, "COMMENT_NOT_FOUND", "Comment not found.")
    get_visible_post(db, comment.post_id, viewer_id)
    if comment.author.status != "active" or users_blocked(db, viewer_id, comment.author_id):
        error(404, "COMMENT_NOT_FOUND", "Comment not found.")
    return comment

def media_card(post: Post, db: Session, viewer_id: str | None = None) -> dict:

    card = post_card(post, db, viewer_id)
    source = Path("output") / post.media_path
    card["filename"] = source.name
    card["folder"] = source.parent.name if source.parent != Path("output") else "root"
    try:
        card["size"] = media_service.human_bytes(source.stat().st_size)
    except (OSError, AttributeError):
        card["size"] = ""
    if post.media_type == "image":
        card["preview_url"] = card["url"]
        card["poster_url"] = card["url"]
        card["codec"] = "IMG"
        return card

    def sibling_url(path: Path) -> str | None:
        try:
            if path.exists() and path.stat().st_size > 0:
                rel = path.resolve().relative_to(Path("output").resolve()).as_posix()
                return f"/media/{rel}"
        except (OSError, ValueError):
            return None
        return None

    card["preview_url"] = sibling_url(media_service.explore_preview_path(str(source)))
    card["poster_url"] = sibling_url(media_service.explore_poster_path(str(source)))
    try:
        card["codec"] = media_service.get_video_codec(str(source)).upper()
    except Exception:
        card["codec"] = ""
    return card


def post_query(db: Session):
    from server.social.models import PostTag

    return db.query(Post).options(
        joinedload(Post.owner),
        selectinload(Post.tags).selectinload(PostTag.tag),
    ).filter(Post.status == "published", Post.deleted_at.is_(None))


class RegisterRequest(BaseModel):
    email: EmailStr
    username: str
    password: str
    display_name: str = ""


class LoginRequest(BaseModel):
    identifier: str
    password: str


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str


class ProfileUpdateRequest(BaseModel):
    display_name: str | None = None
    bio: str | None = None
    website: str | None = None


class PostUpdateRequest(BaseModel):
    title: str | None = None
    caption: str | None = None
    tags: list[str] | None = None
    location: dict | None = None


class CommentRequest(BaseModel):
    text: str
    timestamp: float | None = None


class ViewRequest(BaseModel):
    watch_ms: int = 0
    position_ms: int | None = None
    completed: bool = False
    source: str = "reels"
    client_event_id: str | None = None
    context: dict = Field(default_factory=dict)


class EventRequest(BaseModel):
    event_type: str
    post_id: str | None = None
    watch_ms: int | None = None
    position_ms: int | None = None
    completed: bool = False
    source: str = "unknown"
    client_event_id: str | None = None
    context: dict = Field(default_factory=dict)


@router.post("/api/auth/register")
def register(req: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    validate_origin(request)
    if not REGISTRATION_ENABLED:
        error(403, "REGISTRATION_DISABLED", "New account registration is disabled.")
    rate_limiter.check(db, f"register-ip:{request_identity(request)}", 5, 60 * 60)
    email = normalize_email(str(req.email))
    username = validate_username(req.username)
    password = validate_password(req.password)
    rate_limiter.check(db, f"register-account:{email}:{username}", 3, 60 * 60)
    if db.query(User.id).filter(User.email_norm == email).first():
        error(409, "EMAIL_TAKEN", "An account already uses this email.", "email")
    if db.query(User.id).filter(User.username_norm == username).first():
        error(409, "USERNAME_TAKEN", "This username is already taken.", "username")
    user = User(
        email=email,
        email_norm=email,
        username=username,
        username_norm=username,
        password_hash=hash_password(password),
        display_name=(req.display_name.strip() or username)[:60],
        account_type="real",
        role=configured_role(email, username),
        status="active",
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if db.query(User.id).filter(User.email_norm == email).first():
            error(409, "EMAIL_TAKEN", "An account already uses this email.", "email")
        if db.query(User.id).filter(User.username_norm == username).first():
            error(409, "USERNAME_TAKEN", "This username is already taken.", "username")
        error(409, "ACCOUNT_CONFLICT", "The account details are already in use.")
    db.refresh(user)
    _session, session_token, csrf_token = create_auth_session(db, user, request)
    response = JSONResponse({"user": private_user(user)})
    set_auth_cookies(response, session_token, csrf_token)
    return response


@router.post("/api/auth/login")
def login(req: LoginRequest, request: Request, db: Session = Depends(get_db)):
    validate_origin(request)
    identity = request_identity(request)
    rate_limiter.check(db, f"login-ip:{identity}", 20, 15 * 60)
    rate_limiter.check(db, f"login-account:{str(req.identifier or '').strip().casefold()}", 10, 15 * 60)
    identifier = str(req.identifier or "").strip().casefold()
    user = db.query(User).filter(
        User.status == "active",
        User.account_type == "real",
        or_(User.email_norm == identifier, User.username_norm == identifier),
    ).first()
    if not user or not verify_password(user.password_hash, req.password):
        error(401, "INVALID_CREDENTIALS", "Email/username or password is incorrect.")
    assigned_role = configured_role(user.email or "", user.username)
    if user.role != assigned_role:
        user.role = assigned_role
    _session, session_token, csrf_token = create_auth_session(db, user, request)
    response = JSONResponse({"user": private_user(user)})
    set_auth_cookies(response, session_token, csrf_token)
    return response


@router.post("/api/auth/logout")
def logout(
    response: Response,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    context.session.revoked_at = utcnow()
    db.commit()
    clear_auth_cookies(response)
    return {"ok": True}


@router.get("/api/auth/me")
def me(context: AuthContext | None = Depends(get_optional_auth)):
    return {"user": private_user(context.user) if isinstance(context, AuthContext) else None}


@router.patch("/api/auth/password")
def change_password(
    req: PasswordChangeRequest,
    request: Request,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    if not verify_password(context.user.password_hash, req.current_password):
        error(400, "INVALID_PASSWORD", "Current password is incorrect.", "current_password")
    new_password = validate_password(req.new_password)
    context.user.password_hash = hash_password(new_password)
    db.query(AuthSession).filter(
        AuthSession.user_id == context.user.id,
        AuthSession.id != context.session.id,
        AuthSession.revoked_at.is_(None),
    ).update({AuthSession.revoked_at: utcnow()}, synchronize_session=False)
    db.commit()
    return {"ok": True}


@router.get("/api/users/{username}")
def get_profile(
    username: str,
    db: Session = Depends(get_db),
    context: AuthContext | None = Depends(get_optional_auth),
):
    user = get_target_user(db, username)
    viewer_id = auth_user_id(context)
    if users_blocked(db, viewer_id, user.id):
        error(404, "USER_NOT_FOUND", "Profile not found.")
    payload = public_user(
        user,
        viewer_id=viewer_id,
        is_following=relationship_state(db, viewer_id, user.id),
    )
    payload["is_blocked_by_me"] = bool(
        viewer_id
        and db.query(UserBlock.id).filter(
            UserBlock.blocker_id == viewer_id,
            UserBlock.blocked_id == user.id,
        ).first()
    )
    return {"user": payload}


@router.patch("/api/users/me")
def update_profile(
    req: ProfileUpdateRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    user = context.user
    if req.display_name is not None:
        name = req.display_name.strip()
        if not name:
            error(422, "INVALID_DISPLAY_NAME", "Display name cannot be empty.", "display_name")
        user.display_name = name[:60]
    if req.bio is not None:
        user.bio = req.bio.strip()[:150]
    if req.website is not None:
        website = req.website.strip()
        if website:
            parsed = urlsplit(website)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                error(422, "INVALID_WEBSITE", "Website must be a complete http(s) URL.", "website")
        user.website = website[:300]
    db.commit()
    db.refresh(user)
    return {"user": private_user(user)}


@router.post("/api/users/me/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    raw = await file.read(MAX_AVATAR_BYTES + 1)
    if len(raw) > MAX_AVATAR_BYTES:
        error(413, "AVATAR_TOO_LARGE", "Avatar must be 5 MB or smaller.")
    try:
        image = Image.open(io.BytesIO(raw))
    except Exception:
        error(422, "INVALID_AVATAR", "Avatar must be a valid PNG, JPEG, or WebP image.")
    if image.width * image.height > 25_000_000:
        error(413, "AVATAR_DIMENSIONS_TOO_LARGE", "Avatar dimensions are too large.")
    try:
        image.load()
    except Exception:
        error(422, "INVALID_AVATAR", "Avatar must be a valid PNG, JPEG, or WebP image.")
    if image.format not in {"PNG", "JPEG", "WEBP"}:
        error(422, "INVALID_AVATAR", "Avatar must be a PNG, JPEG, or WebP image.")
    image = ImageOps.exif_transpose(image).convert("RGB")
    image = ImageOps.fit(image, (512, 512), method=Image.Resampling.LANCZOS)

    user_dir = AVATAR_DIR / context.user.id
    user_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}.webp"
    destination = user_dir / filename
    image.save(destination, "WEBP", quality=88, method=6)

    old_path = context.user.avatar_path
    context.user.avatar_path = f"{context.user.id}/{filename}"
    db.commit()
    if old_path:
        try:
            (AVATAR_DIR / old_path).unlink(missing_ok=True)
        except OSError:
            pass
    return {"user": private_user(context.user)}


@router.delete("/api/users/me/avatar")
def delete_avatar(
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    old_path = context.user.avatar_path
    context.user.avatar_path = None
    db.commit()
    if old_path:
        try:
            (AVATAR_DIR / old_path).unlink(missing_ok=True)
        except OSError:
            pass
    return {"user": private_user(context.user)}


@router.get("/api/users/{username}/posts")
def get_profile_posts(
    username: str,
    media: str = "all",
    cursor: str | None = None,
    limit: int = 24,
    db: Session = Depends(get_db),
    context: AuthContext | None = Depends(get_optional_auth),
):
    user = get_target_user(db, username)
    viewer_id = auth_user_id(context)
    if users_blocked(db, viewer_id, user.id):
        error(404, "USER_NOT_FOUND", "Profile not found.")
    limit = max(1, min(int(limit), 50))
    query = post_query(db).filter(Post.owner_id == user.id)
    if media in {"video", "image"}:
        query = query.filter(Post.media_type == media)
    query = apply_cursor(query, cursor).order_by(Post.created_at.desc(), Post.id.desc())
    rows = query.limit(limit + 1).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [media_card(post, db, viewer_id) for post in rows],
        "next_cursor": encode_cursor(rows[-1]) if has_more and rows else None,
    }


@router.get("/api/users/{username}/followers")
def followers(
    username: str,
    cursor: str | None = None,
    limit: int = 24,
    db: Session = Depends(get_db),
    context: AuthContext | None = Depends(get_optional_auth),
):
    user = get_target_user(db, username)
    viewer_id = auth_user_id(context)
    if users_blocked(db, viewer_id, user.id):
        error(404, "USER_NOT_FOUND", "Profile not found.")
    return relationship_page(
        db,
        user=user,
        kind="followers",
        viewer_id=viewer_id,
        cursor=cursor,
        limit=limit,
    )


@router.get("/api/users/{username}/following")
def following(
    username: str,
    cursor: str | None = None,
    limit: int = 24,
    db: Session = Depends(get_db),
    context: AuthContext | None = Depends(get_optional_auth),
):
    user = get_target_user(db, username)
    viewer_id = auth_user_id(context)
    if users_blocked(db, viewer_id, user.id):
        error(404, "USER_NOT_FOUND", "Profile not found.")
    return relationship_page(
        db,
        user=user,
        kind="following",
        viewer_id=viewer_id,
        cursor=cursor,
        limit=limit,
    )


@router.put("/api/users/{username}/follow")
def follow_user(
    username: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    rate_limiter.check(db, f"follow:{context.user.id}", 120, 60)
    target = get_target_user(db, username)
    if target.id == context.user.id:
        error(422, "SELF_FOLLOW", "You cannot follow yourself.")
    if users_blocked(db, context.user.id, target.id):
        error(403, "BLOCKED_RELATIONSHIP", "Following is unavailable for this profile.")
    existing = db.query(Follow).filter(
        Follow.follower_id == context.user.id,
        Follow.followee_id == target.id,
    ).first()
    if not existing:
        db.add(Follow(follower_id=context.user.id, followee_id=target.id))
        context.user.following_count = max(0, int(context.user.following_count or 0) + 1)
        target.follower_count = max(0, int(target.follower_count or 0) + 1)
        record_event(db, event_type="follow", user_id=context.user.id, source="profile", context={"target_user_id": target.id})
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
    db.refresh(target)
    return {"following": True, "follower_count": target.follower_count}


@router.delete("/api/users/{username}/follow")
def unfollow_user(
    username: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    target = get_target_user(db, username)
    row = db.query(Follow).filter(
        Follow.follower_id == context.user.id,
        Follow.followee_id == target.id,
    ).first()
    if row:
        db.delete(row)
        context.user.following_count = max(0, int(context.user.following_count or 0) - 1)
        target.follower_count = max(0, int(target.follower_count or 0) - 1)
        record_event(db, event_type="unfollow", user_id=context.user.id, source="profile", context={"target_user_id": target.id})
        db.commit()
    return {"following": False, "follower_count": target.follower_count}


@router.get("/api/users/me/saved")
def saved_posts(
    cursor: str | None = None,
    limit: int = 24,
    context: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
):
    limit = max(1, min(int(limit), 50))
    hidden_ids = blocked_user_ids(db, context.user.id)
    query = post_query(db).join(PostSave, PostSave.post_id == Post.id).join(
        User, User.id == Post.owner_id
    ).filter(PostSave.user_id == context.user.id, User.status == "active")
    if hidden_ids:
        query = query.filter(~Post.owner_id.in_(hidden_ids))
    query = apply_cursor(query, cursor).order_by(Post.created_at.desc(), Post.id.desc())
    rows = query.limit(limit + 1).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [media_card(post, db, context.user.id) for post in rows],
        "next_cursor": encode_cursor(rows[-1]) if has_more and rows else None,
    }


@router.get("/api/posts/{post_id}")
def get_post(
    post_id: str,
    db: Session = Depends(get_db),
    context: AuthContext | None = Depends(get_optional_auth),
):
    viewer_id = auth_user_id(context)
    post = get_visible_post(db, post_id, viewer_id)
    return {"post": media_card(post, db, viewer_id)}


@router.get("/api/posts/{post_id}/share")
def get_post_share(
    post_id: str,
    request: Request,
    db: Session = Depends(get_db),
    context: AuthContext | None = Depends(get_optional_auth),
):
    viewer_id = auth_user_id(context)
    post = get_visible_post(db, post_id, viewer_id)
    configured = os.environ.get("SX_PUBLIC_URL", "").strip().rstrip("/")
    public_root = configured or str(request.base_url).rstrip("/")
    canonical_url = f"{public_root}/reels?post={post.id}"
    title = post.title.strip() or "Watch this reel on ECHO"
    return {
        "post_id": post.id,
        "canonical_url": canonical_url,
        "title": title,
        "share_text": f"{title} — ECHO",
    }


@router.patch("/api/posts/{post_id}")
def update_post(
    post_id: str,
    req: PostUpdateRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    post = get_target_post(db, post_id)
    if post.owner_id != context.user.id:
        error(403, "FORBIDDEN", "Only the post owner can edit this post.")
    if req.title is not None:
        post.title = req.title.strip()[:100]
    if req.caption is not None:
        post.caption = req.caption.strip()[:2200]
    if req.location is not None:
        post.location = dict(req.location)
    if req.tags is not None:
        sync_post_tags(db, post, req.tags)
    db.commit()
    db.refresh(post)
    return {"post": media_card(post, db, context.user.id)}


@router.delete("/api/posts/{post_id}")
def delete_post(
    post_id: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    post = get_target_post(db, post_id)
    if post.owner_id != context.user.id:
        error(403, "FORBIDDEN", "Only the post owner can delete this post.")
    post.status = "deleted"
    post.deleted_at = utcnow()
    context.user.post_count = max(0, int(context.user.post_count or 0) - 1)
    record_event(db, event_type="delete_post", post_id=post.id, user_id=context.user.id, source="profile")
    db.commit()
    return {"ok": True}


def set_post_like(db: Session, post: Post, user_id: str, enabled: bool) -> dict:
    row = db.query(PostLike).filter(PostLike.user_id == user_id, PostLike.post_id == post.id).first()
    if enabled and not row:
        db.add(PostLike(user_id=user_id, post_id=post.id))
        post.like_count = max(post.legacy_like_count, int(post.like_count or 0) + 1)
        record_event(db, event_type="like", post_id=post.id, user_id=user_id, source="reels")
    elif not enabled and row:
        db.delete(row)
        post.like_count = max(post.legacy_like_count, int(post.like_count or 0) - 1)
        record_event(db, event_type="unlike", post_id=post.id, user_id=user_id, source="reels")
    db.commit()
    return {"post_id": post.id, "likes": post.like_count, "liked": enabled, "liked_by_me": enabled}


@router.put("/api/posts/{post_id}/like")
def like_post(post_id: str, context: AuthContext = Depends(require_auth_csrf), db: Session = Depends(get_db)):
    rate_limiter.check(db, f"like:{context.user.id}", 300, 60)
    return set_post_like(db, get_visible_post(db, post_id, context.user.id), context.user.id, True)


@router.delete("/api/posts/{post_id}/like")
def unlike_post(post_id: str, context: AuthContext = Depends(require_auth_csrf), db: Session = Depends(get_db)):
    return set_post_like(db, get_visible_post(db, post_id, context.user.id), context.user.id, False)


def set_post_save(db: Session, post: Post, user_id: str, enabled: bool) -> dict:
    row = db.query(PostSave).filter(PostSave.user_id == user_id, PostSave.post_id == post.id).first()
    if enabled and not row:
        db.add(PostSave(user_id=user_id, post_id=post.id))
        post.save_count = max(0, int(post.save_count or 0) + 1)
        record_event(db, event_type="save", post_id=post.id, user_id=user_id, source="reels")
    elif not enabled and row:
        db.delete(row)
        post.save_count = max(0, int(post.save_count or 0) - 1)
        record_event(db, event_type="unsave", post_id=post.id, user_id=user_id, source="reels")
    db.commit()
    return {"post_id": post.id, "saves": post.save_count, "saved": enabled, "saved_by_me": enabled}


@router.put("/api/posts/{post_id}/save")
def save_post(post_id: str, context: AuthContext = Depends(require_auth_csrf), db: Session = Depends(get_db)):
    return set_post_save(db, get_visible_post(db, post_id, context.user.id), context.user.id, True)


@router.delete("/api/posts/{post_id}/save")
def unsave_post(post_id: str, context: AuthContext = Depends(require_auth_csrf), db: Session = Depends(get_db)):
    return set_post_save(db, get_visible_post(db, post_id, context.user.id), context.user.id, False)


@router.get("/api/posts/{post_id}/comments")
def list_comments(
    post_id: str,
    db: Session = Depends(get_db),
    context: AuthContext | None = Depends(get_optional_auth),
):
    post = get_visible_post(db, post_id, auth_user_id(context))
    rows = db.query(Comment).options(joinedload(Comment.author), joinedload(Comment.post)).filter(
        Comment.post_id == post.id,
        Comment.deleted_at.is_(None),
    ).order_by(Comment.created_at.asc()).all()
    viewer_id = auth_user_id(context)
    hidden_ids = blocked_user_ids(db, viewer_id)
    if hidden_ids:
        rows = [row for row in rows if row.author_id not in hidden_ids]
    liked_ids = set()
    if viewer_id and rows:
        ids = [row.id for row in rows]
        liked_ids = {
            value[0]
            for value in db.query(CommentLike.comment_id)
            .filter(CommentLike.user_id == viewer_id, CommentLike.comment_id.in_(ids))
            .all()
        }
    return {"post_id": post.id, "comments": [serialize_comment(row, viewer_id, liked_ids) for row in rows]}


@router.post("/api/posts/{post_id}/comments")
def create_post_comment(
    post_id: str,
    req: CommentRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    rate_limiter.check(db, f"comment:{context.user.id}", 20, 60)
    post = get_visible_post(db, post_id, context.user.id)
    text = req.text.strip()
    if not text:
        error(422, "EMPTY_COMMENT", "Comment text cannot be empty.", "text")
    if len(text) > 500:
        error(422, "COMMENT_TOO_LONG", "Comments are limited to 500 characters.", "text")
    timestamp_ms = None
    if req.timestamp is not None:
        timestamp_ms = max(0, min(round(float(req.timestamp) * 1000), 24 * 60 * 60 * 1000))
    comment = Comment(
        post_id=post.id,
        author_id=context.user.id,
        text=text,
        timestamp_ms=timestamp_ms,
    )
    db.add(comment)
    post.comment_count = max(0, int(post.comment_count or 0) + 1)
    record_event(db, event_type="comment", post_id=post.id, user_id=context.user.id, source="reels")
    db.commit()
    db.refresh(comment)
    comment.author = context.user
    comment.post = post
    return serialize_comment(comment, context.user.id, set())


@router.delete("/api/comments/{comment_id}")
def delete_social_comment(
    comment_id: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    comment = db.query(Comment).filter(Comment.id == comment_id, Comment.deleted_at.is_(None)).first()
    if not comment:
        error(404, "COMMENT_NOT_FOUND", "Comment not found.")
    if comment.author_id != context.user.id:
        error(403, "FORBIDDEN", "Only the comment author can delete this comment.")
    comment.deleted_at = utcnow()
    post = db.get(Post, comment.post_id)
    if post:
        post.comment_count = max(0, int(post.comment_count or 0) - 1)
    record_event(db, event_type="delete_comment", post_id=comment.post_id, user_id=context.user.id, source="reels")
    db.commit()
    return {"ok": True}


def set_comment_like(db: Session, comment: Comment, user_id: str, enabled: bool) -> dict:
    row = db.query(CommentLike).filter(CommentLike.user_id == user_id, CommentLike.comment_id == comment.id).first()
    if enabled and not row:
        db.add(CommentLike(user_id=user_id, comment_id=comment.id))
        comment.like_count = max(comment.legacy_like_count, int(comment.like_count or 0) + 1)
        record_event(db, event_type="comment_like", post_id=comment.post_id, user_id=user_id, source="reels", context={"comment_id": comment.id})
    elif not enabled and row:
        db.delete(row)
        comment.like_count = max(comment.legacy_like_count, int(comment.like_count or 0) - 1)
        record_event(db, event_type="comment_unlike", post_id=comment.post_id, user_id=user_id, source="reels", context={"comment_id": comment.id})
    db.commit()
    return {"id": comment.id, "likes": comment.like_count, "liked": enabled}


@router.put("/api/comments/{comment_id}/like")
def like_social_comment(comment_id: str, context: AuthContext = Depends(require_auth_csrf), db: Session = Depends(get_db)):
    return set_comment_like(db, get_visible_comment(db, comment_id, context.user.id), context.user.id, True)


@router.delete("/api/comments/{comment_id}/like")
def unlike_social_comment(comment_id: str, context: AuthContext = Depends(require_auth_csrf), db: Session = Depends(get_db)):
    return set_comment_like(db, get_visible_comment(db, comment_id, context.user.id), context.user.id, False)


@router.post("/api/posts/{post_id}/view")
def record_view(
    post_id: str,
    req: ViewRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    context: AuthContext | None = Depends(get_optional_auth),
):
    validate_origin(request)
    viewer_id = auth_user_id(context)
    post = get_visible_post(db, post_id, viewer_id)
    anonymous_hash = ensure_anonymous_cookie(request, response)
    qualified = req.completed or req.watch_ms >= (2000 if post.media_type == "image" else 3000)
    counted = False
    if qualified:
        key = f"u:{viewer_id}" if viewer_id else f"a:{anonymous_hash[:48]}"
        today = utcnow().date().isoformat()
        existing = db.query(ViewDedup.id).filter(
            ViewDedup.post_id == post.id,
            ViewDedup.viewer_key == key,
            ViewDedup.window_date == today,
        ).first()
        if not existing:
            db.add(ViewDedup(post_id=post.id, viewer_key=key, window_date=today))
            post.view_count = max(post.legacy_view_count, int(post.view_count or 0) + 1)
            counted = True
    record_event(
        db,
        event_type="view" if qualified else "playback",
        post_id=post.id,
        user_id=viewer_id,
        anonymous_id=None if viewer_id else anonymous_hash,
        source=req.source,
        watch_ms=req.watch_ms,
        position_ms=req.position_ms,
        completed=req.completed,
        context=req.context,
        client_event_id=req.client_event_id,
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        counted = False
        post = get_target_post(db, post_id)
    return {"post_id": post.id, "views": post.view_count, "counted": counted}


@router.post("/api/events")
def create_event(
    req: EventRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    context: AuthContext | None = Depends(get_optional_auth),
):
    validate_origin(request)
    allowed = {
        "impression", "open", "playback", "view", "complete", "skip",
        "search_impression", "search_select", "share",
    }
    event_type = req.event_type.strip().casefold()
    if event_type not in allowed:
        error(422, "INVALID_EVENT", "Unsupported event type.", "event_type")
    viewer_id = auth_user_id(context)
    post = get_visible_post(db, req.post_id, viewer_id) if req.post_id else None
    anonymous_hash = ensure_anonymous_cookie(request, response)
    row = record_event(
        db,
        event_type=event_type,
        post_id=post.id if post else None,
        user_id=viewer_id,
        anonymous_id=None if viewer_id else anonymous_hash,
        source=req.source,
        watch_ms=req.watch_ms,
        position_ms=req.position_ms,
        completed=req.completed,
        context=req.context,
        client_event_id=req.client_event_id,
    )
    db.commit()
    return {"accepted": row is not None}


@router.get("/api/feed")
def get_feed(
    scope: str = "discover",
    media: str = "all",
    cursor: str | None = None,
    limit: int = 24,
    db: Session = Depends(get_db),
    context: AuthContext | None = Depends(get_optional_auth),
):
    viewer_id = auth_user_id(context)
    if scope == "following" and not viewer_id:
        error(401, "AUTH_REQUIRED", "Sign in to view posts from people you follow.")
    limit = max(1, min(int(limit), 50))
    hidden_ids = blocked_user_ids(db, viewer_id)
    query = post_query(db).join(User, User.id == Post.owner_id).filter(User.status == "active")
    if hidden_ids:
        query = query.filter(~Post.owner_id.in_(hidden_ids))
    if media in {"video", "image"}:
        query = query.filter(Post.media_type == media)
    if scope == "following":
        followed = db.query(Follow.followee_id).filter(Follow.follower_id == viewer_id)
        query = query.filter(or_(Post.owner_id == viewer_id, Post.owner_id.in_(followed)))
    elif scope != "discover":
        error(422, "INVALID_FEED", "Feed scope must be discover or following.")
    query = apply_cursor(query, cursor).order_by(Post.created_at.desc(), Post.id.desc())
    rows = query.limit(limit + 1).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    return {
        "scope": scope,
        "items": [media_card(post, db, viewer_id) for post in rows],
        "next_cursor": encode_cursor(rows[-1]) if has_more and rows else None,
    }


@router.get("/api/search/suggestions")
def search_suggestions(
    q: str = "",
    limit: int = 6,
    db: Session = Depends(get_db),
    context: AuthContext | None = Depends(get_optional_auth),
):
    from server.routers import reels as reels_router

    query = str(q or "").strip()
    key = query.casefold().lstrip("@#")
    bounded = max(1, min(int(limit), 12))
    viewer_id = auth_user_id(context)
    hidden_ids = blocked_user_ids(db, viewer_id)

    user_rows = []
    if key:
        candidate_query = db.query(User).filter(
            User.status == "active",
            or_(
                User.username_norm.contains(key),
                User.display_name.ilike(f"%{key}%"),
            ),
        )
        if hidden_ids:
            candidate_query = candidate_query.filter(~User.id.in_(hidden_ids))
        candidates = candidate_query.limit(bounded * 3).all()

        def user_score(user: User):
            display = user.display_name.casefold()
            if user.username_norm == key:
                return (0, -user.follower_count, user.username_norm)
            if user.username_norm.startswith(key):
                return (1, -user.follower_count, user.username_norm)
            if display.startswith(key):
                return (2, -user.follower_count, user.username_norm)
            return (3, -user.follower_count, user.username_norm)

        candidates.sort(key=user_score)
        for user in candidates[:bounded]:
            user_rows.append(public_user(user, viewer_id, relationship_state(db, viewer_id, user.id)))
    else:
        candidates = db.query(User).filter(User.status == "active", ~User.id.in_(hidden_ids) if hidden_ids else User.id.is_not(None)).order_by(
            User.follower_count.desc(), User.post_count.desc(), User.username_norm.asc()
        ).limit(bounded).all()
        user_rows = [
            public_user(user, viewer_id, relationship_state(db, viewer_id, user.id))
            for user in candidates
        ]

    tag_rows = reels_router.list_reel_tags(q=query, limit=bounded).get("tags", [])

    posts = []
    if key:
        rows = post_query(db).join(User, User.id == Post.owner_id).filter(
            User.status == "active",
            or_(
                Post.title.ilike(f"%{key}%"),
                Post.caption.ilike(f"%{key}%"),
                User.username_norm.contains(key),
                User.display_name.ilike(f"%{key}%"),
            ),
        )
        if hidden_ids:
            rows = rows.filter(~Post.owner_id.in_(hidden_ids))
        rows = rows.order_by(Post.created_at.desc()).limit(bounded).all()
        posts = [media_card(post, db, viewer_id) for post in rows]

    return {
        "query": query,
        "strategy": "social-search-v1",
        "users": user_rows,
        "tags": tag_rows,
        "posts": posts,
    }
