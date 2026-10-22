"""Sign up through the real verification flow, for tests that need a session.

Registration returns 202 and creates no session; the account only exists once
its emailed link is used. The root conftest exposes ``debug_token`` (the same
dev switch password reset uses), so this helper plays the inbox: register,
then POST the token to /api/auth/verify-email, which sets the cookies.
"""

from __future__ import annotations


def register_verified(client, **kwargs):
    """Drop-in for ``client.post("/api/auth/register", ...)``.

    Returns the verify-email response (200 with ``{"user": ...}`` and the
    session cookies) when registration is accepted, otherwise the register
    response unchanged (403 closed, 409 taken, 400 terms, ...).
    """
    response = client.post("/api/auth/register", **kwargs)
    if response.status_code != 202:
        return response
    token = response.json().get("debug_token")
    assert token, "set SX_PASSWORD_RESET_EXPOSE_TOKEN=1 so register returns debug_token"
    return client.post("/api/auth/verify-email", json={"token": token})
