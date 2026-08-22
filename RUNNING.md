# Running Square Extender 4K

Two stacks live side by side:

| Stack | Entry | Port | Status |
|---|---|---|---|
| **New (FastAPI + React)** | `make dev` / `make start` | 8000 | primary |
| **Legacy (Streamlit)** | `make streamlit` | 8501 | fallback, `app.py` untouched |

The FastAPI server serves everything from one process: `/api/*` (REST + SSE job
streams), `/media/*` (output files, Range-capable — replaces the old
`mediaserver.py` on 8502), and the built React app.

---

## Quick start (new stack)

Dev mode runs the API and the Vite dev server together:

```bash
make install   # backend (venv) + frontend (npm) dependencies
make dev       # uvicorn :8000  +  vite :5173
```

Then open http://localhost:5173 — the Vite server proxies `/api` and `/media`
to the backend, so everything works with no extra config.

Manual alternative:

```bash
source .venv/bin/activate
uvicorn server.app:app --reload --port 8000
cd web && npm run dev
```

Production-style single server:

```bash
make build     # web/dist -> server/static
make start     # uvicorn serves API + static on :8000
```

Open http://localhost:8000.

## Streamlit fallback

```bash
make streamlit        # streamlit run app.py on :8501
```

Kept working indefinitely — `app.py` is untouched by the new stack.

## Docker

```bash
docker build -t square-extender .
docker run -p 8000:8000 -v "$(pwd)/output:/app/output" -e FAL_KEY=... square-extender
```

Single container serves the API, the static React app, and `/media/*` on port
8000. No VapourSynth/znedi3 inside the container, so the STUDIO engine is
auto-disabled (FAST and FAL AI work). Mount `output/` to keep renders.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `FAL_KEY` | fal.ai API key (also settable in the sidebar) | — |
| `SX_DEV_ORIGINS` | CORS allow-list for the Vite dev server | `http://localhost:5173,http://127.0.0.1:5173` |
| `FFMPEG_DIR` / `SX_FFMPEG_DIR` | Directory containing `ffmpeg`/`ffprobe` if not on PATH | PATH lookup |
| `SX_MEDIA_PORT` | Legacy mediaserver port (unused by new stack) | 8502 |
| `SX_LIBX264` | `0` disables libx264 proxies (forces HEVC masters) | `1` |
| `SX_DEBUG` | Streamlit sidebar debug output | off |

## Meta Quest 3 / VR

The Reels player is a WebXR page. Because all media URLs are same-origin
relative paths, it works in the Quest browser over plain HTTP on your LAN, or
through an HTTPS tunnel:

1. Run the server (dev or start) on the machine hosting `output/`.
2. On the Quest browser, open `http://<your-LAN-ip>:8000/reels`.
3. Behind a firewall / for remote play, open an HTTPS tunnel to port 8000 and
   paste the `https://…` URL into the Reels page's TUNNEL box — the player
   rewrites media URLs through it.

Streamlit fallback: the reels iframe uses the same assets; make sure the
mediaserver (8502) is running (`SX_MEDIA_PORT`) or use the tunnel field.