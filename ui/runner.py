"""Pipeline execution wrapped in st.status.

Replaces the old st.empty() + .info() pattern, where every callback overwrote
the previous one — a 4-minute video run ended with a single line and no history.
"""

import html
import threading
import time

import streamlit as st

from ui import state as S

# (substring matched against the callback message, display label, entry weight)
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
]

MAX_LOG_LINES = 200


@st.cache_resource(show_spinner=False)
def _run_lock() -> threading.Lock:
    """Process-wide lock serializing renders.

    The workers write to a fixed shared temp path and unlink it at run start,
    so two concurrent runs corrupt each other inside the worker's own execution
    window — which persist_result() cannot fix from the outside. Serializing is
    the right behavior for a local single-user tool anyway.
    """
    return threading.Lock()


def classify(msg: str) -> tuple[str, float]:
    for needle, label, weight in PHASES:
        if needle.lower() in msg.lower():
            return label, weight
    return "WORKING", 0.0


def fmt_elapsed(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 60}:{s % 60:02d}"


def format_error(ex: Exception) -> tuple[str, str]:
    """(headline, detail) for the three known failure families."""
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


def run_pipeline(ns: str, kind: str, fn, kwargs: dict):
    """Execute a pipeline worker, streaming progress into st.status.

    Returns (result_tuple, error) — exactly one is None.
    """
    lines: list[str] = []
    lock = _run_lock()

    if not lock.acquire(blocking=False):
        return None, ("RENDER IN PROGRESS",
                      "Another render is already running in this app. "
                      "Wait for it to finish, then try again.")
    try:
        with st.status("RENDERING…", expanded=True, state="running") as status:
            head = st.empty()
            meter = st.progress(0.0)
            pane = st.container(height=220, border=False, key=f"sx-log-{kind}")
            body = pane.empty()

            t0 = time.monotonic()
            highest = 0.0

            def cb(msg: str) -> None:
                nonlocal highest
                label, weight = classify(msg)
                elapsed = time.monotonic() - t0
                highest = max(highest, weight)  # never rewind
                status.update(label=f"{label}  ·  {fmt_elapsed(elapsed)}")
                head.markdown(
                    f'<div class="sx-phase">{html.escape(label)}</div>',
                    unsafe_allow_html=True,
                )
                meter.progress(highest)
                lines.append(f"{int(elapsed):>5}s  {msg}")
                # Fal log messages are third-party strings going into
                # unsafe_allow_html — escape every one.
                body.markdown(
                    '<div class="sx-log">'
                    + "<br>".join(html.escape(x) for x in lines[-MAX_LOG_LINES:])
                    + "</div>",
                    unsafe_allow_html=True,
                )

            try:
                out = fn(status_callback=cb, **kwargs)
                meter.progress(1.0)
                total = fmt_elapsed(time.monotonic() - t0)
                status.update(label=f"COMPLETE · {total}", state="complete",
                              expanded=False)
                S.set_(ns, "log", lines[-MAX_LOG_LINES:])
                S.set_(ns, "elapsed", total)
                return out, None
            except Exception as ex:  # noqa: BLE001 — surfaced to the user
                status.update(label="FAILED", state="error", expanded=True)
                S.set_(ns, "log", lines[-MAX_LOG_LINES:])
                return None, format_error(ex)
    finally:
        lock.release()
