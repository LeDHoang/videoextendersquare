# UI open items

What was still open from the UI/UX critique (`docs/ui-skill-check/`, fixes 1–76) when the report
was removed. The full report with screenshots is in git at `9264b73:docs/ui-skill-check/index.html`.

## Needs the headset

- **Head-locked screen spans about 89° (fix 30, not attempted).** Guidance for content the eyes
  scan is 50–60°. Proposed, all in `ui/assets/webxr_vr.js`:
  - Set `lockToViewer = false` by default in `resetXRSessionState`, `init` and the headset preview.
  - Add a lazy follow to `applyLockToViewer`: re-centre over about 0.5 s once head yaw has been
    more than 30° off the screen for 1 s.
  - Set `DEFAULT_SCALE` to about 2 × 2.24 × tan(27.5°) ≈ 2.3 m (about 55° wide at the 2.24 m
    station). Keep grip + stick resizing.
  - Then the dock-below-screen layout lands near −29°, so the 20° unlocked-dock cap from fix 25
    applies without overlapping the dome.
  - The default lock and the 4 m screen were confirmed by the owner as legacy behaviour.
- **UI panels draw through the video dome (fix 29, not attempted).** Must land with fix 30.
  - Set `depthTest: true` on the dock, comments panel and guide materials. Keep the overlay as is.
  - Place each panel at least 0.1 m in front of the dome along the view ray: about 0.3–0.7 m
    nearer than the screen centre plane at the default 4 m dome.
  - Alternative: move the dock and panels to XRQuadLayers (compositor depth-sorted, sharper).
- Check on device: fixes 24–28 (including flashes after hand tracking is requested, fix 27), and
  fixes 60–61 (comments panel in front of the screen, VR loading screen).
- Where the locked comments panel should sit (fix 60): it now sits in front of the screen but
  covers part of the reel. Moving it beside the dock is a design call.

## Left as is, on purpose

- Success notes that stay inline (fix 73): the studio "SHARED — LIVE" block (it carries actions),
  the models-saved note in the sidebar (it carries instructions), the wallet payment note, the
  auth "email resent" notes, and the share dialog statuses (the dialog is modal).
- Caption backfill (fix 71): ran on 2026-11-03 and captioned nothing new; the videos still
  without captions are ones it skips or has no speech in.
- Legal page placeholders: deferred by scope (fix 23).
- The immersive preview toolbar wraps to two rows at 1280px.
- The "Stripe checkout is disabled" banner shows only when credits are on and Stripe is off.
- "Layout gaps at 375px": the audit did not record which gaps; needs a fresh look.
- The /reels status strip still shows "CODEC: HEVC" and "H.264 PROXIES" (fix 37).
- Colour literals and `!important` left after the codemod (fix 51): each needs a design or
  specificity decision. `web/tests/css-guardrails.test.js` stops new ones.

## Not tested

Real screen readers (VoiceOver, TalkBack), real touch devices, hand tracking on device, uploads
and purchases end to end, and the moderation queue. Contrast and size figures came from computed
styles in Chromium; VR angles from scene geometry read over CDP.
