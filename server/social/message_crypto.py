"""Application-level AES-GCM encryption for direct-message content."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class MessageCryptoConfigurationError(RuntimeError):
    """Raised when encrypted messaging is used without a dedicated key."""


def _key() -> bytes:
    secret = os.environ.get("SX_MESSAGE_ENCRYPTION_KEY", "").strip()
    if not secret:
        raise MessageCryptoConfigurationError(
            "SX_MESSAGE_ENCRYPTION_KEY is required for direct messaging"
        )
    return hashlib.sha256(("echo-message-v1:" + secret).encode("utf-8")).digest()


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def message_aad(message_id: str, conversation_id: str, sender_id: str, kind: str) -> bytes:
    return f"message:{message_id}:{conversation_id}:{sender_id}:{kind}".encode("utf-8")


def report_aad(report_id: str, message_id: str) -> bytes:
    return f"message-report:{report_id}:{message_id}".encode("utf-8")


def encrypt_payload(payload: dict[str, Any], *, aad: bytes) -> str:
    nonce = os.urandom(12)
    plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ciphertext = AESGCM(_key()).encrypt(nonce, plaintext, aad)
    return f"v1.{_b64encode(nonce)}.{_b64encode(ciphertext)}"


def decrypt_payload(envelope: str, *, aad: bytes) -> dict[str, Any]:
    if not envelope:
        return {}
    version, nonce, ciphertext = envelope.split(".", 2)
    if version != "v1":
        raise ValueError("Unsupported message encryption version")
    plaintext = AESGCM(_key()).decrypt(_b64decode(nonce), _b64decode(ciphertext), aad)
    value = json.loads(plaintext.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Encrypted payload is not an object")
    return value


def encrypt_message_text(plaintext: str, *, aad: bytes) -> str:
    return encrypt_payload({"text": plaintext}, aad=aad)


def decrypt_message_text(envelope: str, *, aad: bytes) -> str:
    return str(decrypt_payload(envelope, aad=aad).get("text") or "")
