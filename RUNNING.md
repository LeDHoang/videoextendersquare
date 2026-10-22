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
make streamlit        # streamlit run app.py on :8501 (needs requirements-streamlit.txt, separate venv)
```

Kept working indefinitely — `app.py` is untouched by the new stack.

## Docker / production (compose)

Production is `compose.yaml` on one VPS: `app` + `postgres:16` + `cloudflared`
(Cloudflare Tunnel, no inbound ports). Full procedure, Cloudflare/R2 dashboard
checklist and operations: [`docs/deploy-runbook.md`](docs/deploy-runbook.md).
Backups and the restore drill: [`docs/backup-restore-runbook.md`](docs/backup-restore-runbook.md).

```bash
cp deploy/env.example .env && chmod 600 .env     # fill in every <...>
docker compose build --build-arg GIT_SHA="$(git rev-parse HEAD)"
docker compose up -d                             # app + postgres on 127.0.0.1:8000
docker compose --profile tunnel up -d            # + cloudflared
```

- The image (`Dockerfile`) copies only the runtime trees (`server core pipeline
  migrations ui` + the built React app), runs as non-root uid 10001, and wraps
  `ffmpeg` in `nice` (`SX_FFMPEG_NICE`, default 10). No VapourSynth/znedi3 inside
  the container, so the STUDIO engine is auto-disabled (FAST and FAL AI work).
- `deploy/entrypoint.sh` runs `alembic upgrade head`, then **one** uvicorn worker
  (`--proxy-headers`, 20 s graceful shutdown). Never add workers: JobManager and
  staged uploads are in-process.
- Volumes: `data` (`/app/data`: avatars, map-tile cache), `output`
  (`/app/output`), `pgdata`. Staged uploads and job temp files live in container
  `/tmp` and are lost on restart.
- Caps: app `cpus: 3`, `mem_limit: 6g`; postgres `cpus: 1.5`; json-file logs
  rotate at 10 MB × 5.
- `compose.yaml` builds `DATABASE_URL` from `POSTGRES_USER/PASSWORD/DB`.
- CI (`.github/workflows/ci.yml`) runs `make test`, migrations + the pool test on
  PostgreSQL 16, and a Docker build with image-content assertions.

Free production rehearsal on a laptop (SeaweedFS for R2, Caddy for the
Cloudflare edge, Mailpit for SMTP): [`docs/local-staging.md`](docs/local-staging.md).

```bash
cp deploy/env.staging.example .env.staging && chmod 600 .env.staging   # fill in every <...>
docker compose --env-file .env.staging up -d --build
node scripts/verify_staging.cjs
```

Plain single-container smoke test (SQLite, dev mode):

```bash
docker build -t echo-app .
docker run --rm -p 8000:8000 -v echo-data:/app/data -v echo-output:/app/output -e FAL_KEY=... echo-app
```

### Production environment

`deploy/env.example` is the complete template. With `SX_ENV=production` the app
refuses to boot until every check in `server/settings.py` passes.

| Variable | Production value | Notes |
|---|---|---|
| `SX_ENV` | `production` | Fail-fast config checks; no `/media` mount, no legacy discovery, diagnostics off |
| `SX_SECURITY_SECRET`, `SX_MESSAGE_ENCRYPTION_KEY`, `SX_FAL_KEY_ENCRYPTION_KEY` | 3 independent secrets, ≥ 32 chars | Never the dev default. **Escrow all three** — backups are unreadable without them |
| `DATABASE_URL` | `postgresql+psycopg://…@postgres:5432/echo` | Built by `compose.yaml` from `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| `SX_PUBLIC_URL`, `SX_PUBLIC_BASE_URL` | `https://<domain>` | Must be `https://` |
| `SX_MEDIA_BASE_URL` | `https://media.<domain>` | R2 public bucket custom domain; must be `https://` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BUCKET` | set | Token scoped to the public bucket only |
| `SX_TRUST_PROXY_HEADERS` | `1` | Correct behind Cloudflare Tunnel (only cloudflared reaches the app) |
| `SX_COOKIE_SECURE` | `1` | HTTPS-only cookies |
| `SX_DEV_ORIGINS` | _(empty)_ | Localhost origins are rejected at boot |
| `TUNNEL_TOKEN` | set | Read by the `cloudflared` service |
| `R2_ENDPOINT_URL` | _(unset)_ | S3 endpoint override; local staging points it at SeaweedFS. Unset means `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `SX_ENV_FILE`, `SX_APP_PORT` | _(unset)_ | Compose only: env file for the app (default `.env`) and its loopback port (default `8000`). Local staging uses `.env.staging` and `8001` |
| `SENTRY_DSN`, `SX_LOG_LEVEL` | DSN, `INFO` | Release tag comes from the `GIT_SHA` build arg |
| `SX_ALERT_5XX_RATE` / `SX_ALERT_P95_MS` | `0.05` / `2000` | Watchdog thresholds over the last 5 min (need at least 20 requests). Crossings are error logs, so Sentry events |
| `SX_ALERT_FAILURES` | `3` | Failed jobs plus failed derived encodes in 5 min before an alert |
| `SX_ALERT_INTERVAL_S` / `SX_ALERT_COOLDOWN_S` | `60` / `900` | How often the watchdog checks, and how long one alert stays quiet after it fires |
| `SX_LOG_FORMAT` | `json` | `json` (default in production) or `text`; every line carries the `request_id` echoed in `X-Request-ID` |
| `SX_CSP_MODE` | `report` | `off` (default outside production), `report` (default in production; reports go to `POST /api/csp-report` and the log) or `enforce` |
| `SX_SHUTDOWN_DRAIN_S` | `15` | Shutdown drain: queued jobs are cancelled and refunded, running ones get this long |
| `SX_SUPPORT_EMAIL` | operator inbox | Notified per `/support` request (no body). Unset: log line only |
| `SX_REGISTRATION_ENABLED` / `SX_REGISTRATION_ALLOWLIST` | `0` / invited emails | Invite-only beta |
| `SX_ADMIN_USERS` / `SX_MODERATOR_USERS` | operator / _(empty)_ | Bootstrap only: sign-in raises a listed account to that role and never lowers it. Roles are stored in the database. Demote in `/moderation` → USERS, after removing the account from the list |
| `SX_MAX_VIDEO_UPLOAD_MB` / `SX_MAX_IMAGE_UPLOAD_MB` | `95` / `50` | Upload size caps (95 MB stays under Cloudflare's 100 MB request limit) |
| `SX_UPLOAD_HOURLY_MAX` | `30` | Uploads per user per hour |
| `SX_VIDEO_WORKERS` / `SX_IMAGE_WORKERS` | `1` / `2` | Job concurrency |
| `SX_MAX_PENDING_JOBS` / `SX_MAX_JOBS_PER_USER` | `6` / `2` | Queue caps (429 when full) |
| `SX_STAGED_BYTES_MAX` | e.g. `2147483648` | Total bytes held in staged uploads |
| `SX_DISK_MIN_FREE_GB` | `5` | Refuse new work below this free space |
| `SX_JOB_RETENTION_S` | `21600` | Finished-job retention (6 h) |
| `SX_FFMPEG_THREADS` / `SX_FFMPEG_NICE` | `2` / `10` | Per-encode threads / nice level |
| `SX_REEL_PACK_CREATION_ENABLED`, `SX_REEL_PACK_DISCOVERY_ENABLED`, `SX_REEL_PACK_IMMERSIVE_ENABLED` | `1` | Explicit beta launch decision: Reel Packs ON |
| `SX_CREDITS_ENABLED`, `SX_STRIPE_ENABLED`, `SX_REEL_REWARDS_ENABLED` | `0` | Off for the beta |

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `FAL_KEY` | Server-owned fal.ai key for ECHO Credit-funded jobs; never exposed to users | — |
| `SX_CREDITS_ENABLED` | Enables server-funded quotes and credit spending. When off, the render panels still show price estimates (`POST /api/billing/estimate`: same pricing, no quote row, cannot fund a render) | `0` |
| `SX_STRIPE_ENABLED` | Enables Stripe Checkout pack purchases | `0` |
| `SX_REEL_REWARDS_ENABLED` | Enables qualified reel-view credit rewards | `0` |
| `SX_FAL_KEY_ENCRYPTION_KEY` | Stable dedicated secret for AES-GCM encryption of personal Fal keys | required to save BYOK keys |
| `STRIPE_SECRET_KEY` | Stripe secret API key (use test mode before launch) | — |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `/api/billing/webhooks/stripe` | — |
| `SX_STRIPE_PRICE_500` | Stripe Price ID for the $5 / 500-credit pack | — |
| `SX_STRIPE_PRICE_1050` | Stripe Price ID for the $10 / 1,050-credit pack | — |
| `SX_STRIPE_PRICE_2750` | Stripe Price ID for the $25 / 2,750-credit pack | — |
| `SX_PUBLIC_BASE_URL` | Browser origin used for Stripe Checkout return URLs (required for Checkout; no `Host` fallback) | — |
| `SX_BILLING_RESERVED_TTL_MIN` | Age after which never-submitted credit reservations are reaped (minimum 5) | `30` |
| `SX_REEL_REWARD_IP_DAILY_CLAIMS` | Eligible reel claims allowed per keyed IP per UTC day | `50` (minimum `1`) |
| `SX_FAL_MAX_QUOTE_USD` | Per-job fal spend cap enforced at quote time (`0` disables) | `10` |
| `SX_STRIPE_WEBHOOK_MAX_BYTES` | Max Stripe webhook body (minimum 1024) | `1048576` |
| `SX_STRIPE_WEBHOOK_RPM` | Stripe webhook requests per IP per minute | `120` |
| `SX_QUOTE_RPM` | Billing quotes per user per minute | `15` |
| `SX_PACK_CREATE_HOURLY` | Reel Pack creations per user per hour | `10` |
| `SX_PUBLISH_HOURLY_MAX` / `SX_PUBLISH_DAILY_MAX` | Upload publishes per user per hour / day | `5` / `20` |
| `SX_SSE_MAX_CONN` / `SX_SSE_MAX_MIN` | Message SSE streams per user / max stream lifetime minutes | `8` / `30` |
| `SX_EVENT_RPM` | View and event writes per actor per minute; the per-IP limit is 5x | `120` |
| `SX_EVENT_DAILY_CAP` | Contributions one actor can add to one post per UTC day when the event has no impression | `5` |
| `SX_EMAIL_VERIFY_TTL_MIN` | Lifetime of the sign-up verification link in minutes; the account exists only after it is used | `1440` |
| `SX_TURNSTILE_SITE_KEY` / `SX_TURNSTILE_SECRET` | Cloudflare Turnstile for sign-up. The site key goes to the SPA, the secret stays on the server. With the secret unset the check is skipped and a warning is logged at boot | empty |
| `SX_LOGIN_RATE_LIMIT` | `0` lifts the sign-in limits (20 per IP, 10 per account, per 15 min) for scripted runs. Production refuses to boot with `0` unless `SX_PUBLIC_URL` is a localhost URL | `1` |
| `SX_MOD_SPIKE_MIN` | Smallest count the moderation Overview flags as a spike (at least 3x the previous window) | `10` |
| `SX_REGISTRATION_ENABLED` | `0` closes public registration (invite-only); `SX_REGISTRATION_ALLOWLIST` emails can still register | `1` |
| `SX_REGISTRATION_ALLOWLIST` | Comma-separated invite emails honored while registration is closed (case-insensitive) | empty (fully closed) |
| `DATABASE_URL` | Shared social/messaging/billing database URL | `sqlite:///./data/echo.db` |
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
| `SX_MAP_TILES_ENABLED` | `0` disables the tile proxy (VR globe falls back to the holographic look, label shows `MAP OFFLINE — CITY VIEW`) | `1` |
| `SX_MAP_TILES_URL` | Upstream **base** tile template swapped without code change (default keyless OSM standard raster, labels baked in. OSM can block a proxy it deems out of policy — check for TLS resets / an `X-Blocked` header; Esri World Street Map `…/MapServer/tile/{z}/{y}/{x}` works keyless but needs an ArcGIS plan commercially; CARTO dark is opt-in with a keyed template — anonymous CARTO returns key-wall placeholders) | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` |
| `SX_MAP_LABELS_URL` | Upstream **labels** tile template, empty = disabled (client renders base-only; set to a keyed CARTO `dark_only_labels` template to restore split untinted labels) | _(empty)_ |
| `SX_MAP_TILES_CACHE_DIR` | Disk cache for proxied tiles, keyed per layer + upstream-template hash (immutable, `Cache-Control: public, max-age=604800`) — persist this alongside `output/` or repeat zooms refetch upstream | `data/map_tiles/` |
| `SX_MAP_MIN_CELL_REELS` | K-anonymity floor: sub-city heat cells (geohash ≥ 6) are suppressed below this many active reels (city-level rows are unaffected — already the published privacy unit) | `3` |
| `VITE_SX_HIDE_DEV_TOOLS` | Build-time (Vite) flag. Set to `true` to hide the sidebar engine-probe card and telemetry bar in production builds. Off by default | _(unset)_ |

VR globe debugging: append `?earthmap=0` to disable the slippy-map tile layer on-device (bisection alongside `?lock=0`, `?overlay=0`). The base layer is GPU-tinted toward holo cyan in the tile shader while labels composite untinted on top; append `?earthstyle=raw` to compare against the unstyled raster. Zoomed drag pans the map by default (grab feel); `?topdown=1` remains as a compatible alias. Warp magnification ramps in over S∈[2,4] (globe is exact at/below S=2) and stands down whenever tiles are degraded/disabled, so offline zoom grows a clean undistorted globe. Bearing is exact via the dock `NORTH UP` button (full-basis pose, ≤0.5°); on-device feel check pending. If the label shows `MAP OFFLINE — CITY VIEW` while activity loads: `curl localhost:8000/api/reels/map-tiles/attribution` — no `layers` field means a pre-v2 backend is serving (restart uvicorn); otherwise check outbound HTTPS to `*.basemaps.cartocdn.com`. Tile budget: ≤6 concurrent slots (up to 12 image requests: base+labels pairs), ≤128 MiB unique GPU textures with LRU + parent-fallback parking. The tile proxy requires outbound HTTPS to the upstream hosts with a policy-compliant `User-Agent: EchoVR-MapTiles/1.0`; upstream failures return 502 with `Retry-After` (never 500 — the globe always renders).

## Credits, Stripe, and reel-reward deployment notes

Keep `SX_CREDITS_ENABLED`, `SX_STRIPE_ENABLED`, and `SX_REEL_REWARDS_ENABLED` off by default. Apply migrations through head (`20261021_0015`), back up the database, and configure a stable `SX_FAL_KEY_ENCRYPTION_KEY` before allowing users to save personal keys. Generate it independently from `SX_SECURITY_SECRET` and `SX_MESSAGE_ENCRYPTION_KEY`; rotating it requires re-encrypting all saved Fal credentials first.

When any billing flag is on, `SX_SECURITY_SECRET` must be a real secret (not the development default) and `SX_FAL_KEY_ENCRYPTION_KEY` must be at least 16 characters and not a placeholder — otherwise paid endpoints (`/api/billing/*`, credit-funded `/process`, reward claims) return 503 `BILLING_MISCONFIGURED` while free local processing and reels keep working. The misconfiguration is also logged loudly at startup.

Staged uploads live in process memory: in multi-worker deployments a quote/submit pair must land on the same worker (sticky sessions or a single worker), and a restart drops staged files. Quotes record a fingerprint (size, mtime, dimensions, duration) of the staged bytes; if the file changes between quote and submit the job is rejected with `INVALID_QUOTE` so a swap can never ride a stale price.

For Stripe, create three one-time USD Prices whose totals exactly match $5.00, $10.00, and $25.00, then place their IDs in `SX_STRIPE_PRICE_500`, `SX_STRIPE_PRICE_1050`, and `SX_STRIPE_PRICE_2750`. Configure the webhook endpoint at `/api/billing/webhooks/stripe` and subscribe to Checkout completion/delayed-success events plus refunds and disputes. The webhook must receive the unmodified raw request body. Set `SX_PUBLIC_BASE_URL` to the externally reachable HTTPS origin used for Checkout redirects.

Recommended rollout order:

1. Enable credits in a non-production environment and verify quotes/reservations with test balances.
2. Enable Stripe in test mode and exercise duplicate, delayed-success, refund, and dispute webhooks with Stripe CLI.
3. Run low-cost Fal jobs for each enabled stock model and compare the stored quote snapshot with Fal dashboard charges.
4. Enable reel rewards and monitor per-user/per-IP claim rates before production rollout.
5. Before Horizon Store distribution, verify the current external-payment policy from a supported macOS/Windows `metavr` host; this Linux host cannot run the required Meta documentation check.

Credits never expire, are non-transferable, and have no cash value. Refunds/disputes may make a wallet negative, which blocks new platform-funded jobs. FAST/STUDIO work remains anonymous and free; all Fal-backed work requires sign-in and either ECHO Credits or a saved personal key.

Reward anti-gaming posture (accepted, documented): the watch threshold uses the client-reported duration, but every claim is additionally gated by server-observed elapsed time (impression `first_visible_at` → event `created_at`), foreground-playback telemetry, 1 credit per 10 distinct eligible reels, 5 credits per user per UTC day, and a keyed-IP daily cap. A forged short duration still requires real foreground watch time to pass the server gate, and farming throughput is capped by the daily limits.

## Messaging deployment notes

Run `make migrate` before startup so the database is at revision `20261021_0015` (head). Generate `SX_SECURITY_SECRET` and `SX_MESSAGE_ENCRYPTION_KEY` independently (for example, `openssl rand -base64 48`) and store both in the deployment secret manager. Do not rotate the messaging key until stored messages and report evidence have been re-encrypted.

Set `SX_PUBLIC_URL` to the externally reachable origin, without a trailing slash. This is the base for copied reel links and QR codes. Tenor is optional; if enabled, the backend needs outbound HTTPS access to `tenor.googleapis.com`, while stored GIF URLs must match `SX_TENOR_ALLOWED_HOSTS`.

The authenticated event stream is `/api/messages/events`. Reverse proxies must disable response buffering and keep SSE connections open for longer than the 15-second keep-alive interval. Multiple app workers do not require sticky sessions when they share the same database, because reconnects resume from the durable event outbox.

After deployment, test with two real accounts in separate browser sessions: request routing, acceptance/decline, text/emote/GIF/reel messages, unread/read state, reconnect after disabling the network briefly, blocking, deletion, and a logged-out canonical reel link.

## Meta Quest 3 / VR

The Reels player is a Three.js-accelerated WebXR experience (`ui/assets/webxr_vr.js`). Because all media URLs are same-origin relative paths, it works in the Quest browser over plain HTTP on your LAN, through an HTTPS tunnel, or via USB reverse port-forwarding:

### 1. USB-C Reverse Port Forwarding (Recommended for Development & Zero Lag)
WebXR requires a Secure Context. By using ADB reverse port forwarding, Quest Browser treats the host machine as `localhost`, providing complete WebXR access without SSL setup:

```bash
# 1. Connect Quest 3 to your computer with a USB-C link cable and allow debugging
adb devices

# 2. Map host ports to the headset
adb reverse tcp:8000 tcp:8000
adb reverse tcp:5173 tcp:5173

# 3. Open in Meta Quest Browser:
# Primary feed: http://localhost:5173/reels
# Desktop 3D parity inspector: http://localhost:5173/reels/immersive-preview
```

### 2. Real-Time Telemetry & Frame Drops Probing
To inspect hardware HEVC decoder cadence and dropped frames via Chrome DevTools Protocol:
```bash
# Probe active Quest Browser tabs and inspect WebGL renderer stats
node scripts/debug-quest-targets.cjs
node scripts/debug-quest.cjs
```

### 3. Wi-Fi / LAN Mode
1. Run the server (`make dev` or `make start`) on the machine hosting `output/`.
2. On the Quest browser, open `http://<your-LAN-ip>:8000/reels`.
3. For remote play over WAN, open an HTTPS tunnel to port 8000 and paste the `https://…` URL into the Reels page's TUNNEL box — the player rewrites media URLs through it.

Streamlit fallback: the reels iframe uses the same assets; make sure the mediaserver (8502) is running (`SX_MEDIA_PORT`) or use the tunnel field.