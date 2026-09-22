# Beta Launch Checklist

Last updated: 2026-09-19 (audit round 2 + planned-feature scope inventory)

Status: **Blocked for public beta.** Complete every item in "Public beta release blockers" before opening registration or exposing the deployment publicly. An invite-only beta must still protect paid processing endpoints and private user media.

## Infrastructure design verdicts (decided 2026-09-19)

These are the settled architecture decisions for beta and the reasoning behind each. Checklist items below that reference topology, database, media storage, payments, or GPU inference should be implemented to match these verdicts. Each was reached by adversarial review (separate for/against agents arguing from the actual codebase) and both sides converged on the same phasing.

**One-line version:** *VPS + PostgreSQL + Stripe + fal.ai today; Cloudflare R2 when egress measurably hurts; one L40S when fal spend crosses ~$500/mo; Fly.io multi-machine when one box isn't enough.*

### Hosting — single VPS first, managed platform later
- **Launch (invite beta, ~$10/mo):** the existing multi-stage `Dockerfile` on one VPS (e.g. Hetzner CX32: 4 vCPU / 8 GB / 80 GB / 20 TB egress included at ~€7.51/mo). One machine is *correct* here: jobs and staged-upload registries are process-local, so one instance satisfies that constraint instead of forcing a premature shared queue.
- **Why not Fly.io/Render/Neon now:** scale-to-zero contradicts this codebase — SSE job streams either hold the machine awake (paying always-on anyway) or get severed mid-job, and Stripe webhooks hit a cold-booting machine. A VPS is 6–8× cheaper at $0 revenue and every failure mode is one we understand.
- **Growth trigger → Fly.io multi-machine:** only when one box genuinely can't keep up; the app is already stateless-shaped (Docker, env config), so it's a lift, not a rewrite.
- **Rejected:** Kubernetes/microservices (resume-driven at this scale), AWS/GCP (idle cost ~$150/mo before a single user), scale-to-zero platforms (incompatible with SSE + webhooks).

### Database — PostgreSQL, before the first Stripe charge
- **Verdict:** migrate SQLite → PostgreSQL *before* accepting payment, not after. Non-negotiable because the 962-line credits ledger (`server/billing/service.py`) does reservation/capture/reversal with real money; one concurrent write during a purchase webhook on single-disk SQLite risks financial-record corruption with no point-in-time recovery.
- **Why it's cheap:** the codebase is pre-migrated — `DATABASE_URL` is env-driven (`server/social/database.py`), `psycopg` is already in requirements, and the Alembic tree is already dual-dialect (`sqlite_where`/`postgresql_where` partial indexes). It's a connection-string change plus `alembic upgrade head`.
- **Where it runs:** co-located on the same VPS at launch (free, no network latency, no Neon cold-start in the billing path); move to a managed Postgres only when backup/HA burden actually exceeds the cost.

### Media storage — local disk now, Cloudflare R2 when egress hurts
- **Launch:** media stays on local disk (`output/`, served via `/media/*` with Range requests). Cheapest possible and playback paths are already validated.
- **Growth trigger → R2:** when egress billing or disk I/O measurably hurts, move media to **Cloudflare R2** (S3-compatible, **$0 egress**) behind Cloudflare CDN. The math is decisive for a video product: ~3.2 TB/mo at 10k MAU costs ~$270/mo on S3+CloudFront vs ~$45/mo storage-only on R2 — egress is the one cost that scales superlinearly with success.
- **Why not R2 before launch:** the rewrite (`server/media.py`, reels player, avatars, presigned URLs, re-validating Range/seek behavior — which our own VR playback docs flag as fragile) is launch-blocking surgery at zero revenue. Ship first; the interim step is Cloudflare's free CDN in front as a pull cache.

### Payments — keep Stripe, gated until retention is proven
- **Verdict:** keep **Stripe** (already integrated: 358-line idempotent webhook layer with `StripeEvent` dedup, signature verification, server-side price re-validation + the PSP-agnostic 962-line ledger).
- **Why not a merchant-of-record (Paddle/Lemon Squeezy) yet:** their 5% + $0.50 is confiscatory on the $5 credit pack (~15% vs Stripe's ~8.9%; ~2–3.3× penalty across the $5/$10/$25 tiers), and Stripe→MoR is a well-trodden migration while the reverse is painful. Tax exposure is small while US-centric with 3 SKUs (Stripe Tax calculates; register only on nexus).
- **Two adopted caveats:** (1) fix the **$5 pack economics** — at 8.9% effective fee it eats ~33% of gross margin against the `credits_for_cost` markup, so raise the minimum or make entry packs web-only/larger; (2) **gate payments behind the existing launch flag** (`SX_STRIPE_ENABLED=0`, enforced in `server/billing/stripe_service.py`) until retention is proven — free tiers cost only fal fees, not complexity.

### AI inference — fal.ai now, hybrid self-host at a measured trigger
- **Verdict:** stay on **fal.ai** metered inference. Per-second COGS ($0.04–0.08/s outpaints, $0.03/MP upscales) scales to $0 at $0 revenue — and the credits system requires per-job metered costs to keep margin auditable per job. An always-on GPU is a $430–800/mo fixed liability against revenue that doesn't exist yet.
- **Why not self-host everything:** 8+ models in the catalog = 8+ weight pipelines, CUDA matrices, and license reviews ≈ a $150k/yr MLOps hire to save $1–2k/mo. Frontier outpaints (Luma Ray-2 reframe, LTX-2) have no open-weight equivalent at all.
- **Hybrid trigger (adopted):** when fal spend crosses **~$500/mo** or **~20–50 upscale jobs/day**, self-host the open-weight, high-volume upscalers (Real-ESRGAN class) on one L40S (~$15–26/day); keep Ray-2/LTX-2 hero outpaints on fal permanently, using fal as burst/overflow. The repo already has the escape hatches: free FFmpeg `fast` engine is the default, `pipeline/spatial_worker.py` already runs Video-Depth-Anything locally (cuda/mps/cpu), and the VapourSynth Studio engine is one dependency fix from shipping.
- **Known margin pressure (watch it):** a 60s hero outpaint ≈ $3.60 fal COGS vs ~$4.56 net on a $5 pack after Stripe — ~$0.96 margin, one retry from underwater. fal's documented price instability (`core/models.py`: "Estimate only — pull live pricing") means credit pricing must track fal pricing.

### What these verdicts do NOT remove from this checklist
The blockers below are unchanged and still gate public beta. The verdicts pick *where* things run; they do not implement the security/ownership/anti-abuse controls (auth on processing endpoints, FAL spend limits, per-user quotas, ownership checks, retention/deletion, backups + restore drill, monitoring/alerting) that remain required regardless of host.

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

### VR roadmap phases — out of beta scope by design (source: `docs/todolist.md`)

- **Phase 0 — playback foundation:** remove normal-path decoded-frame skipping (today the VR uploader intentionally drops the 30fps source to 10–15fps via stride — the choppy-motion workaround documented in `vr-reels-playback-investigation.md:94–157`); standardize one Quest-appropriate rendition with auto-selection (today: single `-preview.mp4` proxy, `reels.py:1194`); texture-upload contention control (video/controls/comments/earth/glow `needsUpdate` calls + hidden preload competing per frame — `webxr_vr.js`); bounded cache/memory/thermal on-device validation.
- **Phase 1 — immersive-media contract:** stored projection/stereo-layout/orientation/comfort metadata; per-rendition codec/bitrate/fps records; caption + AI-provenance metadata; replace filename-based SBS detection (`reels.html:4255–4262` regexes `sbs|3d` against filename/folder — renaming a file silently breaks stereo) with metadata + legacy inference fallback; guaranteed mono-flat fallback for invalid/missing metadata.
- **Phase 2 tail:** open city/event Packs directly from Earth (with location privacy + preview safety filtering).
- **Phase 3:** world/body-lock default, recenter + `COMFORT`/`CINEMA`/`IMMERSIVE` presets, timed captions + transcription/translation.
- **Phase 4:** World Shell PoC (keyframe → panorama/depth shell at upload, `ENTER WORLD`/`EXIT WORLD`, provenance labels).
- **Phases 5–6:** commercial pilots (property/travel/city), synchronized viewing, voice nav, 2.5D reels, splats/volumetric research.
- **Funding-doc guardrails (settled, no action):** creator view-payouts deferred; gaze-data resale, casino-style retention, stolen IP, fake-memories, bots-as-humans all rejected.

> [!IMPORTANT]
> **Accepted beta limitation:** the Quest device gate below validates the *frame-skipping* playback path as it exists today. Beta ships with stride-reduced VR playback (30fps source → ~10–15fps in headset) as a known limitation; Phase 0 is the follow-up that removes it. Do not treat the device gate as failing against Phase 0 expectations.

### Known unfinished engineering (tracked in `docs/todolist.md` — verified still open 2026-09-19)

- `MessagingContext.jsx:248–256`: send-reconcile builds `reconciled` but discards it (possible duplicate bubbles on key migration); optimistic GIF sends render empty until server echo.
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
- [ ] Add hard FAL spending limits and alerts — **confirmed still open; sharpened:** `normalize_model_id` (`core/models.py:235–254`) accepts *any* fal model ID (BYOK-only for credits, but no per-job cost cap/confirmation), and the `ltx_loras` validator only checks the string starts with `http(s)://` while `attach_civitai_token` (`pipeline/utils.py:12–34`) splices the server-held `CIVITAI_KEY` onto any URL **containing the substring** `civitai.com/api/download/models` — a crafted URL exfiltrates the token. Parse hostnames + allowlist; cap custom-model BYOK spend. **Partially done (2026-09-20):** `attach_civitai_token` now parses `urlsplit` against an exact hostname allowlist (`civitai.com`, `www.civitai.com`) + https-only (substring exfil closed, unit-tested); per-job spend cap `SX_FAL_MAX_QUOTE_USD` (default $10, `0` disables) enforced in `create_quote`. **Remaining:** global spend alerts.
- [ ] Configure reverse-proxy request-body limits and timeouts that match the application upload limits. **Note (2026-09-19):** Cloudflare's free-plan body limit is 100 MB vs the app's 500 MB video cap — lower the app cap or document the plan requirement.
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

- [ ] Publish a privacy policy, terms of service, and community/content rules — **build task, not just writing (2026-09-19):** no `/privacy`, `/terms`, or `/rules` routes or page components exist anywhere in `web/src`; add a `LegalPage` + routes + footer links first.
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
- [ ] Until those controls exist, operate as invite-only/allowlisted or set `SX_REGISTRATION_ENABLED=0`. **Update (2026-09-20):** invite path implemented — `SX_REGISTRATION_ALLOWLIST` (comma-separated emails, case-insensitive) is honored while registration is closed (`social.py:80–121`, tested in `test_registration_allowlist.py`).
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

- [ ] Choose and document the supported production topology. **Decided 2026-09-19 — see "Infrastructure design verdicts" above:** single VPS + co-located PostgreSQL for beta; Fly.io and managed Postgres are later growth triggers, not launch choices. **Remaining work for that topology (2026-09-19 audit):** ship a `compose.yaml` (app + `postgres:16`, `pgdata` named volume, health-gated `depends_on`); document the full `docker run`/compose command including `-v data:/app/data` (the current RUNNING.md command mounts only `output/` — `docker rm` would destroy the DB and avatars); add a container entrypoint that runs `alembic upgrade head` before uvicorn (today first boot against an empty Postgres crash-loops: `init_database()` raises from lifespan).
- [ ] **New:** Write and rehearse the SQLite→PostgreSQL **data** migration procedure — Alembic manages schema only; existing users/posts/credits rows need `scripts/sqlite_to_pg.py` or a pgloader recipe, run before the first Stripe charge.
- [ ] SQLite is acceptable only pre-payments on the single VPS; migrate to PostgreSQL before the first Stripe charge (verdicts above). If SQLite is retained temporarily, run exactly one application instance/worker and pass realistic concurrent-write and lock-contention tests.
- [ ] Because jobs and staged-upload registries are currently process-local, deploy exactly one application worker/replica (matches the single-VPS verdict); only replace them with a durable shared job queue and state store if/when moving to multi-machine later.
- [ ] Persist or externally store the production database, `data/avatars`, published media, and any paid job result that must survive a restart. The documented Docker command currently persists only `output/`. Media stays on the VPS's local disk per the verdicts; Cloudflare R2 is a later egress trigger, not a launch blocker. **Note:** staged uploads live in the container's `/tmp/square_extender_api/uploads` — lost on restart mid-job; document this as accepted behavior.
- [ ] Define storage lifecycle cleanup for abandoned uploads, failed jobs, expired drafts, proxies, previews, and deleted posts.
- [ ] Run automated database and media backups on a documented schedule — **specify:** cron'd `pg_dump` with off-box copy (or Hetzner volume snapshots) + documented retention.
- [ ] Perform and record a full restore drill, including message decryption and media availability.
- [ ] Document deployment rollback, schema rollback limitations, and recovery from an interrupted migration.
- [ ] **New:** Graceful shutdown — lifespan teardown currently only cancels the cleanup task; `ThreadPoolExecutor` pools are never shut down, so SIGTERM kills in-flight ffmpeg mid-write. Drain pools on shutdown; document restart-during-job behavior (reservation reconciliation at next boot already exists — `app.py:52–53` — but is undocumented).
- [ ] **New:** Container hygiene — run as non-root (`USER`), pin the base image digest + ffmpeg version, and split Streamlit out of the production requirements (it bakes pyarrow et al. into the prod image). Also standardize dev/prod interpreters (repo `.venv` is CPython 3.14; the image is 3.12).

### Network and application hardening

- [ ] Terminate HTTPS at a trusted proxy and configure HSTS after HTTPS behavior is verified. **Note:** Quest Browser requires a secure context for WebXR — the physical-Quest gate below depends on HTTPS being live (or the `adb reverse` localhost workflow from `docs/threejs-vr-implementation-plan.md` §6).
- [ ] Configure trusted-host validation and production security headers, including CSP, `X-Content-Type-Options`, and a suitable referrer policy. **Add `script-src 'self'`:** the reels player mount injects server-rendered HTML/scripts into the SPA DOM unsandboxed (`ReelsPlayer.jsx:95–110`) — currently safe (feed JSON escaped, user text via `textContent`), but CSP makes a future template regression non-exploitable.
- [ ] Restrict production CORS origins — **override `SX_DEV_ORIGINS` explicitly** (it defaults to `http://localhost:5173,http://127.0.0.1:5173` in `app.py:95`).
- [ ] **New (2026-09-19):** Cloudflare-specific edge config — Cache Rule bypass for `/api/*` and `/media/*` (CF caches/compresses by extension), Rocket Loader + minify off for the SPA, and note the 15s SSE keep-alive sits safely under CF's ~100s idle timeout. `X-Accel-Buffering: no` covers nginx, not Cloudflare.
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
- [ ] Run `make migrate` on a production-like database and verify the schema reaches **`20260913_0010`** (updated from the stale `20260912_0004`; source of truth: `EXPECTED_SCHEMA_REVISION` in `server/social/database.py:14`).
- [ ] Test fresh database creation, upgrade from the oldest supported production schema, failed-migration recovery, and backup restoration.
- [ ] Test the chosen production database rather than relying only on SQLite test runs — **priority:** re-run the billing suite and the recommendation concurrency tests (`tests/test_recommendations.py -k concurrent`, currently SQLite-fixture-only) against PostgreSQL.
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
- [ ] Run `make migrate` and confirm the final revision is **`20260913_0010`** (updated from stale `20260912_0004`).

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

**2026-09-20 security/money + edge verification (uncommitted working tree):**

- Backend regression suite: **158 passed** (`pytest -q tests`, ~27s) — includes 66 pre-existing hardening-adjacent tests plus 6 registration-allowlist, 24 security/money, and 36 edge-case tests (all SQLite fixtures; Postgres re-run remains a listed gate above).
- Frontend: 13 vitest passed; `vite build` clean.
- Publication-path ownership now enforced (the 2026-09-19 "remains open" note above is resolved); no job-cancel endpoint yet.

**2026-09-19 audit round 2 (four-agent codebase re-verification):**

- Recommendation concurrency regression tests: **passing** — `test_concurrent_page_materialization_replays_winner` + `test_concurrent_affinity_upsert_dedupes` (4 passed, ~1.5s, SQLite fixtures; Postgres re-run is a listed gate above). The 2026-09-12 "failed with HTTP 500s" record below is **historical** — the fix (winner-replay on `uq_recommendation_request_session_page`) landed and is dual-dialect.
- Staged-upload/job ownership tests: **passing** (`tests/test_cloud_routes.py` — owner-private staging, owned job status/download). Publication-path ownership was open at audit time — **fixed 2026-09-20** (see verification entry above).
- `.venv` recreated (CPython 3.14.6); the 2026-09-12 ".venv absent" note is resolved.
- Current schema head: `20260913_0010` (`EXPECTED_SCHEMA_REVISION`, `server/social/database.py:14`).
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
