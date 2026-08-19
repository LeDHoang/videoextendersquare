"""Square Extender 4K — FastAPI application factory.

Serves:
  /api/*        — REST + SSE endpoints (image/video pipelines, reels, compare)
  /media/*      — static files from output/ (Range-capable; replaces the old
                  mediaserver.py on port 8502)
  /*            — built React app (production); nothing if web/dist is absent
"""

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


@asynccontextmanager
async def lifespan(app: FastAPI):
    from ui.health import ensure_ffmpeg_on_path

    # Must run before pipeline modules are imported by routers.
    ensure_ffmpeg_on_path()
    yield


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