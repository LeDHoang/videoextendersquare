# ECHO Credits and Fal Billing — Progress

- **Overall status:** Implementation complete; live rollout gated
- **Last updated:** 2026-09-13 UTC
- **Current milestone:** 8 — Automated validation complete; external release checks remain
- **Immediate next action:** Run the documented Stripe, live Fal, live PostgreSQL, legal/tax, HTTPS webhook, and supported-host Meta policy checks before enabling production flags.
- **Migration state:** New head `20260913_0006` created and applied successfully to a fresh SQLite database.
- **Quest verification:** Blocked on this host because `metavr` has no `linux-x64` binary. A supported-host policy check remains a release gate.

## Milestones

- [x] 1. Create the canonical plan and crash-recovery tracker.
- [x] 2. Correct/version Fal endpoints, pricing, formulas, and constraints.
- [x] 3. Add wallet, ledger, quote, purchase, credential, cloud-job, and reward persistence.
- [x] 4. Add billing, Stripe, BYOK, and reel-reward APIs.
- [x] 5. Add cloud-job ownership, credit reservation/settlement, request IDs, and reconciliation.
- [x] 6. Integrate quotes and Credits/My Fal Key selection across React workflows.
- [x] 7. Add wallet UI, header balance, checkout flow, and reward notifications.
- [x] 8. Complete migrations, automated tests, documentation, and record external rollout gates.

## Files changed

- `docs/outpainting-credits-plan.md`
- `docs/outpainting-credits-progress.md`
- `core/models.py`
- `core/pricing.py`
- `tests/test_pricing.py`
- `server/social/models.py`
- `server/social/database.py`
- `server/social/auth.py`
- `migrations/versions/20260913_0006_credits_billing_rewards.py`
- `server/billing/__init__.py`
- `server/billing/crypto.py`
- `server/billing/parameters.py`
- `server/billing/runtime.py`
- `server/billing/service.py`
- `server/billing/stripe_service.py`
- `server/routers/billing.py`
- `server/routers/rewards.py`
- `server/routers/config.py`
- `server/app.py`
- `server/jobs.py`
- `pipeline/image_worker.py`
- `pipeline/video_worker.py`
- `requirements.txt`
- `tests/test_billing.py`
- `web/src/utils/cloudBilling.js`
- `web/src/components/billing/CloudFundingPanel.jsx`
- `web/src/components/ui/JobRunner.jsx`
- `web/src/hooks/useCreditQuotes.js`
- `web/src/hooks/WalletContext.jsx`
- `web/src/pages/ImagePage.jsx`
- `web/src/pages/VideoPage.jsx`
- `web/src/pages/UploadPage.jsx`
- `web/src/pages/WalletPage.jsx`
- `web/src/components/layout/HeaderBar.jsx`
- `web/src/components/layout/Sidebar.jsx`
- `ui/assets/reels.html`
- `ui/assets/reels_rewards.js`
- `ui/assets/webxr_vr.js`
- `server/routers/reels.py`
- `server/routers/social.py`
- `web/tests/reels-rewards.test.js`
- `web/tests/webxr-earth.test.js`

- `.env.example`
- `README.md`
- `RUNNING.md`
- `docs/to-beta.md`
- `pipeline/utils.py`
- `server/routers/image.py`
- `server/routers/video.py`
- `tests/test_cloud_routes.py`
- `tests/test_rewards_api.py`
- `tests/test_stripe_billing.py`
- `web/src/App.jsx`
- `web/src/components/billing/CloudFundingPanel.test.jsx`
- `web/src/components/layout/AppShell.jsx`
- `web/src/components/ui/CustomModelPanel.jsx`
- `web/src/hooks/useConfig.js`
- `web/src/main.jsx`
- `web/src/pages/WalletPage.test.jsx`
- `web/tests/cloud-billing.test.js`

## Validation log

- 2026-09-13: Repository and current outpainting, authentication, job, recommendation, and pricing flows audited.
- 2026-09-13: Live Fal public documentation and OpenAPI availability checked for stock and replacement endpoints.
- 2026-09-13: Stripe public pricing and official webhook/Checkout fulfillment guidance reviewed.
- 2026-09-13: Required Meta documentation verification attempted; blocked by unsupported `linux-x64` metavr binary.
- 2026-09-13: Pricing/catalog modules compile successfully.
- 2026-09-13: Pricing golden suite passed (`6 passed`), covering representative Fal prices, whole-MP/frame rounding, trim-aware per-item totals, square skips, BYOK-only models, provider limits, and parameter-hash stability.
- 2026-09-13: Billing migration `20260913_0006` applied cleanly from an empty SQLite database.
- 2026-09-13: Billing/pricing service suite passed (`11 passed`), including atomic concurrent reservation, quote tamper/reuse checks, partial capture/release, BYOK encryption binding, and ten-reel rewards.
- 2026-09-13: Platform Fal-key mutation was removed; model overrides now require an administrator session plus CSRF.
- 2026-09-13: Fixed square-video cleanup so a staged source reused as the outpaint input is never deleted; focused application suite passed (`34 passed`, 2 dependency deprecation warnings).
- 2026-09-13: Integrated authoritative quotes and Credits/My Fal Key selection into image, video, and upload workflows; frontend suite passed (`18 passed`).
- 2026-09-13: Added qualified reel reward claims, 2D progress notices, React wallet refresh events, and WebXR award notifications; frontend suite passed (`21 passed`).
- 2026-09-13: Full scoped backend suite run found one isolated fake-Stripe test-fixture name-resolution error (`46 passed, 1 failed`); application tests otherwise passed and the fixture is being corrected before rerun.
- 2026-09-13: Backend rerun reproduced the same fixture-only failure because the combined patch did not persist its first hunk (`46 passed, 1 failed`); the fixture was then patched and verified independently.
- 2026-09-13: Complete scoped backend suite passed (`47 passed`, 2 dependency deprecation warnings), covering pricing, billing, Stripe, BYOK, rewards, cloud auth/ownership, settlement, and reconciliation.
- 2026-09-13: Complete frontend suite passed (`21 passed`: 19 Node tests and 2 Vitest component tests).
- 2026-09-13: First production frontend build failed because `web/src/utils/cloudBilling.js` was truncated mid-function; the shared serializer is being restored before rebuild.
- 2026-09-13: Restored `appendProcessingParameters` and square-aware `stagedItemNeedsCloud`; the production Vite build then succeeded (`168 modules transformed`).
- 2026-09-13: Added direct Fal-key API encryption, redaction, ownership, and deletion coverage; focused cloud-route suite passed (`3 passed`, 2 dependency deprecation warnings).
- 2026-09-13: Frontend suite passed after adding serializer coverage (`23 passed`: 21 Node tests and 2 Vitest tests); one intended square-detection assertion was found missing from the test file and added before final rerun.
- 2026-09-13: Frontend suite passed with all serializer and square-cloud regression cases present (`24 passed`: 22 Node tests and 2 Vitest tests).
- 2026-09-13: Hardened reel rewards to require same-day active impressions, dedicated attributed foreground telemetry, and server-observed elapsed time; focused billing/reward suite passed (`11 passed`, 2 dependency deprecation warnings).
- 2026-09-13: Added pricing provenance, rounding rules, model constraints, and quote-time Wan/LTX limit checks; focused pricing/billing/reward suite passed (`17 passed`, 2 dependency deprecation warnings).
- 2026-09-13: Re-applied the complete Alembic chain successfully to a fresh SQLite database through head `20260913_0006`.
- 2026-09-13: PostgreSQL offline Alembic compilation could not start because the temporary test dependency path lacks the declared `psycopg` driver (`ModuleNotFoundError`); driver availability is being checked before retry.
- 2026-09-13: Installed the already-declared `psycopg` package into the temporary test environment and successfully compiled the full Alembic chain as PostgreSQL SQL through head `20260913_0006`.
- 2026-09-13: Added frontend funding-source and Checkout-return tests; the first run found missing test cleanup (`26 passed, 1 failed`), which was corrected before rerun.
- 2026-09-13: Complete frontend suite passed after fixing test cleanup (`27 passed`: 22 Node tests and 5 Vitest tests).
- 2026-09-13: Hardened BYOK resolution to convert corrupted AES-GCM credentials into a safe billing error and added synchronous enqueue cleanup that releases reservations and removes orphan in-memory jobs.
- 2026-09-13: New corrupted-key and enqueue-failure regressions passed (`2 passed`).
- 2026-09-13: Final complete scoped backend suite passed (`51 passed`, 2 dependency deprecation warnings).
- 2026-09-13: Final production Vite build succeeded (`168 modules transformed`).
- 2026-09-13: `git diff --check` passed.
- 2026-09-13: Application/test compilation passed after excluding the two unrelated tracked legacy placeholders `pipeline/havsfunc.py` and `pipeline/mvsfunc.py`; an unfiltered compile reports their existing `404: Not Found` contents as syntax errors.

## Remaining rollout gates

- Exercise Stripe CLI test-mode completed, delayed-success, duplicate, refund, and dispute webhook flows with the deployment's real Stripe price IDs.
- Run small real Fal image/video jobs and compare quoted provider costs with Fal dashboard charges.
- Run the migration and concurrency suite against a live PostgreSQL instance; offline PostgreSQL Alembic compilation has passed.
- Verify production HTTPS webhook delivery, current Fal rates, tax/refund terms, and legal copy.
- Verify Meta/Horizon external-payment policy with `metavr` on a supported macOS or Windows host before Quest/Horizon distribution.

## Session recovery

At the start of a resumed session:

1. Read `docs/outpainting-credits-plan.md` and this tracker.
2. Check `git status --short` and the current Alembic head.
3. Continue from the current milestone and immediate next action.
4. Before stopping, record changed files, tests, migration state, blockers, and the next exact command/action here.
