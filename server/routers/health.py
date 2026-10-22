"""Health router — system probe results as JSON.

Uses the shared probe logic from `core.probes`/`core.tooling` (single source
of truth with the Streamlit fallback) but returns structured JSON instead of
Streamlit widgets.
"""

import os
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from core import probes as _probes
from core import tooling as _tooling
from server.settings import env_int, is_production
from server.social.auth import AuthContext, require_admin
from server.social.database import EXPECTED_SCHEMA_REVISION, get_db

router = APIRouter(tags=["health"])

# Cache probes in-process (same idea as st.cache_resource) but with a TTL.
# Probes spawn ffmpeg smoke-tests (up to seconds each), so re-probing on every
# 8s frontend poll would hammer the machine. The frontend polls the cheap
# cached snapshot; only ?refresh=true (RECHECK button) or TTL expiry rebuilds.
_CACHE_TTL_S = 60.0
_cached_probes: dict | None = None
_cached_at: float = 0.0
_cache_lock = threading.Lock()
_rebuild_lock = threading.Lock()
# system_memory() may spawn nvidia-smi (10 s timeout); keep it off the
# per-request path for the 8s poller.
_SYSTEM_TTL_S = 10.0
_cached_system: dict | None = None
_system_at: float = 0.0


def _probe_to_dict(p) -> dict:
    return {
        "id": p.id,
        "label": p.label,
        "ok": p.ok,
        "severity": p.severity,
        "detail": p.detail,
        "fix": p.fix,
    }


def _system_snapshot() -> dict:
    global _cached_system, _system_at
    now = time.time()
    with _cache_lock:
        if _cached_system is None or (now - _system_at) > _SYSTEM_TTL_S:
            _cached_system = _probes.system_memory()
            _system_at = now
        return _cached_system


def _is_admin(request: Request, db: Session) -> bool:
    from server.social.auth import get_optional_auth

    context = get_optional_auth(request, db)
    return context is not None and context.user.role == "admin"


@router.get("/api/health")
def get_health(request: Request, refresh: bool = False, db: Session = Depends(get_db)):
    """Return system probe results.

    Cached snapshot is served for up to ``_CACHE_TTL_S`` so the 8s frontend
    poller stays cheap. ?refresh=true (sidebar RECHECK) forces a re-probe for
    admins only; everyone else silently gets the cached snapshot, since a
    re-probe spawns several ffmpeg smoke-tests.
    """
    global _cached_probes, _cached_at

    # The session is only used (and a connection only checked out) when a
    # refresh is requested and a session cookie is present.
    if refresh and not _is_admin(request, db):
        refresh = False

    now = time.time()
    from_cache = True
    expired = _cached_probes is None or (now - _cached_at) > _CACHE_TTL_S
    # One rebuild at a time. While it runs, other pollers get the previous
    # snapshot instead of parking a threadpool thread behind the ffmpeg
    # smoke-tests; only the very first build and an admin refresh wait.
    if (refresh or expired) and _rebuild_lock.acquire(blocking=refresh or _cached_probes is None):
        try:
            _tooling.ensure_ffmpeg_on_path()
            # Build probes without Streamlit dependency
            probes = _probes.build_probes()
            with _cache_lock:
                _cached_probes = {k: _probe_to_dict(v) for k, v in probes.items()}
                _cached_at = time.time()
            from_cache = False
        finally:
            _rebuild_lock.release()

    fal = _probe_to_dict(_probes.fal_key_probe())
    if is_production():
        # Never echo any part of the platform key from a public endpoint.
        fal["detail"] = "set" if fal["ok"] else "not set"

    return {
        "probes": _cached_probes,
        "fal_key": fal,
        "from_cache": from_cache,
        "refreshed_at": _cached_at,
        # Informational only, never part of the ENG ok-count.
        "system": _system_snapshot(),
    }


@router.get("/api/healthz")
async def healthz():
    """Liveness: the process is up and serving. No I/O.

    async on purpose: a sync handler waits for a threadpool slot behind the
    sync feed/DB handlers, which pushed the Docker HEALTHCHECK past its
    timeout under load. On the event loop it answers in milliseconds.
    """
    return {"ok": True}


def disk_status() -> list[dict]:
    """Free space on the volumes the app writes to (output/ and the job tempdir)."""
    minimum_gb = env_int("SX_DISK_MIN_FREE_GB", 5, minimum=0)
    out = []
    for label, path in (("output", Path("output")), ("tmp", Path(tempfile.gettempdir()))):
        try:
            free_gb = shutil.disk_usage(path).free / (1024 ** 3)
        except OSError:
            out.append({"volume": label, "ok": False, "free_gb": None})
            continue
        out.append({"volume": label, "ok": free_gb >= minimum_gb, "free_gb": round(free_gb, 1)})
    return out


def _output_writable() -> bool:
    probe = Path("output") / f".readyz-{uuid.uuid4().hex}"
    try:
        probe.parent.mkdir(parents=True, exist_ok=True)
        probe.write_bytes(b"ok")
        probe.unlink()
        return True
    except OSError:
        return False


@router.get("/api/readyz")
def readyz(db: Session = Depends(get_db)):
    """Readiness: database reachable at the expected schema, storage usable."""
    checks: dict[str, dict] = {}
    try:
        db.execute(text("SELECT 1"))
        installed = {row[0] for row in db.execute(text("SELECT version_num FROM alembic_version"))}
        checks["database"] = {"ok": True}
        checks["schema"] = {"ok": EXPECTED_SCHEMA_REVISION in installed, "expected": EXPECTED_SCHEMA_REVISION}
    except Exception as exc:
        checks["database"] = {"ok": False, "error": type(exc).__name__}
        checks["schema"] = {"ok": False, "expected": EXPECTED_SCHEMA_REVISION}
    finally:
        db.rollback()
    checks["output_writable"] = {"ok": _output_writable()}
    disks = disk_status()
    checks["disk"] = {"ok": all(d["ok"] for d in disks), "volumes": disks}
    ok = all(c["ok"] for c in checks.values())
    return JSONResponse({"ok": ok, "checks": checks}, status_code=200 if ok else 503)


@router.get("/api/ops/metrics")
def ops_metrics(response: Response, context: AuthContext = Depends(require_admin)):
    """Admin-only operations snapshot: request window, events, job queue, DB pool, SSE, disk."""
    del context
    from server import metrics

    response.headers["Cache-Control"] = "no-store"
    return metrics.snapshot()
