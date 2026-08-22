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

from core.phases import MAX_LOG_LINES, classify, default_pool_sizes, fmt_elapsed, format_error
from ui import state as S


@st.cache_resource(show_spinner=False)
def _run_lock() -> threading.Lock:
    """Process-wide lock serializing renders.

    The workers write to a fixed shared temp path and unlink it at run start,
    so two concurrent runs corrupt each other inside the worker's own execution
    window — which persist_result() cannot fix from the outside. Serializing is
    the right behavior for a local single-user tool anyway.
    """
    return threading.Lock()


def run_batch_pipeline(ns: str, kind: str, fn, items_kwargs: list[dict]):
    """Execute a batch of pipeline tasks with auto-scaling parallel workers and queuing.

    Calculates max parallel concurrency from system resources. Items exceeding
    concurrency limit are queued and start automatically as slots free up.

    Returns list of (result_tuple, error) matching items_kwargs order.
    """
    import os
    from concurrent.futures import ThreadPoolExecutor

    num_items = len(items_kwargs)
    if num_items == 0:
        return []

    # Auto-scale concurrency pool based on CPU resources and task type
    max_image, max_video = default_pool_sizes()
    max_workers = max_video if kind == "video" else max_image

    # Thread safety for session state & delta emissions
    try:
        from streamlit.runtime.scriptrunner import (
            add_script_run_ctx,
            get_script_run_ctx,
        )
        ctx = get_script_run_ctx()
    except Exception:
        ctx = None

    # Track state for each item in batch
    batch_state = []
    for i, kw in enumerate(items_kwargs):
        name = kw.get("name", f"Item {i+1}")
        batch_state.append({
            "index": i,
            "name": name,
            "status": "QUEUED",  # QUEUED, PROCESSING, COMPLETE, FAILED
            "phase": "QUEUED",
            "progress": 0.0,
            "elapsed": "0:00",
            "lines": [],
            "result": None,
            "error": None,
            "kwargs": kw,
        })

    with st.status(f"PROCESSING BATCH ({num_items} items, max {max_workers} parallel)…", expanded=True, state="running") as status:
        header_el = st.empty()
        overall_meter = st.progress(0.0)
        table_el = st.empty()
        log_pane = st.container(height=180, border=False, key=f"sx-batch-log-{kind}")
        log_body = log_pane.empty()

        lock = threading.Lock()
        t0 = time.monotonic()

        def update_ui():
            with lock:
                done_count = sum(1 for item in batch_state if item["status"] in ("COMPLETE", "FAILED"))
                running_count = sum(1 for item in batch_state if item["status"] == "PROCESSING")
                queued_count = sum(1 for item in batch_state if item["status"] == "QUEUED")
                overall_frac = done_count / num_items

                header_el.markdown(
                    f'<div class="sx-phase">'
                    f'Completed {done_count}/{num_items} · Running {running_count} · Queued {queued_count}'
                    f'</div>',
                    unsafe_allow_html=True,
                )
                overall_meter.progress(overall_frac)

                # Render compact item list
                rows = []
                for item in batch_state:
                    st_color = "#3b82f6" if item["status"] == "PROCESSING" else ("#22c55e" if item["status"] == "COMPLETE" else ("#ef4444" if item["status"] == "FAILED" else "#888888"))
                    rows.append(
                        f"<tr>"
                        f"<td style='padding:4px 8px;font-weight:600;'>{html.escape(item['name'])}</td>"
                        f"<td style='padding:4px 8px;'><span style='color:{st_color};font-weight:700;'>● {item['status']}</span></td>"
                        f"<td style='padding:4px 8px;'>{html.escape(item['phase'])}</td>"
                        f"<td style='padding:4px 8px;'>{item['elapsed']}</td>"
                        f"</tr>"
                    )
                table_el.markdown(
                    f"<table style='width:100%;font-size:0.85rem;border-collapse:collapse;margin:8px 0;'>"
                    f"<thead><tr style='text-align:left;border-bottom:1px solid rgba(255,255,255,0.1);'>"
                    f"<th>ITEM</th><th>STATUS</th><th>PHASE</th><th>ELAPSED</th></tr></thead>"
                    f"<tbody>{''.join(rows)}</tbody></table>",
                    unsafe_allow_html=True,
                )

                # Active log stream (tail of all items)
                all_logs = []
                for item in batch_state:
                    if item["lines"]:
                        all_logs.append(f"[{item['name']}] {item['lines'][-1]}")
                log_body.markdown(
                    '<div class="sx-log">'
                    + "<br>".join(html.escape(x) for x in all_logs[-MAX_LOG_LINES:])
                    + "</div>",
                    unsafe_allow_html=True,
                )

        def process_item(item):
            if ctx is not None:
                try:
                    add_script_run_ctx(threading.current_thread(), ctx)
                except Exception:
                    pass
            item_t0 = time.monotonic()
            with lock:
                item["status"] = "PROCESSING"
                item["phase"] = "STARTING"
            update_ui()

            highest_w = [0.0]

            def item_cb(msg: str):
                lbl, weight = classify(msg)
                elapsed_s = time.monotonic() - item_t0
                highest_w[0] = max(highest_w[0], weight)
                with lock:
                    item["phase"] = lbl
                    item["progress"] = highest_w[0]
                    item["elapsed"] = fmt_elapsed(elapsed_s)
                    item["lines"].append(f"{int(elapsed_s):>5}s  {msg}")
                update_ui()

            kwargs = item["kwargs"].copy()
            kwargs.pop("name", None)

            try:
                res = fn(status_callback=item_cb, **kwargs)
                with lock:
                    item["status"] = "COMPLETE"
                    item["phase"] = "COMPLETE"
                    item["progress"] = 1.0
                    item["result"] = res
            except Exception as ex:
                with lock:
                    item["status"] = "FAILED"
                    item["phase"] = "FAILED"
                    item["error"] = format_error(ex)
            update_ui()

        # Submit tasks to pool
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [executor.submit(process_item, item) for item in batch_state]

            # Heartbeat while tasks complete
            all_done = False
            while not all_done:
                time.sleep(0.5)
                with lock:
                    all_done = all(item["status"] in ("COMPLETE", "FAILED") for item in batch_state)
                    # Update elapsed timers for running items
                    for item in batch_state:
                        if item["status"] == "PROCESSING":
                            item["elapsed"] = fmt_elapsed(time.monotonic() - t0)
                update_ui()

        total_elapsed = fmt_elapsed(time.monotonic() - t0)
        failures = [i for i in batch_state if i["status"] == "FAILED"]
        if failures and len(failures) == num_items:
            status.update(label=f"BATCH FAILED · {total_elapsed}", state="error", expanded=True)
        elif failures:
            status.update(label=f"BATCH FINISHED WITH {len(failures)} ERROR(S) · {total_elapsed}", state="error", expanded=True)
        else:
            status.update(label=f"ALL {num_items} ITEMS COMPLETE · {total_elapsed}", state="complete", expanded=False)

        results = []
        for item in batch_state:
            results.append((item["result"], item["error"]))

        S.set_(ns, "batch_progress", batch_state)
        S.set_(ns, "elapsed", total_elapsed)
        return results


def run_pipeline(ns: str, kind: str, fn, kwargs: dict):
    """Execute a single pipeline worker, streaming progress into st.status.

    Returns (result_tuple, error) — exactly one is None.
    """
    batch_res = run_batch_pipeline(ns, kind, fn, [kwargs])
    if batch_res and len(batch_res) > 0:
        return batch_res[0]
    return None, ("PIPELINE ERROR", "Execution failed to start")

