"""Square Extender 4K — FastAPI application factory.

Serves:
  /api/*        — REST + SSE endpoints (image/video pipelines, reels, compare)
  /media/*      — static files from output/ (Range-capable; replaces the old
                  mediaserver.py on port 8502)
  /*            — built React app (production); nothing if web/dist is absent
"""

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Only the Streamlit entrypoint (app.py) called this before; the FastAPI
# stack never did, so FAL_KEY in .env was invisible to `uvicorn server.app:app`
# unless it was also exported in the shell or set via the (unauthenticated)
# /api/config/fal-key endpoint.
load_dotenv()

_CLEANUP_INTERVAL_S = 15 * 60


async def _cleanup_loop():
    """Periodically reclaim finished job records and expired staged uploads."""
    from server.jobs import job_manager
    from server.routers import image, video

    while True:
        await asyncio.sleep(_CLEANUP_INTERVAL_S)
        try:
            job_manager.cleanup_old()
            image.cleanup_stale_uploads()
            video.cleanup_stale_uploads()
        except Exception:
            pass  # best-effort housekeeping must never crash the loop


@asynccontextmanager
async def lifespan(app: FastAPI):
    from core.tooling import ensure_ffmpeg_on_path, pick_encoder

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

    cleanup_task = asyncio.create_task(_cleanup_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()


def create_app() -> FastAPI:
    app = FastAPI(title="Square Extender 4K", version="2.0", lifespan=lifespan)

    # CORS for the Vite dev server (port 5173)
    dev_origins = os.environ.get("SX_DEV_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in dev_origins.split(",") if o.strip()],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["*"],
    )

    from server.routers import compare, config, health, image, reels, video

    for module in (health, config, image, video, reels, compare):
        app.include_router(module.router)

    # Static media serving (replaces mediaserver.py port 8502).
    # Starlette's StaticFiles supports HTTP Range requests, so video seeking
    # inside the Reels/Compare iframes works.
    output_dir = Path("output").resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/media", StaticFiles(directory=output_dir), name="media")

    # Built React app (production). Mounted last so /api and /media win.
    static_dir = Path(__file__).resolve().parent / "static"
    if static_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="web-assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str):
            file = (static_dir / full_path).resolve()
            if full_path and file.is_file() and file.is_relative_to(static_dir):
                return FileResponse(str(file))
            return FileResponse(static_dir / "index.html")

    return app


app = create_app()