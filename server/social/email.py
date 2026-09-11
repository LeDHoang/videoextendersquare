"""Minimal SMTP delivery for account recovery messages."""

from __future__ import annotations

import os
import smtplib
from email.message import EmailMessage
from urllib.parse import urlencode


def password_reset_link(token: str) -> str:
    base = os.environ.get("SX_PUBLIC_URL", "http://localhost:5173").rstrip("/")
    return base + "/reset-password?" + urlencode({"token": token})


def send_password_reset_email(recipient: str, token: str) -> bool:
    host = os.environ.get("SX_SMTP_HOST", "").strip()
    sender = os.environ.get("SX_SMTP_FROM", "").strip()
    if not host or not sender:
        return False

    message = EmailMessage()
    message["Subject"] = "Reset your ECHO password"
    message["From"] = sender
    message["To"] = recipient
    message.set_content(
        "A password reset was requested for your ECHO account.\n\n"
        + password_reset_link(token)
        + "\n\nThis link expires in 30 minutes. If you did not request it, ignore this email.\n"
    )

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
