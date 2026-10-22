# Beta Launch Checklist

Last updated: 2026-10-22 (follow-ups verified: healthz off the threadpool, suspended sign-in tells the user to appeal, queue shows the acting moderator, `/api/feed` viewer state batched per page; load, abuse and queue runs on local staging; browser matrix on Chrome, Firefox and emulated phones; moderation drill; in-app ops metrics and watchdog alerts; earlier: 4K publish blocker fixed locally: video encodes moved to a background job, publish 107 s → 2.3 s; first CI run green; free local staging stack (`docs/local-staging.md`) run: production boot, SeaweedFS-for-R2 publish/delete, Caddy edge CORS/Range, backup + restore drill passed; inline 4K publish took 107 s, over the 100 s Cloudflare timeout (fixed 2026-10-21); P0 workstreams merged and ticked off; local Docker build + image assertions green, remaining live checks listed under "Not yet verified"; deploy stack: `compose.yaml`, `deploy/`, CI, deploy/backup/manual-check runbooks; Reel Pack flags decided ON; infrastructure verdicts revised: R2 media at launch, PostgreSQL day one, SEA/Asia + US region design, Ray-2 deprecation and Ray 3.2 migration; stale-entry pass; latest engineering entries 2026-10-16; audit round 2 + planned-feature scope inventory 2026-09-19)

Status: **Blocked for public beta.** Complete every item in "Public beta release blockers" before opening registration or exposing the deployment publicly. An invite-only beta must still protect paid processing endpoints and private user media.

## Infrastructure design verdicts (decided 2026-09-19, revised 2026-10-20)

These are the settled architecture decisions for beta and the reasoning behind each. Checklist items below that reference topology, region, database, media storage, payments, or GPU inference should be implemented to match these verdicts. Each was reached by adversarial review (separate for/against agents arguing from the actual codebase).

**Revision 2026-10-20:** a second for/against review, with 2026 pricing and terms checked on the web, changed four verdicts:
- Media moves to Cloudflare R2 at launch. Cloudflare's CDN terms, updated 2026-09-28, rule out proxying video hosted on our own server.
- The host budget is corrected for Hetzner's 2026 repricing.
- PostgreSQL is used from day one.
- The origin region now targets SEA/Asia + US users.

The review also found that fal is retiring the Ray-2 reframe endpoint on 2026-10-25.

**One-line version:** *One VPS (Singapore by default) + co-located PostgreSQL + Cloudflare R2 media + Stripe (gated) + fal.ai at launch. Add a second region when the minority region measurably hurts. Add one L40S when fal spend crosses ~$500/mo. Move to Fly.io multi-machine when one box isn't enough.*

**Beta fixed cost (estimate):**
- Hetzner SIN CPX32: €48.99/mo.
- R2: ~$0–2/mo; the free tier covers early beta.
- Database dumps in R2: cents per month.
- Total: ≈ €50–55/mo plus metered fal usage.

### Hosting — single VPS first, managed platform later
- **Launch:** run the existing multi-stage `Dockerfile` via `compose.yaml` (app + `postgres:16`) on one VPS. One machine is *correct* here: jobs and staged-upload registries are process-local (`server/jobs.py` `_jobs`, the `STAGED_UPLOADS` dicts in `server/routers/image.py`/`video.py`, `/tmp` staging). One instance satisfies that constraint without a premature shared queue.
- **Box and price (verified 2026-10-20 on Hetzner's price-adjustment page):** Hetzner repriced twice in 2026. The 1 Apr change applied to all customers. The 15 Jun change applies to new orders and rescales.
  - The old "CX32 ~€7.51" line is stale.
  - The cost-optimized CX line (CX33 now €8.49 in DE/FI) shows "Currently not available" on hetzner.com/cloud, and is EU-only anyway.
  - **Pick: CPX32 in Singapore (€48.99/mo).** The dedicated-vCPU alternative is CCX13 (SIN €53.99, US €43.49).
  - Confirm specs and availability in the Hetzner Console before ordering.
- **Traffic:** included traffic outside the EU is small. A third party reports 0.5–1 TB; this is not confirmed on official pages. That is acceptable only because media egress goes to R2, not the VPS (see Media storage).
- **CPU contention (must fix before beta, <1 day):** this box shares web, SSE, Postgres and ffmpeg.
  - Linux has no hardware HEVC encoder, so encodes fall back to `libx265 -preset medium` (`core/tooling.py:36`).
  - Default pools are 4 image + 2 video workers on 4 vCPU (`core/phases.py:71-74`).
  - No `-threads` or `nice` cap exists in `core/` or `pipeline/`.
  - Two 4K encodes will pin every core.
  - **Fix:** set the video pool to 1. Run ffmpeg with `-threads 2` under `nice`. Put a `cpus` limit on the **app** container (`compose.yaml`: app `cpus: 3`, postgres `cpus: 1.5`), so encodes cannot starve Postgres. Require auth on the free 4K path (Processing API item below).
- **Why not Fly.io/Render/Railway/Neon now (reasoning corrected 2026-10-20):** scale-to-zero is not the blocker. Neon and Fly (`min_machines_running`) can both keep an instance always on. The real reasons are:
  1. The single-process constraint means paying for one always-on instance anyway.
  2. PaaS per-GB egress pricing is the wrong cost shape for a video app.
  3. A VPS is several times cheaper at $0 revenue, and every failure mode is one we understand.
- **Growth trigger → Fly.io multi-machine:** only when one box genuinely can't keep up and a shared job queue exists. The app is already stateless-shaped (Docker, env config), so it's a lift, not a rewrite.
- **Rejected:** Kubernetes/microservices (resume-driven at this scale), AWS/GCP (idle cost ~$150/mo before a single user), scale-to-zero platforms.

### Region — one origin, global edge, SEA/Asia + US users
- **Shape:** one write origin (one app process, one Postgres primary), because jobs are process-local. Global reach comes from Cloudflare's edge, not from multiple origins:
  - **Media** (the heavy bytes): served from R2 through the Cloudflare cache at the nearest PoP in SEA, Asia and the US, wherever the origin is.
  - **SPA assets** (hashed Vite bundles): cached at the edge.
  - **Origin traffic:** only API calls and SSE streams reach it.
- **Origin: Hetzner Singapore (`sin`, network zone `ap-southeast`) by default.**
  - SEA/Asia users get low API latency.
  - US users pay roughly 170 ms (West) to 230 ms (East) per API round trip. These are estimates; measure them on the beta.
  - Pick Hillsboro (`hil`, US West) instead if the invite list is majority US. US West is the Pacific compromise: about 160–190 ms to SEA, low latency across the US.
  - Decide from the actual invite list before provisioning. Moving later means backing up the old box and restoring onto a new one, which the restore drill rehearses.
- **R2 bucket location hint matches the origin:** `apac` for SIN, `wnam` for HIL. Cache misses and server-side media writes then stay close.
- **Latency-tolerant client:** the feed already preloads the next page. Avoid adding blocking API calls to the playback path. SSE keep-alive (15 s) is unaffected by RTT.
- **Region-independent pieces:** fal.ai jobs are asynchronous, and Stripe Checkout is global.
- **Growth trigger → second region:** when the minority region exceeds ~30% of DAU **and** its p95 API latency exceeds ~400 ms. The path is a Postgres read replica plus read-only API instances in the second region, or Fly multi-region. Both need the shared job queue from the multi-machine trigger first.

### Database — PostgreSQL from day one
- **Verdict (revised 2026-10-20):** launch on PostgreSQL, not SQLite. The old rule was "migrate before the first Stripe charge". Stripe is gated off for beta, so that wording allowed a SQLite launch followed by a live-data migration through a script that was never written (`scripts/sqlite_to_pg.py`). Starting on Postgres removes that migration entirely.
  - The 1025-line credits ledger (`server/billing/service.py`) still needs Postgres before real money moves.
  - `DEFAULT_DATABASE_URL` is still SQLite (`server/social/database.py:12`), so production must set `DATABASE_URL`.
- **Why it's cheap:** the codebase is pre-migrated.
  - `DATABASE_URL` is env-driven and honoured by both the app and `migrations/env.py`.
  - `psycopg` is already in requirements.
  - The Alembic tree is dual-dialect (`sqlite_where`/`postgresql_where` partial indexes).
  - It's a connection string plus `alembic upgrade head`, run by the container entrypoint.
- **Where it runs:** `postgres:16` co-located in `compose.yaml` on the same VPS (free, no network hop).
- **Backups:** a nightly `pg_dump` (or WAL-G) to a private R2 bucket.
- **Key escrow:** escrow `SX_SECURITY_SECRET`, `SX_MESSAGE_ENCRYPTION_KEY` and `SX_FAL_KEY_ENCRYPTION_KEY` off the box. A restore is useless without them.
- **Restore drill:** run one before launch.
- **Managed alternative (if restores won't be rehearsed):** Neon Launch with scale-to-zero disabled, in its Singapore region next to the origin.
  - Price: $0.106/CU-hour + $0.35/GB-month, with a 7-day history window. 0.25 CU always-on ≈ $19/mo.
  - Switch when backup/HA burden exceeds that cost.

### Media storage — Cloudflare R2 at launch
- **Verdict (revised 2026-10-20):** serve published media from an R2 public bucket on a custom domain (`media.<domain>`) behind the Cloudflare cache, starting at launch. The old verdict was "local disk now, R2 when egress hurts".
- **Why the change:**
  - Cloudflare's CDN terms, updated 2026-09-28, say non-Enterprise plans "must use" a Cloudflare paid service (Developer Platform, Images, Stream) to serve video and other large files via the CDN.
  - Cloudflare's video-delivery policy says it may redirect such traffic. The fixes it lists are a DNS-only subdomain or a paid service.
  - Video hosted on R2 is allowed on Free/Pro/Business (Cloudflare "updated ToS" blog).
  - So "local disk + free CDN pull cache" was never an allowed option. The checklist's own `/media/*` cache bypass meant it would not have cached anyway.
- **It overlaps open blockers:**
  - Separating private from public media (Job, upload, and media ownership section) needs the same media-path work.
  - Public routes must return only database-backed published posts, and legacy `rglob` discovery must be disabled.
  - Published posts are written through to R2.
  - Private/unpublished job artifacts stay on local disk behind an owner-checked route.
  - The `/media` mount of the whole `output/` tree (`server/app.py`) is removed.
  - Avatars (`data/avatars`, mounted at `/avatars`) move to R2 or are included in backups.
- **Cost (verified 2026-10-20):** $0.015/GB-month, 10 GB-month free, **$0 egress**. Class A operations cost $4.50/M and Class B $0.36/M.
- **Cache:** a custom domain caches only default file types. Add a Cache Everything rule for the media host. `r2.dev` is rate-limited and not for production.
- **Uploads:** Cloudflare's request-body limit is 100 MB on Free/Pro (200 MB Business), and larger requests get a 413.
  - For beta, lower `MAX_VIDEO_UPLOAD_BYTES` (`server/media.py:19`, now 500 MB) below 100 MB.
  - Post-beta target: presigned multipart PUT straight to a private R2 bucket. That also takes upload bytes off the origin.
- **Must re-verify before beta:** Range/seek playback from R2 on Quest, desktop and mobile. Our VR playback docs flag seek behaviour as fragile.
- **Effort:** ~3–5 days, much of it shared with the ownership blockers.

### Payments — keep Stripe, gated until retention is proven
- **Verdict:** keep **Stripe**. It is already integrated:
  - a 358-line idempotent webhook layer with `StripeEvent` dedup, signature verification, and server-side price re-validation;
  - the PSP-agnostic credits ledger.
- **Why not a merchant-of-record (Paddle/Lemon Squeezy) yet:**
  - Their 5% + $0.50 is confiscatory on the $5 credit pack (~15% vs Stripe's ~8.9%; a ~2–3.3× penalty across the $5/$10/$25 tiers).
  - Moving from Stripe to an MoR is a well-trodden migration; the reverse is painful.
  - Tax exposure is small while US-centric with 3 SKUs (Stripe Tax calculates; register only on nexus). SEA/Asia buyers do not change that until volume creates registration obligations there; review before enabling payments.
- **Two adopted caveats:**
  1. Fix the **$5 pack economics**. At an 8.9% effective fee it eats ~33% of gross margin against the `credits_for_cost` markup. Raise the minimum or make entry packs web-only/larger.
  2. **Gate payments behind the existing launch flag** (`SX_STRIPE_ENABLED=0`, enforced in `server/billing/stripe_service.py`) until retention is proven. Free tiers cost only fal fees, not complexity.

### AI inference — fal.ai now, hybrid self-host at a measured trigger
- **Verdict:** stay on **fal.ai** metered inference.
  - Per-second COGS scales to $0 at $0 revenue.
  - The credits system needs per-job metered costs to keep margin auditable per job.
  - An always-on GPU is a $430–800/mo fixed liability against revenue that doesn't exist yet.
- **Deprecation (verified 2026-10-20, deadline 2026-10-25):** fal marks both `fal-ai/luma-dream-machine/ray-2-flash/reframe` and `ray-2/reframe` as "deprecated on October 25, 2026", with migration to Ray v3.2. The flash endpoint is the catalog entry at `core/models.py:61`, also referenced in `web/src/components/upload/useExtendConfig.js` and `web/src/pages/VideoPage.jsx`.
  - Replacement: `luma/agent/ray/v3.2/reframe`.
  - Price: $0.06/s at 540p, $0.12/s at 720p, $0.36/s at 1080p, billed per started source second.
  - Its API docs require a **source of 10 s or less** and produce 5 s/10 s output.
  - **Migrated 2026-10-20:** catalog entry (`core/models.py`, 720p default), request builder (`pipeline/video_worker.py`, sends `prompt`/`aspect_ratio`/`resolution`), quote path (`core/pricing.py`, `luma_resolution`) and web UI now use `luma/agent/ray/v3.2/reframe`. Sources over 10 s are refused by the quote, by `/api/video/process` (400 `SOURCE_TOO_LONG`, BYOK included) and by the worker before upload. No resolution selector in the UI yet; it pins 720p.
- **Why not self-host everything:** 8+ models in the catalog means 8+ weight pipelines, CUDA matrices and license reviews. That is ≈ a $150k/yr MLOps hire to save $1–2k/mo. Frontier outpaints (Luma Ray 3.2 reframe, LTX-2) have no open-weight equivalent at all.
- **Hybrid trigger (adopted):** self-host when fal spend crosses **~$500/mo** or **~20–50 upscale jobs/day**.
  - Move the open-weight, high-volume upscalers (Real-ESRGAN class) onto one L40S (~$15–26/day; re-quote, see repricing note below).
  - Keep the Ray/LTX-2 hero outpaints on fal permanently, with fal as burst/overflow.
  - The repo already has the escape hatches:
    - the free FFmpeg `fast` engine is the default;
    - `pipeline/spatial_worker.py` already runs Video-Depth-Anything locally (cuda/mps/cpu);
    - the VapourSynth Studio engine is one dependency fix from shipping.
- **fal repricing (2026-10-04):** hourly GPU rental prices rose. That affects only the L40S/self-host comparison. No change to per-second model API prices was reported. The source is a single third-party capture.
- **Known margin pressure (recompute):** the earlier example, "60s hero outpaint ≈ $3.60 fal COGS vs ~$4.56 net on a $5 pack", is **obsolete**. Ray-2 is retired, and Ray 3.2 reframe caps the source at 10 s, so a 60 s hero outpaint is no longer one job. The largest Ray 3.2 job is now 10 s: $0.60 at 540p, $1.20 at 720p (the UI default, 162 credits) or $3.60 at 1080p. Recompute per-clip margin for every outpaint model in the catalog against the $5/$10/$25 packs before enabling credits. fal's documented price instability (`core/models.py`: "Estimate only — pull live pricing") means credit pricing must track fal pricing.

### What these verdicts do NOT remove from this checklist
The blockers below are unchanged and still gate public beta. The verdicts pick *where* things run. They do not implement the controls that remain required regardless of host:
- auth on processing endpoints, FAL spend limits, per-user quotas and ownership checks;
- ffmpeg CPU caps;
- retention/deletion;
- backups + restore drill;
- monitoring/alerting.

**Sources (checked 2026-10-20):**
- [Cloudflare service-specific terms](https://www.cloudflare.com/service-specific-terms-application-services/)
- [Cloudflare updated-ToS blog](https://blog.cloudflare.com/updated-tos/)
- [Delivering videos with Cloudflare](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)
- [Cloudflare request limits](https://developers.cloudflare.com/workers/platform/limits/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Hetzner price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- [Hetzner Cloud](https://www.hetzner.com/cloud/)
- [Neon pricing](https://neon.com/pricing)
- [fal Ray-2 flash reframe](https://fal.ai/models/fal-ai/luma-dream-machine/ray-2-flash/reframe)
- [fal Ray 3.2 reframe](https://fal.ai/models/luma/agent/ray/v3.2/reframe)
- [fal Ray 3.2 reframe API](https://fal.ai/models/luma/agent/ray/v3.2/reframe/api)
- [fal GPU repricing capture](https://www.usagepricing.com/blueprint/activity/fal-ai-2026-10-04-gpu-fleet-repricing)

## Beta feature scope — planned but missing features (2026-09-19)

This section answers "is this supposed to exist yet?" for every planned feature. **In scope for beta:** the current shipped feature set (reels, packs, explore/tag/location/Earth, comments/likes/saves, DMs, credits wallet + Stripe, rewards, WebXR/Quest mode) plus the release blockers below. **Out of scope by design:** the VR roadmap phases and the items tabled here — with the single exception of the P1 features listed, which gate public registration or payments.

### Features missing that intersect with beta

| Feature | Priority | State | Where it lands |
|---|---|---|---|
| Email verification flow | **P1** (or stay invite-only via `SX_REGISTRATION_ENABLED=0`) | Zero machinery — no model, route, or template (invite-only path now supports `SX_REGISTRATION_ALLOWLIST`, 2026-09-20) | Registration blockers above |
| Job cancellation endpoint | **P1** | No cancel endpoint exists in any router (verified 2026-09-19) | Ownership section above |
| DSAR data export (`GET /api/users/me/export`) | P2 (P1 if EU users allowed) | Absent | Privacy section above |
| Report dialog UI (replace `window.prompt`) | P2 | API complete incl. packs; UX missing | Privacy section above |
| In-app support/contact surface | **Done (2026-10-21)** | `/support` form (signed out too, so suspended users can appeal), footer SUPPORT link, moderator Support tab; `report_content` requests file real reports | Health/support section above |
| Cookie-consent banner (ePrivacy) | P2 (EU-scoped) | 1-year anon cookie writes on load | Privacy section above |
| Credits nav icon final art | P2 cosmetic | `web/src/components/icons/svg/credits.svg` marked TEMP | todolist.md near-term |
| Captions/WebVTT | **Out of scope for beta (decided 2026-10-21)** | No `<track>`/VTT capability anywhere | A11y item above |
| Alt-text field on upload | P3 | No field; avatars render `alt=""` | Deferred |
| Reels page default folder | **Done** | ~~`ReelsPage.jsx` still defaults `folder` to `testpipeline` (dev HEVC test clips). That folder holds no image posts, so the default For You feed shows videos only; image/slideshow posts (added 2026-10-11) appear only under ALL FOLDERS / `uploads` or via deep links. Owner decision: keep `testpipeline` during dev, switch the default (likely `ALL FOLDERS`) when close to beta launch~~ **Corrected 2026-10-21:** Reels already defaults to `ALL FOLDERS` | `web/src/pages/ReelsPage.jsx` `useState(searchParams.get('folder') \|\| 'testpipeline')` (+ the matching fallback in its fetch `.then`) |

### VR roadmap phases — out of beta scope by design (source: `docs/todolist.md`)

- **Phase 0 — playback foundation:** remove normal-path decoded-frame skipping (today the VR uploader intentionally drops the 30fps source to 10–15fps via stride — the choppy-motion workaround documented in `vr-reels-playback-investigation.md:94–157`); standardize one Quest-appropriate rendition with auto-selection (today: single `-preview.mp4` proxy, `reels.py:1194`); texture-upload contention control (video/controls/comments/earth/glow `needsUpdate` calls + hidden preload competing per frame — `webxr_vr.js`); bounded cache/memory/thermal on-device validation.
- **Phase 1 — immersive-media contract:** stored projection/stereo-layout/orientation/comfort metadata; per-rendition codec/bitrate/fps records; caption + AI-provenance metadata; guaranteed mono-flat fallback for invalid/missing metadata (partial: VR falls back to the 2D left-eye rendition when a stereo file fails to load). ~~Replace filename-based SBS detection~~ — **done (3D Reels, migration `20261015_0013`):** the player reads `posts.stereo_layout` (`mono`/`sbs`/`tb`); the filename regex is gone (re-verified 2026-10-20).
- **Phase 2 tail:** open city/event Packs directly from Earth (with location privacy + preview safety filtering).
- **Phase 3:** world/body-lock default, recenter + `COMFORT`/`CINEMA`/`IMMERSIVE` presets, timed captions + transcription/translation.
- **Phase 4:** World Shell PoC (keyframe → panorama/depth shell at upload, `ENTER WORLD`/`EXIT WORLD`, provenance labels).
- **Phases 5–6:** commercial pilots (property/travel/city), synchronized viewing, voice nav, 2.5D reels, splats/volumetric research.
- **Funding-doc guardrails (settled, no action):** creator view-payouts deferred; gaze-data resale, casino-style retention, stolen IP, fake-memories, bots-as-humans all rejected.

> [!IMPORTANT]
> **Accepted beta limitation:** the Quest device gate below validates the *frame-skipping* playback path as it exists today. Beta ships with stride-reduced VR playback (30fps source → ~10–15fps in headset) as a known limitation; Phase 0 is the follow-up that removes it. Do not treat the device gate as failing against Phase 0 expectations.

### Known unfinished engineering (tracked in `docs/todolist.md` — verified still open 2026-09-19)

- `web/src/hooks/MessagingContext.jsx:305–313`: send-reconcile checks `alreadyPresent` against the optimistic-key list instead of the target conversation list (duplicate bubble on key migration until the next reload); optimistic GIF sends render empty until server echo. Re-verified still open 2026-10-20.
- Reporting an already-deleted message returns 404 `REPORT_TARGET_NOT_FOUND` (evidence path only verified for live messages).
- Staged uploads are process-memory (consistent with the single-worker verdict; documented in RUNNING.md).
- Reward threshold trusts client-reported duration (documented accepted risk: server-elapsed gate + foreground telemetry + caps bound farming).

## Public beta release blockers

### Processing API security and cost controls

- [x] ~~Require authentication and CSRF protection for image/video upload and processing endpoints~~ — **partially done (verified 2026-09-19):** cloud (FAL-funded) processing requires auth + origin + CSRF + stage ownership (`image.py:139–142`, `video.py:266–269`); uploads carry owner identity. **Remaining:** the *free/local* path (`upscale_engine="fast"`/`"studio"`, no FAL) runs 4K ffmpeg with **no auth, no CSRF, no rate limit** in both routers — decide: require auth for all jobs, or strict per-IP quota + global queued-job cap with 429. **Done (2026-10-20, `b73a16d`):** every upload and `/process` call (free and cloud) requires sign-in, CSRF and origin; every job has an `owner_id`; anonymous upload/process returns 401 (`tests/test_cloud_routes.py`).
- [x] Remove runtime platform-key mutation and restrict `PUT /api/config/models` to administrator sessions with CSRF protection.
- [x] Protect CPU/GPU-intensive Reels and comparison endpoints — **sharpened by audit (2026-09-19):** `POST /api/reels/proxy` runs up to **50 synchronous ffmpeg transcodes per call with zero auth** (`reels.py:2073–2098`); `POST /api/reels/spatialize` creates owner-less jobs that can download model weights, with an unvalidated `strength` float (`reels.py:2113–2171`). Admin-gate or remove both from the public router; also covers Explore preview generation, comparison preparation, and forced health refreshes. **Partially done (2026-09-20):** proxy + spatialize (+ status) now require admin session with CSRF + per-admin rate limit; `strength` clamped 0–2 via pydantic; anon/non-admin denied with regression tests. **Remaining:** Explore preview generation, comparison preparation, forced health refreshes. **Done (2026-10-20):** `POST /api/reels/explore-preview` requires sign-in + CSRF + origin, is rate-limited 30/min/user, and in production only transcodes paths of live published posts (`9e76de3`, `tests/test_reels_prod_gates.py`); the compare router is not registered in production and `?refresh=` on `/api/health` is honoured only for admins (`b78cdd0`); spatialize jobs carry `owner_id`.
- [~] Add per-user and per-IP upload, processing, event, and storage quotas. **Uploads:** anonymous staging accepts 50 MB image / 500 MB video per file (caps exist and are enforced mid-stream — `media.py:15–19`) but with **no per-identity rate limit and no global staged-bytes ceiling**; a bot can fill the disk. Add staged-bytes ceiling + 429/507 on overflow. **Done for uploads/processing (2026-10-20, `b73a16d`):** `SX_UPLOAD_HOURLY_MAX` (30/user/hour), per-file `SX_MAX_IMAGE_UPLOAD_MB` / `SX_MAX_VIDEO_UPLOAD_MB`, staged-bytes ceiling `SX_STAGED_BYTES_MAX` (4 GiB → 507 `STORAGE_FULL`), `tests/test_upload_quotas.py`. **Remaining:** event quotas (see recommendation section).
- [x] Add bounded job queues, global and per-user concurrency limits, and overload responses — **confirmed still open:** `JobManager._jobs` has no global cap; `cleanup_old` only evicts *terminal* jobs, so queued-job count is unbounded (`server/jobs.py`). **Done (2026-10-20, `b73a16d`):** slot reserved under the JobManager lock before billing; `SX_MAX_PENDING_JOBS` (6) and `SX_MAX_JOBS_PER_USER` (2) return 429 `QUEUE_FULL` + `Retry-After`; `tests/test_job_limits.py`. Load behaviour under real concurrency is still a manual check (see "Not yet verified" below).
- [x] **New (2026-10-20, deadline 2026-10-25):** Migrate the Luma reframe catalog entry off `fal-ai/luma-dream-machine/ray-2-flash/reframe` (`core/models.py:61`, `web/src/components/upload/useExtendConfig.js`, `web/src/pages/VideoPage.jsx`, `web/src/pages/UploadPage.test.jsx`) to `luma/agent/ray/v3.2/reframe` — fal deprecates Ray-2 reframe on 2026-10-25. Update pricing ($0.06/$0.12/$0.36 per source second at 540p/720p/1080p), the request builder and quote path, and enforce the ≤10 s source limit server-side (see verdicts → AI inference). **Done (2026-10-20):** see the AI inference verdict; regression tests in `tests/test_pricing.py` and `tests/test_ray_reframe_source_limit.py`.
- [x] **New (2026-10-20):** Cap ffmpeg CPU on the shared VPS — video pool size 1 in production (`core/phases.py:71-74`), `-threads 2` and `nice` on libx265 encodes (`core/tooling.py:36`), and a `cpus` limit on the **app** container (corrected 2026-10-20: the cap belongs on the app, not Postgres), so two 4K encodes cannot starve web/SSE/DB (see verdicts → Hosting). **Partial (2026-10-20):** `compose.yaml` caps the app at `cpus: 3` / `mem_limit: 6g` (postgres `cpus: 1.5`), and the image wraps every `ffmpeg` call in `nice -n ${SX_FFMPEG_NICE:-10}` (`deploy/ffmpeg-nice.sh`). Pool size and `-threads` are app-code work. **Done (2026-10-20, `b73a16d`):** `SX_IMAGE_WORKERS` / `SX_VIDEO_WORKERS` size the pools (prod 2/1 in `deploy/env.example`); `SX_FFMPEG_THREADS=2` adds `-threads` and x265 `pools`. Nice level in a running container is still unverified.
- [ ] Add hard FAL spending limits and alerts — **confirmed still open; sharpened:** `normalize_model_id` (`core/models.py:235–254`) accepts *any* fal model ID (BYOK-only for credits, but no per-job cost cap/confirmation), and the `ltx_loras` validator only checks the string starts with `http(s)://` while `attach_civitai_token` (`pipeline/utils.py:12–34`) splices the server-held `CIVITAI_KEY` onto any URL **containing the substring** `civitai.com/api/download/models` — a crafted URL exfiltrates the token. Parse hostnames + allowlist; cap custom-model BYOK spend. **Partially done (2026-09-20):** `attach_civitai_token` now parses `urlsplit` against an exact hostname allowlist (`civitai.com`, `www.civitai.com`) + https-only (substring exfil closed, unit-tested); per-job spend cap `SX_FAL_MAX_QUOTE_USD` (default $10, `0` disables) enforced in `create_quote`. **Remaining:** global spend alerts.
- [~] Configure reverse-proxy request-body limits and timeouts that match the application upload limits. **Note (2026-09-19):** Cloudflare's free-plan body limit is 100 MB vs the app's 500 MB video cap — lower the app cap or document the plan requirement. **Decided 2026-10-20 (verdicts → Media storage):** lower `MAX_VIDEO_UPLOAD_BYTES` below 100 MB for beta; presigned multipart direct-to-R2 uploads post-beta. **Done in app (2026-10-20):** `SX_MAX_VIDEO_UPLOAD_MB=95` in `deploy/env.example`, below the 100 MB Cloudflare limit; the web client reads the cap from `/api/config` `upload_limits`. **Remaining:** re-time a 95 MB 4K publish on the CPX32 against the 100 s CF origin timeout. The encodes no longer run inside the request (2026-10-21, see the blocker item under "Not yet verified"): locally publish now returns in 2.3 s.
- [~] Add regression tests proving logged-out users and ordinary users cannot access administrator or cost-bearing operations. **Partially covered (2026-09-20):** admin-gate tests for proxy/spatialize (anon/non-admin denied) + cross-user publish tests green (`test_security_money.py`). **Remaining:** systematic coverage of the remaining cost-bearing ops.
- [x] **New (2026-09-19 audit):** Cap the Stripe webhook body (currently `await request.body()` with no size limit — `billing.py:178–189`) and IP-rate-limit the path with 429. **Done (2026-09-20):** `SX_STRIPE_WEBHOOK_MAX_BYTES` (default 1 MB, floor 1 KB → 413) + per-IP `SX_STRIPE_WEBHOOK_RPM` (default 120/min → 429); generic 400 preserved.
- [x] **New:** `packs.py` has **no rate limits at all** — pack creation, items, save, like, and a DB write on every watch-tick progress update are unthrottled. Add per-user limits mirroring like/comment limits; debounce/coalesce progress writes. **Done (2026-09-20):** create 10/hr, writes 100/hr, save/like 120/hr, progress 12/min per viewer+pack (all rate-limited, regression-tested).
- [x] **New:** Publish endpoint (`uploads.py:137–246`) has no rate limit — each call copies up to 500 MB and runs up to 3 ffmpeg/Pillow passes while creating a public post. Add a per-user daily publish cap. **Done (2026-09-20):** `SX_PUBLISH_HOURLY_MAX` (5) + `SX_PUBLISH_DAILY_MAX` (20).
- [x] **New:** Rate-limit `POST /api/billing/quote` (spawns two ffprobe subprocesses per call) and cache probe results per stage fingerprint. **Done (2026-09-20):** `SX_QUOTE_RPM` (15/min/user + 4×/IP) + 5-min mtime/size-validated probe cache.
- [x] **New:** Login timing enumeration — `social.py:400–406` short-circuits unknown accounts before the argon2 delay; verify against a dummy hash when the user is missing. **Done (2026-09-20):** lazily-cached dummy argon2 verification on unknown users; identical 401 text.
- [x] **New:** Decompression-bomb headroom — set `Image.MAX_IMAGE_PIXELS` explicitly and reject oversized pixel dimensions at upload (avatars are guarded at 25 MP; staged processing is not). **Done (2026-09-20):** explicit 50 MP ceiling (`MAX_STAGED_IMAGE_PIXELS`) enforced in `get_image_dimensions`, mapped to 413 at image staging + quote.
- [x] **New:** Assert minimum length/entropy for `SX_FAL_KEY_ENCRYPTION_KEY` inside `billing/crypto.py:_key()` itself (currently sha256s any value; the ≥16-char rule lives only in the startup check). **Done (2026-09-20):** `_key()` requires ≥16 chars and rejects placeholders.

### Job, upload, and media ownership

- [x] Add an owner identity to staged uploads and job records — **done (verified 2026-09-19):** `STAGED_UPLOADS` stores `(path, timestamp, stage_owner_identity(...))` with fail-closed matching (`auth.py:206–230`); owner tests pass (`test_cloud_routes.py`).
- [x] Enforce ownership on job status, SSE progress, results, downloads, cancellation, and publication — **partial:** status/SSE/result/download all enforced via `_owned_job`. **Update (2026-09-20):** publication is now owner-enforced (`_resolve_source` verifies `rec.owner_id` / `stage_owner_matches`; owner-less free jobs keep legacy behavior). **Remaining gap:** no cancel endpoint exists at all. **Done (2026-10-20, `b73a16d`):** owner-only, CSRF-checked `POST /api/{image,video}/jobs/{id}/cancel` (202, 409 when terminal); `tests/test_job_cancel.py`.
- [x] Prevent one authenticated user from publishing another user's `stage_id` or `job_id` — **fixed (2026-09-20):** cross-user stage/job publish returns 403 with regression tests (`test_security_money.py`); same-browser anon→authed migration still works via `stage_owner_matches`.
- [x] Separate private/unpublished job artifacts from public published media — **confirmed still open:** `server/app.py:113–115` mounts the entire `output/` tree at `/media`; unpublished job artifacts persist into that tree (`pipeline/utils.py:208–212` documents the leak). **Done (2026-10-20):** production has no `/media` mount (`b78cdd0`, `tests/test_production_boot.py`); published media is uploaded to R2 on `media.<domain>` before the local file is committed, and unpublish deletes the R2 objects (`9e76de3`, `tests/test_media_store.py`). Live R2 behaviour is still unverified (see below).
- [x] Ensure every item returned by public Reels, Explore, tag, location, profile, and canonical-link routes corresponds to an active, published database post. **Done (2026-10-20, `9e76de3`):** in production `_scan_cached` keeps only rels with a live `Post` row, which covers `/api/reels`, tags, locations, packs and recommendations; Explore preview generation is limited the same way (`tests/test_public_discovery_gate.py`, `tests/test_reels_prod_gates.py`).
- [x] Disable directory-style legacy media discovery in production — **confirmed still open:** `reels.py:997–1002` `rglob`s `output/` (`_scan_cached` → `scan_output_media`) with no production-mode gate; consumed by feed hydration fallback at `:1241–1251`, `:1433`, `:1590`. **Done (2026-10-20, `9e76de3`):** see the item above; dev keeps loose-file discovery.
- [~] Add multi-user authorization tests covering guessed, stolen, expired, and cross-user stage/job identifiers — **partial:** stage + job status/download tests exist and pass; publish-path cross-user/expired/pointer-matrix tests added 2026-09-20 (`test_security_money.py`, `test_security_edge.py`).

### Recommendation correctness and abuse resistance

- [x] Fix concurrent materialization of the same recommendation cursor — **code fix landed and is dual-dialect** (winner-replay on `uq_recommendation_request_session_page`, `service.py:527–577`; `events.py:30–55` branches `pg_insert.on_conflict_do_nothing` vs SQLite). **Remaining:** the concurrency tests run on SQLite fixtures only — **re-run on PostgreSQL before launch** (launch verdict: Postgres before payments; READ-COMMITTED retry semantics differ). **Done (2026-10-21):** both concurrent tests now run on SQLite and Postgres (`SX_TEST_POSTGRES_URL`), and the CI postgres job runs `-k concurrent`.
- [x] Add a permanent synchronized concurrency regression test for both Reels pages and creator-suggestion pages — **done; verified passing 2026-09-19** (`test_concurrent_page_materialization_replays_winner`, `test_concurrent_affinity_upsert_dedupes` — 4 passed; the 2026-09-12 failure record below is historical).
- [x] Rate-limit `/api/events`, `/api/posts/{post_id}/view`, and anonymous recommendation feedback. **Done (2026-10-21):** `/api/events` and `/api/posts/{id}/view` are limited to `SX_EVENT_RPM` per actor and 5x per IP.
- [x] Validate watch, foreground, position, and duration values against server-known media duration; reject or clamp impossible values. **Done (2026-10-21):** watch, foreground and position are clamped to the server duration x 4.
- [x] Limit the serialized size and accepted keys of event `context` and `playback_quality` objects. **Done (2026-10-21):** `context` and `playback_quality` are capped at 2 KB and 16 scalar keys (422 `EVENT_CONTEXT_TOO_LARGE`).
- [x] Cap repeated actor/item contributions so event replay cannot manipulate affinities, co-watch data, or global popularity statistics. **Done (2026-10-21):** contributions are capped per actor, post and impression, and `SX_EVENT_DAILY_CAP` per day without one.
- [x] Preserve valid impression/session attribution checks and add tests for fabricated events without delivery provenance. **Done (2026-10-21):** fabricated or foreign impression ids still record but carry no attribution; `tests/test_event_abuse.py`.
- [x] **New (2026-09-19 audit):** The anonymous cookie is **unsigned** — `ensure_anonymous_cookie` (`auth.py:295–309`) accepts any client-supplied `echo_anon` value, so a bot rotates unlimited anonymous actors (view-count inflation, replay-cap evasion, recommendation poisoning). HMAC-sign it with `SX_SECURITY_SECRET`; reject unsigned/forged values. **Done (2026-09-20):** `echo_anon` is now `raw.signature` (HMAC via `keyed_hash`); forged/legacy values rotate-and-continue (never honored); `stage_owner_matches` verifies the signature. One-time invalidation of pre-existing anon cookies.
- [x] **New:** SSE `/api/messages/events` connection exhaustion — each connection polls the DB every 1s with no per-user connection cap and no max stream lifetime (`messages.py:901–960`). Cap concurrent streams per user; force reconnect after N minutes. **Done (2026-09-20):** `SX_SSE_MAX_CONN` (3/user → 429; default raised to 8 on 2026-10-21 because a few quick page reloads hit the cap before old streams were released) + `SX_SSE_MAX_MIN` (30-min lifetime with `reconnect` frame); slots released on close (concurrency + lifetime regression-tested).
- [ ] Decide whether an already materialized page should refill after a post or creator becomes ineligible. Currently it safely removes the item but can return an underfilled page with stale `has_more`.
- [x] Refactor recommendation scope reads to use the request's dependency-injected database session rather than opening a second global session. **Verified (2026-10-22):** already done by the 2026-10-16 pool fix (`scoped_media_paths` and the other helpers take the request `db`); no code change needed. `tests/test_db_pool_isolation.py` now also covers the For You page, its cursor page 2, the anonymous For You page, `feed=following`, `author=`, `/api/recommendations/creators`, `POST /api/recommendations/feedback`, `/api/feed` (discover and following) and 6 concurrent For You requests on a one-connection pool. All 27 tests pass on SQLite and on Postgres 16.

### Privacy, deletion, and public policy

- [~] Publish a privacy policy, terms of service, and community/content rules — **build task, not just writing (2026-09-19):** no `/privacy`, `/terms`, or `/rules` routes or page components exist anywhere in `web/src`; add a `LegalPage` + routes + footer links first. **Terms drafted (2026-10-20):** `/terms` (`web/src/pages/TermsPage.jsx`, footer link) covers 13+ age with guardian consent for minors, content licence, AI processing, community rules, copyright notices, credits (14-day refund of unspent purchased credits), BYOK, VR safety. **Privacy + acceptance (2026-10-20):** `/privacy` (`web/src/pages/PrivacyPage.jsx`, footer link, linked from Terms §14) lists every data category, provider, cookie and retention period checked against the code; shared values live in `web/src/components/legal/LegalKit.jsx`. Signup requires a Terms/Privacy checkbox; `/api/auth/register` rejects without `accept_terms: true` (`TERMS_NOT_ACCEPTED`) and stores `users.terms_version` / `terms_accepted_at` (migration `20261020_0014`, `TERMS_VERSION` in `server/routers/social.py`). Age check deferred: no date of birth collected, Terms state 13+. Still open: fill the `LEGAL` placeholders (entity, address, emails, governing law, venue, hosting region, activity retention, deleted-media purge period, effective date), lawyer review, `/rules` page. Gaps the policy discloses but the code should fix: published originals keep EXIF/GPS metadata (`shutil.copy2` in `server/routers/uploads.py`); soft-deleted posts' media files are never purged.
- [ ] **New:** Add a GDPR data-export (DSAR) endpoint — `GET /api/users/me/export` returning posts, packs, comments, and ledger as a JSON archive. Currently absent.
- [x] **New:** Account deletion leaves **DMs and conversation state intact** — `delete_account` (`account_safety.py:499–608`) predates the messaging and billing subsystems: it never touches `DirectMessage`/`Conversation`/`ConversationMember`/`MessageEvent` (deleted users' messages persist verbatim in recipients' inboxes). Either document "DMs retained, author tombstoned" in the privacy policy or crypto-shred per-user keys. **Decided and done (2026-10-21): hidden, not deleted.** Rows stay (moderation evidence); the other participant no longer sees the conversation, its unread count or its live events, and gets 404 on it (`deleted_counterpart_clause` in `server/routers/messages.py`). Privacy page, Terms and the deletion hint say so. Revisit hard deletion with the retention periods.
- [~] **New:** Account deletion leaves **billing tables untouched** — `CreditLedgerEntry`/`StripePurchase`/`ReelRewardClaim` retention is defensible under financial-record law but must be a documented decision; `FalCredential` (encrypted BYOK keys) should be hard-deleted on account closure. **Done (2026-09-20):** `delete_account` hard-deletes the `FalCredential` row in-transaction (regression-tested); ledger/financial rows retained as legal records, DM retention still a documented decision per the item above.
- [~] Disclose which media and metadata are sent to FAL or other third-party processors before users submit content. **Extend to WebXR:** Quest sessions implicitly process head/hand pose data — the policy must name it, with a first-run notice on VR entry. **Done (2026-10-20, `1a5a5bc`):** fal.ai disclosure in `CloudFundingPanel.jsx`; the Privacy page lists fal.ai, Cloudflare, Hetzner and Sentry; `reels.html` shows a one-time VR pose notice whose Continue starts the session, and XR diagnostics are opt-in only. **Remaining:** on-device check on Quest.
- [ ] Define retention periods for staged uploads, job artifacts, published media, raw engagement events, recommendation sessions, impressions, dismissals, affinities, co-watch rows, messages, reports, logs, and anonymous identifiers.
- [ ] Extend account deletion to delete or irreversibly anonymize all recommendation sessions, impressions, requests, dismissals, affinities, co-watch data, and retained actor keys associated with the account.
- [ ] Add deletion tests proving a deleted account cannot be reconstructed from recommendation or analytics tables — **extend to messaging + billing tables per the two items above.**
- [ ] **New:** Add an ePrivacy **cookie-consent banner** gating the one-year anonymous tracking cookie (`auth.py:295`) for EU users — retention policy alone doesn't cover consent.
- [ ] Add a visible "Clear personalization" control and shorter documented retention for anonymous activity before relying on the one-year anonymous cookie.
- [ ] Decide whether anonymous history may ever be merged into a registered account; do not merge it without explicit documented product and privacy approval.
- [x] Document the moderation response process, escalation contacts, expected response time, appeal process, and content-removal procedure. **Done (2026-10-21):** `docs/moderation-runbook.md`; appeals arrive through `/support` and an admin applies `reinstate_user`.
- [~] **New:** Add a **DMCA/copyright takedown process** — contact address, repeat-infringer policy; users upload videos containing third-party music/media. **Process written (2026-10-21)** in `docs/moderation-runbook.md` §Copyright (notice contents, counter-notice, third-notice repeat-infringer rule, CDN purge). **Still open:** the notice address in Terms and whether a designated DMCA agent must be registered (lawyer).
- [ ] **New:** Add an **age gate** (13+/16+/18+ attestation or DOB) at registration — none exists.
- [x] **New:** Replace `window.prompt`-based report flows (reels.html, MessagingPanel, PackPage) with a real dialog — pack/user/post/comment reporting exists in the API (`ReportCreateRequest` covers `"pack"`), the UX is the gap. **Done (2026-10-21):** shared `ReportDialog` on the profile and pack pages and a native dialog in `reels.html`; `MessagingPanel` keeps its inline form.
- [ ] **New:** User-facing **refund policy** at the point of purchase (WalletPage states "never expire, non-transferable, no cash value" but nothing on refunds/disputes) + a dispute-evidence runbook for support.

### Registration and anti-abuse

- [x] For a public beta, add email verification and bot protection to registration. **Confirmed absent (2026-09-19):** zero email-verification machinery in the codebase. **Done (2026-10-21):** an account exists only after the emailed link is used (`20261022_0016`), plus Turnstile and a honeypot. Remaining before launch: set `SX_TURNSTILE_SITE_KEY` and `SX_TURNSTILE_SECRET` in production.
- [~] Until those controls exist, operate as invite-only/allowlisted or set `SX_REGISTRATION_ENABLED=0`. **Mechanism done; remaining: set `SX_REGISTRATION_ENABLED=0` + `SX_REGISTRATION_ALLOWLIST` in the production environment.** **Update (2026-09-20):** invite path implemented — `SX_REGISTRATION_ALLOWLIST` (comma-separated emails, case-insensitive) is honored while registration is closed (`social.py:80–121`, tested in `test_registration_allowlist.py`).
- [~] Verify account, messaging, reporting, following, upload, and recommendation-event rate limits under coordinated abuse. **Note:** comments/likes/follows/blocks/message-send/reports already carry limiters (verified); **packs and publish do not** (see cost-controls items above). **Update (2026-09-20):** packs and publish now carry limiters (those items checked off above); coordinated-abuse verification still open. **Partly done (2026-10-22):** `node scripts/verify_load.cjs --abuse` on local staging: login per account, report, follow, DM conversations, events and post views each returned 429 exactly at their documented limit +1, with no 5xx. Register was skipped because staging runs with registration closed: every request got 403 `REGISTRATION_DISABLED` before the limiter. The register limits are covered by `tests/test_email_verification.py`. Still open: a coordinated run from several IPs and accounts, and upload/publish limits under load.
- [~] **New:** Gate reel-reward claims on verified email + minimum account age; the per-IP cap has a `max(10, …)` floor that silently overrides lower config (`billing/service.py:894`) — remove the floor. Record a rewards-economics cost ceiling and go/no-go before enabling `SX_REEL_REWARDS_ENABLED`. **Partially done (2026-09-20):** floor removed (`reel_reward_ip_cap()`, min 1, tested). **Remaining:** email/age gating + economics ceiling + go/no-go. **Update (2026-10-21):** email verification now exists, so every active account has a verified address; the minimum account age is still open.
- [x] Add moderator alerts and dashboards for report spikes, spam registrations, abusive messaging, unusual generation spend, and storage growth. **Done (2026-10-21):** `GET /api/moderation/stats` and the Overview tab show 24 h and 7 d counts against the previous window, with spike flags (`SX_MOD_SPIKE_MIN`). Paging stays with Sentry and UptimeRobot.

## Production deployment and operations

### Secrets and environment

- [ ] Generate a long random value and set `SX_SECURITY_SECRET`.
- [ ] Generate a separate long random value for `SX_MESSAGE_ENCRYPTION_KEY`, store it in the deployment secret manager, and back it up. Do not rotate it without re-encrypting stored data.
- [ ] **New (2026-09-19):** Generate a third independent secret for `SX_FAL_KEY_ENCRYPTION_KEY` (≥16 chars, required before BYOK personal Fal keys; rotating it orphans all encrypted credentials — RUNNING.md §Credits).
- [ ] Store `FAL_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, SMTP credentials, and all other production secrets in the deployment secret manager rather than accepting them from a public UI.
- [ ] **New:** Set the three pack price IDs `SX_STRIPE_PRICE_500` / `SX_STRIPE_PRICE_1050` / `SX_STRIPE_PRICE_2750` (one-time USD Prices matching $5/$10/$25 exactly — see RUNNING.md) and set `SX_PUBLIC_BASE_URL` for Checkout redirects (distinct from `SX_PUBLIC_URL`, which email/social use).
- [ ] **New:** Decide and record the billing flag trio: `SX_CREDITS_ENABLED` / `SX_STRIPE_ENABLED` / `SX_REEL_REWARDS_ENABLED` — all default `0` and fail closed with `BILLING_MISCONFIGURED` 503 if secrets are placeholders (RUNNING.md §Credits). Keep all off until the Stripe test-mode + live-webhook walkthrough in RUNNING.md passes.
- [ ] If GIF search is enabled, configure `SX_TENOR_API_KEY`, `SX_TENOR_CLIENT_KEY`, and the narrowest practical `SX_TENOR_ALLOWED_HOSTS` list.
- [x] **New:** Record launch decisions for the reel-pack flags, which default **ON**: `SX_REEL_PACK_CREATION_ENABLED`, `SX_REEL_PACK_DISCOVERY_ENABLED`, `SX_REEL_PACK_IMMERSIVE_ENABLED`. **Decided 2026-10-20: all three ON for the beta**, set explicitly to `1` in `deploy/env.example` (not left to the code default).
- [ ] Set `SX_ADMIN_USERS` and/or `SX_MODERATOR_USERS` to the launch-team usernames or emails. Since `20261022_0017` these only bootstrap roles: sign-in never lowers a stored role, so demote in `/moderation` → USERS.
- [ ] Set `SX_PUBLIC_URL` to the deployed HTTPS website origin.
- [ ] Set `SX_COOKIE_SECURE=1` when serving over HTTPS.
- [ ] Keep `SX_PASSWORD_RESET_EXPOSE_TOKEN=0` outside local development.
- [~] ~~Keep `SX_TRUST_PROXY_HEADERS=0`~~ — **corrected 2026-09-19:** behind Cloudflare (the decided topology) every client IP is a CF egress IP, which collapses all IP-keyed rate limits into shared buckets. Set `SX_TRUST_PROXY_HEADERS=1` **and** restrict origin traffic to Cloudflare IP ranges so client-supplied forwarding headers can't be spoofed from the open internet.
- [x] Confirm `.env`, database files, keys, and generated secrets are excluded from version control and container images — **`.dockerignore` fixed 2026-09-19** (typo `venv/` → `.venv/`; added `data/`, `logs/`, `.models/`, `.stitch/`, tests/docs and other non-runtime trees). **Remaining:** verify the built image contents (`docker run --rm img ls /app`) in CI. **Added 2026-10-20:** the Dockerfile now copies an explicit allowlist (`server core pipeline migrations alembic.ini ui` + built static), `.dockerignore` excludes `**/node_modules`, `**/dist`, `video/`, `server/static*`, and the `docker` CI job asserts no `tests/`, `video/`, `.env` or `web/node_modules`, empty `data/` and `output/`, `server/static/index.html` present, non-root uid, working `ffmpeg`. Tick after the first green CI run. **Done:** CI green on `d7e5a0f` (2026-10-20), including the image-contents assertions.
- [x] **New:** Set `load_dotenv(override=False)` semantics — `server/app.py:26` currently uses `override=True`, so a stray `.env` in the image would beat `docker -e` secrets. **Done (2026-09-20):** environment now wins over `.env`.

### Database, storage, and workers

- [ ] Choose and document the supported production topology. **Decided 2026-09-19 — see "Infrastructure design verdicts" above:** single VPS (Hetzner Singapore by default, Hillsboro if the invite list is majority US — see verdicts → Region) + co-located PostgreSQL + Cloudflare R2 for published media; Fly.io, a second region and managed Postgres are later growth triggers, not launch choices. **Remaining work for that topology (2026-09-19 audit):** ship a `compose.yaml` (app + `postgres:16`, `pgdata` named volume, health-gated `depends_on`); document the full `docker run`/compose command including `-v data:/app/data` (the current RUNNING.md command mounts only `output/` — `docker rm` would destroy the DB and avatars); add a container entrypoint that runs `alembic upgrade head` before uvicorn (today first boot against an empty Postgres crash-loops: `init_database()` raises from lifespan). **Done 2026-10-20:** `compose.yaml` (app + `postgres:16` + `cloudflared` under `--profile tunnel`; named volumes `data`, `output`, `pgdata`; `service_healthy` gate; app on `127.0.0.1:8000` only), `deploy/entrypoint.sh` (migrate with retry, then one uvicorn worker with `--proxy-headers`), RUNNING.md compose section, and `docs/deploy-runbook.md`.
- [x] ~~**New:** Write and rehearse the SQLite→PostgreSQL **data** migration procedure~~ — **Obsolete 2026-10-20:** production launches on PostgreSQL from day one (verdicts → Database), so there is no live SQLite data to migrate. Only needed if a SQLite deployment ever holds real users.
- [ ] Run production on PostgreSQL from day one (verdicts above, revised 2026-10-20) — set `DATABASE_URL` explicitly, since `DEFAULT_DATABASE_URL` in `server/social/database.py` is still SQLite. SQLite remains for local dev and tests only.
- [ ] Because jobs and staged-upload registries are currently process-local, deploy exactly one application worker/replica (matches the single-VPS verdict); only replace them with a durable shared job queue and state store if/when moving to multi-machine later.
- [ ] Persist or externally store the production database, `data/avatars`, published media, and any paid job result that must survive a restart. The documented Docker command currently persists only `output/`. **Revised 2026-10-20:** published media and avatars go to Cloudflare R2 at launch (verdicts → Media storage); only private/unpublished job artifacts stay on the VPS disk, behind an owner-checked route, and need the `output/` volume. **Note:** staged uploads live in the container's `/tmp/square_extender_api/uploads` — lost on restart mid-job; document this as accepted behavior.
- [ ] Define storage lifecycle cleanup for abandoned uploads, failed jobs, expired drafts, proxies, previews, and deleted posts.
- [ ] Run automated database and media backups on a documented schedule — **specify:** cron'd nightly `pg_dump` (or WAL-G) to a private R2 bucket + documented retention; escrow `SX_SECURITY_SECRET`, `SX_MESSAGE_ENCRYPTION_KEY` and `SX_FAL_KEY_ENCRYPTION_KEY` off the box; one restore drill onto a fresh box before launch (also rehearses a region move). Published media in R2 needs no separate backup beyond its own durability; local private artifacts are covered by the retention policy. **Partial (2026-10-20):** `deploy/backup.sh` (host cron: `pg_dump -Fc` + `data/avatars` tarball streamed via `rclone rcat` to the private R2 bucket, optional `BACKUP_PING_URL`) and `docs/backup-restore-runbook.md`; 30-day retention is an R2 lifecycle rule. **Remaining:** install the cron on the VPS and escrow the three secrets.
- [~] Perform and record a full restore drill, including message decryption and media availability. Procedure: `docs/backup-restore-runbook.md` §Restore. **Local rehearsal passed 2026-10-20** (`docs/local-staging.md`: 108 s wipe-to-healthy, DM decrypts, media served). **Remaining:** the drill onto a second VM from real R2 backups.
- [x] Document deployment rollback, schema rollback limitations, and recovery from an interrupted migration. **Done (2026-10-21):** `docs/incident-response.md` §Rollback and §Migrations; deploys tag each image with its commit (`docs/deploy-runbook.md` §3).
- [x] **New (2026-10-16):** Fix the request-path DB pool deadlock (pre-existing on `main`, found in WebXR Earth QA). `get_optional_auth` kept the request session's connection checked out (it only committed when `last_used_at` was ≥300 s stale) while reels helpers opened a second `SessionLocal()` per call; ~15 concurrent signed-in requests held all 5+10 QueuePool connections waiting for another, starved every AnyIO worker (even `/api/health`), and in QA one request pinned a connection for 17+ minutes until restart. **Fix:** `get_optional_auth` commits on every path that queried (so `require_auth` endpoints — including the 30-minute `GET /api/messages/events` SSE stream — start with no connection held); `unavailable_media_paths_for_viewer`, `reel_records`, `metadata_for_paths`, and `scoped_media_paths` take an optional `db` that every `reels.py` route threads through (one request, one connection); the per-item `_get_comments_for_video` / `_get_meta_for_video` fallbacks no longer re-query after the batched lookup. **Tests:** `tests/test_db_pool_isolation.py` (peak checkouts per request ≤ 1 across the affected endpoints, concurrent signed-in requests on a `pool_size=1` pool, auth releases its connection, no per-item retries) — fail on `main`, pass with the fix, on SQLite **and PostgreSQL 15** (local throwaway cluster via `SX_TEST_POSTGRES_URL`). `tests/conftest.py` now points the global `SessionLocal` fallback at a throwaway DB so tests never read the developer's `data/echo.db`. **Still open:** `/api/reels/tags` and `/api/reels/locations` (no auth, no request session) open helper sessions sequentially — safe, but not yet single-session (`GET /api/search/suggestions` was the unsafe caller — see the last item below). ~~`_metadata_snapshot` / `_get_meta_for_video` still fall back to fabricated `_seed_meta` engagement when the database lookup fails~~ — fixed, see next item.
- [x] **New (2026-10-16):** Never fabricate reel metadata when the social-database lookup fails. `_metadata_snapshot` and `_build_payload` swallowed any exception from the batched `metadata_for_paths` / `reel_records` lookup and fell back per item to legacy JSON or `_seed_meta`, so during pool starvation published posts were served with invented tags, location, likes and views (and no `post_id` / viewer state). **Fix:** a `SQLAlchemyError` from the lookup now raises **503 + `Retry-After: 5`** (`_reel_data_unavailable` in `server/routers/reels.py`); other exceptions propagate as 500 instead of being swallowed. Chosen over zeroed metadata because a failed lookup cannot tell a published post from a local file: zeros would still be invented numbers (and empty tag/location/Earth-heat results that look real), drop `post_id` so like/comment/save break, and mask the outage. Frontend fetches already catch errors. The legacy JSON / `_seed_meta` fallback is unchanged for paths the database answered have no published post (local, unpublished `output/` files). **Tests:** `tests/test_reels_metadata_failures.py` (real pool-timeout starvation for both helpers, 503 across `/api/reels`, tags, locations and Earth activity routes with no seeding, success-path DB rows + legacy fallback) — fail on the previous code, pass with the fix.
- [x] **New (2026-10-16):** Never cache a reels scan built without the slide filter. `_scan_cached` swallowed any `slide_media_paths` failure, fell back to `set()` and cached that scan for `_SCAN_TTL` (10 s), so every request in that window — even with the database healthy again — served the extra images of multi-image posts as standalone tiles; a slide is not any post's `media_path`, so `_build_payload` → `_get_meta_for_video` → `_seed_meta` gave them fabricated tags, location, likes and views. **Fix:** a `SQLAlchemyError` from the slide lookup now raises the same **503 + `Retry-After: 5`** (`_reel_data_unavailable`) and invalidates the cache timestamp, so nothing unfiltered is cached and the next request retries the lookup (a previous filtered scan is kept, never replaced); other exceptions propagate. **Tests:** `tests/test_reels_scan_slide_failures.py` (failed slide lookup neither caches nor seeds slide tiles across a 503 → healthy request pair, real pool-timeout starvation, stale-cache refresh, non-DB errors propagate, 503 on every `_scan_cached` route) — fail on the previous code, pass with the fix.
- [x] **New (2026-10-16):** `GET /api/search/suggestions` was a nested pool-hold: it queried its request `db`, then called the `/api/reels/tags` route function with no `db`, so `unavailable_media_paths_for_viewer(None)`, `_scan_cached()` (→ `slide_media_paths`) and `_tag_catalog` (→ `metadata_for_paths`) each opened a second `SessionLocal()` while the request connection was still checked out — the same hold-and-wait that caused the QueuePool deadlock. **Fix:** the body of `list_reel_tags` moved into `tag_suggestions(q, limit, db=None)` in `server/routers/reels.py`; the `/api/reels/tags` route keeps its signature and calls it without a session (sequential, safe), `search_suggestions` passes its own `db` (one request, one pooled connection). A failed reels lookup still surfaces from the suggestions route as **503 + `Retry-After: 5`**. **Tests:** `tests/test_db_pool_isolation.py` — peak checkouts ≤ 1 for `/api/search/suggestions` (with and without a query), 6 concurrent requests on a `pool_size=1` pool, and a failed `metadata_for_paths` / `slide_media_paths` lookup returning 503 with the connection released — fail on the previous code, pass with the fix. `/api/reels/tags` and `/api/reels/locations` stay not-yet-single-session (they have no request session of their own).
- [x] **New:** Graceful shutdown — lifespan teardown currently only cancels the cleanup task; `ThreadPoolExecutor` pools are never shut down, so SIGTERM kills in-flight ffmpeg mid-write. Drain pools on shutdown; document restart-during-job behavior (reservation reconciliation at next boot already exists — `app.py:52–53` — but is undocumented). **Done (2026-10-21):** shutdown refuses new jobs (503 `SHUTTING_DOWN`), cancels and refunds queued ones, gives running ones `SX_SHUTDOWN_DRAIN_S` (15 s; compose `stop_grace_period: 45s`); boot re-queues up to 50 posts with missing previews or posters. Checked on staging 2026-10-21: a restart mid-encode drains, and the boot re-queue finishes the preview.
- [~] **New:** Container hygiene — **non-root done 2026-10-20** (`USER app`, uid 10001, `/app/data` and `/app/output` pre-owned for named volumes); remaining: pin the base image digest + ffmpeg version, and split Streamlit out of the production requirements (it bakes pyarrow et al. into the prod image). Also standardize dev/prod interpreters (repo `.venv` is CPython 3.14; the image is 3.12). **Update (2026-10-21):** base images are pinned by digest, Dependabot has a docker ecosystem, `.python-version` is 3.12, and `COPY ui/` is reduced to `ui/assets/`. Streamlit was already split into `requirements-streamlit.txt`. ffmpeg is not pinned to an exact Debian version; CI asserts major version 7.

### Network and application hardening

- [ ] Terminate HTTPS at a trusted proxy and configure HSTS after HTTPS behavior is verified. **Note:** Quest Browser requires a secure context for WebXR — the physical-Quest gate below depends on HTTPS being live (or the `adb reverse` localhost workflow from `docs/threejs-vr-implementation-plan.md` §6).
- [~] Configure trusted-host validation and production security headers, including CSP, `X-Content-Type-Options`, and a suitable referrer policy. **Add `script-src 'self'`:** the reels player mount injects server-rendered HTML/scripts into the SPA DOM unsandboxed (`ReelsPlayer.jsx:95–110`) — currently safe (feed JSON escaped, user text via `textContent`), but CSP makes a future template regression non-exploitable. **Done (2026-10-21) except trusted-host:** `server/security_headers.py` sets nosniff, Referrer-Policy, X-Frame-Options, COOP and Permissions-Policy on every response, plus a nonce + `'strict-dynamic'` CSP. **Decision: report-only for the beta** (`SX_CSP_MODE=report`, reports logged via `POST /api/csp-report`). **Before public launch:** switch to `SX_CSP_MODE=enforce` once the logs show no `csp-report` lines from real use. Host validation is left to the Tunnel (only cloudflared reaches the app).
- [ ] Restrict production CORS origins — **override `SX_DEV_ORIGINS` explicitly** (it defaults to `http://localhost:5173,http://127.0.0.1:5173` in `app.py:95`).
- [ ] **New (2026-09-19):** Cloudflare-specific edge config — Cache Rule bypass for `/api/*` (CF caches/compresses by extension); **revised 2026-10-20:** published media is served from R2 on `media.<domain>` with a Cache Everything rule (not `r2.dev`), and the origin's `/media/*` route serves only private owner-checked artifacts (bypass cache) — never proxy self-hosted video through the CF CDN (2026-09-28 terms); Rocket Loader + minify off for the SPA, and note the 15s SSE keep-alive sits safely under CF's ~100s idle timeout. `X-Accel-Buffering: no` covers nginx, not Cloudflare. **Documented 2026-10-20:** dashboard checklist in `docs/deploy-runbook.md` §1 (Tunnel, R2 `apac` buckets, bucket CORS, static-ACAO Transform Rule on `media.<domain>`, `/api/*` bypass except map tiles, Always HTTPS); edge checks in `docs/manual-beta-checks.md` §1. Tick once applied in the dashboard.
- [ ] Disable buffering for `/api/messages/events` and keep SSE connections open beyond the 15-second keep-alive interval.
- [x] Protect or disable production diagnostic endpoints. Do not let anonymous users overwrite or read global headset telemetry. **Done (2026-10-20):** `/api/reels/diag` (GET/POST) and `/api/reels/vr-video-path-ab` return 404 in production (`9e76de3`); the player only posts diagnostics behind a debug opt-in (`1a5a5bc`).
- [ ] Rate-limit outbound model-information lookups and other endpoints that can force network or transcoding work.
- [ ] Run dependency, secret, and vulnerability scans and resolve release-blocking findings.

### Health, monitoring, and support

- [x] Split cheap liveness from readiness checks — **sharpened (2026-09-19):** today's `/api/health` runs ffmpeg smoke probes cached 60s and **never touches the DB or `alembic_version`** (`health.py:43–72`), so the Docker HEALTHCHECK passes with a dead Postgres; the uncached probe burst can also exceed the 5s HEALTHCHECK timeout. Add `/api/healthz` (process) vs `/api/readyz` (`SELECT 1` + schema revision + writable storage) and point the HEALTHCHECK at the cheap one. **Done (2026-10-20, `b78cdd0`):** `/api/healthz` (no I/O) and `/api/readyz` (DB, schema revision, writable output, free disk → 503); HEALTHCHECK points at `/api/healthz`.
  - **Follow-up (2026-10-22, `caf5613`):** under 100 load-test users the sync `/api/healthz` waited for a threadpool slot (p95 2.2 s, max 3.3 s, against the 4 s probe timeout). It is now `async` and answers on the event loop. The HEALTHCHECK timeout is 10 s (probe 8 s), and compose runs the app with `init: true` so orphaned children are reaped. `/api/health` rebuilds its probes one at a time and serves the previous snapshot meanwhile. **Verified on staging:** `Init=true`, 0 `<defunct>` processes, healthz p95 0.19 s (max 2.0 s, 40 samples) during a 50-user run.
- [x] Make readiness verify database connectivity/schema revision, writable storage, required encryption configuration, and other critical dependencies without launching expensive probes on every request. **Done (2026-10-20, `b78cdd0`):** see above; encryption config is enforced at boot by `production_config_errors()` instead.
- [x] Add structured request logs, correlation/request IDs, centralized error tracking, and redaction of credentials and private recommendation context. **Baseline is near-zero (2026-09-19):** ~4 `logging` call-sites total, no formatter/config, no request-log middleware; the `_cleanup_loop` swallows exceptions silently. Add minimal structlog + log sweep failures. (No emails/tokens found in logs today.) **Done (2026-10-21):** `server/observability.py` — `X-Request-ID` on every response, `request_id` on every log line and Sentry event, JSON logs (`SX_LOG_FORMAT`), one `sx.access` line per request without client IP or query string; uvicorn's own access log is off.
- [x] Monitor HTTP error rate, latency, queue depth, worker utilization, database locks/connections, disk usage, SSE disconnects, event-attribution failures, and recommendation page failures. **Done (2026-10-22):** `server/metrics.py` keeps a per-process 5-minute window fed by the access log (count, 5xx, p50/p95 per route template), plus job queue queued/running/capacity, DB pool checked-out/capacity, open SSE streams, disk, and counters for failed jobs, failed derived encodes, full queues, recommendation attribution failures and reel-data 503s. Admin-only `GET /api/ops/metrics` and an Operations block on the Moderation Overview. **Gaps:** no Postgres lock view (pool exhaustion and reel-data 503s are the proxy); SSE shows open streams and 429s by route, not disconnect counts.
- [x] Alert on FAL spend, storage exhaustion, backup failure, elevated report volume, registration spikes, and repeated processing failures. **Done (2026-10-22):** a watchdog in the app lifespan checks every `SX_ALERT_INTERVAL_S` and logs `ALERT <key>` once per `SX_ALERT_COOLDOWN_S` for 5xx rate, p95, a full queue, an exhausted DB pool, repeated processing failures and report/sign-up spikes; low disk was already an error log. Sentry turns those logs into events (`docs/incident-response.md` §Alerts). FAL spend stays on the fal.ai dashboard and backup failure on healthchecks.io (`docs/deploy-runbook.md` §Alerts). The Sentry alert rule is set at deploy.
- [x] Define an on-call owner, incident procedure, public support/contact channel, and rollback decision criteria for the beta. **Note:** no in-app support/contact surface exists (`AppShell.jsx` has no help link) — add a footer mailto/link so users can appeal moderation, request refunds, or submit DSARs. **Done (2026-10-21):** `docs/incident-response.md` (single operator on call, SEV levels, rollback); `/support` inbox with `SX_SUPPORT_EMAIL` notification.

## Build, migration, and automated release gates

- [x] Create CI that installs dependencies from a clean environment and runs the scoped website checks on every release candidate. **Add a Docker build gate (2026-09-19):** `requirements.txt` was fixed today (`vapoursynth==78` has no manylinux wheel and previously failed the Linux build — now scoped `sys_platform != "linux"`; the container deliberately runs without the Studio engine); CI must prove `docker build` stays green. **Added 2026-10-20:** `.github/workflows/ci.yml` — `test` (py3.12, node 22, apt ffmpeg, `make test`), `postgres` (`postgres:16` service, `alembic upgrade head`, `tests/test_db_pool_isolation.py` via `SX_TEST_POSTGRES_URL`), `docker` (build + image-content assertions). **First green run 2026-10-20** (run 39391990177, all three jobs). **Local 2026-10-20:** `docker build` and the `docker` job's assertions pass on arm64 (see "Latest recorded automated verification").
- [ ] Run `make test` in the normal project `.venv` and record the exact commit and dependency versions. (`.venv` exists again as of 2026-09-19, Python 3.14.6 — but standardize on 3.12 to match the image; see container-hygiene item.)
- [ ] Run `make build` and deploy the generated frontend from the same tested commit.
- [ ] Run Python compilation and frontend/inline JavaScript parse checks.
- [ ] Run `make migrate` on a production-like database and verify the schema reaches **`20261022_0017`** (source of truth: `EXPECTED_SCHEMA_REVISION` in `server/social/database.py:14`).
- [ ] Test fresh database creation, upgrade from the oldest supported production schema, failed-migration recovery, and backup restoration.
- [~] Test the chosen production database rather than relying only on SQLite test runs — **priority:** re-run the billing suite and the recommendation concurrency tests (`tests/test_recommendations.py -k concurrent`, currently SQLite-fixture-only) against PostgreSQL. **Partial (2026-10-16):** the DB-pool isolation tests take `SX_TEST_POSTGRES_URL` and passed 13/13 on a local PostgreSQL 15.15 cluster; billing and recommendation concurrency fixtures are still SQLite-only. **Update (2026-10-21):** the recommendation concurrency tests run on Postgres in CI; the billing suite on Postgres is not re-run.
- [ ] Require CI success, migration success, a clean worktree, and an approved release checklist before deployment.

## Functional, concurrency, and device verification

- [ ] Send a real password-reset email and verify the deployed reset link.
- [ ] With two real accounts in separate browser sessions, test message request routing, accept/decline, all message types, unread/read receipts, reconnect, deletion, blocking, reporting, and ten-recipient reel sharing.
- [ ] Open a copied or QR reel link while logged out and confirm `/reels?post=<id>` opens only the intended active public reel.
- [ ] Smoke-test registration, email verification, login/logout, profile editing, avatar replacement, post publishing/editing/deletion, Saved links, following, blocking, reporting, moderation, password reset, personalization reset, and account deletion. **Extend (2026-09-19):** also cover Reel Packs (create → publish → discovery → unlisted share → XR), the credits wallet (quote → reserve → capture → refund → reconciliation), and BYOK personal Fal keys — none were in the pre-2026-09-12 list.
- [ ] Test simultaneous upload, processing, polling, downloading, publishing, and recommendation pagination from multiple accounts.
- [~] Load-test feed pagination, event ingestion, authentication, messaging SSE, uploads, jobs, and database writes at the expected beta concurrency plus safety margin. **Run (2026-10-22, local staging, one uvicorn worker, Docker on 8 CPUs):**
  - 50 virtual users for 30 s: 1,517 requests, 0 5xx, 0 network errors, all 8 message streams open. p95 was 2,039 ms, over the 1,500 ms target (feed p95 2.7 s).
  - 100 users for 60 s: 3,517 requests, 0 5xx. p95 3.2 s. `/api/readyz` stayed 200 (slowest 3.1 s), and the container stayed healthy.
  - Throughput tops out near 50–60 requests/s. The app runs at about 150% CPU, Postgres at 25%, app memory at 220 MiB.
  - A feed request costs about 34 ms of CPU, and requests are served one at a time. p50 grows linearly: 34 ms at 1 concurrent, 390 ms at 10, 946 ms at 25. p95 stays under 1.5 s up to about 25 concurrent feed requests.
  - The watchdog logged `ALERT db_pool` (15 of 15 connections checked out) and `ALERT p95` during the 50-user run. No checkout timed out.
  - **Open:** set the expected beta concurrency, then decide between feed CPU work, more workers (blocked by the in-process job queue), or a larger box. Uploads and publishing were not part of the load mix.
  - **Feed CPU work (2026-10-22):** the load mix calls `/api/feed`, not `/api/reels/feed`. `/api/feed` ran 3 viewer-state queries per card. It now runs them once per page (`viewer_post_state`) and loads slides with `selectinload`: 39 to 7 queries for a 12-item page. In-process handler CPU fell from about 22 ms to 7 ms. Measured as uvicorn CPU for sequential requests: feed 12–21 ms, view 5–18 ms, event 5–13 ms, messages bootstrap 7–8 ms. These swing 2–3x with host load (load average 15–30 on 8 CPUs).
  - After the feed fix, 50 users for 30 s, 0 5xx in every run: p95 1,902 ms (1,581 requests), 1,803 ms (1,709 requests), 2,208 ms (1,409 requests). Still **FAIL** against 1,500 ms.
  - Under load the app uses 135–140% CPU at about 57 requests/s. That is about 31 ms of CPU per request (21 ms user, 10 ms kernel), against about 8.5 ms for the same mix one request at a time. Most of the remaining cost comes from concurrency (40 sync threads contending for the GIL and the 15-connection pool), not from one endpoint.
  - Next candidates: cap the sync threadpool near the DB pool size (needs a staging experiment); sweep `rate_limit_events` older than 2 days at most once a minute, not on every `rate_limiter.check` (2 of the 14 queries in each view/event); `/api/reels/feed` (34 queries per page, not in this load mix).
  - Re-check (2026-10-22): `/api/feed` liked, saved and following flags matched the database on every item (discover and following, as bob with 2 likes, 2 saves and 1 follow; anonymous all false). A fourth 50-user run: p95 1,935 ms over 1,609 requests, one 502.
  - **Open:** that 502 was `POST /api/events`, `connection reset by peer` from the app to Caddy after 67 ms. uvicorn closes idle keep-alive connections after 5 s (its default), while Caddy reuses upstream connections for up to 2 minutes, and Caddy does not retry a `POST`. Fix: keep uvicorn's keep-alive longer than the proxy's (`--timeout-keep-alive`), or shorten Caddy's upstream `keepalive`. Check the production proxy too.
- [~] Confirm queue saturation produces controlled `429`/`503` responses and does not exhaust memory, disk, threads, database connections, or FAL budget. **Partly done (2026-10-22):** `node scripts/verify_load.cjs --queue --video <square clip>` submits free jobs (square clip, upscale only, `fast` engine: no fal call, no credits).
  - The third job for one user got 429 `QUEUE_FULL` with `Retry-After: 60`. Six active jobs across alice, bob and dave were all accepted.
  - Every cancel returned 202, and every job ended. `/api/readyz` stayed 200, and app memory stayed near 220 MiB.
  - Not driven: the server-wide `SX_MAX_PENDING_JOBS` 429. It needs a fourth signed-in account, and staging registration is allowlist-only. It is covered by `tests/test_job_limits.py`.
  - Cancel takes effect only between stages. A cancelled running job keeps its slot until the current ffmpeg step ends: about 3 minutes for a 4 s clip upscaled and previewed at 2160p.
- [ ] Test process restart during queued/running/completed jobs and confirm the documented recovery behavior.
- [~] Test current Chrome, Safari, Firefox, mobile browsers, and the supported Quest Browser/device matrix. **Partly done (2026-10-22):** `docs/browser-matrix.md`. Scripted page checks passed on Chrome 155 (headless and headed), real Firefox 158 and Chrome iPhone/Android/tablet emulation, collecting console and CSP errors. Safari 26.2 passed signed-out pages only, because the local Caddy CA is not trusted. Still open: signed-in Safari, real iOS and Android devices, Quest, and interactive flows (auth, upload, messaging, reels actions).
- [ ] Validate Reels autoplay/manual navigation, audio, next-page preloading, negative feedback, creator suggestions, canonical links, and profile navigation on a physical Quest device. **Extend (2026-09-22, Earth Zoom Map):** on-device pass for the zoomable globe — tap-to-zoom vs tap-to-select feel at the city band, grip+stickY zoom comfort (object-motion only, ≤500 ms eases), `OPEN FEED`/`ZOOM OUT`/`GLOBE RESET` dock reachability, tile sharpness to street level, heat-blob legibility over tiles, and the `MAP OFFLINE — CITY VIEW` fallback with Wi-Fi dropped.
- **Note (2026-10-04):** OSM's tile servers blocked the dev machine's proxy (TLS reset + "Access blocked" placeholder). Default stays OSM (owner decision: Esri looked worse and needs a commercial plan); the decision below is now a choice of *paid* provider before launch.
- [x] **New (2026-09-22, Earth Zoom Map tile provider):** pre-launch decision — stay on OSM tile-policy limits (compliant UA + disk cache already in place) or swap `SX_MAP_TILES_URL` to a paid MapTiler/Mapbox endpoint (no code change). Either way, carve `/api/reels/map-tiles/*` out of the Cloudflare `/api/*` cache-bypass above (tiles are immutable with a 7-day `Cache-Control`; bypassing forces every zoom through origin and risks tripping OSM limits). **Decided 2026-10-21: keep OSM for the beta** (`docs/deploy-runbook.md` Cloudflare checklist); the carve-out is already in the runbook. Switch `SX_MAP_TILES_URL` / `SX_MAP_LABELS_URL` before the public launch.
- [~] Verify keyboard navigation, focus visibility, reduced-motion behavior, readable contrast, captions/accessible alternatives where applicable, and responsive layouts. **Decision needed:** no caption/WebVTT capability exists anywhere (`ReelsPlayer.jsx`, VR modules) — declare captions out-of-scope for beta or build VTT support. **Decided 2026-10-21:** captions out of scope for the beta. **Partly done (2026-10-21):** `docs/accessibility-pass.md` (keyboard, names, contrast, focus on 11 pages in Chrome); screen readers, 375 px and reduced motion on every page are open. Captions stay out of scope.
- [x] **New:** Gate `/reels/immersive-preview` — it is currently unauthenticated (`App.jsx:36`, no `RequireAuth` wrapper) despite being a creator desktop tool; wrap it or tie it to `SX_REEL_PACK_IMMERSIVE_ENABLED`. **Done (2026-09-20):** wrapped in the existing `RequireAuth` (logged-out redirects to login); `vite build` clean.
- [~] Run a final moderation drill using real reports, blocks, content removal, account suspension, appeal handling, and audit evidence. **Staging drill done (2026-10-22):** all steps passed on local staging (`docs/moderation-runbook.md` §Drill log). One display bug was fixed. **Both drill gaps fixed (2026-10-22, `7873e99`):** a suspended account with the right password now gets 403 `ACCOUNT_SUSPENDED` and an "Appeal on the Support page" link (a wrong password is still a plain 401), and each report shows `HANDLED BY`. Checked on staging by suspending and reinstating dave. **Remaining gaps fixed (2026-10-22, staff console):** reports have a CLAIM step (409 `REPORT_CLAIMED` for a second moderator, 30-minute expiry, audited admin override), and every action, including `reinstate_user`, is recorded in the report history and the `staff_actions` audit log. Repeat on the production stack before invites, including the Cloudflare purge.

Automated Meta documentation and device verification remain unavailable on the current Linux host because `metavr` does not publish a `linux-x64` binary. Physical Quest verification remains a release gate. This document does not claim current Meta Horizon Store compliance requirements.

## Existing pre-Alembic database only

Do not use this procedure for a blank database.

- [ ] Confirm the old social tables exist and `alembic_version` does not.
- [ ] Back up `data/echo.db`.
- [ ] Run `.venv/bin/python -m alembic stamp 20260910_0001`.
- [ ] Run `make migrate` and confirm the final revision is **`20261022_0017`**.

## Suggested production environment

This is a starting point, not a substitute for implementing the controls above.

```env
FAL_KEY=<deployment-secret>
DATABASE_URL=postgresql+psycopg://<user>:<password>@<host>/<database>

SX_SECURITY_SECRET=<long-random-secret>
SX_MESSAGE_ENCRYPTION_KEY=<different-long-random-secret>
SX_FAL_KEY_ENCRYPTION_KEY=<third-independent-long-random-secret>
SX_REGISTRATION_ENABLED=0
SX_REGISTRATION_ALLOWLIST=<invited-email-1,invited-email-2>
SX_STRIPE_ENABLED=0
SX_CREDITS_ENABLED=0
SX_REEL_REWARDS_ENABLED=0

# Cost/abuse controls (all have code defaults; set explicitly per launch)
SX_FAL_MAX_QUOTE_USD=10
SX_QUOTE_RPM=15
SX_PACK_CREATE_HOURLY=10
SX_PUBLISH_HOURLY_MAX=5
SX_PUBLISH_DAILY_MAX=20
SX_STRIPE_WEBHOOK_MAX_BYTES=1048576
SX_STRIPE_WEBHOOK_RPM=120
SX_SSE_MAX_CONN=8
SX_SSE_MAX_MIN=30
SX_REEL_REWARD_IP_DAILY_CLAIMS=50

# Stripe (only needed when SX_STRIPE_ENABLED=1; test mode first — see RUNNING.md)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
SX_STRIPE_PRICE_500=
SX_STRIPE_PRICE_1050=
SX_STRIPE_PRICE_2750=
SX_PUBLIC_BASE_URL=https://your-domain.example

SX_TENOR_API_KEY=
SX_TENOR_CLIENT_KEY=echo_reels
SX_TENOR_ALLOWED_HOSTS=media.tenor.com,media1.tenor.com

# Reel Pack rollout flags default ON — record an explicit launch decision
SX_REEL_PACK_CREATION_ENABLED=1
SX_REEL_PACK_DISCOVERY_ENABLED=1
SX_REEL_PACK_IMMERSIVE_ENABLED=1

SX_ADMIN_USERS=<admin-username-or-email>
SX_MODERATOR_USERS=
SX_PUBLIC_URL=https://your-domain.example
SX_COOKIE_SECURE=1
SX_TRUST_PROXY_HEADERS=1
SX_DEV_ORIGINS=
SX_PASSWORD_RESET_EXPOSE_TOKEN=0

SX_SMTP_HOST=
SX_SMTP_PORT=465
SX_SMTP_USERNAME=
SX_SMTP_PASSWORD=
SX_SMTP_FROM=
SX_SMTP_SSL=1
SX_SMTP_STARTTLS=1
```

Keep `SX_REGISTRATION_ENABLED=0` for an invite-only deployment until public-registration verification and anti-bot controls are implemented. Keep `SX_STRIPE_ENABLED=0` until retention is proven and the credit-pack price floor is fixed (see "Infrastructure design verdicts → Payments": the $5 pack loses ~33% of gross margin to fees at 8.9% effective rate). `SX_TRUST_PROXY_HEADERS=1` is correct for the decided Cloudflare-in-front topology — restrict origin traffic to Cloudflare IP ranges at the firewall so forwarded headers can't be spoofed.

## Completed implementation

- [x] Saved-post navigation fix.
- [x] Post edit/delete controls and ownership checks for database-backed posts.
- [x] Explicit Alembic migrations and startup schema revision validation.
- [x] Blocking and blocked-content filtering.
- [x] User, post, and comment reporting.
- [x] Moderator report queue and moderation actions.
- [x] Password reset and the initial account-deletion flow.
- [x] Database-backed authentication throttling and trusted-proxy opt-in.
- [x] Staff console on `/moderation` (2026-10-22, schema `20261022_0017`). It adds USERS, CONTENT and AUDIT tabs, report claims, an immutable `staff_actions` audit log, direct suspend, sign-out and reinstate, roles stored in the database with the env vars as bootstrap, content remove and restore, admin credit adjustments, and admin account deletion. API: `server/routers/admin.py`. Runbook: `docs/moderation-runbook.md` §Staff console.
- [x] Moderation overview as a dashboard, report cards with a live preview of the post or comment and the reporter note, and admin restore of removed posts (2026-10-22). A restored post re-uploads its kept local media before the database commit; if the commit then fails, the uploaded objects stay public but unreferenced. Staging UI pass 32/32 (desktop and 375 px): remove a post (media 404), restore it from the report card (media 200, status published), restore a comment, both audited.
- [x] Avatar upload dimension protection.
- [x] Backend profile/safety integration tests.
- [x] Frontend Saved-link regression tests.
- [x] Production frontend build and syntax validation.
- [x] AES-GCM encrypted direct messages and encrypted message-report evidence.
- [x] Message requests, durable SSE delivery, unread/read state, deletion, and blocking behavior.
- [x] Text, emote, optional Tenor GIF, and reel messages.
- [x] Canonical link, clipboard, native share, QR PNG, and one-to-ten-recipient reel sharing.
- [x] Responsive messages page, compact dock, profile entry point, and immersive-mode hiding.
- [x] Personalized Reels pagination, recommendation impressions, explicit negative feedback, and creator-suggestion APIs.
- [x] Recommendation attribution defenses for stolen cursors, cross-actor impressions, duplicate visibility, and duplicate terminal events.
- [x] Invite-only registration allowlist (`SX_REGISTRATION_ALLOWLIST` honored while closed; 2026-09-20).
- [x] Security/money hardening batch (2026-09-20): admin-gated reels proxy/spatialize, publish ownership + caps, Civitai hostname allowlist + per-job quote cap, signed anon cookies, webhook caps, quote/pack/publish/SSE rate limits + probe cache, login timing alignment, staged-image pixel ceiling, Fal-key entropy assert, `FalCredential` deletion on account closure.
- [x] Prod-env fixes (2026-09-20): `load_dotenv(override=False)`, immersive-preview behind auth, rewards IP floor removal.

## Latest recorded automated verification

**2026-10-22 staff console (local staging, schema `20261022_0017`):**

- `make test`: backend **605 passed, 7 skipped**; vitest **461 passed** (39 files); `npm run build` clean.
- `scripts/verify_staging.cjs` **25/25** on the rebuilt image.
- Admin API drive over HTTPS: **39/39**. It covered search, direct suspend (dave's sign-in got 403 `ACCOUNT_SUSPENDED`), reinstate, comment remove and restore, post removal (media 404), +50/−50 credits to bob, report claim (409 for the second moderator) and audit rows for every step.
- Headless Chrome UI pass as alice (admin) and bob (moderator via the console role change), desktop 1440 px and iPhone 375 px: **48/48**. Checks: STAFF entry in the account menu, tab visibility per role, user detail actions per role, the sign-out dialog end to end, CONTENT and AUDIT rows, claimed report rows, no horizontal scroll, no console errors.
- Fixed during the pass: `.sx-pk-dialog` was transparent outside the Pack page because `--pk-panel` is scoped to `.sx-pk`. This also affected the report dialog on profiles. Audit rows no longer repeat the report id.
- Staging runs with `SX_LOGIN_RATE_LIMIT=0` so scripted runs can sign in repeatedly. Production refuses to boot with it unless `SX_PUBLIC_URL` is a localhost URL.
- Seen, not fixed: `POST /api/image/upload` answers 500 (PIL `UnidentifiedImageError`, `server/routers/image.py:81`) for a non-image file instead of 4xx.

**2026-10-22 follow-ups (health, moderation drill gaps, feed CPU; local staging):**

- `make test`: backend **590 passed, 6 skipped**; vitest **446 passed** (38 files).
- Health (`caf5613`): container runs `docker-init` as PID 1, the HEALTHCHECK uses `/api/healthz` with a 10 s timeout, 0 `<defunct>` processes. During a 50-user run, healthz p95 was 0.19 s over 40 samples.
- Moderation (`7873e99`): bob reported dave and alice suspended him. dave's sign-in then got 401 `INVALID_CREDENTIALS` for a wrong password and 403 `ACCOUNT_SUSPENDED` for the right one. The login page showed the message and the `/support?category=appeal` link (Chrome screenshot). After reinstatement, the report listed `handled_by: alice` in the API and `HANDLED BY: @alice` on `/moderation`. dave is active again.
- Feed: the viewer-state flags on `/api/feed` matched the database, as recorded under the load-test item. The 50-user p95 is still over target (1,935 ms), with one keep-alive 502, also recorded there.

**2026-10-22 load, abuse, queue, browser matrix and monitoring (local staging, schema `20261022_0016`):**

- `scripts/verify_load.cjs`: results are under the load-test, abuse and queue-saturation items above. Summary: no 5xx at 50 or 100 virtual users, but p95 was over 1.5 s from about 25 concurrent feed requests. Abuse limits held. The per-user queue cap and cancel worked.
- Browser matrix (`docs/browser-matrix.md`): Chrome 155 headless and headed passed 13 of 13 pages, real Firefox 158 passed 13 of 13, and Chrome phone and tablet emulation passed 38 of 39. Safari 26.2 passed only the signed-out pages.
- CSP: the scripted Chrome and Firefox runs (reels playback, explore, messages page, moderation) logged no `csp` lines in about 3 hours. Not yet covered: a stereo reel, Earth city zoom, and sending messages in the DM UI.
- Monitoring: `/api/ops/metrics` tracked the load runs. The watchdog raised `ALERT db_pool` and `ALERT p95` while they ran.

**2026-10-21 P1 workstreams (T1–T6) merged into `3dreels`:**

- Backend **521 passed, 3 skipped** (`pytest -q tests`); vitest **405 passed** (34 files).
- Local staging rebuilt at schema `20261021_0015`: `node scripts/verify_staging.cjs` **25/25** (now also asserts `X-Request-ID`, security headers and the report-only CSP nonce on `/` and `/api/healthz`). Logs are JSON with `request_id`, no `csp` report lines, no uvicorn access lines (fixed during the sweep: `configure_logging()` had re-enabled them, client IP included).
- Manual staging checks (API-driven, 2026-10-21):
  - Signed-out appeal: `POST /api/support` 202; Mailpit got `[ECHO support] appeal: …` with the request ID and without the body; alice saw it under `GET /api/moderation/support` and closed it.
  - Deleted-account DMs: carol (throwaway invite) DMed alice, alice reported the message, carol deleted her account. Alice no longer lists the conversation, unread went 1 → 0, GET and send on it return 404; the report still shows the message evidence and `resolve` works.
  - Restart during encode: `--time-publish` with a 93.6 MB 4K HEVC clip, `docker compose restart app` while the preview encoded. Shutdown logged `Drained derived encodes: {'dropped': 0, 'running': 1, 'unfinished': 1}` after the 15 s drain; the next boot logged `Re-queued derived assets for 1 posts at boot`, and the preview landed 203 s after publish.

**2026-10-20 P0 workstreams merged into `3dreels` (`b62ae4b`):**

- `make test`: backend **448 passed, 2 skipped** (`pytest -q tests`); web node tests **359 passed**; vitest **395 passed** (33 files).
- Local `docker build --build-arg GIT_SHA=b62ae4b… -t echo-app:ci .` on Docker Desktop (arm64): **green**, image 1.17 GB (`/app` 16 MB, site-packages 594 MB, mostly Streamlit/pyarrow — see the container-hygiene item).
  - **Network note:** the dev network hijacks Docker Hub DNS (`registry-1.docker.io` resolves to a 100.60.x.x CGNAT address, TLS fails with `tlsv1 alert protocol version`). Workaround used: `docker pull mirror.gcr.io/library/node:22-slim` and `mirror.gcr.io/library/python:3.12-slim`, then `docker tag` them to the Hub names. The Dockerfile is unchanged; GitHub runners pull from Docker Hub directly.
- CI image-content assertions (`.github/workflows/ci.yml` `docker` job) run by hand against `echo-app:ci`: **all pass** — no `/app/{tests,video,.env,web/node_modules,docs,scripts}`; `/app/data` and `/app/output` exist, are empty and owned by `app`; `server/static/index.html` present; runs as uid 10001; `ffmpeg 7.1.5` at `/usr/local/bin/ffmpeg` (the nice wrapper); `GIT_SHA` baked in; `import server.app, boto3, sentry_sdk` works.
- Container boot smoke (no compose, SQLite default): entrypoint migrated an empty DB to `20261020_0014`; `/api/healthz` 200; `/api/readyz` 200 with all checks ok; `/` serves the SPA; anonymous `POST /api/video/upload` 401. With `SX_ENV=production` and no other config the app refuses to boot and lists the missing secrets / flags.

**2026-10-20 first CI run and local staging (`docs/local-staging.md`):**

- GitHub Actions run 39391990177 on `d7e5a0f` (`3dreels`): **all three jobs green** — `test` (`make test`), `postgres` (`alembic upgrade head` + `tests/test_db_pool_isolation.py` on PostgreSQL 16), `docker` (amd64 build + image-content assertions). Annotations to handle later: Node 20 actions are deprecated (bump `actions/checkout` / `actions/setup-python`), and `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19.
- Local staging stack (`compose.yaml` + `deploy/compose.staging.yaml`, `SX_ENV=production`, PostgreSQL 16, SeaweedFS standing in for R2, Caddy for the Cloudflare edge, Mailpit for SMTP) on Docker Desktop arm64:
  - Boot: production config checks passed, alembic migrated to `20261020_0014`, app `cpus: 3` / `mem_limit: 6g` and postgres `cpus: 1.5` applied (`docker inspect`).
  - `node scripts/verify_staging.cjs`: **19/19 pass** — healthz/readyz 200, `/media/…` 404, `/api/reels/diag` 404, anonymous upload 401, uninvited sign-up refused, `Secure` session cookie, publish writes the object with `media_url` on the media origin, `Range` 206 + `Content-Range`, a single ACAO equal to the app origin with and without `Origin`, `Cache-Control: max-age=86400`, owner delete makes the object 404.
  - Postgres stopped: `readyz` 503 (`OperationalError`) while `healthz` stays 200; back to 200 after restart.
  - ffmpeg runs at **nice 10** inside the app container during a publish (`docker top … -o pid,ni,comm`).
  - Password-reset email delivered to Mailpit with an `https://<public-url>/reset-password?token=…` link.
  - Backup bucket refuses anonymous reads (403).
  - **Backup + restore drill passed:** `deploy/backup.sh` wrote `echo-*.dump` (175 KB) and `avatars-*.tar.gz` in 3 s; after deleting the `pgdata`, `data` and `output` volumes, the runbook restore (`pg_restore --clean`, avatar untar, public bucket copied back to `output/uploads`) took **108 s** from wipe to healthy; `--drill check` **5/5** — readyz 200, a pre-backup DM **decrypts**, the restored password signs in, the post media is still served. The avatar tarball was empty (no avatar uploaded), and the drill ran on the same machine, not a second VM.
  - Found and fixed on the way: an edge that *adds* ACAO on top of the store's own CORS sends the header twice and browsers reject it. The production Transform Rule must use "Set static" (already in `docs/deploy-runbook.md`).
- **~~New blocker~~ fixed 2026-10-21 — 4K publish was too slow inline:** `node scripts/verify_staging.cjs --time-publish` with a 93.6 MB 30 s 3840×2160 HEVC clip: upload 2.8 s, **publish 107.4 s** (HTTP 200), under the `cpus: 3` cap on an Apple-silicon laptop. That was over Cloudflare's 100 s origin timeout. `make_web_preview`, `make_explore_preview` and the poster all ran inside the publish request.
  - **Fix (2026-10-21):** a 2D video publish now returns once the original is committed and the post exists. Poster, explore preview and web preview encode on a single-worker background executor (`_derived_pool` in `server/routers/uploads.py`, shared with the stereo path), each through part-then-commit. Until they land, cards and reels use the original as media with no poster. `/api/reels/explore-preview` skips an upload whose job is pending. A failed encode is logged and the post stays usable. Leftover `.part` files are removed on failure and swept at startup. If the post is deleted mid-encode, the late R2 siblings are deleted. Tests: `tests/test_publish_background.py`.
  - **Re-timed 2026-10-21** (same laptop, same `cpus: 3` cap, 94.9 MB 30 s 3840×2160 HEVC clip): upload 5.7 s, **publish 2.3 s** (HTTP 200). In the background the poster landed at 4.5 s, the explore preview at 43.6 s and the web preview at **221.2 s**. `verify_staging.cjs` 19/19.
  - For about 4 minutes after a 4K publish, the feed plays the HEVC original until the web preview lands. The poster appears within seconds. The background encode also runs alongside the `SX_VIDEO_WORKERS` job pool; it does not share that pool's limit.

**Not yet verified (2026-10-20)** — every item below still needs a real run before the first invite:

- [x] ~~First CI run on GitHub~~ — green 2026-10-20 (above).
- [~] `docker compose up` with `SX_ENV=production` and PostgreSQL — done on local staging (above). Third concurrent job 429 `QUEUE_FULL` and queued-job cancel checked on local staging (2026-10-22, `verify_load.cjs --queue`). **Remaining:** the server-wide queue cap with four or more accounts; repeat on the VPS with the real `.env`.
- [~] Live R2 against a staging bucket — publish and owner delete verified against SeaweedFS (S3 API) on local staging. **Remaining:** real R2 (needs a payment method on the Cloudflare account); moderation removal and account deletion making objects 404.
- [ ] Edge checks on `media.<domain>`: `curl -I` with and without `Origin` and `Range: bytes=0-1` in both orders → 206, ACAO present, `Content-Range`, `cf-cache-status: HIT` (`docs/manual-beta-checks.md` §1).
- [ ] CDN copies can be served up to 1 day after delete: rehearse a purge-by-URL takedown once.
- [~] **Blocker (measured 2026-10-20, 107 s locally):** move the inline publish encodes (`make_web_preview`, explore preview, poster) for large videos into a background job, then re-time a 95 MB 4K HEVC publish on the CPX32 with `node scripts/verify_staging.cjs --app https://<domain> --media https://media.<domain> --time-publish <clip>`. Target under 60 s. **Done locally (2026-10-21):** encodes moved to a background job; publish 2.3 s, web preview lands at 221 s (above). **Remaining:** the CPX32 re-time, including how long the derived files take to land there.
- [ ] **After deploy — ffmpeg overlap on the CPX32:** the background publish encode (`_derived_pool` in `server/routers/uploads.py`, 1 worker) is outside the `SX_VIDEO_WORKERS` limit, so it can run alongside a paid job's encode (2 ffmpeg at once, both at nice 10, inside the app's `cpus: 3` cap). The `server/media.py` encodes also ignore `SX_FFMPEG_THREADS`. Start a paid video job and a 4K publish together and watch API latency (feed, SSE, sign-in). If it lags, add the thread cap to the `media.py` encodes or share one encode slot between the two pools.
- [~] `deploy/backup.sh` + restore drill — passed on local staging (above). **Remaining:** host cron on the VPS writing to the real private R2 bucket, and one drill onto a second VM.
- [ ] Sentry receives a test error with cookies/CSRF/auth headers stripped and the `GIT_SHA` release set.
- [ ] Quest smoke test on the real HTTPS domain through the Tunnel: VR pose notice shows once and Continue starts the session; mono and stereo reels play and seek from the media domain; no WebGL taint errors; no `/api/reels/diag` traffic.
- [ ] Two-browser manual pass with two accounts: signup, publish, DM, delete (`docs/manual-beta-checks.md`).
- [ ] LegalKit values still missing: operator name, contact email, jurisdiction (`web/src/components/legal/LegalKit.jsx`).

**2026-10-16 DB pool deadlock fix (branch `fix/db-pool-deadlock`, based on `origin/main` `dcaa4e4`):**

- `make test`: backend **289 passed** (`pytest -q tests`, ~45s; includes 13 new `tests/test_db_pool_isolation.py` tests), frontend **341 vitest passed**.
- New pool tests on unmodified `origin/main`: **13 failed** (2 connections per request; `QueuePool limit of size 1 overflow 0 reached` under concurrency; 4 `reel_records` + 3 `metadata_for_paths` calls for a 3-item payload after a failed batch). With the fix: 13 passed; 10 consecutive reruns green.
- PostgreSQL check: same 13 tests with `SX_TEST_POSTGRES_URL=postgresql+psycopg://postgres@127.0.0.1:55432/pool_test` against a throwaway PostgreSQL 15.15 cluster — 13 passed on the fix, 13 failed on `origin/main`. The rest of the suite was not run on PostgreSQL.

**2026-09-20 security/money + edge verification (uncommitted working tree):**

- Backend regression suite: **158 passed** (`pytest -q tests`, ~27s) — includes 66 pre-existing hardening-adjacent tests plus 6 registration-allowlist, 24 security/money, and 36 edge-case tests (all SQLite fixtures; Postgres re-run remains a listed gate above).
- Frontend: 13 vitest passed; `vite build` clean.
- Publication-path ownership now enforced (the 2026-09-19 "remains open" note above is resolved); no job-cancel endpoint yet.

**2026-09-19 audit round 2 (four-agent codebase re-verification):**

- Recommendation concurrency regression tests: **passing** — `test_concurrent_page_materialization_replays_winner` + `test_concurrent_affinity_upsert_dedupes` (4 passed, ~1.5s, SQLite fixtures; Postgres re-run is a listed gate above). The 2026-09-12 "failed with HTTP 500s" record below is **historical** — the fix (winner-replay on `uq_recommendation_request_session_page`) landed and is dual-dialect.
- Staged-upload/job ownership tests: **passing** (`tests/test_cloud_routes.py` — owner-private staging, owned job status/download). Publication-path ownership was open at audit time — **fixed 2026-09-20** (see verification entry above).
- `.venv` recreated (CPython 3.14.6); the 2026-09-12 ".venv absent" note is resolved.
- Current schema head: `20261022_0017` (`EXPECTED_SCHEMA_REVISION`, `server/social/database.py:14`).
- Build fixes landed 2026-09-19: `.dockerignore` rewritten (`.venv/` typo fixed; `data/` + `logs/` + model caches excluded — previously baked the dev DB into the image); `vapoursynth==78` scoped off Linux (no manylinux wheel — previously broke `docker build`).
- WebXR engine: 43/43 node tests, vite build clean (see `docs/threejs-vr-implementation-plan.md` §7).

Historical record — recommendation-system verification from 2026-09-12 (superseded):

- Backend regression suite: 22 passed in the isolated verification environment.
- Frontend unit tests and production build: passed.
- Python and player JavaScript parse checks: passed.
- Fresh Alembic upgrade to `20260912_0004`, downgrade to `20260911_0003`, and schema-drift check: passed.
- Sequential 56-item crawl and 1,000-item/42-page crawl: passed without duplicates and with a terminal null cursor.
- Adaptive ranking and attribution-defense scenarios: passed.
- Concurrent same-cursor test: failed at the time with one HTTP 200 and three HTTP 500 responses — **fixed since; regression tests now green (see above)**.
- Materialized-page exclusion test: safe filtering passed, but page refill/`has_more` behavior remains incomplete (still open above).

The unscoped repository-wide `pytest` command also collects the separate, user-owned `ComfyUI/` tree and hardware-specific tests with unavailable dependencies. Use `make test` for this website's backend and frontend regression suite.
