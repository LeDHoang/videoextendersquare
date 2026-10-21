"""Minimal SMTP delivery for account recovery and support-inbox messages."""

from __future__ import annotations

import logging
import os
import smtplib
from email.message import EmailMessage
from urllib.parse import urlencode

logger = logging.getLogger(__name__)


def password_reset_link(token: str) -> str:
    base = os.environ.get("SX_PUBLIC_URL", "http://localhost:5173").rstrip("/")
    return base + "/reset-password?" + urlencode({"token": token})


def send_password_reset_email(recipient: str, token: str) -> bool:
    message = EmailMessage()
    message["Subject"] = "Reset your ECHO password"
    message["To"] = recipient
    message.set_content(
        "A password reset was requested for your ECHO account.\n\n"
        + password_reset_link(token)
        + "\n\nThis link expires in 30 minutes. If you did not request it, ignore this email.\n"
    )
    return _deliver(message)


def support_inbox_link() -> str:
    base = os.environ.get("SX_PUBLIC_URL", "http://localhost:5173").rstrip("/")
    return base + "/moderation?" + urlencode({"tab": "support"})


def send_support_notification(request_id: str, category: str, subject: str) -> bool:
    """Tell the support inbox a request arrived. Runs as a background task.

    Only the category, id, subject and an inbox link are sent; the body and the
    requester's email stay in the database to keep PII out of mailboxes.
    """
    recipient = os.environ.get("SX_SUPPORT_EMAIL", "").strip()
    if not recipient:
        logger.info("Support request %s (%s) received; SX_SUPPORT_EMAIL is unset", request_id, category)
        return False
    message = EmailMessage()
    clean_subject = " ".join(str(subject or "").split())[:120]
    message["Subject"] = f"[ECHO support] {category}: {clean_subject or '(no subject)'}"
    message["To"] = recipient
    message.set_content(
        "A new support request arrived.\n\n"
        f"Category: {category}\n"
        f"Request ID: {request_id}\n"
        f"Subject: {clean_subject or '(no subject)'}\n\n"
        "Open the inbox: " + support_inbox_link() + "\n"
    )
    try:
        return _deliver(message)
    except Exception:
        logger.exception("Support notification delivery failed for request %s", request_id)
        return False


def _deliver(message: EmailMessage) -> bool:
    host = os.environ.get("SX_SMTP_HOST", "").strip()
    sender = os.environ.get("SX_SMTP_FROM", "").strip()
    if not host or not sender:
        return False
    message["From"] = sender

    port = int(os.environ.get("SX_SMTP_PORT", "465"))
    username = os.environ.get("SX_SMTP_USERNAME", "")
    password = os.environ.get("SX_SMTP_PASSWORD", "")
    use_ssl = os.environ.get("SX_SMTP_SSL", "1").lower() in {"1", "true", "yes"}

    client_class = smtplib.SMTP_SSL if use_ssl else smtplib.SMTP
    with client_class(host, port, timeout=15) as client:
        if not use_ssl and os.environ.get("SX_SMTP_STARTTLS", "1").lower() in {"1", "true", "yes"}:
            client.starttls()
        if username:
            client.login(username, password)
        client.send_message(message)
    return True
