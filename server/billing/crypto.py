"""AES-GCM encryption for per-user Fal API keys."""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class FalKeyConfigurationError(RuntimeError):
    pass


def _key() -> bytes:
    secret = os.environ.get("SX_FAL_KEY_ENCRYPTION_KEY", "").strip()
    if not secret:
        raise FalKeyConfigurationError("SX_FAL_KEY_ENCRYPTION_KEY is required to store personal Fal keys")
    return hashlib.sha256(("echo-fal-key-v1:" + secret).encode("utf-8")).digest()


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _aad(user_id: str) -> bytes:
    return f"fal-credential:{user_id}:v1".encode("utf-8")


def encrypt_fal_key(user_id: str, plaintext: str) -> str:
    value = str(plaintext or "").strip()
    if not value:
        raise ValueError("Fal API key cannot be empty")
    nonce = os.urandom(12)
    ciphertext = AESGCM(_key()).encrypt(nonce, value.encode("utf-8"), _aad(user_id))
    return f"v1.{_encode(nonce)}.{_encode(ciphertext)}"


def decrypt_fal_key(user_id: str, envelope: str) -> str:
    version, nonce, ciphertext = str(envelope or "").split(".", 2)
    if version != "v1":
        raise ValueError("Unsupported Fal credential encryption version")
    plaintext = AESGCM(_key()).decrypt(_decode(nonce), _decode(ciphertext), _aad(user_id))
    return plaintext.decode("utf-8")


def key_hint(value: str) -> str:
    stripped = str(value or "").strip()
    return f"••••{stripped[-4:]}" if len(stripped) >= 4 else "saved"
