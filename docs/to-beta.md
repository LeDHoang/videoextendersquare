# Beta Launch Checklist

Last updated: 2026-09-12

Status: **Blocked for public beta.** Complete every item in "Public beta release blockers" before opening registration or exposing the deployment publicly. An invite-only beta must still protect paid processing endpoints and private user media.

## Public beta release blockers

### Processing API security and cost controls

- [ ] Require authentication and CSRF protection for image/video upload and processing endpoints.
- [x] Remove runtime platform-key mutation and restrict `PUT /api/config/models` to administrator sessions with CSRF protection.
- [ ] Protect CPU/GPU-intensive Reels and comparison endpoints, including Explore preview generation, proxy generation, spatialization, comparison preparation, and forced health refreshes.
- [ ] Add per-user and per-IP upload, processing, event, and storage quotas.
- [ ] Add bounded job queues, global and per-user concurrency limits, and overload responses instead of allowing an unlimited pending executor queue.
- [ ] Add hard FAL spending limits and alerts. A user must not be able to choose an arbitrary expensive model or repeatedly consume the deployment's FAL credits.
- [ ] Configure reverse-proxy request-body limits and timeouts that match the application upload limits.
- [ ] Add regression tests proving logged-out users and ordinary users cannot access administrator or cost-bearing operations.

### Job, upload, and media ownership

- [ ] Add an owner identity to staged uploads and job records.
- [ ] Enforce ownership on job status, SSE progress, results, downloads, cancellation, and publication.
- [ ] Prevent one authenticated user from publishing another user's `stage_id` or `job_id`.
- [ ] Separate private/unpublished job artifacts from public published media. Do not mount the entire working `output/` tree as public media.
- [ ] Ensure every item returned by public Reels, Explore, tag, location, profile, and canonical-link routes corresponds to an active, published database post.
- [ ] Disable directory-style legacy media discovery in production or constrain it to an explicit public-media directory.
- [ ] Add multi-user authorization tests covering guessed, stolen, expired, and cross-user stage/job identifiers.

### Recommendation correctness and abuse resistance

- [ ] Fix concurrent materialization of the same recommendation cursor. Reels and creator suggestions must use transaction-safe get-or-create/retry handling instead of returning unique-constraint HTTP 500 errors.
- [ ] Add a permanent synchronized concurrency regression test for both Reels pages and creator-suggestion pages.
- [ ] Rate-limit `/api/events`, `/api/posts/{post_id}/view`, and anonymous recommendation feedback.
- [ ] Validate watch, foreground, position, and duration values against server-known media duration; reject or clamp impossible values.
- [ ] Limit the serialized size and accepted keys of event `context` and `playback_quality` objects.
- [ ] Cap repeated actor/item contributions so event replay cannot manipulate affinities, co-watch data, or global popularity statistics.
- [ ] Preserve valid impression/session attribution checks and add tests for fabricated events without delivery provenance.
- [ ] Decide whether an already materialized page should refill after a post or creator becomes ineligible. Currently it safely removes the item but can return an underfilled page with stale `has_more`.
- [ ] Refactor recommendation scope reads to use the request's dependency-injected database session rather than opening a second global session.

### Privacy, deletion, and public policy

- [ ] Publish a privacy policy, terms of service, and community/content rules.
- [ ] Disclose which media and metadata are sent to FAL or other third-party processors before users submit content.
- [ ] Define retention periods for staged uploads, job artifacts, published media, raw engagement events, recommendation sessions, impressions, dismissals, affinities, co-watch rows, messages, reports, logs, and anonymous identifiers.
- [ ] Extend account deletion to delete or irreversibly anonymize all recommendation sessions, impressions, requests, dismissals, affinities, co-watch data, and retained actor keys associated with the account.
- [ ] Add deletion tests proving a deleted account cannot be reconstructed from recommendation or analytics tables.
- [ ] Add a visible "Clear personalization" control and shorter documented retention for anonymous activity before relying on the one-year anonymous cookie.
- [ ] Decide whether anonymous history may ever be merged into a registered account; do not merge it without explicit documented product and privacy approval.
- [ ] Document the moderation response process, escalation contacts, expected response time, appeal process, and content-removal procedure.

### Registration and anti-abuse

- [ ] For a public beta, add email verification and bot protection to registration.
- [ ] Until those controls exist, operate as invite-only/allowlisted or set `SX_REGISTRATION_ENABLED=0`.
- [ ] Verify account, messaging, reporting, following, upload, and recommendation-event rate limits under coordinated abuse.
- [ ] Add moderator alerts and dashboards for report spikes, spam registrations, abusive messaging, unusual generation spend, and storage growth.

## Production deployment and operations

### Secrets and environment

- [ ] Generate a long random value and set `SX_SECURITY_SECRET`.
- [ ] Generate a separate long random value for `SX_MESSAGE_ENCRYPTION_KEY`, store it in the deployment secret manager, and back it up. Do not rotate it without re-encrypting stored data.
- [ ] Store `FAL_KEY`, SMTP credentials, and all other production secrets in the deployment secret manager rather than accepting them from a public UI.
- [ ] If GIF search is enabled, configure `SX_TENOR_API_KEY`, `SX_TENOR_CLIENT_KEY`, and the narrowest practical `SX_TENOR_ALLOWED_HOSTS` list.
- [ ] Set `SX_ADMIN_USERS` and/or `SX_MODERATOR_USERS` to the launch-team usernames or emails.
- [ ] Set `SX_PUBLIC_URL` to the deployed HTTPS website origin.
- [ ] Set `SX_COOKIE_SECURE=1` when serving over HTTPS.
- [ ] Keep `SX_PASSWORD_RESET_EXPOSE_TOKEN=0` outside local development.
- [ ] Keep `SX_TRUST_PROXY_HEADERS=0` unless a trusted reverse proxy overwrites client-supplied forwarding headers.
- [ ] Confirm `.env`, database files, keys, and generated secrets are excluded from version control and container images.

### Database, storage, and workers

- [ ] Choose and document the supported production topology. Prefer PostgreSQL for a public multi-user deployment.
- [ ] If SQLite is retained temporarily, run exactly one application instance/worker and pass realistic concurrent-write and lock-contention tests.
- [ ] Because jobs and staged-upload registries are currently process-local, either deploy exactly one application worker/replica or replace them with a durable shared job queue and state store.
- [ ] Persist or externally store the production database, `data/avatars`, published media, and any paid job result that must survive a restart. The documented Docker command currently persists only `output/`.
- [ ] Define storage lifecycle cleanup for abandoned uploads, failed jobs, expired drafts, proxies, previews, and deleted posts.
- [ ] Run automated database and media backups on a documented schedule.
- [ ] Perform and record a full restore drill, including message decryption and media availability.
- [ ] Document deployment rollback, schema rollback limitations, and recovery from an interrupted migration.

### Network and application hardening

- [ ] Terminate HTTPS at a trusted proxy and configure HSTS after HTTPS behavior is verified.
- [ ] Configure trusted-host validation and production security headers, including CSP, `X-Content-Type-Options`, and a suitable referrer policy.
- [ ] Restrict production CORS origins; do not deploy with unnecessary development origins.
- [ ] Disable buffering for `/api/messages/events` and keep SSE connections open beyond the 15-second keep-alive interval.
- [ ] Protect or disable production diagnostic endpoints. Do not let anonymous users overwrite or read global headset telemetry.
- [ ] Rate-limit outbound model-information lookups and other endpoints that can force network or transcoding work.
- [ ] Run dependency, secret, and vulnerability scans and resolve release-blocking findings.

### Health, monitoring, and support

- [ ] Split cheap liveness from readiness checks.
- [ ] Make readiness verify database connectivity/schema revision, writable storage, required encryption configuration, and other critical dependencies without launching expensive probes on every request.
- [ ] Add structured request logs, correlation/request IDs, centralized error tracking, and redaction of credentials and private recommendation context.
- [ ] Monitor HTTP error rate, latency, queue depth, worker utilization, database locks/connections, disk usage, SSE disconnects, event-attribution failures, and recommendation page failures.
- [ ] Alert on FAL spend, storage exhaustion, backup failure, elevated report volume, registration spikes, and repeated processing failures.
- [ ] Define an on-call owner, incident procedure, public support/contact channel, and rollback decision criteria for the beta.

## Build, migration, and automated release gates

- [ ] Create CI that installs dependencies from a clean environment and runs the scoped website checks on every release candidate.
- [ ] Run `make test` in the normal project `.venv` and record the exact commit and dependency versions.
- [ ] Run `make build` and deploy the generated frontend from the same tested commit.
- [ ] Run Python compilation and frontend/inline JavaScript parse checks.
- [ ] Run `make migrate` on a production-like database and verify the schema reaches `20260912_0004`.
- [ ] Test fresh database creation, upgrade from the oldest supported production schema, failed-migration recovery, and backup restoration.
- [ ] Test the chosen production database rather than relying only on SQLite test runs.
- [ ] Require CI success, migration success, a clean worktree, and an approved release checklist before deployment.

## Functional, concurrency, and device verification

- [ ] Send a real password-reset email and verify the deployed reset link.
- [ ] With two real accounts in separate browser sessions, test message request routing, accept/decline, all message types, unread/read receipts, reconnect, deletion, blocking, reporting, and ten-recipient reel sharing.
- [ ] Open a copied or QR reel link while logged out and confirm `/reels?post=<id>` opens only the intended active public reel.
- [ ] Smoke-test registration, email verification, login/logout, profile editing, avatar replacement, post publishing/editing/deletion, Saved links, following, blocking, reporting, moderation, password reset, personalization reset, and account deletion.
- [ ] Test simultaneous upload, processing, polling, downloading, publishing, and recommendation pagination from multiple accounts.
- [ ] Load-test feed pagination, event ingestion, authentication, messaging SSE, uploads, jobs, and database writes at the expected beta concurrency plus safety margin.
- [ ] Confirm queue saturation produces controlled `429`/`503` responses and does not exhaust memory, disk, threads, database connections, or FAL budget.
- [ ] Test process restart during queued/running/completed jobs and confirm the documented recovery behavior.
- [ ] Test current Chrome, Safari, Firefox, mobile browsers, and the supported Quest Browser/device matrix.
- [ ] Validate Reels autoplay/manual navigation, audio, next-page preloading, negative feedback, creator suggestions, canonical links, and profile navigation on a physical Quest device.
- [ ] Verify keyboard navigation, focus visibility, reduced-motion behavior, readable contrast, captions/accessible alternatives where applicable, and responsive layouts.
- [ ] Run a final moderation drill using real reports, blocks, content removal, account suspension, appeal handling, and audit evidence.

Automated Meta documentation and device verification remain unavailable on the current Linux host because `metavr` does not publish a `linux-x64` binary. Physical Quest verification remains a release gate. This document does not claim current Meta Horizon Store compliance requirements.

## Existing pre-Alembic database only

Do not use this procedure for a blank database.

- [ ] Confirm the old social tables exist and `alembic_version` does not.
- [ ] Back up `data/echo.db`.
- [ ] Run `.venv/bin/python -m alembic stamp 20260910_0001`.
- [ ] Run `make migrate` and confirm the final revision is `20260912_0004`.

## Suggested production environment

This is a starting point, not a substitute for implementing the controls above.

```env
FAL_KEY=<deployment-secret>
DATABASE_URL=postgresql+psycopg://<user>:<password>@<host>/<database>

SX_SECURITY_SECRET=<long-random-secret>
SX_MESSAGE_ENCRYPTION_KEY=<different-long-random-secret>
SX_REGISTRATION_ENABLED=0

SX_TENOR_API_KEY=
SX_TENOR_CLIENT_KEY=echo_reels
SX_TENOR_ALLOWED_HOSTS=media.tenor.com,media1.tenor.com

SX_ADMIN_USERS=<admin-username-or-email>
SX_MODERATOR_USERS=
SX_PUBLIC_URL=https://your-domain.example
SX_COOKIE_SECURE=1
SX_TRUST_PROXY_HEADERS=0
SX_PASSWORD_RESET_EXPOSE_TOKEN=0

SX_SMTP_HOST=
SX_SMTP_PORT=465
SX_SMTP_USERNAME=
SX_SMTP_PASSWORD=
SX_SMTP_FROM=
SX_SMTP_SSL=1
SX_SMTP_STARTTLS=1
```

Keep `SX_REGISTRATION_ENABLED=0` for an invite-only deployment until public-registration verification and anti-bot controls are implemented.

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

## Latest recorded automated verification

Recommendation-system verification recorded on 2026-09-12:

- Backend regression suite: 22 passed in the isolated verification environment.
- Frontend unit tests and production build: passed.
- Python and player JavaScript parse checks: passed.
- Fresh Alembic upgrade to `20260912_0004`, downgrade to `20260911_0003`, and schema-drift check: passed.
- Sequential 56-item crawl and 1,000-item/42-page crawl: passed without duplicates and with a terminal null cursor.
- Adaptive ranking and attribution-defense scenarios: passed.
- Concurrent same-cursor test: **failed** with one HTTP 200 and three HTTP 500 responses; this is a release blocker listed above.
- Materialized-page exclusion test: safe filtering passed, but page refill/`has_more` behavior remains incomplete.

The current checkout could not rerun `make test` during the 2026-09-12 checklist review because `.venv/bin/python` was absent. Recreate the documented environment and make CI the authoritative release result before launch.

The unscoped repository-wide `pytest` command also collects the separate, user-owned `ComfyUI/` tree and hardware-specific tests with unavailable dependencies. Use `make test` for this website's backend and frontend regression suite.
