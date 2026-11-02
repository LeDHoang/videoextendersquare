# ui-beta: what was done and what is left

Branch `ui-beta`. Covers the work of 2026-10-29 to 2026-11-02. The UI plan itself is in `docs/ui-beta-plan.md`; the beta checklist is `docs/to-beta.md`.

## 1. Simplified UI for regular users

Regular users get simplified Reels and Explore controls; admins keep the full UI (commit `43a8458`). Details and decisions are in `docs/ui-beta-plan.md`.

## 2. Security and test work (2026-10-30)

### `/model-info` requires sign-in
- `GET /api/config/model-info` used to answer anyone, and every cache miss made up to two fal.ai fetches.
- It now returns 401 `AUTH_REQUIRED` when signed out. Cache misses are limited to 10 per minute per user (429 `RATE_LIMITED`).
- Code: `server/routers/model_info.py`. Tests: `tests/test_model_info_auth.py` (3 tests).
- `CustomModelPanel.jsx` now clears the previous model's schema and pricing when a lookup fails (the new 401 and 429 make that more likely). Test: `CustomModelPanel.test.jsx`.

### Route-access test
- `tests/test_route_access.py` lists all 161 API routes of the production app: 56 public, 76 user, 15 moderator, 11 admin, 3 hidden in production.
- Anonymous callers get 401 `AUTH_REQUIRED` on every user, moderator and admin route, and 404 on the 3 hidden ones. A regular user gets 403 `MODERATOR_REQUIRED` or `ADMIN_REQUIRED` on staff routes and 404 on hidden ones.
- A guard test walks the app's route table (`fastapi.routing.iter_route_contexts`) and pins the 8 entries OpenAPI leaves out, all public: the SPA catch-all, `/api/csp-report`, the `/assets` and `/avatars` mounts, `/docs`, `/docs/oauth2-redirect`, `/redoc` and `/openapi.json`.
- Mutation runs confirmed it fails on: a dropped `require_auth`, a dropped role check, an unlisted route, a dropped production gate, an added websocket, an `add_route` route, and a schema-hidden extra method.

### Live-messaging (SSE) header test
- `tests/test_security_money.py::test_sse_headers_disable_buffering_and_idle_stream_sends_keep_alive` checks `X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform` and `Connection: keep-alive`.
- It also checks that the first frame of an idle stream is `: keep-alive`, that it arrives after 14 one-second sleeps, and that the stream slot is released.
- Mutants (threshold 120, sleep removed, sleep 2 s) all fail it. The 30-minute reconnect is covered by `tests/test_security_edge.py::test_sse_max_lifetime_frame`.

### Security scans
- CI already ran pip-audit, `npm audit --omit=dev --audit-level=high` and gitleaks. It now also runs a Trivy image scan in the `docker` job (`.github/workflows/ci.yml`).
- Trivy is the 0.76.1 release pinned by sha256, not trivy-action, because of the March 2026 compromise (GHSA-69fq-xp46-6x23). It fails on fixable HIGH or CRITICAL findings only.
- Local results: no leaks in 330 commits; pip-audit and npm audit clean; Trivy found no secrets and no fixable HIGH/CRITICAL issues.
- The image has 725 Debian findings with no fix yet (262 distinct CVEs, 102 packages), including one CRITICAL (`libxml2` CVE-2026-6653, DoS). The gate skips them.
- **The Trivy CI step has not run in GitHub Actions yet.**

### Safari-engine pre-check
- Playwright 1.64.1 with WebKit 27.2 (Linux, headless), against the `echo-app:ci` image in dev mode. Desktop 1280×800 and the iPhone 15 profile: 12 of 13 pages passed on each. The only failure was the expected `/api/rewards/reels/claim` 503 (`REWARDS_DISABLED`).
- Muted autoplay and ArrowDown (desktop) or auto-advance (iPhone) worked. No horizontal scroll at 1280 or 393 px.
- Limits: this is the Safari engine, not Safari (no Apple media stack, no iOS autoplay rules, cookies not `Secure`). CSP was **not** tested, because dev mode sends no CSP header; flow 1 is `part`. In run 2 of 6 the iPhone video stalled at `readyState` 2; the cause is unknown.
- Details: `docs/browser-matrix.md`.

## 3. Test results (2026-10-30, uncommitted tree on top of `43a8458`)

| Suite | Result |
| --- | --- |
| Backend, Python 3.12 container | 712 passed, 9 skipped (fastapi 0.162.0, starlette 1.10.0, SQLAlchemy 2.1.6, pydantic 2.14.2, pytest 8.4.2) |
| Web node tests | 399 of 399 |
| Web vitest | 496 of 496 (45 files) |

The project `.venv` is Python 3.10.12, so the backend did not run there. Rerun in a Python 3.12 `.venv` on the release commit.

## 4. Gaps found by the adversarial review (added to `docs/to-beta.md`)

- `/model-info` cache never drops entries, `model` and `kind` have no limits, and the lowercased cache key can serve a wrong-case result to everyone.
- `GET /api/reels/player` and `/player-inline` are public and unlimited, yet write recommendation rows.
- `GET /api/posts/{id}/comments` still lists comments by suspended users.
- The map-tile proxy has no global cap, no cache bound, and an unpruned `_rate_hits` dict. The default upstream, OSM, can block the server's IP without notice.

## 5. Corrections made to earlier text

- "No CSP violations" in the browser matrix and `to-beta.md` was wrong (CSP was off). Fixed.
- "The page played each time" was wrong (run 2 stall). Fixed.
- Trivy count "725 CVEs" is 725 findings across 262 distinct CVEs. Fixed.
- Anonymous callers get 404 (not 401) on the 3 hidden routes. Fixed.

## 6. Not done yet

1. **Deep project review.** A workflow with eight area auditors and skeptical re-checks was launched but stopped before returning findings. It needs relaunching; only confirmed findings should go into `to-beta.md` and `todolist.md`.
2. **2026-10-30 entry** in the "Latest recorded automated verification" section of `to-beta.md`, and its "Last updated" line.
3. Follow-ups: pip in the image has 6 MEDIUM/LOW CVEs; pytest is capped below 9; the Starlette warning about `httpx` with `starlette.testclient`; `NODE_TLS_REJECT_UNAUTHORIZED=0` on the dev host; `verify_webkit.cjs` lives in `/tmp` and is not in the repo.
4. Needs a real device or account: signed-in Safari, real iOS and Android, Quest, `SX_CSP_MODE` on for a CSP run, and a first GitHub Actions run of the Trivy step.
