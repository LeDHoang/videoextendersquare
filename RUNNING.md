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
| `DATABASE_URL` | Shared social/messaging database URL | `sqlite:///./data/echo.db` |
| `SX_PUBLIC_URL` | Public origin used for reset and canonical reel-share links | `http://localhost:5173` |
| `SX_SECURITY_SECRET` | Session and rate-limit HMAC secret; required in production | insecure development fallback |
| `SX_MESSAGE_ENCRYPTION_KEY` | Stable AES-GCM source secret for messages and report evidence | required for messaging |
| `SX_COOKIE_SECURE` | Send authentication cookies only over HTTPS | `0` |
| `SX_TENOR_API_KEY` | Enables server-proxied Tenor GIF search | disabled |
| `SX_TENOR_CLIENT_KEY` | Tenor application/client identifier | `echo_reels` |
| `SX_TENOR_ALLOWED_HOSTS` | Comma-separated HTTPS GIF media allowlist | `media.tenor.com,media1.tenor.com` |
| `SX_DEV_ORIGINS` | CORS allow-list for the Vite dev server | `http://localhost:5173,http://127.0.0.1:5173` |
| `FFMPEG_DIR` / `SX_FFMPEG_DIR` | Directory containing `ffmpeg`/`ffprobe` if not on PATH | PATH lookup |
| `SX_MEDIA_PORT` | Legacy mediaserver port (unused by new stack) | 8502 |
| `SX_LIBX264` | `0` disables libx264 proxies (forces HEVC masters) | `1` |
| `SX_DEBUG` | Streamlit sidebar debug output | off |

## Messaging deployment notes

Run `make migrate` before startup so the database is at revision `20260911_0003`. Generate `SX_SECURITY_SECRET` and `SX_MESSAGE_ENCRYPTION_KEY` independently (for example, `openssl rand -base64 48`) and store both in the deployment secret manager. Do not rotate the messaging key until stored messages and report evidence have been re-encrypted.

Set `SX_PUBLIC_URL` to the externally reachable origin, without a trailing slash. This is the base for copied reel links and QR codes. Tenor is optional; if enabled, the backend needs outbound HTTPS access to `tenor.googleapis.com`, while stored GIF URLs must match `SX_TENOR_ALLOWED_HOSTS`.

The authenticated event stream is `/api/messages/events`. Reverse proxies must disable response buffering and keep SSE connections open for longer than the 15-second keep-alive interval. Multiple app workers do not require sticky sessions when they share the same database, because reconnects resume from the durable event outbox.

After deployment, test with two real accounts in separate browser sessions: request routing, acceptance/decline, text/emote/GIF/reel messages, unread/read state, reconnect after disabling the network briefly, blocking, deletion, and a logged-out canonical reel link.

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