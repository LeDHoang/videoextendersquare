"""Result persistence for API jobs.

The pipeline workers write to a FIXED shared temp path (%TEMP%/delivery_4k_square.*)
and unlink it at the start of every run. A job's output must therefore be moved
into its own job-scoped directory the instant the worker returns — and while the
process-wide run lock is still held, so no other run can blank the file.
"""

import shutil
import tempfile
from pathlib import Path


def job_dir(job_id: str) -> Path:
    d = Path(tempfile.gettempdir()) / "square_extender_api" / job_id
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