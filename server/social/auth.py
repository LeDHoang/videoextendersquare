"""Password, cookie-session, CSRF, and lightweight rate-limit helpers."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from .database import get_db
from .models import AuthSession, RateLimitEvent, User, utcnow


SESSION_COOKIE = "echo_session"
CSRF_COOKIE = "echo_csrf"
ANON_COOKIE = "echo_anon"
SESSION_DAYS = max(1, int(os.environ.get("SX_SESSION_DAYS", "30")))
COOKIE_SECURE = os.environ.get("SX_COOKIE_SECURE", "0").lower() in {"1", "true", "yes"}
USERNAME_RE = re.compile(r"^[a-z0-9_]{3,30}$")
PASSWORD_HASHER = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2)
TRUST_PROXY_HEADERS = os.environ.get("SX_TRUST_PROXY_HEADERS", "0").lower() in {"1", "true", "yes"}
SECURITY_SECRET = os.environ.get("SX_SECURITY_SECRET", "echo-development-secret-change-me")


def normalize_email(value: str) -> str:
    return str(value or "").strip().casefold()


def normalize_username(value: str) -> str:
    return str(value or "").strip().casefold()


def validate_username(value: str) -> str:
    username = normalize_username(value)
    if not USERNAME_RE.fullmatch(username):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "INVALID_USERNAME",
                "message": "Username must use 3–30 lowercase letters, numbers, or underscores.",
                "field": "username",
            },
        )
    return username


def validate_password(value: str) -> str:
    if len(value or "") < 10 or len(value or "") > 128:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "INVALID_PASSWORD",
                "message": "Password must be 10–128 characters.",
                "field": "password",
            },
        )
    return value


def hash_password(password: str) -> str:
    return PASSWORD_HASHER.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    if not password_hash:
        return False
    try:
        return bool(PASSWORD_HASHER.verify(password_hash, password))
    except (VerifyMismatchError, InvalidHashError):
        return False


def token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()



def keyed_hash(value: str) -> str:
    return hmac.new(SECURITY_SECRET.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()

def aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def avatar_url(user: User) -> str | None:
    return f"/avatars/{user.avatar_path}" if user.avatar_path else None


def public_user(user: User, viewer_id: str | None = None, is_following: bool = False) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "bio": user.bio,
        "website": user.website,
        "avatar_url": avatar_url(user),
        "avatar_color": user.avatar_color,
        "account_type": user.account_type,
        "post_count": user.post_count,
        "follower_count": user.follower_count,
        "following_count": user.following_count,
        "is_me": viewer_id == user.id,
        "is_following": is_following,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


def private_user(user: User) -> dict:
    return {
        **public_user(user, viewer_id=user.id),
        "email": user.email,
        "role": user.role,
        "can_moderate": user.role in {"moderator", "admin"},
    }


@dataclass
class AuthContext:
    user: User
    session: AuthSession


def create_auth_session(db: Session, user: User, request: Request) -> tuple[AuthSession, str, str]:
    session_token = secrets.token_urlsafe(40)
    csrf_token = secrets.token_urlsafe(24)
    client_ip = request_identity(request)
    row = AuthSession(
        user_id=user.id,
        token_hash=token_hash(session_token),
        csrf_hash=token_hash(csrf_token),
        user_agent=request.headers.get("user-agent", "")[:300],
        ip_hash=keyed_hash(client_ip) if client_ip else "",
        expires_at=utcnow() + timedelta(days=SESSION_DAYS),
    )
    db.add(row)
    user.last_seen_at = utcnow()
    db.commit()
    db.refresh(row)
    return row, session_token, csrf_token


def set_auth_cookies(response: Response, session_token: str, csrf_token: str) -> None:
    max_age = SESSION_DAYS * 24 * 60 * 60
    response.set_cookie(
        SESSION_COOKIE,
        session_token,
        max_age=max_age,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        CSRF_COOKIE,
        csrf_token,
        max_age=max_age,
        httponly=False,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")


def get_optional_auth(request: Request, db: Session = Depends(get_db)) -> AuthContext | None:
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw:
        return None
    row = db.query(AuthSession).filter(AuthSession.token_hash == token_hash(raw)).first()
    if not row or row.revoked_at is not None or aware(row.expires_at) <= utcnow():
        return None
    user = db.query(User).filter(User.id == row.user_id, User.status == "active").first()
    if not user:
        return None
    if (utcnow() - aware(row.last_used_at)).total_seconds() >= 300:
        row.last_used_at = utcnow()
        user.last_seen_at = utcnow()
        db.commit()
    return AuthContext(user=user, session=row)


def require_auth(context: AuthContext | None = Depends(get_optional_auth)) -> AuthContext:
    if context is None:
        raise HTTPException(
            status_code=401,
            detail={"code": "AUTH_REQUIRED", "message": "Sign in to continue."},
        )
    return context


def require_auth_csrf(
    request: Request,
    context: AuthContext = Depends(require_auth),
) -> AuthContext:
    validate_csrf(request, context)
    return context


def validate_csrf(request: Request, context: AuthContext) -> None:
    cookie_value = request.cookies.get(CSRF_COOKIE, "")
    header_value = request.headers.get("x-csrf-token", "")
    if not cookie_value or not header_value or not hmac.compare_digest(cookie_value, header_value):
        raise HTTPException(
            status_code=403,
            detail={"code": "CSRF_FAILED", "message": "Security token is missing or invalid."},
        )
    if not hmac.compare_digest(token_hash(header_value), context.session.csrf_hash):
        raise HTTPException(
            status_code=403,
            detail={"code": "CSRF_FAILED", "message": "Security token is missing or invalid."},
        )


def require_moderator(context: AuthContext = Depends(require_auth)) -> AuthContext:
    if context.user.role not in {"moderator", "admin"}:
        raise HTTPException(
            status_code=403,
            detail={"code": "MODERATOR_REQUIRED", "message": "Moderator access is required."},
        )
    return context


def require_moderator_csrf(
    context: AuthContext = Depends(require_auth_csrf),
) -> AuthContext:
    if context.user.role not in {"moderator", "admin"}:
        raise HTTPException(
            status_code=403,
            detail={"code": "MODERATOR_REQUIRED", "message": "Moderator access is required."},
        )
    return context



def ensure_anonymous_cookie(request: Request, response: Response) -> str:
    value = request.cookies.get(ANON_COOKIE)
    if value:
        return token_hash(value)
    value = secrets.token_urlsafe(24)
    response.set_cookie(
        ANON_COOKIE,
        value,
        max_age=365 * 24 * 60 * 60,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    return token_hash(value)


def validate_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin:
        return
    origin_parts = urlsplit(origin)
    request_host = request.headers.get("host", "")
    if origin_parts.netloc == request_host:
        return
    configured = {
        item.strip()
        for item in os.environ.get(
            "SX_DEV_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173",
        ).split(",")
        if item.strip()
    }
    if origin.rstrip("/") not in {item.rstrip("/") for item in configured}:
        raise HTTPException(
            status_code=403,
            detail={"code": "ORIGIN_DENIED", "message": "Request origin is not allowed."},
        )


class RateLimiter:
    """Database-backed limiter shared by every application worker."""

    def check(self, db: Session, key: str, limit: int, window_seconds: int) -> None:
        now = utcnow()
        cutoff = now - timedelta(seconds=max(1, int(window_seconds)))
        key_digest = keyed_hash(key)
        db.query(RateLimitEvent).filter(
            RateLimitEvent.created_at < now - timedelta(days=2),
        ).delete(synchronize_session=False)
        db.query(RateLimitEvent).filter(
            RateLimitEvent.key_hash == key_digest,
            RateLimitEvent.created_at < cutoff,
        ).delete(synchronize_session=False)
        count = db.query(RateLimitEvent.id).filter(
            RateLimitEvent.key_hash == key_digest,
            RateLimitEvent.created_at >= cutoff,
        ).count()
        if count >= limit:
            db.commit()
            raise HTTPException(
                status_code=429,
                detail={"code": "RATE_LIMITED", "message": "Too many requests. Try again shortly."},
            )
        db.add(RateLimitEvent(key_hash=key_digest, created_at=now))
        db.commit()


rate_limiter = RateLimiter()


def request_identity(request: Request) -> str:
    if TRUST_PROXY_HEADERS:
        forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
        if forwarded:
            return forwarded
    return request.client.host if request.client else "unknown"
