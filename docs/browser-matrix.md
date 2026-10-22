# Browser and device matrix

Covers the beta checklist item "Test current Chrome, Safari, Firefox, mobile browsers, and the supported Quest Browser/device matrix" in `docs/to-beta.md`. Run it against the staging stack (`docs/local-staging.md`) or the deployed beta, with two accounts so the messaging rows can be checked end to end.

Legend: `ok` = done and passed, `part` = only the checks listed under "What has been run" passed, `fail` = failed (add a note below the table), blank = not run yet.

## Flows

1. **Load**: `/login`, `/signup`, `/reels`, `/explore`, `/profile/<name>`, `/settings/profile`, `/wallet`, `/upload`, `/messages`, `/support`, `/privacy` render with no console errors and no CSP violations.
2. **Auth**: register, verify the email link, sign in, sign out, password reset.
3. **Reels**: first reel autoplays (muted where the browser requires it), swipe or arrow keys move to the next reel, sound toggle, like, comment, share, More menu (mode, fullscreen, VR), report dialog.
4. **Explore**: tiles load, tapping one opens the reel, search returns people, tags and reels.
5. **Profile**: follow and unfollow, block, report, avatar replace.
6. **Upload**: publish a short video, edit it, delete it.
7. **Messages**: send text, GIF and a reel share; read receipts; the stream reconnects after going offline for 30 s.
8. **Wallet**: balance and ledger render.
9. **Moderation** (moderator account): Overview tab, reports queue.
10. **Responsive**: 375 px, 768 px and 1440 px have no horizontal scroll and no overlapping controls.
11. **Immersive** (devices that offer WebXR): enter and leave VR, playback continues, the exit control works.

## Matrix

| Browser | Version | 1 Load | 2 Auth | 3 Reels | 4 Explore | 5 Profile | 6 Upload | 7 Messages | 8 Wallet | 9 Moderation | 10 Responsive | 11 Immersive |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chrome, macOS (headless, CDP) | 155.0.8059.85 | ok | | part | part | | | part | ok | part | ok | n/a |
| Chrome, macOS (headed) | 155.0.8059.85 | ok | | part | part | | | part | ok | part | | n/a |
| Safari, macOS | 26.2 | part | | | | | | | | | | n/a |
| Firefox, macOS | 158.0.1 | ok | | part | part | | | part | ok | part | | n/a |
| Safari, iOS (Chrome emulation, not a device) | Chrome 155 | ok | | part | part | | | part | ok | part | ok | n/a |
| Chrome, Android (Chrome emulation, not a device) | Chrome 155 | ok | | part | part | | | part | ok | part | ok | |
| Quest Browser | | | | | | | | | | | | |

For the Quest row, record the Quest Browser and Horizon OS versions, and fill the immersive column from the device matrix in `docs/vr-reels-playback-investigation.md`; `docs/vr-playback-review.md` lists what that run should look at.

## What has been run

- 2026-10-21, Chrome 155 headless, signed in as `alice@example.com` on local staging: flow 1 for all eleven pages: each rendered and could be tabbed through (see `docs/accessibility-pass.md`). Console errors and CSP violations were not collected in that run, so the Chrome row is marked for rendering only. Flows 2 to 11 were not run in a browser for this pass, apart from the checks in `scripts/verify_staging.cjs`.
- 2026-10-22, local staging, signed in as `alice@example.com` (admin). Scripted with the Chrome DevTools Protocol (Chrome) and W3C WebDriver (geckodriver for Firefox, safaridriver for Safari). Each page waited 3 s, ran its check, and retried once after 3 s more. Console errors, uncaught errors, unhandled rejections and CSP violations were collected per page. Screenshots were kept for the visual checks.
  - Checks per page: `/login`, `/signup` and signed-out `/support` show their forms. `/reels`: the first video's `currentTime` advances, and ArrowDown moves to the next reel. `/explore`: tiles render. `/profile/alice`: the name shows. `/wallet`: the available balance shows. `/upload`: the file input is present. `/messages`: `/api/ops/metrics` counts an open message stream. `/moderation?tab=overview`: the Operations block shows. `/settings/profile`, `/support` and `/privacy` render. Every page is also checked for horizontal scroll.
  - Not covered: likes, comments, share, the More menu, search, follow and block, publishing, sending messages, reconnecting the stream, the reports queue, and sign-up and password reset (flow 2). These are why most cells are `part`.
  - Chrome 155 headless at 1440 px: 13 of 13 pages passed, with no console errors and no horizontal scroll.
  - Chrome 155 headed at 1280 px: 13 of 13 passed.
  - Firefox 158.0.1 at 1280 px, over `https://localhost:8443`: 13 of 13 passed, including autoplay and ArrowDown on `/reels`. Firefox's autoplay preference was set to allow (`media.autoplay.default=0`), so the muted-autoplay default was not tested.
  - Chrome device emulation (iPhone 375×812 with an iOS user agent, Android 412×915, tablet 768×1024; touch on): 38 of 39 passed, with no horizontal scroll on any page. The one failure was the expected `/api/rewards/reels/claim` 503 on iPhone `/reels` (see Notes). Screenshots were checked by eye: on phones, `/reels` is a full-bleed player with the action rail and bottom navigation. This is emulation in desktop Chrome, not Safari on iOS or a real Android device.
  - Safari 26.2: only the signed-out pages passed (`/login`, `/signup`, `/support`, over `http://localhost:8001`). Signed-in pages could not be run (see Notes).
  - CSP (report-only on staging): no `csp` lines in the app or Caddy logs across about 3 hours of Chrome and Firefox runs.

## Notes

Add one line per failure here with the browser, flow, what happened and the issue or commit that tracks it.

- Safari 26.2, all signed-in flows, 2026-10-22: not run. Over `http://localhost:8001`, Safari drops the `Secure` session cookies, so sign-in does not stick. Over `https://localhost:8443`, Safari shows "This Connection Is Not Private" because the Caddy local root CA is not trusted in the macOS keychain. To finish the row, trust the Caddy root CA (from `/data/caddy/pki/authorities/local/root.crt` in the Caddy container) for SSL in Keychain Access. Then rerun over https. Remove the trust afterwards.
- Chrome on iPhone emulation, flow 3, 2026-10-22: the console logs one failed `POST /api/rewards/reels/claim` (503 `REWARDS_DISABLED`), because staging runs with `SX_REEL_REWARDS_ENABLED=0`. The client stops after one try (commit 258166b). This is not a bug. It could be avoided by checking `reel_rewards_enabled` before claiming.
- All browsers, flow 3, 2026-10-22: the first `GET /api/reels` after a quiet spell took 1.1 to 8.8 s on staging. Warm calls took 35 to 330 ms. The skeleton shows until it returns. This needs a follow-up check on deployed hardware.
