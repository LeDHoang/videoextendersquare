# To-do List

Last verified: 2026-09-14 on the collection-pipeline working tree (billing-fix batch in `532205e`, Reel Packs in `a093a26`) — collection pipeline pass: 11/11 focused pytest, 77/77 full application pytest, 44/44 Node tests, 13/13 Vitest tests, `vite build` clean, pack/WebXR script syntax clean. Scope: save-to-collection (2D player + XR collect card), mixed-creator public-reel membership with per-viewer blocked-member tombstones, publish 3–30 from PackPage and XR cards, curated-by display rule, generic-DM draft share guard. The earlier billing live-smoke record remains in the deep-test notes below.

VR Reels strategy review: [Funding in Vietnam 2 investigation](funding-in-vietnam-2-vr-reels-investigation.md). Reel Packs implementation record: [Reel Packs implementation investigation](reel-packs-implementation-investigation.md).

## Done

- [x] Fix upload avatar (root cause: Vite dev proxy forwarded `/api` + `/media` but not `/avatars`, so uploads succeeded while avatar images 404'd on :5173; fixed by adding `'/avatars': 'http://localhost:8000'` to `web/vite.config.js`.)
- [x] Encrypted direct messaging — requests (pending/active), text/emote/GIF/reel kinds, idempotent sends via `(sender, client_id)`, read receipts, deletion, blocking, durable SSE events (`server/routers/messages.py`, `server/social/message_crypto.py` AES-GCM, migration `20260911_0003`). Note: app-level encryption with a server-held key, **not** true end-to-end (the UI discloses this).
- [x] Reel sharing — canonical links (`GET /api/posts/:id/share`), clipboard + native share, QR PNG download (`qrcode`), multi-recipient (≤10) idempotent delivery, entry points on Reels page, Explore tiles, profile, and player (`ReelShareDialog.jsx`).
- [x] Reel Packs — first-class ordered 5–12 reel collections with public/unlisted visibility, stable URLs and revisions, authoring/reordering, covers/collages, discovery/search/tag/location/profile/library surfaces, live saves, finite 2D and WebXR playback, distinct sharing/messages/tombstones, analytics attribution, moderation, feature flags, and additive migration `20260913_0009`.
- [x] Messages UI — responsive page (`/messages`), compact dock, unread badges, profile entry point (`MessagingContext.jsx`, `MessagingPanel.jsx`, `MessageDock.jsx`, `MessagesPage.jsx`).
- [x] Messages nav icon — `/messages` now uses `IndustrialMessageIcon` (was reusing the explore icon).
- [x] ECHO Credits billing + reel rewards (`18ecbd0`: deterministic Fal pricing, credit accounts/ledger/reservations, Stripe Checkout/webhooks, encrypted BYOK keys, reward claims, migration `20260913_0006`, React + reels + WebXR integration).
- [x] Billing High-fix batch (committed in `532205e`): CAS stage settlement (no double capture/release), guarded release, per-stage finalize commits with `pending_reconciliation` deferral, write-once Fal request IDs, stale-reservation reaper (`SX_BILLING_RESERVED_TTL_MIN`), pro-rated partial refunds (migration `20260913_0007`), terminal Stripe reversal states, BYOK auto-switch with visible notice.
- [x] Billing Medium/Low-fix batch (committed in `532205e`): guarded quote restore on reserve failure, idempotent grant/debit/reserve ledger inserts, webhook dedup race handling, reward grant-first, staged-upload ownership binding + quote file fingerprint (migration `20260913_0008`), fail-closed billing secrets (Option B: billing 503s, rest runs), `/api/config` key-leak removal, required `SX_PUBLIC_BASE_URL`, tightened CORS, generic webhook errors, invalid-cursor 404, quote refresh race/abort, retry-quote submit flow, wallet freshness + origin-checked messages, param serialization guards, billing error map, reward claim retry with backoff, checkout-return polling, temporary Credits nav icon.
- [x] Earth VR interaction (`227c919` + follow-ups, committed): globe +30% (`EARTH_RADIUS` 0.52 → 0.676, rescaled dock/label/preview offsets), vertical pitch rotation (clamped ±1.2 rad, −20% pitch gain), hold-to-drag (280ms hold or flick engages; taps never rotate), single-axis lock per drag, Quest `selectend`-without-pose tap fallback, tremor-immune tap detection (distance-from-press, ~3.4°).
- [x] Deep verification tooling gaps found and fixed during verification: broken `useCreditQuotes.js` duplicated tail (failed `vite build`, invisible to all test suites — fixed), `transactions()` 500 on invalid cursor (now 400), unused `import os` in `config.py`.
- [x] Confirmed the intended `sse-starlette>=2.0` test dependency is declared in `requirements.txt` and reran the complete application backend suite including `tests/test_cloud_routes.py` (2026-09-14: 75/75 passed; the earlier "could not collect" exclusion no longer applies).
- [x] Committed the billing-fix batch (migrations `0007`/`0008`, `billingErrors.js`, credits icon, and related UI/tests) in `532205e`; working tree clean on `6bb9821`.
- [x] Reel Packs collection pipeline: save reels (any creator's public reels) to personal draft collections from the 2D player COLLECT menu and XR SAVE TO card, mixed-creator membership with per-viewer blocked-member tombstones, publish 3–30 from the PackPage and XR intro/complete cards, curated-by collection-level labeling, editor switched to a public-reel search browser, and the generic-DM draft share guard.

## Still open

- [ ] Manual two-browser + Quest validation (see `docs/to-beta.md` checklist; milestone 8 in `docs/messaging-reels-sharing-progress.md`). Includes on-device check of Earth tap-vs-hold feel (`EARTH_DRAG_HOLD_MS`, tap/drag chords) and drag-up direction sign.
- [ ] Complete the Reel Packs release matrix in `docs/reel-packs-implementation-investigation.md`: two-browser concurrency, mobile/keyboard/screen-reader checks, native share/QR/messaging, and physical Quest controller/hand/seated/XR-resume validation.
- [ ] Review the Explore page reels loading priority.
- [ ] Review VR immersive-mode reel playback and loading. (Earth interaction reworked, but full playback/loading review still open.)
- [ ] Reduce and spread out controls on the player action rail.
- [ ] Stripe CLI live webhook walkthrough (duplicate, delayed-success, partial/full refund, dispute, both orders) before enabling `SX_STRIPE_ENABLED` in production.
- [ ] True thread-level/Postgres concurrency test for settlement races (atomicity currently rests on single-statement guarded `UPDATE`s + idempotent keys, exercised sequentially).
- [ ] Replace temporary Credits nav coin glyph with final art (`web/src/components/icons/svg/credits.svg`, marked TEMP).

## VR Reels recommended execution order

Follow the phases in order unless measured results change a dependency.

### Phase 0 — Playback and release foundation

- [ ] Complete the controlled physical-Quest playback matrix in `docs/vr-reels-playback-investigation.md`.
- [ ] Remove normal-path decoded-frame skipping and select a validated Quest/browser rendition automatically.
- [ ] Measure and control contention from hidden preload, glow sampling, comments, and other texture uploads.
- [ ] Verify bounded cache, cancellation, memory stability, buffering, frame pacing, and thermal behavior on device.
- [ ] Complete the applicable security, ownership, quota, queue, recommendation-concurrency, privacy, moderation, storage, and monitoring blockers in `docs/to-beta.md`.
- [ ] Repeat Meta documentation verification on a supported host and record Quest Browser/Horizon OS versions.

### Phase 1 — Immersive-media contract

- [ ] Store explicit projection, stereo-layout, presentation-mode, orientation, and comfort metadata.
- [ ] Store codec, dimensions, bitrate, frame rate, device target, and fallback for every rendition.
- [ ] Add caption, translation, audio-description, generated-asset, and provenance metadata.
- [ ] Replace filename/folder SBS detection with metadata, retaining legacy inference only during migration.
- [ ] Guarantee a safe mono-flat fallback for missing, invalid, or unsupported immersive assets.

### Phase 2 — Reel Packs

- [x] Add additive Pack models, item/tag/save/progress relationships, message/event references, constraints, and migration `20260913_0009`.
- [x] Add ownership-safe draft/create/edit/publish/unpublish/delete APIs with atomic expected-revision conflicts.
- [x] Add public/unlisted permissions, repair hiding, unavailable-item tombstones, and generic inaccessible responses.
- [x] Add distinct Pack tiles and `ALL | REELS | PACKS` discovery with Pack pagination.
- [x] Add Pack results to tag and location discovery, plus public profile and saved-library Pack views.
- [x] Add finite authored 2D playback with intro, resume, queue selection, previous/next, unavailable skipping, and explicit completion.
- [x] Keep like, comments, Save/Share Reel, follow/profile, report, seek, mute, projection, and immersive controls available for the active reel while keeping Pack Save/Share separate.
- [x] Generalize sharing and add live Pack attachments, optional notes, recipient-specific idempotency, distinct conversation previews, and unavailable tombstones.
- [x] Extend WebXR with video/image/static-card sources, Pack position/queue UI, stable intro/completion cards, and safe DOM-action transitions.
- [x] Add Pack analytics attribution and independent creation/discovery/immersive feature flags.
- [ ] Complete browser, mobile, screen-reader, grayscale, keyboard-only, and multi-session conflict validation.
- [ ] Complete physical Quest controller, hand, one-handed, seated, tracking-loss, XR exit/resume, frame pacing, memory, and thermal validation.
- [ ] Re-run official Meta documentation verification on a supported host before immersive rollout.
- [ ] Open city/event Packs directly from Earth while retaining city-level location privacy and preview safety filtering.

### Phase 3 — Comfort and accessibility

- [ ] Make stable world/body lock the default; retain direct head lock as an option.
- [ ] Add recenter plus `COMFORT`, `CINEMA`, and `IMMERSIVE` viewing presets.
- [ ] Validate screen FOV, text, targets, controls, and horizon stability on physical hardware.
- [ ] Ensure every core action works seated and with one controller or hand.
- [ ] Add timed captions with adjustable size, position, contrast, and background.
- [ ] Add optional transcription, translation, reduced motion, and non-audio alternatives for important cues.

### Phase 4 — World Shell proof of concept

- [ ] Let the creator select or approve a representative keyframe.
- [ ] Generate one static panorama/cubemap or shallow depth-layered shell during upload.
- [ ] Keep the original reel unchanged as the central authoritative source.
- [ ] Render one static shell rather than a second background video.
- [ ] Add explicit `ENTER WORLD` and `EXIT WORLD` controls.
- [ ] Label generated surroundings and store source/model/version provenance.
- [ ] Add reduced-motion fallback and measure performance against the no-shell baseline.

### Phase 5 — Controlled commercial pilots

- [ ] Pilot property, hospitality, studio, and creator-space tours with rights holders.
- [ ] Pilot travel, restaurant, and city packs connected to Earth.
- [ ] Measure generation cost, failure rate, comfort, completion, saves, shares, and qualified leads.
- [ ] Require sponsorship, rights, likeness, venue, and AI-generation disclosures.
- [ ] Consider licensed music next; defer sports until fast-motion playback and broadcast rights are proven.
- [ ] Defer creator payouts based on views until fraud and event-attribution controls are production-ready.

### Phase 6 — Later social and research work

- [ ] Prototype invitation-based synchronized viewing using existing messaging.
- [ ] Add optional voice navigation only with visible listening state and controller/hand fallback.
- [ ] Prototype conservative 2.5D image reels.
- [ ] Research Gaussian splats, volumetric capture, and live generated worlds separately from the product roadmap.
- [ ] Treat physical projection rooms and custom glasses as future partnerships/research, not current product work.

Guardrails: no stolen media, deceptive fake memories, unlabeled AI, casino-style
engagement design, biometric/gaze-data resale, military conditioning, harmful
trauma optimization, precise private-location exposure, or bots masquerading as
people.

## Known gaps found during verification (not yet fixed)

- `MessagingContext.jsx:248-256`: send-reconcile builds `reconciled` but discards it (possible duplicate bubbles on key migration); optimistic GIF sends render empty until server echo.
- Report on an already-deleted message returns 404 `REPORT_TARGET_NOT_FOUND` (evidence path only verified for live messages).
- Staged uploads are process-memory: multi-worker deployments need sticky sessions (or a single worker) or quote/submit pairs may miss; a restart drops staged files (documented in `RUNNING.md`).
- Reward threshold uses client-reported duration (accepted risk: server-elapsed gate + foreground telemetry + 5/day + IP caps bound farming; documented in `RUNNING.md`).

## Deep-test notes (all passing, for the record)

- Request lifecycle: stranger DM → `pending`, second send → 409 `REQUEST_PENDING`, accept → `active`; decline → further sends rejected.
- Followed recipient gets an `active` conversation immediately; block (`PUT /api/users/:u/block`) → sends fail with `MESSAGING_BLOCKED`.
- Idempotency: duplicate `client_id` returns `duplicate: true` with no extra row, for both DMs and `share-reel` batches.
- History pagination via `next_before` cursor; `mark read` reduces unread counts; sender delete tombstones for receiver, non-sender delete → 403/404.
- GIF: direct send of allowlisted-host URL works without a Tenor key; off-host URL → 422; `/gifs/search` without key → 503 `GIF_SEARCH_UNAVAILABLE`.
- SSE `/api/messages/events` streams queued `message.created` events with cursor ids (`id:`/`event:`/`data:` frames).
- Logged-out `GET /api/reels?post=<id>` returns exactly the one reel (200, `count: 1`); unknown id → 404 `POST_NOT_FOUND`. (Earlier concern about `ReelsPage` deep-link index was benign — the backend pre-filters to the single post, so index 0 is correct.)
- Client-id format enforced: `^[A-Za-z0-9._:-]{8,64}$`, else 422 `INVALID_CLIENT_ID`.
- Billing (2026-09-13, working tree on `227c919`): 66/66 pytest incl. 15 new fix tests (concurrent release/capture exactly-once, success-after-release → `pending_reconciliation`, write-once request id, quote restore on insufficient balance, fingerprint swap rejection, milestone-race loser without phantom credit, reaper stale/partial cases, pro-rata partial refunds + accumulation, unpaid-refund skip, late-completed-keeps-reversed, staged-ownership owner/other/pre-login cases, placeholder-secrets 503); 6/6 vitest; live-app smoke green (see header); `POST /api/billing/quote` with insufficient balance restores quote to `active` for retry after top-up.
- Pricing spot checks: `credits_for_cost(0.30)=41`, `upscale_only+fast → 0 stages/0 credits`, zero-duration → `PricingError`.
- Collections follow-up (2026-09-14, migration `20260913_0010`): collection tiles mirror reel tiles (creator chip, SHARE, autoplaying low-res thumbnails drawn from `cover_items`, like/view/comment counters); duplicate 2D COLLECT rail button removed (SAVE opens the collect overlay), collect dialog moved above all player chrome (`z-index: 90/91` + `.sx-collect-open`); Pack intro gate removed so collections play immediately; Explore/tag/location tiles deep-link straight to playback. 78/78 pytest, 45 node + 13 vitest, `vite build` clean.
- Collections verification round (2026-09-14): live end-to-end pass confirmed like idempotency, 10-minute per-viewer view dedup (auth + anonymous cookie), and unlike; pack counters excluded comment authors the viewer blocks (new test); fixed collect-dialog edge-nav leak (page-level chevrons stayed clickable behind the modal — now hidden via a body-level class); fixed PackTile error handling to advance to the next clip instead of disabling autoplay, stop the cycle timer once every clip has failed, and reset failed clips on pack refresh; hid the tile REEL PACK badge under the owner EDIT chip; trimmed XR queue rows to 10 when the publish row renders so they cannot overlap; hoisted a per-tombstone `serialize_pack` call out of the pack feed loop.
