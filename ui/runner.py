"""Pipeline execution wrapped in st.status.

Replaces the old st.empty() + .info() pattern, where every callback overwrote
the previous one — a 4-minute video run ended with a single line and no history.

The pipeline fn runs in a background thread so the main thread can tick the
elapsed-time counter every second. The heartbeat loop ONLY updates a timer
child element — it never calls status.update(), which re-renders the status
component and collapses a user-expanded dropdown on every tick.
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

    The worker runs in a background thread. The main thread ticks the
    elapsed-time counter every second via a child st.empty() element —
    never via status.update(), which would collapse a user-opened dropdown.

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
            # phase label — updated by cb() on each pipeline callback
            head = st.empty()
            # live elapsed clock — updated by heartbeat; a child element so
            # the heartbeat never touches status.update() itself
            timer_el = st.empty()
            meter = st.progress(0.0)
            pane = st.container(height=220, border=False, key=f"sx-log-{kind}")
            body = pane.empty()

            t0 = time.monotonic()
            highest = [0.0]
            current_label = ["WORKING"]

            def cb(msg: str) -> None:
                label, weight = classify(msg)
                elapsed = time.monotonic() - t0
                current_label[0] = label
                highest[0] = max(highest[0], weight)  # never rewind
                # Update phase label and progress in the body; do NOT call
                # status.update() here either — it re-renders the header and
                # may collapse the dropdown on every phase transition.
                head.markdown(
                    f'<div class="sx-phase">{html.escape(label)}</div>',
                    unsafe_allow_html=True,
                )
                meter.progress(highest[0])
                lines.append(f"{int(elapsed):>5}s  {msg}")
                # Fal log messages are third-party strings going into
                # unsafe_allow_html — escape every one.
                body.markdown(
                    '<div class="sx-log">'
                    + "<br>".join(html.escape(x) for x in lines[-MAX_LOG_LINES:])
                    + "</div>",
                    unsafe_allow_html=True,
                )

            result_holder: list = [None]
            error_holder: list = [None]
            done = threading.Event()

            # Share the Streamlit script context so cb() can call element
            # methods (meter.progress, body.markdown, etc.) from the worker
            # thread — they emit to the same delta queue as the main thread.
            try:
                from streamlit.runtime.scriptrunner import (
                    add_script_run_ctx,
                    get_script_run_ctx,
                )
                _ctx = get_script_run_ctx()
            except Exception:
                _ctx = None

            def _worker():
                try:
                    result_holder[0] = fn(status_callback=cb, **kwargs)
                except Exception as ex:  # noqa: BLE001
                    error_holder[0] = ex
                finally:
                    done.set()

            worker = threading.Thread(target=_worker, daemon=True)
            if _ctx is not None:
                add_script_run_ctx(worker, _ctx)
            worker.start()

            # Heartbeat: tick the elapsed clock every second. Updating
            # timer_el is a targeted child-element delta — it does NOT
            # re-render or collapse the parent st.status component.
            while not done.wait(timeout=1.0):
                elapsed = time.monotonic() - t0
                timer_el.markdown(
                    f'<span class="sx-eyebrow" style="color:var(--sx-ink-2)">'
                    f'&#9201; {fmt_elapsed(elapsed)}</span>',
                    unsafe_allow_html=True,
                )

            # Worker has finished — clear the timer and render final state
            timer_el.empty()
            if error_holder[0] is not None:
                status.update(label="FAILED", state="error", expanded=True)
                S.set_(ns, "log", lines[-MAX_LOG_LINES:])
                return None, format_error(error_holder[0])

            meter.progress(1.0)
            total = fmt_elapsed(time.monotonic() - t0)
            status.update(label=f"COMPLETE · {total}", state="complete",
                          expanded=False)
            S.set_(ns, "log", lines[-MAX_LOG_LINES:])
            S.set_(ns, "elapsed", total)
            return result_holder[0], None
    finally:
        lock.release()
