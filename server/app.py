"""Square Extender 4K — FastAPI application factory.

Serves:
  /api/*        — REST + SSE endpoints (image/video pipelines, reels, compare)
  /media/*      — static files from output/ (Range-capable; replaces the old
                  mediaserver.py on port 8502). Dev only: in production
                  (SX_ENV=production) published media is served from R2.
  /*            — built React app (production); nothing if web/dist is absent
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Only the Streamlit entrypoint (app.py) called this before; the FastAPI
# stack never did, so FAL_KEY in .env was invisible to `uvicorn server.app:app`
# unless it was also exported in the shell. The platform key is no longer
# mutable through a public API.
# override=False so a stray .env baked into the image can never beat
# production secrets passed via the environment (docker -e / secret manager).
load_dotenv(override=False)

from server.observability import RequestIDMiddleware, configure_logging, current_request_id  # noqa: E402
from server.settings import env_int, is_production, production_config_errors  # noqa: E402

logger = logging.getLogger("server.app")
_CLEANUP_INTERVAL_S = 15 * 60


_SCRUBBED_HEADERS = {"cookie", "authorization", "x-csrf-token", "set-cookie"}


def _sentry_before_send(event, hint):
    request_id = current_request_id()
    if request_id:
        tags = event.get("tags")
        if isinstance(tags, dict):
            tags["request_id"] = request_id
        else:
            event["tags"] = {"request_id": request_id}
    request = event.get("request") or {}
    request.pop("cookies", None)
    headers = request.get("headers")
    if isinstance(headers, dict):
        for name in list(headers):
            if name.lower() in _SCRUBBED_HEADERS:
                headers[name] = "[filtered]"
    return event


def _init_sentry() -> None:
    """Error tracking, active only when SENTRY_DSN is set (backend only, no PII)."""
    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        return
    import sentry_sdk

    sentry_sdk.init(
        dsn=dsn,
        environment=os.environ.get("SX_ENV", "development"),
        release=os.environ.get("GIT_SHA") or None,
        send_default_pii=False,
        traces_sample_rate=0,
        max_request_body_size="never",
        before_send=_sentry_before_send,
    )


def _check_disk() -> None:
    from server.routers.health import disk_status

    for volume in disk_status():
        if not volume["ok"]:
            logger.error("Low disk space on %s: %s GB free", volume["volume"], volume["free_gb"])


async def _cleanup_loop():
    """Periodically reclaim finished job records and expired staged uploads."""
    from server.billing.runtime import reap_stale_reservations, reconcile_pending_requests
    from server.jobs import job_manager
    from server.routers import image, messages, video

    while True:
        await asyncio.sleep(_CLEANUP_INTERVAL_S)
        # Each step is isolated so one failure cannot skip the rest; failures
        # are logged (and reach Sentry) but never crash the loop.
        for step in (
            job_manager.cleanup_old,
            job_manager.sweep_orphan_dirs,
            image.cleanup_stale_uploads,
            video.cleanup_stale_uploads,
            messages.cleanup_message_events,
            reconcile_pending_requests,
            reap_stale_reservations,
            _backfill_media_info,
            _check_disk,
        ):
            try:
                await asyncio.to_thread(step)
            except Exception:
                logger.exception("Cleanup step %s failed", getattr(step, "__name__", step))


def _alert_interval_s() -> int:
    return env_int("SX_ALERT_INTERVAL_S", 60, minimum=5)


async def _alert_loop():
    """Check the alert thresholds in server/metrics.py; crossings are error logs (Sentry)."""
    from server import metrics

    while True:
        await asyncio.sleep(_alert_interval_s())
        try:
            await asyncio.to_thread(metrics.check_alerts)
        except Exception:
            logger.exception("Alert check failed")


def _backfill_media_info() -> None:
    """Fill reel duration/size for posts that predate the probe (see services.backfill_media_info)."""
    if os.environ.get("SX_MEDIA_BACKFILL", "1").strip().lower() in {"0", "false", "no", "off"}:
        return
    from server.social.services import backfill_media_info

    count = backfill_media_info()
    if count:
        logger.info("Backfilled duration/size for %d posts", count)


def _requeue_derived_assets() -> None:
    """Queue the derived encodes a restart lost (see uploads.requeue_missing_derived)."""
    from server.routers.uploads import requeue_missing_derived

    try:
        count = requeue_missing_derived()
    except Exception:
        logger.exception("Could not re-queue missing derived assets")
        return
    logger.info("Re-queued derived assets for %d posts at boot", count)


def _shutdown_drain_s() -> int:
    return env_int("SX_SHUTDOWN_DRAIN_S", 15, minimum=0)


async def _drain_workers() -> None:
    """Shutdown: cancel queued jobs/encodes, give running ones SX_SHUTDOWN_DRAIN_S."""
    from server.jobs import job_manager
    from server.routers.uploads import shutdown_derived_pool

    drain_s = _shutdown_drain_s()
    jobs, derived = await asyncio.gather(
        asyncio.to_thread(job_manager.shutdown, drain_s),
        asyncio.to_thread(shutdown_derived_pool, drain_s),
        return_exceptions=True,
    )
    for name, result in (("jobs", jobs), ("derived encodes", derived)):
        if isinstance(result, BaseException):
            logger.error("Draining %s failed", name, exc_info=result)
        else:
            logger.info("Drained %s: %s", name, result)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from core.tooling import ensure_ffmpeg_on_path, pick_encoder
    from server.social import init_database
    from server.social.legacy import import_legacy_social

    errors = production_config_errors()
    if errors:
        raise RuntimeError("Production configuration is unsafe:\n- " + "\n- ".join(errors))

    init_database()
    from server.social.turnstile import log_turnstile_status
    log_turnstile_status()
    if not is_production():
        # Dev convenience only: turns loose files in output/ into posts.
        await asyncio.to_thread(import_legacy_social)
    from server.billing.runtime import reap_stale_reservations, reconcile_pending_requests
    await asyncio.to_thread(reconcile_pending_requests)
    await asyncio.to_thread(reap_stale_reservations)
    try:
        from server.billing.service import require_billing_secrets
        require_billing_secrets()
    except Exception as exc:
        # Option B fail-closed: billing routes 503 on their own; the rest of
        # the app (free local processing, reels) keeps running. Loud so a
        # misconfigured deploy cannot sit half-broken unnoticed.
        logger.error("Billing secrets misconfigured; paid endpoints will refuse work: %s", exc)

    # Must run before pipeline modules are imported by routers.
    ensure_ffmpeg_on_path()

    # Pre-warm the HEVC encoder probe at startup rather than inside the first
    # job — it spawns up to 4 ffmpeg smoke-tests, and jobs can now run
    # concurrently (see server/jobs.py), so doing this lazily would mean the
    # first few concurrent jobs all block on the same probe lock.
    try:
        pick_encoder()
    except Exception:
        pass  # health checks / job errors surface this properly later

    # Single worker: no encode is running yet, so any .part file is a leftover
    # of a background publish encode the last process died in.
    from server.media import sweep_part_files
    try:
        swept = sweep_part_files()
        if swept:
            logger.info("Removed %d stale .part files from output/uploads", swept)
    except OSError:
        logger.exception("Could not sweep stale .part files")

    # A previous lifespan in this process (tests) may have drained the pools.
    from server.jobs import job_manager
    from server.routers.uploads import start_derived_pool
    job_manager.start()
    start_derived_pool()

    cleanup_task = asyncio.create_task(_cleanup_loop())
    alert_task = asyncio.create_task(_alert_loop())
    # Off the startup path: probing a large library can take a while.
    backfill_task = asyncio.create_task(asyncio.to_thread(_backfill_media_info))
    # Also off the startup path (and readyz): only file checks, the encodes
    # run on the derived-asset worker.
    requeue_task = asyncio.create_task(asyncio.to_thread(_requeue_derived_assets))
    try:
        yield
    finally:
        cleanup_task.cancel()
        alert_task.cancel()
        backfill_task.cancel()
        requeue_task.cancel()
        await _drain_workers()


def mount_spa(app: FastAPI, static_dir: Path) -> None:
    """Serve the built React app from *static_dir*, if it exists.

    HTML documents are read once and get the request's CSP nonce stamped on
    their <script> tags per request (server/security_headers.py).
    """
    if not static_dir.is_dir():
        return
    static_dir = static_dir.resolve()
    from fastapi.responses import HTMLResponse

    from server.security_headers import nonce_request_html

    app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="web-assets")
    html_cache: dict[Path, str] = {}

    def html_document(request: Request, file: Path) -> HTMLResponse:
        if file not in html_cache:
            html_cache[file] = file.read_text(encoding="utf-8")
        # Per-request nonce: never let a shared cache replay a stale one.
        return HTMLResponse(nonce_request_html(request, html_cache[file]), headers={"Cache-Control": "no-cache"})

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str, request: Request):
        # Unknown API or media paths are real 404s, not the SPA shell
        # (in production /media is unmounted and must not look like 200).
        if full_path.startswith(("api/", "media/")):
            raise HTTPException(status_code=404)
        file = (static_dir / full_path).resolve()
        if full_path and file.is_file() and file.is_relative_to(static_dir):
            if file.suffix.casefold() == ".html":
                return html_document(request, file)
            return FileResponse(str(file))
        return html_document(request, static_dir / "index.html")


def create_app() -> FastAPI:
    configure_logging()
    _init_sentry()
    app = FastAPI(title="Square Extender 4K", version="2.0", lifespan=lifespan)

    # CORS for the Vite dev server (port 5173). Credentials are on, so keep
    # the surface tight: only the methods/headers the frontend actually sends
    # (CSRF protection in server/social/auth.py is the real defense).
    dev_origins = os.environ.get("SX_DEV_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in dev_origins.split(",") if o.strip()],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-CSRF-Token"],
        expose_headers=["X-Request-ID"],
    )
    # Security headers + CSP (+ POST /api/csp-report). Wraps CORS; the
    # request-ID middleware is added after this so it stays outermost.
    from server.security_headers import install_security_headers

    install_security_headers(app)
    # Added last, so it is the outermost middleware: CORS preflights and
    # errors get an ID too (security headers sit inside it).
    app.add_middleware(RequestIDMiddleware)

    from server.routers import account_safety, admin, billing, compare, config, health, image, map_tiles, messages, model_info, packs, reels, rewards, social, support, uploads, video

    production = is_production()
    modules = [health, config, model_info, billing, image, video, account_safety, admin, social, packs, messages, reels, map_tiles, rewards, uploads, support]
    if not production:
        # Compare reads output/pairs through /media; neither exists in production.
        modules.append(compare)
    for module in modules:
        app.include_router(module.router)

    output_dir = Path("output").resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    if not production:
        # Static media serving (replaces mediaserver.py port 8502).
        # Starlette's StaticFiles supports HTTP Range requests, so video seeking
        # inside the Reels/Compare iframes works. Never in production: output/
        # holds unpublished uploads, logs and test folders. Published media is
        # served from R2 (SX_MEDIA_BASE_URL) there.
        app.mount("/media", StaticFiles(directory=output_dir), name="media")

    avatar_dir = Path("data/avatars").resolve()
    avatar_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/avatars", StaticFiles(directory=avatar_dir), name="avatars")

    # Built React app (production). Mounted last so /api and /media win.
    mount_spa(app, Path(__file__).resolve().parent / "static")

    return app


app = create_app()
