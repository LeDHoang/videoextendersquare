"""Deployment mode and production boot checks.

``SX_ENV=production`` is the single switch for production-only behaviour
(no /media mount, no legacy discovery, diagnostics off, fail-fast config).
Values are read at call time so tests can monkeypatch the environment.
"""

from __future__ import annotations

import os
from urllib.parse import urlparse


DEV_SECURITY_SECRET = "echo-development-secret-change-me"
MIN_SECRET_LENGTH = 32
_TRUE_VALUES = {"1", "true", "yes", "on"}
_REQUIRED_SECRETS = (
    "SX_SECURITY_SECRET",
    "SX_MESSAGE_ENCRYPTION_KEY",
    "SX_FAL_KEY_ENCRYPTION_KEY",
)
_REQUIRED_R2 = (
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_PUBLIC_BUCKET",
)
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"}


def is_production() -> bool:
    return os.environ.get("SX_ENV", "").strip().casefold() == "production"


def env_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().casefold() in _TRUE_VALUES


def env_int(name: str, default: int, *, minimum: int | None = None) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    if minimum is not None:
        value = max(minimum, value)
    return value


def _https(value: str) -> bool:
    parsed = urlparse(value.strip())
    return parsed.scheme == "https" and bool(parsed.netloc)


def production_config_errors() -> list[str]:
    """Return every reason the current environment is unsafe for production.

    Empty outside production, so dev and test boots are unaffected.
    """
    if not is_production():
        return []
    errors: list[str] = []
    for name in _REQUIRED_SECRETS:
        value = os.environ.get(name, "").strip()
        if not value:
            errors.append(f"{name} is not set")
        elif value == DEV_SECURITY_SECRET:
            errors.append(f"{name} uses the development default")
        elif len(value) < MIN_SECRET_LENGTH:
            errors.append(f"{name} must be at least {MIN_SECRET_LENGTH} characters")
    if not env_flag("SX_COOKIE_SECURE"):
        errors.append("SX_COOKIE_SECURE must be 1 (HTTPS-only cookies)")
    if not env_flag("SX_TRUST_PROXY_HEADERS"):
        errors.append("SX_TRUST_PROXY_HEADERS must be 1 behind Cloudflare")
    if not _https(os.environ.get("SX_PUBLIC_URL", "")):
        errors.append("SX_PUBLIC_URL must be an https:// URL")
    if not os.environ.get("DATABASE_URL", "").startswith("postgresql+psycopg://"):
        errors.append("DATABASE_URL must use postgresql+psycopg://")
    if not _https(os.environ.get("SX_MEDIA_BASE_URL", "")):
        errors.append("SX_MEDIA_BASE_URL must be an https:// URL")
    for name in _REQUIRED_R2:
        if not os.environ.get(name, "").strip():
            errors.append(f"{name} is not set")
    for origin in os.environ.get("SX_DEV_ORIGINS", "").split(","):
        host = (urlparse(origin.strip()).hostname or "").casefold()
        if host in _LOCAL_HOSTS or host.endswith(".localhost"):
            errors.append(f"SX_DEV_ORIGINS must not include local origin {origin.strip()}")
    return errors
