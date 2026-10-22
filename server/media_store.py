"""Published media storage: Cloudflare R2 in production, local output/ otherwise.

Rule: a published file (anything under ``output/uploads/``) exists locally
only once its R2 object exists. Generators write a hidden ``.part`` file and
hand it to :func:`commit`, which uploads first and renames second, so the
request-time sibling probes (``exists()`` / ``stat()``) stay correct and no
call site needs its own upload hook. Local copies stay on disk as the
working set for derived assets and as unserved moderation evidence.

R2 is on when ``SX_MEDIA_BASE_URL`` and ``R2_PUBLIC_BUCKET`` are both set
(production requires them, see ``server/settings.py``). Without them URLs
keep the dev ``/media/`` mount and nothing is uploaded.
"""

from __future__ import annotations

import logging
import mimetypes
import os
import threading
from pathlib import Path
from typing import Iterable

logger = logging.getLogger(__name__)

OUTPUT_ROOT = Path("output")
PUBLISHED_PREFIX = "uploads/"
CACHE_CONTROL = "public, max-age=86400"
_DELETE_BATCH = 1000
_CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

_client = None
_client_lock = threading.Lock()


class MediaStoreError(Exception):
    """The R2 object could not be written; the local file was not committed."""


def enabled() -> bool:
    return bool(os.environ.get("SX_MEDIA_BASE_URL", "").strip() and os.environ.get("R2_PUBLIC_BUCKET", "").strip())


def _bucket() -> str:
    return os.environ.get("R2_PUBLIC_BUCKET", "").strip()


def _base_url() -> str:
    base = os.environ.get("SX_MEDIA_BASE_URL", "").strip()
    return base if base.endswith("/") else base + "/"


def public_url(rel: str) -> str:
    """Browser URL of a file under output/, given its output-relative path."""
    rel = str(rel).lstrip("/")
    if enabled():
        return _base_url() + rel
    return "/media/" + rel


def rel_path(path: str | Path) -> str | None:
    """Output-relative POSIX path of *path*, or None outside output/."""
    try:
        return Path(path).resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()
    except (OSError, ValueError):
        return None


def url_for_path(path: str | Path) -> str | None:
    rel = rel_path(path)
    return public_url(rel) if rel else None


def set_client(client) -> None:
    """Swap the S3 client (tests inject a fake; None resets to boto3)."""
    global _client
    with _client_lock:
        _client = client


def endpoint_url() -> str:
    """R2's S3 endpoint; ``R2_ENDPOINT_URL`` points at a stand-in (SeaweedFS in local staging)."""
    override = os.environ.get("R2_ENDPOINT_URL", "").strip()
    if override:
        return override
    account = os.environ.get("R2_ACCOUNT_ID", "").strip()
    return f"https://{account}.r2.cloudflarestorage.com"


def client():
    global _client
    with _client_lock:
        if _client is None:
            import boto3
            from botocore.config import Config

            _client = boto3.client(
                "s3",
                endpoint_url=endpoint_url(),
                aws_access_key_id=os.environ.get("R2_ACCESS_KEY_ID", "").strip(),
                aws_secret_access_key=os.environ.get("R2_SECRET_ACCESS_KEY", "").strip(),
                region_name="auto",
                # R2 rejects the newer default CRC checksums on some calls.
                config=Config(
                    request_checksum_calculation="when_required",
                    response_checksum_validation="when_required",
                    retries={"max_attempts": 3, "mode": "standard"},
                ),
            )
        return _client


def content_type(name: str) -> str:
    ext = Path(name).suffix.lower()
    return _CONTENT_TYPES.get(ext) or mimetypes.guess_type(name)[0] or "application/octet-stream"


def is_published(rel: str | None) -> bool:
    return bool(rel) and rel.startswith(PUBLISHED_PREFIX)


def commit(part: str | Path, dest: str | Path) -> None:
    """Upload *part* as *dest*'s object (published paths only), then rename it into place.

    Raises MediaStoreError when the upload fails and OSError when the rename
    fails; the caller removes *part* in both cases.
    """
    rel = rel_path(dest)
    if enabled() and is_published(rel):
        _upload(part, rel)
    os.replace(part, dest)


def _upload(local: str | Path, rel: str) -> None:
    try:
        client().upload_file(
            str(local),
            _bucket(),
            rel,
            ExtraArgs={"ContentType": content_type(rel), "CacheControl": CACHE_CONTROL},
        )
    except Exception as ex:
        logger.error("R2 upload of %s failed: %s", rel, ex)
        raise MediaStoreError(f"Could not store {rel}") from ex


def republish_paths(paths: Iterable[str | Path]) -> int:
    """Upload the kept local copies of *paths* again (a restored post); returns how many.

    The reverse of :func:`delete_paths`. Missing files are skipped. Raises
    MediaStoreError on the first failed upload.
    """
    count = 0
    for path in paths:
        rel = rel_path(path)
        if not is_published(rel) or not Path(path).is_file():
            continue
        if enabled():
            _upload(path, rel)
        count += 1
    return count


def delete(rels: Iterable[str]) -> int:
    """Best-effort removal of published objects; returns how many were requested.

    Errors are logged, never raised: takedowns must not fail on storage. The
    CDN can keep serving a cached copy for up to a day (purge by URL when
    urgent, see docs/deploy-runbook.md).
    """
    keys = sorted({rel for rel in rels if is_published(rel)})
    if not keys or not enabled():
        return 0
    for start in range(0, len(keys), _DELETE_BATCH):
        batch = keys[start:start + _DELETE_BATCH]
        try:
            result = client().delete_objects(
                Bucket=_bucket(),
                Delete={"Objects": [{"Key": key} for key in batch], "Quiet": True},
            )
            for error in (result or {}).get("Errors", []):
                logger.error("R2 delete of %s failed: %s", error.get("Key"), error.get("Message"))
        except Exception:
            logger.exception("R2 delete of %d objects failed", len(batch))
    return len(keys)


def delete_paths(paths: Iterable[str | Path]) -> int:
    return delete(rel for rel in (rel_path(path) for path in paths) if rel)
