# ECHO Credits, Fal Billing, and Reel Rewards

Last updated: 2026-09-13 UTC

## Goal

Add an account-based ECHO Credits economy for every supported Fal-powered outpainting and upscaling stage, preserve encrypted per-user Fal API keys as a bring-your-own-key option, and let signed-in users earn a deliberately small number of credits through qualified reel viewing.

## Verified implementation audit

- Image and video cloud-processing routes are currently unauthenticated and use the process-global `FAL_KEY`.
- `/api/config/fal-key` and `/api/config/models` currently mutate global process state without an authentication or administrator boundary.
- Job records are process-memory only and have no owner or durable billing state.
- The configured `fal-ai/flux/outpaint`, `fal-ai/wan-vace-14b/video-to-video`, `fal-ai/kling-video/v1.5/pro/upscale`, and `fal-ai/esrgan-video` model pages/OpenAPI definitions returned HTTP 404 on 2026-09-13.
- LTX pricing does not apply Fal's documented whole-megapixel rounding, and the worker estimates source-duration frames without sending an explicit `num_frames` value.
- The React estimator undercounts trimmed multi-file batches, quotes outpainting for square inputs that the worker skips, and has no authoritative server-side image quote.
- Qualified reel views already have authenticated identity, recommendation-impression attribution, foreground watch telemetry, and daily post/viewer deduplication that can be reused for rewards.

## Pricing research snapshot

Fal public model documentation verified on 2026-09-13:

- `fal-ai/ltx-2.3-quality/outpaint` and `/lora`: $0.0024075 per generated megapixel-frame, rounded up.
- `fal-ai/luma-dream-machine/ray-2-flash/reframe`: $0.06 per video second.
- `fal-ai/wan-vace-14b/outpainting`: $0.04/$0.06/$0.08 per video second at 480p/580p/720p, calculated at 16fps.
- `fal-ai/image-apps-v2/outpaint`: $0.035 per output megapixel.
- `fal-ai/bytedance-upscaler/upscale/video`: $0.0072/$0.0144/$0.0288 per second at 1080p/2K/4K and 30fps; 60fps doubles cost and Pro is 10x.
- `fal-ai/seedvr/upscale/video`: $0.001 per output megapixel-frame.
- `fal-ai/clarity-upscaler`: $0.03 per output megapixel.

Stripe's public US standard pricing page showed 2.9% + $0.30 per successful online card transaction. This is used only for launch economics, never as executable billing logic. Stripe's official Checkout guidance requires webhook fulfillment, raw-body signature validation, idempotent fulfillment, and duplicate/out-of-order event handling.

The mandatory Meta documentation query for external web payments could not run because the current `metavr` package has no `linux-x64` binary. A supported-host Meta policy check is a release gate before any Horizon Store/PWA distribution.

## Product rules

- One ECHO Credit represents $0.01 of service value and is stored as a whole integer.
- Packs: $5/500 credits, $10/1,050 credits, and $25/2,750 credits.
- A server-funded stage costs `ceil(provider_cost_usd * 1.35 * 100)` credits.
- Credits never expire, cannot be transferred or redeemed for cash, and retain an auditable purchased/earned/admin/refund source.
- Local FAST/STUDIO processing remains free and anonymous. Every Fal-backed job requires sign-in and either credits or a saved personal key.
- Platform credits support only allowlisted models with deterministic pricing. Custom or compute-time-priced models require BYOK.
- Reel rewards grant one credit per ten distinct eligible reels, capped at five credits per UTC day.
- Reward eligibility requires a signed-in user, matching server-issued recommendation impression, foreground playback, a non-self-owned post, one claim per post/day, and an additional keyed-IP daily cap.
- Images require three seconds. Videos require `min(10s, max(3s, 50% of duration))`.

## Architecture

### Pricing and model catalog

- Replace image outpaint with `fal-ai/image-apps-v2/outpaint` and its `expand_*` fields.
- Replace Wan with `fal-ai/wan-vace-14b/outpainting`, pin resolution, 16fps, and explicit frame count.
- Remove dead Kling and ESRGAN video entries.
- Keep LTX, LTX LoRA, Luma Ray-2 Flash, Wan VACE, Bytedance, SeedVR, and Clarity credit-enabled.
- Keep CCSR, AuraSR, image ESRGAN, and arbitrary custom models BYOK-only.
- Store prices as `Decimal`/integer micro-USD with a pricing version, verification date, source URL, rounding rule, and constraints.
- Produce authoritative ten-minute quotes from staged-file metadata. The quote locks model, parameters, derived dimensions/frames, provider-cost estimate, credit charge, and a canonical parameter hash.
- Explicitly pass duration-derived frames to LTX and Wan and enforce provider duration/input limits.

### Persistence and settlement

Add an Alembic migration and SQLAlchemy models for credit accounts, immutable ledger entries, billing quotes, cloud-generation billing records, Stripe purchases/events, encrypted Fal credentials, and reel reward claims.

Use atomic conditional updates for reservations. A credit job reserves its full quote before enqueueing. Each completed Fal stage captures its quoted portion; failed or unstarted stages release their remaining reservation. Persist model/request IDs immediately. On restart, reconcile submitted Fal requests through the client request-handle API and release only reservations proven not to have been submitted.

Stripe fulfillment accepts only configured pack price IDs, verifies the raw webhook body, retrieves the Checkout Session, checks payment status, and grants credits once per session. Refunds/disputes append reversal entries; a negative available balance blocks new platform-funded jobs.

Encrypt per-user Fal keys using AES-GCM and a dedicated `SX_FAL_KEY_ENCRYPTION_KEY`, with user-bound additional authenticated data. Never return or log plaintext. Keep `FAL_KEY` as the platform key only.

### API and UI

Add:

- `GET /api/billing/wallet`
- `GET /api/billing/transactions`
- `GET /api/billing/catalog`
- `POST /api/billing/quote`
- `POST /api/billing/checkout-session`
- `POST /api/billing/webhooks/stripe`
- `GET|PUT|DELETE /api/account/fal-key`
- `POST /api/rewards/reels/claim`

Cloud process requests include `payment_source=credits|byok` and a `quote_id` for credit-funded work. The server rejects expired, consumed, wrong-user, or parameter-mismatched quotes. Cloud job status, result, stream, and download routes enforce ownership.

Add a wallet page, header balance, pack checkout, transaction history, encrypted-key controls, and Credits/My Fal Key selectors to image, video, and upload flows. Server quotes replace client-authored authoritative totals. The reels player displays reward progress/toasts in 2D and WebXR and emits an event that refreshes the React wallet context.

## Delivery sequence

1. Create this plan and the crash-recovery progress tracker.
2. Correct and version the Fal model/pricing catalog and add quote tests.
3. Add the database migration, wallet/ledger, encrypted credentials, rewards, purchases, and billing service.
4. Add authenticated billing, key, reward, and Stripe webhook APIs.
5. Add job ownership, reservation/settlement callbacks, Fal request persistence, and restart reconciliation.
6. Integrate authoritative quotes/payment source into all React cloud workflows.
7. Add wallet UI and reel reward notifications.
8. Update environment/deployment documentation and complete automated/manual validation.

## Verification and acceptance

- Golden tests cover every supported pricing formula, rounding, square skips, trimming, batches, image dimensions, and limits.
- Concurrency tests prove balances cannot be overspent and every reserve/capture/release operation is idempotent.
- Failure tests cover pre-submit errors, partial stage completion, provider timeout, restart reconciliation, refund, and dispute behavior.
- Security tests prove cloud auth/job ownership, Stripe signature validation, quote tamper rejection, BYOK ciphertext-only storage, redaction, and custom-model restrictions.
- Reward tests cover timing, impression ownership, duplicates, self-views, daily/user/IP caps, concurrency, and anonymous viewers.
- Frontend tests cover wallet refresh, checkout return, quote expiry, insufficient balance, payment-source switching, and reward notifications.
- Run the full backend/frontend suites, a fresh SQLite migration, PostgreSQL-compatible schema checks, Stripe CLI test flows, and low-cost Fal smoke jobs.
- Feature flags: `SX_CREDITS_ENABLED`, `SX_STRIPE_ENABLED`, and `SX_REEL_REWARDS_ENABLED`, disabled until test-mode validation succeeds.

## Scope and defaults

- Initial fiat currency is USD and Stripe Checkout is used for one-time purchases.
- FastAPI/React is the production surface. Streamlit stays development-only and cannot spend platform credits.
- No subscriptions, transfers, cash-out, creator revenue sharing, or automatic tax-registration workflow are included in v1.
