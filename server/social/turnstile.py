"""Cloudflare Turnstile verification for the forms that send email or reach an account.

``SX_TURNSTILE_SITE_KEY`` goes to the SPA through ``/api/config``;
``SX_TURNSTILE_SECRET`` stays server-side. With the secret unset the check is
skipped (local dev, tests) and ``log_turnstile_status`` warns once at boot.

A token passes only when Cloudflare reports the expected ``action`` (one per
form) and the hostname of ``SX_PUBLIC_URL``. Cloudflare's test secrets answer
with a placeholder hostname and no action, so those two checks are skipped for them.
"""

from __future__ import annotations

import logging
import os
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException

logger = logging.getLogger("server.turnstile")

SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
TIMEOUT_SECONDS = 10.0
MAX_TOKEN_LENGTH = 2048
# Cloudflare's dummy secrets: always pass, always fail, token already spent.
TEST_SECRETS = {
    "1x0000000000000000000000000000000AA",
    "2x0000000000000000000000000000000AA",
    "3x0000000000000000000000000000000AA",
}


def turnstile_secret() -> str:
    return os.environ.get("SX_TURNSTILE_SECRET", "").strip()


def turnstile_site_key() -> str:
    return os.environ.get("SX_TURNSTILE_SITE_KEY", "").strip()


def turnstile_enabled() -> bool:
    return bool(turnstile_secret())


def log_turnstile_status() -> None:
    if not turnstile_secret():
        logger.warning("SX_TURNSTILE_SECRET is not set: the bot check is skipped.")
    elif not turnstile_site_key():
        logger.warning("SX_TURNSTILE_SITE_KEY is not set: the forms cannot render the challenge.")


def _bot_check_failed() -> HTTPException:
    return HTTPException(
        status_code=400,
        detail={
            "code": "BOT_CHECK_FAILED",
            "message": "We could not verify you are human. Reload the page and try again.",
            "field": "turnstile_token",
        },
    )


def _expected_hostname() -> str:
    return urlparse(os.environ.get("SX_PUBLIC_URL", "http://localhost:5173")).hostname or ""


def verify_turnstile(token: str | None, ip: str | None, *actions: str) -> None:
    """Raise 400 ``BOT_CHECK_FAILED`` unless Cloudflare accepts ``token`` for one of ``actions``."""
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
        result = response.json() if response.status_code == 200 else {}
        ok = result.get("success") is True
        if ok and secret not in TEST_SECRETS:
            ok = result.get("action") in actions and result.get("hostname") == _expected_hostname()
    except (httpx.HTTPError, ValueError):
        logger.exception("Turnstile siteverify failed")
        ok = False
    if not ok:
        raise _bot_check_failed()
