"""Result persistence for API jobs.

The pipeline workers write to a FIXED shared temp path (%TEMP%/delivery_4k_square.*)
and unlink it at the start of every run. A job's output must therefore be moved
into its own job-scoped directory the instant the worker returns — and while the
process-wide run lock is still held, so no other run can blank the file.

With R2 on, a completed job's files are also kept in the public bucket under
``jobs/<keyed hash of the job id>/`` (:func:`keep`), so a restart or the
retention sweep does not lose a paid result. An R2 lifecycle rule expires
that prefix after 30 days (docs/storage-design.md).
"""

import logging
import re
import shutil
import tempfile
from pathlib import Path

from server import media_store
from server.jobs import JobRecord, JobStatus, public_result

logger = logging.getLogger(__name__)

_JOB_ID = re.compile(r"[0-9a-f]{12}")
# Result keys holding a file in the job dir.
_FILE_KEYS = ("path", "preview")


def jobs_root() -> Path:
    """Parent of every job dir (and of the staged-upload dir, ``uploads/``)."""
    return Path(tempfile.gettempdir()) / "square_extender_api"


def job_dir(job_id: str) -> Path:
    d = jobs_root() / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def persist(worker_path: str, kind: str, job_id: str) -> dict:
    """Move a worker's output out of its fixed shared path into the job dir."""
    src = Path(worker_path)
    ext = src.suffix or (".png" if kind == "image" else ".mp4")
    dest = job_dir(job_id) / f"result{ext}"
    try:
        shutil.move(str(src), str(dest))
    except OSError:
        shutil.copy2(str(src), str(dest))
    return {
        "path": str(dest),
        "kind": kind,
        "bytes": dest.stat().st_size,
        "preview": None,
    }


def _r2_prefix(job_id: str) -> str:
    """Key prefix of a kept job. Keyed by a hash: the bucket is public, and job ids appear in URLs."""
    from server.social.auth import keyed_hash

    return f"jobs/{keyed_hash('job-result:' + job_id)[:32]}/"


def _thumbnail(record: JobRecord, source: Path) -> Path | None:
    """A small JPEG of the result for gallery tiles, beside it in the job dir. Best effort."""
    from server import media as SM

    try:
        made = SM.make_image_poster(str(source)) if record.kind == "image" else SM.make_explore_poster(str(source))
    except Exception:
        logger.exception("Could not build the thumbnail of job %s", record.job_id)
        return None
    return Path(made) if made else None


def keep(record: JobRecord) -> dict | None:
    """Copy a completed job's result files to R2. Never raises; no-op without R2.

    Returns the stored file names (``path``, ``preview``, ``thumb``) once the job is
    restorable, else None. ``job.json`` goes last, so a job is restorable only once
    its files are stored.
    """
    result = record.result
    if not (media_store.enabled() and isinstance(result, dict)):
        return None
    root = (jobs_root() / record.job_id).resolve()
    files = {}
    for key in _FILE_KEYS:
        value = result.get(key)
        if value and Path(value).resolve().parent == root and Path(value).is_file():
            files[key] = Path(value).name
    if "path" not in files:
        return None
    prefix = _r2_prefix(record.job_id)
    # The H.264 preview decodes anywhere; an HEVC master may not.
    thumb = _thumbnail(record, root / files.get("preview", files["path"]))
    try:
        for name in sorted(set(files.values())):
            media_store.store_file(root / name, prefix + name)
        if thumb is not None:
            media_store.store_file(thumb, prefix + thumb.name)
        media_store.put_json(prefix + "job.json", {
            "kind": record.kind,
            "owner_id": record.owner_id,
            "elapsed": record.elapsed,
            "files": files,
            "result": public_result(result),
        })
    except Exception:
        logger.exception("Could not keep the result of job %s in R2", record.job_id)
        return None
    return {**files, "thumb": thumb.name if thumb is not None else None}


def restore(job_id: str) -> JobRecord | None:
    """Rebuild the record of a kept job, or None. Its files come back when read (:func:`fetch`)."""
    if not (media_store.enabled() and _JOB_ID.fullmatch(job_id)):
        return None
    try:
        kept = media_store.get_json(_r2_prefix(job_id) + "job.json")
    except Exception as ex:
        logger.warning("Could not read the kept result of job %s: %s", job_id, ex)
        return None
    if not kept:
        return None
    root = jobs_root() / job_id
    result = {**kept["result"], **{key: str(root / name) for key, name in kept["files"].items()}}
    return JobRecord(
        job_id=job_id,
        kind=kept["kind"],
        owner_id=kept["owner_id"],
        status=JobStatus.COMPLETE,
        phase="COMPLETE",
        progress=1.0,
        elapsed=kept["elapsed"],
        result=result,
    )


def fetch(job_id: str, path: str | Path) -> bool:
    """Make sure a result file of *job_id* is on this disk, downloading it when it is not."""
    path = Path(path)
    if path.is_file():
        return True
    return media_store.enabled() and media_store.fetch_file(_r2_prefix(job_id) + path.name, path)
