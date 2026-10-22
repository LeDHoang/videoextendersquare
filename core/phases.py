"""Phase classification, formatting, and pool sizing shared by the FastAPI
server and the Streamlit fallback.

These were duplicated (and had already started to drift) between
`server/jobs.py` and `ui/runner.py`. This module is the single source of
truth; both now import from here.
"""

from __future__ import annotations

import os

# (substring matched against a worker callback message, display label, entry weight)
PHASES: list[tuple[str, str, float]] = [
    ("Analyzing", "ANALYZE SOURCE", 0.05),
    ("Uploading", "UPLOAD TO CDN", 0.10),
    ("Submitting", "SUBMIT JOB", 0.15),
    ("Queued", "QUEUED AT FAL", 0.20),
    ("already square", "SKIP OUTPAINT", 0.55),
    ("Outpainting: Completed", "OUTPAINT COMPLETE", 0.60),
    ("Outpainting", "OUTPAINTING", 0.40),
    ("Downloading", "DOWNLOAD RESULT", 0.70),
    ("Performing studio-quality", "STUDIO UPSCALE", 0.80),
    ("Performing", "LOCAL 4K UPSCALE", 0.85),
    # Make 3D (pipeline/spatial_worker.py)
    ("Estimating depth", "ESTIMATE DEPTH", 0.30),
    ("Rendering 3D", "RENDER 3D", 0.60),
]

MAX_LOG_LINES = 200


def classify(msg: str) -> tuple[str, float]:
    """Return (label, weight) for a worker progress message."""
    for needle, label, weight in PHASES:
        if needle.lower() in msg.lower():
            return label, weight
    return "WORKING", 0.0


def fmt_elapsed(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 60}:{s % 60:02d}"


def format_error(ex: Exception) -> tuple[str, str]:
    """(headline, detail) for the known failure families."""
    msg = str(ex)
    name = type(ex).__name__

    if isinstance(ex, ValueError) and "FAL_KEY" in msg:
        return (
            "API KEY MISSING",
            "Cloud outpainting needs a fal.ai key. Enter one in the sidebar, "
            "or switch to UPSCALE ONLY to run entirely locally.",
        )
    if isinstance(ex, FileNotFoundError) or "WinError 2" in msg:
        return (
            "FFMPEG NOT FOUND",
            f"{msg}\n\nSee SYSTEM in the sidebar. Set FFMPEG_DIR in .env to the "
            "folder containing ffmpeg.exe.",
        )
    if name == "CalledProcessError":
        stderr = getattr(ex, "stderr", None)
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", "replace")
        tail = "\n".join((stderr or "").strip().splitlines()[-12:])
        return ("FFMPEG FAILED", tail or msg)
    return (f"{name.upper()}", msg)


def _env_workers(name: str) -> int | None:
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return None
    return value if value >= 1 else None


def default_pool_sizes() -> tuple[int, int]:
    """(image, video) worker counts: SX_IMAGE_WORKERS / SX_VIDEO_WORKERS,
    else CPU-aware defaults."""
    cpus = os.cpu_count() or 2
    max_video = _env_workers("SX_VIDEO_WORKERS") or max(1, min(2, cpus // 2))
    max_image = _env_workers("SX_IMAGE_WORKERS") or max(1, min(4, cpus))
    return max_image, max_video
