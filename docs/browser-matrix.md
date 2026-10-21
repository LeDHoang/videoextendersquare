# Browser and device matrix

Covers the beta checklist item "Test current Chrome, Safari, Firefox, mobile browsers, and the supported Quest Browser/device matrix" in `docs/to-beta.md`. Run it against the staging stack (`docs/local-staging.md`) or the deployed beta, with two accounts so the messaging rows can be checked end to end.

Legend: `ok` = done and passed, `fail` = failed (add a note below the table), blank = not run yet.

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
| Chrome, macOS (headless, CDP) | 155.0.8059.85 | ok | | | | | | | | | | n/a |
| Chrome, macOS (headed) | | | | | | | | | | | | |
| Safari, macOS | | | | | | | | | | | | n/a |
| Firefox, macOS | | | | | | | | | | | | n/a |
| Safari, iOS | | | | | | | | | | | | n/a |
| Chrome, Android | | | | | | | | | | | | |
| Quest Browser | | | | | | | | | | | | |

For the Quest row, record the Quest Browser and Horizon OS versions, and fill the immersive column from the device matrix in `docs/vr-reels-playback-investigation.md`; `docs/vr-playback-review.md` lists what that run should look at.

## What has been run

- 2026-10-21, Chrome 155 headless, signed in as `alice@example.com` on local staging: flow 1 for all eleven pages: each rendered and could be tabbed through (see `docs/accessibility-pass.md`). Console errors and CSP violations were not collected in that run, so the Chrome row is marked for rendering only. Flows 2 to 11 were not run in a browser for this pass, apart from the checks in `scripts/verify_staging.cjs`.

## Notes

Add one line per failure here with the browser, flow, what happened and the issue or commit that tracks it.
