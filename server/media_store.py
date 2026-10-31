"""Published media storage: Cloudflare R2 in production, local output/ otherwise.

Rule: a published file (anything under ``output/uploads/``) exists locally
only once its R2 object exists. Generators write a hidden ``.part`` file and
hand it to :func:`commit`, which uploads first and renames second, so no
call site needs its own upload hook.

R2 is the only durable copy of published media; this disk is a work area
(see docs/storage-design.md). Builders :func:`fetch_local` what they read and
:func:`drop_local` it when done. Removing a post only hides it: its objects
stay, so a staff restore can publish it again. Completed job results are
kept under ``jobs/`` (see server/output.py).

R2 is on when ``SX_MEDIA_BASE_URL`` and ``R2_PUBLIC_BUCKET`` are both set
(production requires them, see ``server/settings.py``). Without them URLs
keep the dev ``/media/`` mount and nothing is uploaded.
"""

from __future__ import annotations

import json
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


def store_file(local: str | Path, key: str) -> None:
    """Upload *local* as *key*, a key outside ``uploads/`` (job results). Raises MediaStoreError."""
    _upload(local, key)


def put_json(key: str, data: dict) -> None:
    """Store *data* as the JSON object *key*. Raises MediaStoreError."""
    try:
        client().put_object(
            Bucket=_bucket(), Key=key, Body=json.dumps(data).encode("utf-8"), ContentType="application/json"
        )
    except Exception as ex:
        logger.error("R2 upload of %s failed: %s", key, ex)
        raise MediaStoreError(f"Could not store {key}") from ex


def get_json(key: str) -> dict | None:
    """The JSON object *key*, or None when it does not exist. Other errors raise."""
    try:
        body = client().get_object(Bucket=_bucket(), Key=key)["Body"].read()
    except Exception as ex:
        if _missing(ex):
            return None
        raise
    return json.loads(body)


def _missing(ex: Exception) -> bool:
    """True when *ex* is R2 saying the object does not exist."""
    code = str((getattr(ex, "response", None) or {}).get("Error", {}).get("Code", ""))
    return code in ("404", "NoSuchKey", "NotFound")


def _download(path: Path, rel: str) -> None:
    """Download *rel* to *path* through a hidden ``.part`` file, so a half-written copy is never read."""
    part = path.with_name(f".{path.name}.part")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        client().download_file(_bucket(), rel, str(part))
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)


def fetch_local(path: str | Path) -> bool:
    """Make sure a published file is on this disk, downloading its object when it is not.

    Returns True when the file is local afterwards. Builders of derived
    assets call this before reading an original whose local copy was
    dropped.
    """
    path = Path(path)
    if path.is_file():
        return True
    rel = rel_path(path)
    if not (enabled() and is_published(rel)):
        return False
    try:
        _download(path, rel)
    except Exception as ex:
        logger.warning("R2 download of %s failed: %s", rel, ex)
        return False
    return True


def fetch_file(key: str, path: str | Path) -> bool:
    """Download the object *key* to *path*; False (logged) when it fails."""
    try:
        _download(Path(path), key)
    except Exception as ex:
        logger.warning("R2 download of %s failed: %s", key, ex)
        return False
    return True


def drop_local(paths: Iterable[str | Path]) -> int:
    """Remove this disk's copies of published files that R2 holds; returns how many.

    A copy goes only when its object exists with the same size, so the
    evidence of a post removed while removals still deleted its objects, and
    a file that never reached R2, both stay. Never raises; no-op without R2.
    """
    if not enabled():
        return 0
    count = 0
    for path in paths:
        path = Path(path)
        rel = rel_path(path)
        if not is_published(rel) or not path.is_file():
            continue
        try:
            size = path.stat().st_size
            stored = client().head_object(Bucket=_bucket(), Key=rel)["ContentLength"]
        except Exception as ex:
            if not (isinstance(ex, FileNotFoundError) or _missing(ex)):
                logger.warning("Kept %s: could not check its R2 object: %s", rel, ex)
            continue
        if stored != size:
            logger.warning("Kept %s: its R2 object has %s bytes, this copy %s", rel, stored, size)
            continue
        try:
            path.unlink()
        except OSError as ex:
            logger.warning("Could not drop the local copy of %s: %s", rel, ex)
            continue
        count += 1
    return count


def republish_paths(paths: Iterable[str | Path]) -> int:
    """Upload the kept local copies of *paths* again (a restored post); returns how many.

    A post removed while removals still deleted its objects has only these
    copies. Missing files are skipped. Raises MediaStoreError on the first
    failed upload.
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

    Errors are logged, never raised. The CDN can keep serving a cached copy
    for up to a day (purge by URL when urgent, see docs/deploy-runbook.md).
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

