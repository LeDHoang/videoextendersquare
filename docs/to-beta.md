# Beta Launch Checklist

Last updated: 2026-10-20 (infrastructure verdicts revised: R2 media at launch, PostgreSQL day one, SEA/Asia + US region design, Ray-2 deprecation and Ray 3.2 migration; stale-entry pass; latest engineering entries 2026-10-16; audit round 2 + planned-feature scope inventory 2026-09-19)

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
  - **Fix:** set the video pool to 1. Run ffmpeg with `-threads 2` under `nice`. Put a `cpus` limit on the Postgres container. Require auth on the free 4K path (Processing API item below).
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
| In-app support/contact surface | P2 | No footer/help link in `AppShell.jsx` | Health/support section above |
| Cookie-consent banner (ePrivacy) | P2 (EU-scoped) | 1-year anon cookie writes on load | Privacy section above |
| Credits nav icon final art | P2 cosmetic | `web/src/components/icons/svg/credits.svg` marked TEMP | todolist.md near-term |
| Captions/WebVTT | **Decision needed: declare out-of-scope for beta** | No `<track>`/VTT capability anywhere | A11y item above |
| Alt-text field on upload | P3 | No field; avatars render `alt=""` | Deferred |
| Reels page default folder | **P1 (pre-launch config)** | `ReelsPage.jsx` still defaults `folder` to `testpipeline` (dev HEVC test clips). That folder holds no image posts, so the default For You feed shows videos only; image/slideshow posts (added 2026-10-11) appear only under ALL FOLDERS / `uploads` or via deep links. Owner decision: keep `testpipeline` during dev, switch the default (likely `ALL FOLDERS`) when close to beta launch | `web/src/pages/ReelsPage.jsx` `useState(searchParams.get('folder') \|\| 'testpipeline')` (+ the matching fallback in its fetch `.then`) |

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

- [~] ~~Require authentication and CSRF protection for image/video upload and processing endpoints~~ — **partially done (verified 2026-09-19):** cloud (FAL-funded) processing requires auth + origin + CSRF + stage ownership (`image.py:139–142`, `video.py:266–269`); uploads carry owner identity. **Remaining:** the *free/local* path (`upscale_engine="fast"`/`"studio"`, no FAL) runs 4K ffmpeg with **no auth, no CSRF, no rate limit** in both routers — decide: require auth for all jobs, or strict per-IP quota + global queued-job cap with 429.
- [x] Remove runtime platform-key mutation and restrict `PUT /api/config/models` to administrator sessions with CSRF protection.
- [~] Protect CPU/GPU-intensive Reels and comparison endpoints — **sharpened by audit (2026-09-19):** `POST /api/reels/proxy` runs up to **50 synchronous ffmpeg transcodes per call with zero auth** (`reels.py:2073–2098`); `POST /api/reels/spatialize` creates owner-less jobs that can download model weights, with an unvalidated `strength` float (`reels.py:2113–2171`). Admin-gate or remove both from the public router; also covers Explore preview generation, comparison preparation, and forced health refreshes. **Partially done (2026-09-20):** proxy + spatialize (+ status) now require admin session with CSRF + per-admin rate limit; `strength` clamped 0–2 via pydantic; anon/non-admin denied with regression tests. **Remaining:** Explore preview generation, comparison preparation, forced health refreshes.
- [ ] Add per-user and per-IP upload, processing, event, and storage quotas. **Uploads:** anonymous staging accepts 50 MB image / 500 MB video per file (caps exist and are enforced mid-stream — `media.py:15–19`) but with **no per-identity rate limit and no global staged-bytes ceiling**; a bot can fill the disk. Add staged-bytes ceiling + 429/507 on overflow.
- [ ] Add bounded job queues, global and per-user concurrency limits, and overload responses — **confirmed still open:** `JobManager._jobs` has no global cap; `cleanup_old` only evicts *terminal* jobs, so queued-job count is unbounded (`server/jobs.py`).
- [x] **New (2026-10-20, deadline 2026-10-25):** Migrate the Luma reframe catalog entry off `fal-ai/luma-dream-machine/ray-2-flash/reframe` (`core/models.py:61`, `web/src/components/upload/useExtendConfig.js`, `web/src/pages/VideoPage.jsx`, `web/src/pages/UploadPage.test.jsx`) to `luma/agent/ray/v3.2/reframe` — fal deprecates Ray-2 reframe on 2026-10-25. Update pricing ($0.06/$0.12/$0.36 per source second at 540p/720p/1080p), the request builder and quote path, and enforce the ≤10 s source limit server-side (see verdicts → AI inference). **Done (2026-10-20):** see the AI inference verdict; regression tests in `tests/test_pricing.py` and `tests/test_ray_reframe_source_limit.py`.
- [ ] **New (2026-10-20):** Cap ffmpeg CPU on the shared VPS — video pool size 1 in production (`core/phases.py:71-74`), `-threads 2` and `nice` on libx265 encodes (`core/tooling.py:36`), and a `cpus` limit on the Postgres container, so two 4K encodes cannot starve web/SSE/DB (see verdicts → Hosting).
- [ ] Add hard FAL spending limits and alerts — **confirmed still open; sharpened:** `normalize_model_id` (`core/models.py:235–254`) accepts *any* fal model ID (BYOK-only for credits, but no per-job cost cap/confirmation), and the `ltx_loras` validator only checks the string starts with `http(s)://` while `attach_civitai_token` (`pipeline/utils.py:12–34`) splices the server-held `CIVITAI_KEY` onto any URL **containing the substring** `civitai.com/api/download/models` — a crafted URL exfiltrates the token. Parse hostnames + allowlist; cap custom-model BYOK spend. **Partially done (2026-09-20):** `attach_civitai_token` now parses `urlsplit` against an exact hostname allowlist (`civitai.com`, `www.civitai.com`) + https-only (substring exfil closed, unit-tested); per-job spend cap `SX_FAL_MAX_QUOTE_USD` (default $10, `0` disables) enforced in `create_quote`. **Remaining:** global spend alerts.
- [ ] Configure reverse-proxy request-body limits and timeouts that match the application upload limits. **Note (2026-09-19):** Cloudflare's free-plan body limit is 100 MB vs the app's 500 MB video cap — lower the app cap or document the plan requirement. **Decided 2026-10-20 (verdicts → Media storage):** lower `MAX_VIDEO_UPLOAD_BYTES` below 100 MB for beta; presigned multipart direct-to-R2 uploads post-beta.
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
- [~] Enforce ownership on job status, SSE progress, results, downloads, cancellation, and publication — **partial:** status/SSE/result/download all enforced via `_owned_job`. **Update (2026-09-20):** publication is now owner-enforced (`_resolve_source` verifies `rec.owner_id` / `stage_owner_matches`; owner-less free jobs keep legacy behavior). **Remaining gap:** no cancel endpoint exists at all.
- [x] Prevent one authenticated user from publishing another user's `stage_id` or `job_id` — **fixed (2026-09-20):** cross-user stage/job publish returns 403 with regression tests (`test_security_money.py`); same-browser anon→authed migration still works via `stage_owner_matches`.
- [ ] Separate private/unpublished job artifacts from public published media — **confirmed still open:** `server/app.py:113–115` mounts the entire `output/` tree at `/media`; unpublished job artifacts persist into that tree (`pipeline/utils.py:208–212` documents the leak).
- [ ] Ensure every item returned by public Reels, Explore, tag, location, profile, and canonical-link routes corresponds to an active, published database post.
- [ ] Disable directory-style legacy media discovery in production — **confirmed still open:** `reels.py:997–1002` `rglob`s `output/` (`_scan_cached` → `scan_output_media`) with no production-mode gate; consumed by feed hydration fallback at `:1241–1251`, `:1433`, `:1590`.
- [~] Add multi-user authorization tests covering guessed, stolen, expired, and cross-user stage/job identifiers — **partial:** stage + job status/download tests exist and pass; publish-path cross-user/expired/pointer-matrix tests added 2026-09-20 (`test_security_money.py`, `test_security_edge.py`).

### Recommendation correctness and abuse resistance

- [~] Fix concurrent materialization of the same recommendation cursor — **code fix landed and is dual-dialect** (winner-replay on `uq_recommendation_request_session_page`, `service.py:527–577`; `events.py:30–55` branches `pg_insert.on_conflict_do_nothing` vs SQLite). **Remaining:** the concurrency tests run on SQLite fixtures only — **re-run on PostgreSQL before launch** (launch verdict: Postgres before payments; READ-COMMITTED retry semantics differ).
- [x] Add a permanent synchronized concurrency regression test for both Reels pages and creator-suggestion pages — **done; verified passing 2026-09-19** (`test_concurrent_page_materialization_replays_winner`, `test_concurrent_affinity_upsert_dedupes` — 4 passed; the 2026-09-12 failure record below is historical).
- [ ] Rate-limit `/api/events`, `/api/posts/{post_id}/view`, and anonymous recommendation feedback.
- [ ] Validate watch, foreground, position, and duration values against server-known media duration; reject or clamp impossible values.
- [ ] Limit the serialized size and accepted keys of event `context` and `playback_quality` objects.
- [ ] Cap repeated actor/item contributions so event replay cannot manipulate affinities, co-watch data, or global popularity statistics.
- [ ] Preserve valid impression/session attribution checks and add tests for fabricated events without delivery provenance.
- [x] **New (2026-09-19 audit):** The anonymous cookie is **unsigned** — `ensure_anonymous_cookie` (`auth.py:295–309`) accepts any client-supplied `echo_anon` value, so a bot rotates unlimited anonymous actors (view-count inflation, replay-cap evasion, recommendation poisoning). HMAC-sign it with `SX_SECURITY_SECRET`; reject unsigned/forged values. **Done (2026-09-20):** `echo_anon` is now `raw.signature` (HMAC via `keyed_hash`); forged/legacy values rotate-and-continue (never honored); `stage_owner_matches` verifies the signature. One-time invalidation of pre-existing anon cookies.
- [x] **New:** SSE `/api/messages/events` connection exhaustion — each connection polls the DB every 1s with no per-user connection cap and no max stream lifetime (`messages.py:901–960`). Cap concurrent streams per user; force reconnect after N minutes. **Done (2026-09-20):** `SX_SSE_MAX_CONN` (3/user → 429) + `SX_SSE_MAX_MIN` (30-min lifetime with `reconnect` frame); slots released on close (concurrency + lifetime regression-tested).
- [ ] Decide whether an already materialized page should refill after a post or creator becomes ineligible. Currently it safely removes the item but can return an underfilled page with stale `has_more`.
- [ ] Refactor recommendation scope reads to use the request's dependency-injected database session rather than opening a second global session.

### Privacy, deletion, and public policy

- [~] Publish a privacy policy, terms of service, and community/content rules — **build task, not just writing (2026-09-19):** no `/privacy`, `/terms`, or `/rules` routes or page components exist anywhere in `web/src`; add a `LegalPage` + routes + footer links first. **Terms drafted (2026-10-20):** `/terms` (`web/src/pages/TermsPage.jsx`, footer link) covers 13+ age with guardian consent for minors, content licence, AI processing, community rules, copyright notices, credits (14-day refund of unspent purchased credits), BYOK, VR safety. **Privacy + acceptance (2026-10-20):** `/privacy` (`web/src/pages/PrivacyPage.jsx`, footer link, linked from Terms §14) lists every data category, provider, cookie and retention period checked against the code; shared values live in `web/src/components/legal/LegalKit.jsx`. Signup requires a Terms/Privacy checkbox; `/api/auth/register` rejects without `accept_terms: true` (`TERMS_NOT_ACCEPTED`) and stores `users.terms_version` / `terms_accepted_at` (migration `20261020_0014`, `TERMS_VERSION` in `server/routers/social.py`). Age check deferred: no date of birth collected, Terms state 13+. Still open: fill the `LEGAL` placeholders (entity, address, emails, governing law, venue, hosting region, activity retention, deleted-media purge period, effective date), lawyer review, `/rules` page. Gaps the policy discloses but the code should fix: published originals keep EXIF/GPS metadata (`shutil.copy2` in `server/routers/uploads.py`); soft-deleted posts' media files are never purged.
- [ ] **New:** Add a GDPR data-export (DSAR) endpoint — `GET /api/users/me/export` returning posts, packs, comments, and ledger as a JSON archive. Currently absent.
- [ ] **New:** Account deletion leaves **DMs and conversation state intact** — `delete_account` (`account_safety.py:499–608`) predates the messaging and billing subsystems: it never touches `DirectMessage`/`Conversation`/`ConversationMember`/`MessageEvent` (deleted users' messages persist verbatim in recipients' inboxes). Either document "DMs retained, author tombstoned" in the privacy policy or crypto-shred per-user keys.
- [~] **New:** Account deletion leaves **billing tables untouched** — `CreditLedgerEntry`/`StripePurchase`/`ReelRewardClaim` retention is defensible under financial-record law but must be a documented decision; `FalCredential` (encrypted BYOK keys) should be hard-deleted on account closure. **Done (2026-09-20):** `delete_account` hard-deletes the `FalCredential` row in-transaction (regression-tested); ledger/financial rows retained as legal records, DM retention still a documented decision per the item above.
- [ ] Disclose which media and metadata are sent to FAL or other third-party processors before users submit content. **Extend to WebXR:** Quest sessions implicitly process head/hand pose data — the policy must name it, with a first-run notice on VR entry.
- [ ] Define retention periods for staged uploads, job artifacts, published media, raw engagement events, recommendation sessions, impressions, dismissals, affinities, co-watch rows, messages, reports, logs, and anonymous identifiers.
- [ ] Extend account deletion to delete or irreversibly anonymize all recommendation sessions, impressions, requests, dismissals, affinities, co-watch data, and retained actor keys associated with the account.
- [ ] Add deletion tests proving a deleted account cannot be reconstructed from recommendation or analytics tables — **extend to messaging + billing tables per the two items above.**
- [ ] **New:** Add an ePrivacy **cookie-consent banner** gating the one-year anonymous tracking cookie (`auth.py:295`) for EU users — retention policy alone doesn't cover consent.
- [ ] Add a visible "Clear personalization" control and shorter documented retention for anonymous activity before relying on the one-year anonymous cookie.
- [ ] Decide whether anonymous history may ever be merged into a registered account; do not merge it without explicit documented product and privacy approval.
- [ ] Document the moderation response process, escalation contacts, expected response time, appeal process, and content-removal procedure.
- [ ] **New:** Add a **DMCA/copyright takedown process** — contact address, repeat-infringer policy; users upload videos containing third-party music/media.
- [ ] **New:** Add an **age gate** (13+/16+/18+ attestation or DOB) at registration — none exists.
- [ ] **New:** Replace `window.prompt`-based report flows (reels.html, MessagingPanel, PackPage) with a real dialog — pack/user/post/comment reporting exists in the API (`ReportCreateRequest` covers `"pack"`), the UX is the gap.
- [ ] **New:** User-facing **refund policy** at the point of purchase (WalletPage states "never expire, non-transferable, no cash value" but nothing on refunds/disputes) + a dispute-evidence runbook for support.

### Registration and anti-abuse

- [ ] For a public beta, add email verification and bot protection to registration. **Confirmed absent (2026-09-19):** zero email-verification machinery in the codebase.
- [~] Until those controls exist, operate as invite-only/allowlisted or set `SX_REGISTRATION_ENABLED=0`. **Mechanism done; remaining: set `SX_REGISTRATION_ENABLED=0` + `SX_REGISTRATION_ALLOWLIST` in the production environment.** **Update (2026-09-20):** invite path implemented — `SX_REGISTRATION_ALLOWLIST` (comma-separated emails, case-insensitive) is honored while registration is closed (`social.py:80–121`, tested in `test_registration_allowlist.py`).
- [ ] Verify account, messaging, reporting, following, upload, and recommendation-event rate limits under coordinated abuse. **Note:** comments/likes/follows/blocks/message-send/reports already carry limiters (verified); **packs and publish do not** (see cost-controls items above). **Update (2026-09-20):** packs and publish now carry limiters (those items checked off above); coordinated-abuse verification still open.
- [~] **New:** Gate reel-reward claims on verified email + minimum account age; the per-IP cap has a `max(10, …)` floor that silently overrides lower config (`billing/service.py:894`) — remove the floor. Record a rewards-economics cost ceiling and go/no-go before enabling `SX_REEL_REWARDS_ENABLED`. **Partially done (2026-09-20):** floor removed (`reel_reward_ip_cap()`, min 1, tested). **Remaining:** email/age gating + economics ceiling + go/no-go.
- [ ] Add moderator alerts and dashboards for report spikes, spam registrations, abusive messaging, unusual generation spend, and storage growth.

## Production deployment and operations

### Secrets and environment

- [ ] Generate a long random value and set `SX_SECURITY_SECRET`.
- [ ] Generate a separate long random value for `SX_MESSAGE_ENCRYPTION_KEY`, store it in the deployment secret manager, and back it up. Do not rotate it without re-encrypting stored data.
- [ ] **New (2026-09-19):** Generate a third independent secret for `SX_FAL_KEY_ENCRYPTION_KEY` (≥16 chars, required before BYOK personal Fal keys; rotating it orphans all encrypted credentials — RUNNING.md §Credits).
- [ ] Store `FAL_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, SMTP credentials, and all other production secrets in the deployment secret manager rather than accepting them from a public UI.
- [ ] **New:** Set the three pack price IDs `SX_STRIPE_PRICE_500` / `SX_STRIPE_PRICE_1050` / `SX_STRIPE_PRICE_2750` (one-time USD Prices matching $5/$10/$25 exactly — see RUNNING.md) and set `SX_PUBLIC_BASE_URL` for Checkout redirects (distinct from `SX_PUBLIC_URL`, which email/social use).
- [ ] **New:** Decide and record the billing flag trio: `SX_CREDITS_ENABLED` / `SX_STRIPE_ENABLED` / `SX_REEL_REWARDS_ENABLED` — all default `0` and fail closed with `BILLING_MISCONFIGURED` 503 if secrets are placeholders (RUNNING.md §Credits). Keep all off until the Stripe test-mode + live-webhook walkthrough in RUNNING.md passes.
- [ ] If GIF search is enabled, configure `SX_TENOR_API_KEY`, `SX_TENOR_CLIENT_KEY`, and the narrowest practical `SX_TENOR_ALLOWED_HOSTS` list.
- [ ] **New:** Record launch decisions for the reel-pack flags, which default **ON**: `SX_REEL_PACK_CREATION_ENABLED`, `SX_REEL_PACK_DISCOVERY_ENABLED`, `SX_REEL_PACK_IMMERSIVE_ENABLED`.
- [ ] Set `SX_ADMIN_USERS` and/or `SX_MODERATOR_USERS` to the launch-team usernames or emails.
- [ ] Set `SX_PUBLIC_URL` to the deployed HTTPS website origin.
- [ ] Set `SX_COOKIE_SECURE=1` when serving over HTTPS.
- [ ] Keep `SX_PASSWORD_RESET_EXPOSE_TOKEN=0` outside local development.
- [~] ~~Keep `SX_TRUST_PROXY_HEADERS=0`~~ — **corrected 2026-09-19:** behind Cloudflare (the decided topology) every client IP is a CF egress IP, which collapses all IP-keyed rate limits into shared buckets. Set `SX_TRUST_PROXY_HEADERS=1` **and** restrict origin traffic to Cloudflare IP ranges so client-supplied forwarding headers can't be spoofed from the open internet.
- [~] Confirm `.env`, database files, keys, and generated secrets are excluded from version control and container images — **`.dockerignore` fixed 2026-09-19** (typo `venv/` → `.venv/`; added `data/`, `logs/`, `.models/`, `.stitch/`, tests/docs and other non-runtime trees). **Remaining:** verify the built image contents (`docker run --rm img ls /app`) in CI.
- [x] **New:** Set `load_dotenv(override=False)` semantics — `server/app.py:26` currently uses `override=True`, so a stray `.env` in the image would beat `docker -e` secrets. **Done (2026-09-20):** environment now wins over `.env`.

### Database, storage, and workers

- [ ] Choose and document the supported production topology. **Decided 2026-09-19 — see "Infrastructure design verdicts" above:** single VPS (Hetzner Singapore by default, Hillsboro if the invite list is majority US — see verdicts → Region) + co-located PostgreSQL + Cloudflare R2 for published media; Fly.io, a second region and managed Postgres are later growth triggers, not launch choices. **Remaining work for that topology (2026-09-19 audit):** ship a `compose.yaml` (app + `postgres:16`, `pgdata` named volume, health-gated `depends_on`); document the full `docker run`/compose command including `-v data:/app/data` (the current RUNNING.md command mounts only `output/` — `docker rm` would destroy the DB and avatars); add a container entrypoint that runs `alembic upgrade head` before uvicorn (today first boot against an empty Postgres crash-loops: `init_database()` raises from lifespan).
- [x] ~~**New:** Write and rehearse the SQLite→PostgreSQL **data** migration procedure~~ — **Obsolete 2026-10-20:** production launches on PostgreSQL from day one (verdicts → Database), so there is no live SQLite data to migrate. Only needed if a SQLite deployment ever holds real users.
- [ ] Run production on PostgreSQL from day one (verdicts above, revised 2026-10-20) — set `DATABASE_URL` explicitly, since `DEFAULT_DATABASE_URL` in `server/social/database.py` is still SQLite. SQLite remains for local dev and tests only.
- [ ] Because jobs and staged-upload registries are currently process-local, deploy exactly one application worker/replica (matches the single-VPS verdict); only replace them with a durable shared job queue and state store if/when moving to multi-machine later.
- [ ] Persist or externally store the production database, `data/avatars`, published media, and any paid job result that must survive a restart. The documented Docker command currently persists only `output/`. **Revised 2026-10-20:** published media and avatars go to Cloudflare R2 at launch (verdicts → Media storage); only private/unpublished job artifacts stay on the VPS disk, behind an owner-checked route, and need the `output/` volume. **Note:** staged uploads live in the container's `/tmp/square_extender_api/uploads` — lost on restart mid-job; document this as accepted behavior.
- [ ] Define storage lifecycle cleanup for abandoned uploads, failed jobs, expired drafts, proxies, previews, and deleted posts.
- [ ] Run automated database and media backups on a documented schedule — **specify:** cron'd nightly `pg_dump` (or WAL-G) to a private R2 bucket + documented retention; escrow `SX_SECURITY_SECRET`, `SX_MESSAGE_ENCRYPTION_KEY` and `SX_FAL_KEY_ENCRYPTION_KEY` off the box; one restore drill onto a fresh box before launch (also rehearses a region move). Published media in R2 needs no separate backup beyond its own durability; local private artifacts are covered by the retention policy.
- [ ] Perform and record a full restore drill, including message decryption and media availability.
- [ ] Document deployment rollback, schema rollback limitations, and recovery from an interrupted migration.
- [x] **New (2026-10-16):** Fix the request-path DB pool deadlock (pre-existing on `main`, found in WebXR Earth QA). `get_optional_auth` kept the request session's connection checked out (it only committed when `last_used_at` was ≥300 s stale) while reels helpers opened a second `SessionLocal()` per call; ~15 concurrent signed-in requests held all 5+10 QueuePool connections waiting for another, starved every AnyIO worker (even `/api/health`), and in QA one request pinned a connection for 17+ minutes until restart. **Fix:** `get_optional_auth` commits on every path that queried (so `require_auth` endpoints — including the 30-minute `GET /api/messages/events` SSE stream — start with no connection held); `unavailable_media_paths_for_viewer`, `reel_records`, `metadata_for_paths`, and `scoped_media_paths` take an optional `db` that every `reels.py` route threads through (one request, one connection); the per-item `_get_comments_for_video` / `_get_meta_for_video` fallbacks no longer re-query after the batched lookup. **Tests:** `tests/test_db_pool_isolation.py` (peak checkouts per request ≤ 1 across the affected endpoints, concurrent signed-in requests on a `pool_size=1` pool, auth releases its connection, no per-item retries) — fail on `main`, pass with the fix, on SQLite **and PostgreSQL 15** (local throwaway cluster via `SX_TEST_POSTGRES_URL`). `tests/conftest.py` now points the global `SessionLocal` fallback at a throwaway DB so tests never read the developer's `data/echo.db`. **Still open:** `/api/reels/tags` and `/api/reels/locations` (no auth, no request session) open helper sessions sequentially — safe, but not yet single-session (`GET /api/search/suggestions` was the unsafe caller — see the last item below). ~~`_metadata_snapshot` / `_get_meta_for_video` still fall back to fabricated `_seed_meta` engagement when the database lookup fails~~ — fixed, see next item.
- [x] **New (2026-10-16):** Never fabricate reel metadata when the social-database lookup fails. `_metadata_snapshot` and `_build_payload` swallowed any exception from the batched `metadata_for_paths` / `reel_records` lookup and fell back per item to legacy JSON or `_seed_meta`, so during pool starvation published posts were served with invented tags, location, likes and views (and no `post_id` / viewer state). **Fix:** a `SQLAlchemyError` from the lookup now raises **503 + `Retry-After: 5`** (`_reel_data_unavailable` in `server/routers/reels.py`); other exceptions propagate as 500 instead of being swallowed. Chosen over zeroed metadata because a failed lookup cannot tell a published post from a local file: zeros would still be invented numbers (and empty tag/location/Earth-heat results that look real), drop `post_id` so like/comment/save break, and mask the outage. Frontend fetches already catch errors. The legacy JSON / `_seed_meta` fallback is unchanged for paths the database answered have no published post (local, unpublished `output/` files). **Tests:** `tests/test_reels_metadata_failures.py` (real pool-timeout starvation for both helpers, 503 across `/api/reels`, tags, locations and Earth activity routes with no seeding, success-path DB rows + legacy fallback) — fail on the previous code, pass with the fix.
- [x] **New (2026-10-16):** Never cache a reels scan built without the slide filter. `_scan_cached` swallowed any `slide_media_paths` failure, fell back to `set()` and cached that scan for `_SCAN_TTL` (10 s), so every request in that window — even with the database healthy again — served the extra images of multi-image posts as standalone tiles; a slide is not any post's `media_path`, so `_build_payload` → `_get_meta_for_video` → `_seed_meta` gave them fabricated tags, location, likes and views. **Fix:** a `SQLAlchemyError` from the slide lookup now raises the same **503 + `Retry-After: 5`** (`_reel_data_unavailable`) and invalidates the cache timestamp, so nothing unfiltered is cached and the next request retries the lookup (a previous filtered scan is kept, never replaced); other exceptions propagate. **Tests:** `tests/test_reels_scan_slide_failures.py` (failed slide lookup neither caches nor seeds slide tiles across a 503 → healthy request pair, real pool-timeout starvation, stale-cache refresh, non-DB errors propagate, 503 on every `_scan_cached` route) — fail on the previous code, pass with the fix.
- [x] **New (2026-10-16):** `GET /api/search/suggestions` was a nested pool-hold: it queried its request `db`, then called the `/api/reels/tags` route function with no `db`, so `unavailable_media_paths_for_viewer(None)`, `_scan_cached()` (→ `slide_media_paths`) and `_tag_catalog` (→ `metadata_for_paths`) each opened a second `SessionLocal()` while the request connection was still checked out — the same hold-and-wait that caused the QueuePool deadlock. **Fix:** the body of `list_reel_tags` moved into `tag_suggestions(q, limit, db=None)` in `server/routers/reels.py`; the `/api/reels/tags` route keeps its signature and calls it without a session (sequential, safe), `search_suggestions` passes its own `db` (one request, one pooled connection). A failed reels lookup still surfaces from the suggestions route as **503 + `Retry-After: 5`**. **Tests:** `tests/test_db_pool_isolation.py` — peak checkouts ≤ 1 for `/api/search/suggestions` (with and without a query), 6 concurrent requests on a `pool_size=1` pool, and a failed `metadata_for_paths` / `slide_media_paths` lookup returning 503 with the connection released — fail on the previous code, pass with the fix. `/api/reels/tags` and `/api/reels/locations` stay not-yet-single-session (they have no request session of their own).
- [ ] **New:** Graceful shutdown — lifespan teardown currently only cancels the cleanup task; `ThreadPoolExecutor` pools are never shut down, so SIGTERM kills in-flight ffmpeg mid-write. Drain pools on shutdown; document restart-during-job behavior (reservation reconciliation at next boot already exists — `app.py:52–53` — but is undocumented).
- [ ] **New:** Container hygiene — run as non-root (`USER`), pin the base image digest + ffmpeg version, and split Streamlit out of the production requirements (it bakes pyarrow et al. into the prod image). Also standardize dev/prod interpreters (repo `.venv` is CPython 3.14; the image is 3.12).

### Network and application hardening

- [ ] Terminate HTTPS at a trusted proxy and configure HSTS after HTTPS behavior is verified. **Note:** Quest Browser requires a secure context for WebXR — the physical-Quest gate below depends on HTTPS being live (or the `adb reverse` localhost workflow from `docs/threejs-vr-implementation-plan.md` §6).
- [ ] Configure trusted-host validation and production security headers, including CSP, `X-Content-Type-Options`, and a suitable referrer policy. **Add `script-src 'self'`:** the reels player mount injects server-rendered HTML/scripts into the SPA DOM unsandboxed (`ReelsPlayer.jsx:95–110`) — currently safe (feed JSON escaped, user text via `textContent`), but CSP makes a future template regression non-exploitable.
- [ ] Restrict production CORS origins — **override `SX_DEV_ORIGINS` explicitly** (it defaults to `http://localhost:5173,http://127.0.0.1:5173` in `app.py:95`).
- [ ] **New (2026-09-19):** Cloudflare-specific edge config — Cache Rule bypass for `/api/*` (CF caches/compresses by extension); **revised 2026-10-20:** published media is served from R2 on `media.<domain>` with a Cache Everything rule (not `r2.dev`), and the origin's `/media/*` route serves only private owner-checked artifacts (bypass cache) — never proxy self-hosted video through the CF CDN (2026-09-28 terms); Rocket Loader + minify off for the SPA, and note the 15s SSE keep-alive sits safely under CF's ~100s idle timeout. `X-Accel-Buffering: no` covers nginx, not Cloudflare.
- [ ] Disable buffering for `/api/messages/events` and keep SSE connections open beyond the 15-second keep-alive interval.
- [ ] Protect or disable production diagnostic endpoints. Do not let anonymous users overwrite or read global headset telemetry.
- [ ] Rate-limit outbound model-information lookups and other endpoints that can force network or transcoding work.
- [ ] Run dependency, secret, and vulnerability scans and resolve release-blocking findings.

### Health, monitoring, and support

- [ ] Split cheap liveness from readiness checks — **sharpened (2026-09-19):** today's `/api/health` runs ffmpeg smoke probes cached 60s and **never touches the DB or `alembic_version`** (`health.py:43–72`), so the Docker HEALTHCHECK passes with a dead Postgres; the uncached probe burst can also exceed the 5s HEALTHCHECK timeout. Add `/api/healthz` (process) vs `/api/readyz` (`SELECT 1` + schema revision + writable storage) and point the HEALTHCHECK at the cheap one.
- [ ] Make readiness verify database connectivity/schema revision, writable storage, required encryption configuration, and other critical dependencies without launching expensive probes on every request.
- [ ] Add structured request logs, correlation/request IDs, centralized error tracking, and redaction of credentials and private recommendation context. **Baseline is near-zero (2026-09-19):** ~4 `logging` call-sites total, no formatter/config, no request-log middleware; the `_cleanup_loop` swallows exceptions silently. Add minimal structlog + log sweep failures. (No emails/tokens found in logs today.)
- [ ] Monitor HTTP error rate, latency, queue depth, worker utilization, database locks/connections, disk usage, SSE disconnects, event-attribution failures, and recommendation page failures.
- [ ] Alert on FAL spend, storage exhaustion, backup failure, elevated report volume, registration spikes, and repeated processing failures.
- [ ] Define an on-call owner, incident procedure, public support/contact channel, and rollback decision criteria for the beta. **Note:** no in-app support/contact surface exists (`AppShell.jsx` has no help link) — add a footer mailto/link so users can appeal moderation, request refunds, or submit DSARs.

## Build, migration, and automated release gates

- [ ] Create CI that installs dependencies from a clean environment and runs the scoped website checks on every release candidate. **Add a Docker build gate (2026-09-19):** `requirements.txt` was fixed today (`vapoursynth==78` has no manylinux wheel and previously failed the Linux build — now scoped `sys_platform != "linux"`; the container deliberately runs without the Studio engine); CI must prove `docker build` stays green.
- [ ] Run `make test` in the normal project `.venv` and record the exact commit and dependency versions. (`.venv` exists again as of 2026-09-19, Python 3.14.6 — but standardize on 3.12 to match the image; see container-hygiene item.)
- [ ] Run `make build` and deploy the generated frontend from the same tested commit.
- [ ] Run Python compilation and frontend/inline JavaScript parse checks.
- [ ] Run `make migrate` on a production-like database and verify the schema reaches **`20261020_0014`** (updated from the stale `20260912_0004`; source of truth: `EXPECTED_SCHEMA_REVISION` in `server/social/database.py:14`).
- [ ] Test fresh database creation, upgrade from the oldest supported production schema, failed-migration recovery, and backup restoration.
- [ ] Test the chosen production database rather than relying only on SQLite test runs — **priority:** re-run the billing suite and the recommendation concurrency tests (`tests/test_recommendations.py -k concurrent`, currently SQLite-fixture-only) against PostgreSQL. **Partial (2026-10-16):** the DB-pool isolation tests take `SX_TEST_POSTGRES_URL` and passed 13/13 on a local PostgreSQL 15.15 cluster; billing and recommendation concurrency fixtures are still SQLite-only.
- [ ] Require CI success, migration success, a clean worktree, and an approved release checklist before deployment.

## Functional, concurrency, and device verification

- [ ] Send a real password-reset email and verify the deployed reset link.
- [ ] With two real accounts in separate browser sessions, test message request routing, accept/decline, all message types, unread/read receipts, reconnect, deletion, blocking, reporting, and ten-recipient reel sharing.
- [ ] Open a copied or QR reel link while logged out and confirm `/reels?post=<id>` opens only the intended active public reel.
- [ ] Smoke-test registration, email verification, login/logout, profile editing, avatar replacement, post publishing/editing/deletion, Saved links, following, blocking, reporting, moderation, password reset, personalization reset, and account deletion. **Extend (2026-09-19):** also cover Reel Packs (create → publish → discovery → unlisted share → XR), the credits wallet (quote → reserve → capture → refund → reconciliation), and BYOK personal Fal keys — none were in the pre-2026-09-12 list.
- [ ] Test simultaneous upload, processing, polling, downloading, publishing, and recommendation pagination from multiple accounts.
- [ ] Load-test feed pagination, event ingestion, authentication, messaging SSE, uploads, jobs, and database writes at the expected beta concurrency plus safety margin.
- [ ] Confirm queue saturation produces controlled `429`/`503` responses and does not exhaust memory, disk, threads, database connections, or FAL budget.
- [ ] Test process restart during queued/running/completed jobs and confirm the documented recovery behavior.
- [ ] Test current Chrome, Safari, Firefox, mobile browsers, and the supported Quest Browser/device matrix.
- [ ] Validate Reels autoplay/manual navigation, audio, next-page preloading, negative feedback, creator suggestions, canonical links, and profile navigation on a physical Quest device. **Extend (2026-09-22, Earth Zoom Map):** on-device pass for the zoomable globe — tap-to-zoom vs tap-to-select feel at the city band, grip+stickY zoom comfort (object-motion only, ≤500 ms eases), `OPEN FEED`/`ZOOM OUT`/`GLOBE RESET` dock reachability, tile sharpness to street level, heat-blob legibility over tiles, and the `MAP OFFLINE — CITY VIEW` fallback with Wi-Fi dropped.
- **Note (2026-10-04):** OSM's tile servers blocked the dev machine's proxy (TLS reset + "Access blocked" placeholder). Default stays OSM (owner decision: Esri looked worse and needs a commercial plan); the decision below is now a choice of *paid* provider before launch.
- [ ] **New (2026-09-22, Earth Zoom Map tile provider):** pre-launch decision — stay on OSM tile-policy limits (compliant UA + disk cache already in place) or swap `SX_MAP_TILES_URL` to a paid MapTiler/Mapbox endpoint (no code change). Either way, carve `/api/reels/map-tiles/*` out of the Cloudflare `/api/*` cache-bypass above (tiles are immutable with a 7-day `Cache-Control`; bypassing forces every zoom through origin and risks tripping OSM limits).
- [ ] Verify keyboard navigation, focus visibility, reduced-motion behavior, readable contrast, captions/accessible alternatives where applicable, and responsive layouts. **Decision needed:** no caption/WebVTT capability exists anywhere (`ReelsPlayer.jsx`, VR modules) — declare captions out-of-scope for beta or build VTT support.
- [x] **New:** Gate `/reels/immersive-preview` — it is currently unauthenticated (`App.jsx:36`, no `RequireAuth` wrapper) despite being a creator desktop tool; wrap it or tie it to `SX_REEL_PACK_IMMERSIVE_ENABLED`. **Done (2026-09-20):** wrapped in the existing `RequireAuth` (logged-out redirects to login); `vite build` clean.
- [ ] Run a final moderation drill using real reports, blocks, content removal, account suspension, appeal handling, and audit evidence.

Automated Meta documentation and device verification remain unavailable on the current Linux host because `metavr` does not publish a `linux-x64` binary. Physical Quest verification remains a release gate. This document does not claim current Meta Horizon Store compliance requirements.

## Existing pre-Alembic database only

Do not use this procedure for a blank database.

- [ ] Confirm the old social tables exist and `alembic_version` does not.
- [ ] Back up `data/echo.db`.
- [ ] Run `.venv/bin/python -m alembic stamp 20260910_0001`.
- [ ] Run `make migrate` and confirm the final revision is **`20261015_0013`** (updated from stale `20260912_0004`).

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
SX_SSE_MAX_CONN=3
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
- Current schema head: `20261015_0013` (`EXPECTED_SCHEMA_REVISION`, `server/social/database.py:14`).
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
