# ECHO — 4K Square Spatial Video Extender, WebXR VR Player & Social Reels

<p align="center">
  <img src="web/public/logo.png" alt="ECHO Logo" width="120" />
</p>

<p align="center">
  <strong>Generative 1:1 Square Outpainting · 4K HEVC Spatial Master Encoding · WebXR Immersive Cosmic VR Reels · Authored Reel Packs · Social Discovery & Messaging · ECHO Credits</strong>
</p>

---

## Visual Showcase

The screenshots below cover the media pipeline and player (v2.0). The social surfaces added since — Reel Packs, Explore, Messages, Wallet — have no captured screenshots yet.

### 1. Image Extender & Multi-File Batch Mode
Generatively extend canvas borders to 1:1 square (3840×3840) with instant padding metrics and multi-model cloud / offline upscalers.
![Image Processing Interface](docs/images/image_extender.png)

### 2. Video Extender & Live Cost Breakdown
Full outpaint + upscale pipeline featuring Bytedance Video Upscaler, LTX 2.3, Luma Ray-2, local HEVC master encoding, and live pre-render billing estimator.
![Video Processing Interface](docs/images/video_extender.png)

### 3. WebXR 4K Reels Player (Desktop Viewport with Dynamic Glow)
Ultra-smooth 1:1 square reels player with synchronized dynamic ambient glow (Ambilight), instant folder / codec switching, and search filtering.
![Reels Player Interface](docs/images/reels_player.png)

### 4. WebXR Immersive Cosmic VR Mode (Meta Quest 3 / Vision Pro)
Step inside an atmospheric midnight-blue cosmos with 1,800 breathing stars, real-time radiant video glow, 6DOF natural grab-and-drag, and 3D floating spatial transport panel.
![WebXR VR Mode Simulation](docs/images/reels_vr_mode.png)

### 5. Fast vs Studio Render Comparison Inspector
Interactive side-by-side A/B slider comparing Lanczos4+CAS against ZNEDI3 neural interpolation with automatic proxy streaming.
![Compare Page Interface](docs/images/compare_slider.png)

### 6. Reel Packs (no screenshot yet)
Authored, finite collections of 5–12 reels with a stable `/packs/:id` URL, cover/collage tile, ordered tracklist, resume, and identical playback in 2D and WebXR. See [Reel Packs investigation](docs/reel-packs-implementation-investigation.md).

### 7. Explore, Messages & Wallet (no screenshots yet)
`ALL / REELS / PACKS` discovery with tag and location pages, encrypted direct messaging with reel/pack sharing, and the ECHO Credits wallet with Stripe top-up and reel rewards.

---

## Key Features

### 🥽 WebXR 4K Master Reels Player (Meta Quest 3 & Apple Vision Pro)
- **Deep Midnight-Blue Cosmic Skybox**: Surrounds the viewer with 1,800 procedurally placed stars with multi-harmonic harmonic twinkling and additive alpha blending.
- **Dynamic Real-Time Ambilight Aura**: Synchronized Gaussian glow backing on 2D desktop browsers and GLSL fragment glow shader in WebXR stereo VR.
- **All-Side 3D Curvature Screen Modes**:
  - **`🌐 DOME` (Concave Hemisphere)**: Curves symmetrically toward the viewer in a true 3D spherical dome cap with direct center focal apex $(0,0,0)$.
  - **`🔲 SQ CURVE` (Concave Square)**: Dual-axis curvature along both $X$ and $Y$ dimensions while preserving sharp rectangular framing.
  - **`📺 FLAT`**: Planar display mode.
- **6DOF Natural Grab & Level Horizon**: Hold the Quest grip button to freely drag and position the video screen anywhere in 3D space with zero roll disorientation.
- **Floating 3D Spatial Transport Panel**: Seek, Play/Pause, Mute, Volume, Curvature Toggle, and `🔄 AUTO` / `🔁 LOOP` modes rendered in 3D space.
- **Zero-Latency Video Preloader**: Proactively pre-buffers the next track for instantaneous reel transitions.

### 🎨 Generative 1:1 Square Outpainting & 4K Encoding
- **Dual Pipeline Modes**:
  - **OUTPAINT + UPSCALE**: Generatively extends portrait/landscape videos to 1:1 square via supported `fal.ai` models (LTX 2.3, Luma Ray-2 Flash, or Wan VACE) before upscaling.
  - **UPSCALE ONLY**: Runs locally with FAST/STUDIO, or through supported Fal upscalers when FAL AI is selected.
- **Bytedance Video Upscaler Integration**:
  - Model ID: `fal-ai/bytedance-upscaler/upscale/video`
  - Custom target resolution (`1080p`, `2k`, `4k`), frame rate (`30fps`, `60fps`), quality tier, scenario presets, and fidelity settings.
- **Local Hardware HEVC Master Encoding**:
  - Hardware acceleration (`hevc_videotoolbox` on macOS / `hevc_nvenc` on NVIDIA / `libx265`).
  - Bitrate ceiling optimization to guarantee smooth Quest 3 decoding without buffer drops.
  - `-movflags +faststart` MOOV header atom placement for instant frame-1 streaming.

### ⚡ Modern Single Page Application Architecture (v2.0)
- **React 19 + Vite 6 Frontend**: Cyberpunk brutalist dark mode design system with Tron-inspired **Orbitron** typography, glassmorphism, dialog semantics with focus management, and reduced-motion support.
- **FastAPI Asynchronous Backend**: Non-blocking REST endpoints, Server-Sent Events (SSE) live job progress streaming, HTTP 206 Partial Content video range serving, and Alembic-managed schema migrations (`make migrate`).

### 📦 Reel Packs — Authored Finite Collections
- **First-class live objects**: stable ID and canonical `/packs/:id` URL, creator, title, description, cover, tags, city/country location, `public`/`unlisted` visibility, revision, saves, and per-user progress.
- **Authoring**: 0–12 reel drafts, publish at 5–12 of your own published reels, drag-and-drop plus keyboard reordering, cover reel or auto collage. Concurrent edits use revision claims — stale writes get `409 PACK_REVISION_CONFLICT`, never silent overwrites.
- **Discovery**: `ALL / REELS / PACKS` Explore modes with pagination, tag and location pages, creator profile `PACKS` tab, and a Saved library split into `REELS` / `PACKS`. Removed or under-repair packs hide from discovery but keep working direct links.
- **Finite playback**: one shared state machine (`intro → playing → complete`) across 2D and WebXR — start/resume from a stable item ID, queue selection, previous/next with unavailable-item skipping, completion card, and no fall-through into the endless feed. Reel actions (like, comments, save/share reel, follow, report) stay available and separate from Pack save/share.
- **Sharing**: canonical URL, native share, clipboard, QR download, and in-app sends to up to 10 recipients. Messages render a distinct Pack attachment; deleted or inaccessible Packs render a generic tombstone without leaking the reason.
- **Rollout flags** (default on, via `/api/config`): `SX_REEL_PACK_CREATION_ENABLED`, `SX_REEL_PACK_DISCOVERY_ENABLED`, `SX_REEL_PACK_IMMERSIVE_ENABLED`.
- Detail: [Reel Packs investigation](docs/reel-packs-implementation-investigation.md).

### 🔍 Social Discovery, Profiles & Messaging
- **Accounts & profiles**: registration/login, sessions, password reset email, avatars, display names, follow graph, per-user posts/reels/image grids, and profile settings.
- **Explore**: shuffled reel gallery plus Pack sections, title/creator/place/tag search, folder and codec filters, tag pages (`/explore/tag/:tag`) and location pages (`/explore/location/:key`), and an Earth activity mode with city heat zones.
- **Direct messaging**: message requests (pending/active/declined), text/emote/GIF/reel/pack kinds, idempotent sends, read receipts, deletion tombstones, blocking, and a compact message dock. Payloads are encrypted at rest with the server-held `SX_MESSAGE_ENCRYPTION_KEY` (app-level encryption, not end-to-end — the UI discloses this). Optional Tenor GIF search via `SX_TENOR_API_KEY`.
- **Sharing**: canonical reel links (`/reels?post=<id>`), clipboard/native/QR, multi-recipient idempotent delivery from Reels, Explore, profile, and player surfaces.

### 💳 ECHO Credits, Stripe & Reel Rewards
- **Credits wallet** (`/wallet`): credit accounts, ledger, reservations, Stripe Checkout top-ups, and webhook reconciliation. Users can optionally save their own encrypted Fal key (BYOK) instead of the platform key.
- **Deterministic Fal pricing** with staged quotes: failed reservations restore the quote for retry, stale reservations are reaped (`SX_BILLING_RESERVED_TTL_MIN`), and partial refunds are pro-rated.
- **Reel rewards**: earn credits for watching reels, with server-elapsed gates, foreground telemetry, and daily/IP caps against farming. Flag: `SX_REEL_REWARDS_ENABLED`.
- Keep `SX_CREDITS_ENABLED`, `SX_STRIPE_ENABLED`, and `SX_REEL_REWARDS_ENABLED` disabled until the Stripe test-mode checks in [RUNNING.md](RUNNING.md) pass. Billing misconfiguration fails closed (billing 503s, the rest of the app keeps running).

### 🛡️ Moderation & Account Safety
- Pack- and reel-level reports, moderation queue (`/moderation` for staff in `SX_ADMIN_USERS` / `SX_MODERATOR_USERS`), user blocking enforced across profiles, Packs, and messaging, and generic unavailable responses that never reveal whether deletion, moderation, blocking, or visibility caused them.

---

## Quick Start

### 1. Prerequisites
- **Node.js 18+** & **npm**
- **Python 3.10 to 3.12+**
- **FFmpeg & FFprobe** installed and available in your PATH

### 2. Installation

```bash
# Clone the repository
git clone https://github.com/LeDHoang/videoextendersquare.git
cd videoextendersquare

# Set up Python virtual environment
python -m venv .venv
source .venv/bin/activate    # On Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Install frontend dependencies
cd web
npm install
cd ..
```

### 3. Configuration
Create a `.env` file in the project root:

Start from `.env.example`. For local-only FAST/STUDIO processing, the credits flags and Fal key can remain disabled/blank. To enable account-funded cloud processing, configure at least:

```env
FAL_KEY=your_platform_fal_key
SX_FAL_KEY_ENCRYPTION_KEY=a-separate-long-random-secret
SX_CREDITS_ENABLED=1
SX_STRIPE_ENABLED=0
SX_REEL_REWARDS_ENABLED=0
```

`FAL_KEY` is the server-owned platform credential and cannot be changed through public APIs. Users can optionally save their own encrypted Fal key from the Credits page. Stripe and reel rewards should remain disabled until their settings and test-mode checks in [RUNNING.md](RUNNING.md) are complete.

Reel Packs are enabled by default. To stage the rollout independently, set any of `SX_REEL_PACK_CREATION_ENABLED`, `SX_REEL_PACK_DISCOVERY_ENABLED`, or `SX_REEL_PACK_IMMERSIVE_ENABLED` to `0`. Disabling discovery keeps direct pack links working; disabling immersive keeps the full 2D experience.

### Social beta setup

Copy the environment template and configure account security before launching:

```bash
cp .env.example .env
```

At minimum, replace both `SX_SECURITY_SECRET` and `SX_MESSAGE_ENCRYPTION_KEY` with independent random values. You can generate each value with `openssl rand -base64 48`. Keep the messaging key stable and backed up: changing or losing it makes existing messages and encrypted moderation evidence unreadable. Messages are encrypted at rest on the server; they are not end-to-end encrypted.

Set `SX_PUBLIC_URL` to the public site origin so copied links and QR codes use the canonical `/reels?post=<id>` URL. Set `SX_COOKIE_SECURE=1` when the site is served over HTTPS. Enable `SX_TRUST_PROXY_HEADERS=1` only when a trusted reverse proxy overwrites `X-Forwarded-For`. Configure `SX_ADMIN_USERS` or `SX_MODERATOR_USERS` with comma-separated usernames/emails for the moderation queue.

Tenor GIF search is optional. Configure `SX_TENOR_API_KEY` and `SX_TENOR_CLIENT_KEY` to enable it; `SX_TENOR_ALLOWED_HOSTS` controls the HTTPS media hosts accepted in messages. Without an API key, text, emote, and reel messages remain available.

Password reset email requires `SX_PUBLIC_URL`, `SX_SMTP_HOST`, `SX_SMTP_FROM`, and the matching SMTP port/credentials. `SX_PASSWORD_RESET_EXPOSE_TOKEN=1` is for local development only.

Apply the database schema before starting the backend:

```bash
make migrate
```

For a database created by the older automatic `create_all()` startup path, back it up first. Only when the old social tables already exist and `alembic_version` does not, mark that known baseline and then upgrade:

```bash
cp data/echo.db data/echo.db.backup
.venv/bin/python -m alembic stamp 20260910_0001
make migrate
```

Do not stamp a blank or partially created database; use `make migrate` directly instead.

Install and run the backend and frontend regression checks with:

```bash
make install-dev
make test
```


### 4. Running the Application

In terminal 1 (FastAPI Backend):
```bash
.venv/bin/uvicorn server.app:app --host 127.0.0.1 --port 8000 --reload
```

In terminal 2 (Vite Frontend):
```bash
cd web
npm run dev
```

Open **http://localhost:5173** in your browser.

---

## Meta Quest 3 WebXR Testing Setup

WebXR requires a **Secure Context** (`https://` or `localhost`).

1. Connect your Meta Quest 3 to your Mac / PC via USB-C cable.
2. Open Chrome and navigate to `chrome://inspect/#devices`.
3. Click **Port forwarding...** and add:
   - `5173` → `localhost:5173` (Vite Frontend)
   - `8000` → `localhost:8000` (FastAPI Server)
4. On your Meta Quest Browser, navigate to: `http://localhost:5173/reels`.
5. Click **"VR MODE 🥽"** on screen to enter the cosmic WebXR immersive player!

---

## Project Structure

```
videoextendersquare/
├── web/                    # Modern React 19 + Vite 6 SPA
│   ├── src/
│   │   ├── pages/          # Image, Video, Reels, Compare, Explore, Tag/Location,
│   │   │                   # Upload, Auth, Profile(+Settings), Packs(+Editor),
│   │   │                   # Messages, Wallet, Moderation, ImmersivePreview
│   │   ├── components/     # UI primitives, controls, packs, messaging, layout, icons
│   │   ├── styles/         # Design tokens (tokens.css) & global styles (global.css)
│   │   ├── hooks/          # Auth, messaging, config, explore previews
│   │   └── api/            # REST & SSE streaming client
│   └── public/             # Logo emblem, icons, and static assets
├── server/                 # High-performance FastAPI backend
│   ├── app.py              # Application lifecycle & middleware
│   ├── features.py         # Runtime feature flags (e.g. Reel Packs rollout)
│   ├── routers/            # image, video, reels, packs, messages, social,
│   │                       # billing, rewards, compare, config, uploads, ...
│   ├── media.py            # H.264 proxy transcoding & pair scanning
│   ├── jobs.py             # Asynchronous task runner with SSE broadcast
│   └── social/             # Auth, models, services, messaging crypto, safety
├── migrations/             # Alembic schema versions (Packs: 20260913_0009)
├── tests/                  # Backend integration tests (incl. test_reel_packs.py)
├── pipeline/               # Core media transformation workers
│   ├── image_worker.py     # Flux outpainting & Lanczos4 / FAL upscaling
│   ├── video_worker.py     # Video outpainting (LTX/Luma/Wan) & HEVC encoding
│   └── utils.py            # Geometric padding math & FFmpeg probing
├── ui/assets/              # WebGL & WebXR shaders (webxr_vr.js, reels.html, compare.html)
└── docs/images/            # High-resolution documentation screenshots
```

---

## Docs & Planning

- [RUNNING.md](RUNNING.md) — operations, billing/Stripe checks, and deployment notes.
- [docs/todolist.md](docs/todolist.md) — ordered project todo list with verification status.
- [docs/reel-packs-implementation-investigation.md](docs/reel-packs-implementation-investigation.md) — Reel Packs product contract, implementation record, and remaining release gates.
- [docs/vr-reels-playback-investigation.md](docs/vr-reels-playback-investigation.md) — playback architecture, risks, and the physical-Quest validation matrix.
- [docs/funding-in-vietnam-2-vr-reels-investigation.md](docs/funding-in-vietnam-2-vr-reels-investigation.md) — VR Reels strategy review.

---

## License

MIT License. Designed and built for high-performance generative spatial video transformation and immersive WebXR playback.
