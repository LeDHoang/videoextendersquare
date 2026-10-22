"""In-process operational metrics and the alert watchdog.

Single worker, so process-local counters are the whole picture (same verdict
as the SSE stream counter in server/routers/messages.py). Nothing here is
persisted: a restart starts a fresh window.

- record_request() is fed by the access log (server/observability.py): one
  sample per request with its route template, status and duration_ms.
- incr() counts named events (job failures, full queues, derived-encode
  failures, recommendation attribution failures, reel data 503s).
- snapshot() adds live gauges (job queue, DB pool, SSE streams, disk) and is
  served to admins at GET /api/ops/metrics.
- check_alerts() runs every SX_ALERT_INTERVAL_S from the app lifespan and
  logs one error per alert per SX_ALERT_COOLDOWN_S. With SENTRY_DSN set,
  error logs become Sentry events, which is how alerts reach a person.
"""

from __future__ import annotations

import logging
import math
import os
import threading
import time
from collections import Counter, deque

from server.settings import env_int

logger = logging.getLogger("sx.alerts")

WINDOW_S = 300
# Below this many requests in the window, rates and percentiles are noise.
MIN_REQUESTS_FOR_ALERT = 20

_lock = threading.Lock()
_started = time.time()
_requests: deque[tuple[float, str, int, float]] = deque(maxlen=50_000)
_events: dict[str, deque[float]] = {}
_totals: Counter[str] = Counter()
_last_alert: dict[str, float] = {}


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def record_request(route: str, status: int, duration_ms: float) -> None:
    now = time.time()
    with _lock:
        _requests.append((now, route, int(status), float(duration_ms)))
        _totals["requests"] += 1
        if status >= 500:
            _totals["errors_5xx"] += 1


def incr(name: str) -> None:
    now = time.time()
    with _lock:
        _events.setdefault(name, deque(maxlen=10_000)).append(now)
        _totals[name] += 1


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(fraction * len(ordered)) - 1)
    return round(ordered[index], 1)


def _status_class(status: int) -> str:
    return "429" if status == 429 else f"{status // 100}xx"


def request_window(now: float | None = None) -> dict:
    """Request counts, status classes and latency over the last WINDOW_S, plus the slowest routes."""
    cutoff = (now or time.time()) - WINDOW_S
    with _lock:
        samples = [sample for sample in _requests if sample[0] >= cutoff]
    durations = [sample[3] for sample in samples]
    errors = sum(1 for sample in samples if sample[2] >= 500)
    by_route: dict[str, list[tuple[int, float]]] = {}
    for _ts, route, status, duration in samples:
        by_route.setdefault(route, []).append((status, duration))
    routes = [
        {
            "route": route,
            "count": len(rows),
            "errors_5xx": sum(1 for status, _ in rows if status >= 500),
            "rate_limited": sum(1 for status, _ in rows if status == 429),
            "p95_ms": _percentile([duration for _, duration in rows], 0.95),
        }
        for route, rows in by_route.items()
    ]
    routes.sort(key=lambda row: (row["errors_5xx"], row["p95_ms"] or 0), reverse=True)
    return {
        "count": len(samples),
        "errors_5xx": errors,
        "error_rate": round(errors / len(samples), 4) if samples else 0.0,
        "p50_ms": _percentile(durations, 0.50),
        "p95_ms": _percentile(durations, 0.95),
        "status": dict(Counter(_status_class(sample[2]) for sample in samples)),
        "routes": routes[:10],
    }


def event_window(now: float | None = None) -> dict[str, int]:
    cutoff = (now or time.time()) - WINDOW_S
    with _lock:
        return {name: sum(1 for ts in stamps if ts >= cutoff) for name, stamps in _events.items()}


def _pool_gauges() -> dict:
    from server.social.database import engine

    pool = engine.pool
    gauges = {"class": type(pool).__name__}
    for name in ("size", "checkedout", "overflow"):
        method = getattr(pool, name, None)
        if callable(method):
            gauges[name] = method()
    max_overflow = getattr(pool, "_max_overflow", None)
    if isinstance(max_overflow, int) and "size" in gauges:
        # max_overflow < 0 means unbounded.
        gauges["capacity"] = gauges["size"] + max_overflow if max_overflow >= 0 else None
    return gauges


def _sse_gauges() -> dict:
    from server.routers import messages

    return {"open_streams": sum(messages._SSE_STREAMS.values())}


def snapshot() -> dict:
    from server.jobs import job_manager
    from server.routers.health import disk_status

    return {
        "window_s": WINDOW_S,
        "uptime_s": round(time.time() - _started),
        "requests": request_window(),
        "events": event_window(),
        "totals": dict(_totals),
        "jobs": job_manager.queue_depth(),
        "db_pool": _pool_gauges(),
        "sse": _sse_gauges(),
        "disk": disk_status(),
    }


def _registration_and_report_spikes() -> dict[str, str]:
    """Reports and sign-ups in the last hour against the hour before (moderation-stats spike rule)."""
    from datetime import timedelta

    from sqlalchemy import func

    from server.routers.account_safety import _windowed
    from server.social.database import SessionLocal
    from server.social.models import Report, User, utcnow

    floor = env_int("SX_MOD_SPIKE_MIN", 10, minimum=1)
    now = utcnow()
    spikes = {}
    with SessionLocal() as db:
        for label, column in (("reports", Report.created_at), ("registrations", User.created_at)):
            def count(start, end, column=column):
                return db.query(func.count()).select_from(column.class_).filter(column > start, column <= end).scalar()

            window = _windowed(count, now, timedelta(hours=1), floor)
            if window["spike"]:
                spikes[f"{label}_spike"] = (
                    f"{label} spike: {window['current']} in the last hour (previous hour {window['previous']})"
                )
    return spikes


def evaluate_alerts(snap: dict) -> dict[str, str]:
    """Alert key -> message for every threshold the snapshot crosses."""
    alerts: dict[str, str] = {}
    requests = snap["requests"]
    if requests["count"] >= MIN_REQUESTS_FOR_ALERT:
        max_rate = env_float("SX_ALERT_5XX_RATE", 0.05)
        if requests["error_rate"] >= max_rate:
            alerts["5xx_rate"] = (
                f"5xx rate {requests['error_rate']:.1%} over the last {WINDOW_S // 60} min "
                f"({requests['errors_5xx']} of {requests['count']} requests)"
            )
        max_p95 = env_int("SX_ALERT_P95_MS", 2000, minimum=1)
        if (requests["p95_ms"] or 0) >= max_p95:
            alerts["p95"] = f"p95 latency {requests['p95_ms']} ms over the last {WINDOW_S // 60} min (limit {max_p95} ms)"
    jobs = snap["jobs"]
    if jobs["active"] >= jobs["capacity"]:
        alerts["queue_full"] = f"Processing queue full: {jobs['active']} of {jobs['capacity']} job slots in use"
    pool = snap["db_pool"]
    if pool.get("capacity") and pool.get("checkedout", 0) >= pool["capacity"]:
        alerts["db_pool"] = f"DB pool exhausted: {pool['checkedout']} of {pool['capacity']} connections checked out"
    failures = snap["events"].get("job_failed", 0) + snap["events"].get("derived_failed", 0)
    max_failures = env_int("SX_ALERT_FAILURES", 3, minimum=1)
    if failures >= max_failures:
        alerts["processing_failures"] = f"{failures} processing failures in the last {WINDOW_S // 60} min"
    return alerts


def check_alerts() -> list[str]:
    """Log each crossed threshold once per cool-down; returns the keys logged."""
    alerts = evaluate_alerts(snapshot())
    try:
        alerts.update(_registration_and_report_spikes())
    except Exception:
        logger.exception("Could not compute report/registration spikes")
    cooldown = env_int("SX_ALERT_COOLDOWN_S", 900, minimum=0)
    now = time.time()
    logged = []
    for key, message in alerts.items():
        if now - _last_alert.get(key, -math.inf) < cooldown:
            continue
        _last_alert[key] = now
        logger.error("ALERT %s: %s", key, message, extra={"alert": key})
        logged.append(key)
    return logged


def reset_for_tests() -> None:
    with _lock:
        _requests.clear()
        _events.clear()
        _totals.clear()
        _last_alert.clear()
