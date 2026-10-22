"""Cloudflare Turnstile verification for sign-up.

``SX_TURNSTILE_SITE_KEY`` goes to the SPA through ``/api/config``;
``SX_TURNSTILE_SECRET`` stays server-side. With the secret unset the check is
skipped (local dev, tests) and ``log_turnstile_status`` warns once at boot.
"""

from __future__ import annotations

import logging
import os

import httpx
from fastapi import HTTPException

logger = logging.getLogger("server.turnstile")

SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
TIMEOUT_SECONDS = 5.0
MAX_TOKEN_LENGTH = 2048


def turnstile_secret() -> str:
    return os.environ.get("SX_TURNSTILE_SECRET", "").strip()


def turnstile_site_key() -> str:
    return os.environ.get("SX_TURNSTILE_SITE_KEY", "").strip()


def turnstile_enabled() -> bool:
    return bool(turnstile_secret())


def log_turnstile_status() -> None:
    if not turnstile_secret():
        logger.warning("SX_TURNSTILE_SECRET is not set: sign-up bot check is skipped.")
    elif not turnstile_site_key():
        logger.warning("SX_TURNSTILE_SITE_KEY is not set: the sign-up page cannot render the challenge.")


def _bot_check_failed() -> HTTPException:
    return HTTPException(
        status_code=400,
        detail={
            "code": "BOT_CHECK_FAILED",
            "message": "We could not verify you are human. Reload the page and try again.",
            "field": "turnstile_token",
        },
    )


def verify_turnstile(token: str | None, ip: str | None) -> None:
    """Raise 400 ``BOT_CHECK_FAILED`` unless Cloudflare accepts ``token``."""
    secret = turnstile_secret()
    if not secret:
        return
    token = (token or "").strip()
    if not token or len(token) > MAX_TOKEN_LENGTH:
        raise _bot_check_failed()
    data = {"secret": secret, "response": token}
    if ip and ip != "unknown":
        data["remoteip"] = ip
    try:
        response = httpx.post(SITEVERIFY_URL, data=data, timeout=TIMEOUT_SECONDS)
        ok = response.status_code == 200 and bool(response.json().get("success"))
    except (httpx.HTTPError, ValueError):
        logger.exception("Turnstile siteverify failed")
        ok = False
    if not ok:
        raise _bot_check_failed()
