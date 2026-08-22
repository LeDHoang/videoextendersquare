# Square Extender 4K — Full-Stack Migration

Migrate from Streamlit monolith to **FastAPI backend + Vite React frontend** while preserving the editorial design language, all pipeline functionality, and Streamlit as a fallback.

## Decisions (Confirmed)

| Decision | Answer |
|---|---|
| Emoji rendering | **Twemoji** CSS library (Twitter's open-source emoji set) — consistent cross-platform rendering, no stock/system emoji |
| Docker | **Single image** — FastAPI serves both API + built React static files |
| Streamlit | **Keep as fallback** — `app.py` untouched, documented in RUNNING.md |
| Guide | **[NEW] RUNNING.md** — covers both Streamlit and new stack |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  FRONTEND (Vite + React 19)                         │
│  Port 5173 (dev) → static build for prod            │
│  Twemoji for emoji rendering                        │
│                                                     │
│  ┌─────────┐ ┌────────┐ ┌─────────┐ ┌────────────┐ │
│  │ Image   │ │ Video  │ │ Compare │ │ Reels/VR   │ │
│  │ View    │ │ View   │ │ View    │ │ View       │ │
│  └────┬────┘ └───┬────┘ └────┬────┘ └─────┬──────┘ │
│       └──────────┼──────────┼─────────────┘         │
│            REST API calls + SSE streaming            │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│  BACKEND (FastAPI + Uvicorn)                        │
│  Port 8000                                          │
│                                                     │
│  /api/health    — system probes                     │
│  /api/image/*   — upload, process (SSE), download   │
│  /api/video/*   — upload, process (SSE), download   │
│  /api/reels/*   — scan output, proxy generation     │
│  /api/config    — fal key, model endpoints          │
│  /media/*       — static file serving (output/)     │
│  /*             — serves built React app (prod)     │
│                                                     │
│  pipeline/      — UNTOUCHED worker modules          │
└─────────────────────────────────────────────────────┘
```

## Proposed Changes

---

### Phase 1 — Backend API (FastAPI)

Pipeline module stays **completely untouched**.

#### [NEW] `server/__init__.py`
Empty module init.

#### [NEW] `server/app.py`
FastAPI application factory:
- CORS middleware (dev origins)
- Static mount at `/media/` serving `output/` (replaces `mediaserver.py` port 8502)
- Lifespan: runs `health.ensure_ffmpeg_on_path()` at startup
- Mounts built React app at `/` for production
- Includes all routers

#### [NEW] `server/routers/health.py`
- `GET /api/health` — JSON system probe results
- Reuses detection logic from existing `ui/health.py`

#### [NEW] `server/routers/config.py`
- `GET /api/config` — model endpoints + fal key mask
- `PUT /api/config/fal-key` — sets FAL_KEY
- `PUT /api/config/models` — updates model overrides

#### [NEW] `server/routers/image.py`
- `POST /api/image/upload` — multipart upload → metadata response
- `POST /api/image/process` — starts job, returns job_id
- `GET /api/image/jobs/{job_id}/stream` — SSE progress
- `GET /api/image/jobs/{job_id}/result` — download URL

#### [NEW] `server/routers/video.py`
- `POST /api/video/upload` — multipart upload → metadata response
- `POST /api/video/process` — starts job(s), returns job_id(s)
- `GET /api/video/jobs/{job_id}/stream` — SSE progress
- `GET /api/video/jobs/{job_id}/result` — download URL

#### [NEW] `server/routers/reels.py`
- `GET /api/reels` — scans output dir, returns video list with metadata
- `POST /api/reels/proxy` — triggers H.264 proxy generation
- `GET /api/reels/template` — returns reels.html with injected data

#### [NEW] `server/jobs.py`
- In-memory job registry (job_id → state/progress/result/error)
- ThreadPoolExecutor wrapping pipeline workers
- SSE event generator adapting `status_callback` to server-sent events

---

### Phase 2 — Frontend (Vite + React)

#### [NEW] `web/` directory
`npx -y create-vite@latest ./ -- --template react`

#### Emoji: Twemoji Integration
- Install `twemoji` npm package
- Wrap emoji text through `twemoji.parse()` for consistent rendering
- All emoji rendered as Twemoji SVGs, no system/stock fallback

#### [NEW] `web/src/styles/tokens.css`
Design tokens ported from existing `app.css`:
```css
:root {
  --sx-bg: #08090A;
  --sx-surface: #101214;
  --sx-accent: #FF3B1F;
  --sx-ink: #F2F3F5;
  /* ... full token set */
}
```

#### [NEW] `web/src/styles/global.css`
- Resets, Archivo/JetBrains Mono font loading
- Editorial primitives (`.sx-hero`, `.sx-eyebrow`, `.sx-rule`)
- Twemoji sizing/alignment overrides (`.emoji { height: 1.2em; vertical-align: -0.2em; }`)

#### [NEW] `web/src/components/layout/`
| Component | Purpose |
|---|---|
| `AppShell.jsx` | Main grid: sidebar + content |
| `Sidebar.jsx` | API key, health panel, model endpoints |
| `Nav.jsx` | Image / Video / Compare / Reels tabs |

#### [NEW] `web/src/components/ui/`
| Component | Purpose |
|---|---|
| `Hero.jsx` | Giant wordmark with accent rule |
| `Eyebrow.jsx` | Uppercase section labels |
| `Section.jsx` | Numbered editorial sections (01, 02, 03) |
| `Rule.jsx` | Hairline / heavy / accent dividers |
| `HealthDot.jsx` | Status dot + label + detail |
| `AccentBlock.jsx` | Callout blocks |
| `Progress.jsx` | Pipeline progress with phases, timer, log |
| `Button.jsx` | Editorial button (uppercase, no radius) |
| `UploadZone.jsx` | Drag-and-drop + file picker |
| `Emoji.jsx` | Wrapper that auto-parses text through Twemoji |

#### [NEW] `web/src/pages/`
| Page | Mirrors |
|---|---|
| `ImagePage.jsx` | `ui/views/image_view.py` — upload, configure, process, result |
| `VideoPage.jsx` | `ui/views/video_view.py` — upload, configure, batch, result |
| `ComparePage.jsx` | `ui/views/compare_view.py` — output scan + compare.html iframe |
| `ReelsPage.jsx` | `ui/views/reels_view.py` — filters + reels.html iframe |

#### [NEW] `web/src/hooks/`
- `useSSE.js` — consume SSE progress streams
- `useHealth.js` — poll /api/health
- `useConfig.js` — read/write config state

#### [NEW] `web/src/api/client.js`
Fetch wrapper with base URL handling (dev proxy → port 8000).

---

### Phase 3 — Orchestration & Docs

#### [NEW] `RUNNING.md`
Complete guide covering:
- **Quick start (new stack):** `make dev` or manual `uvicorn` + `npm run dev`
- **Streamlit fallback:** `streamlit run app.py`
- **Docker:** `docker build` + `docker run`
- **Environment variables:** `FAL_KEY`, `SX_MEDIA_PORT`, `FFMPEG_DIR`
- **Meta Quest 3 / VR setup:** tunnel instructions

#### [NEW] `Makefile`
```makefile
dev:       # concurrently runs FastAPI + Vite dev
build:     # builds React → web/dist/, ready for Docker
start:     # uvicorn production mode serving API + static
```

#### [MODIFY] `Dockerfile`
Multi-stage:
1. **Node stage** — builds `web/` → `web/dist/`
2. **Python stage** — installs deps, copies `web/dist/` to `server/static/`, runs uvicorn

#### [MODIFY] `requirements.txt`
Add: `fastapi`, `uvicorn[standard]`, `python-multipart`, `sse-starlette`
Keep: `streamlit` (fallback)

#### [NEW] `web/package.json`
Dependencies: `react`, `react-dom`, `react-router-dom`, `twemoji`

#### [KEEP] `app.py`
Untouched — Streamlit fallback entry point.

---

## Verification Plan

### Automated Tests
```bash
# Backend smoke test
python -m pytest server/tests/ -v

# Frontend build
cd web && npm run build
```

### Manual Verification
- Image upload → outpaint → upscale pipeline E2E
- Video upload → SSE progress streaming → result download
- Reels page → output scan → 4K playback
- Compare page → before/after slider
- Sidebar → health probes, FAL key
- Twemoji rendering — no stock emoji visible anywhere
- `streamlit run app.py` still works independently
- Docker build + run → single container serves everything
- Meta Quest 3 browser → WebXR/VR functional
