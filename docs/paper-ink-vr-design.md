# Paper & Ink in VR: Design

Status: draft for review. The implementation plan follows only after this document is approved.

Branch: `redesign/paper-ink-theme`, on top of the 2D light/dark switch (`docs/paper-ink-theme-switch-plan.md`).

## Why

The 2D site now wears Paper & Ink, in a light (cream paper) and a dark version that the viewer picks in the sidebar. The VR side still paints the old carbon look:
- near-black panels with chamfered corners
- Archivo, JetBrains Mono and Orbitron type
- a cold navy space with stars
- a navy and cyan "holo" globe

A viewer who enters VR from a cream page lands in what looks like a different product. The goal is for VR to look like the same product as the 2D site, in both modes, and to follow the same switch.

## What the owner decided

These are the owner's decisions, in their words where quoted:

1. **Light mode is cream paper too.** "light mode should make it cream paper look as well".
2. **Every flat VR panel is redesigned, in both modes.** "make sure the flat panels, for vr are also redesign in the new style both for light and dark mode".
3. **Earth mode is redesigned for light mode as well.** "earth mode should be redesign for light mode as well".
4. **The whole world goes cream in light mode.** This covers the backdrop behind the video and behind the globe, not just the panels ("Yes, whole world cream").
5. **Dark is a starry sky; light is a clear-sky landscape.** "if dark mode is starry skies light mode should be clear sky landscape".
6. **The light world is a creamy blue sky with no ground, distant mountains and clouds.** "lets make this creamy/blue sky, no ground, mountains in the distant with clouds".
7. **In light mode, the world dims while a video plays.** The owner chose this over darker world tones, so the world stays full cream the rest of the time ("Dim during playback").

## Goals

1. Every canvas-drawn VR panel paints in Paper & Ink, with a light and a dark version.
2. The world around the viewer changes with the mode:
   - dark: a starry sky
   - light: a creamy blue sky with distant mountains and clouds
   This applies in both scenes, reels and earth.
3. The globe and everything drawn on it are re-inked for both modes.
4. VR starts in whichever mode the 2D site is in, and has its own LIGHT / DARK switch that keeps both sides in step.

## Non-goals

- No change to what VR does: routes, sections, interactions, controller mapping, playback and earth navigation stay as they are. The one new behaviour is the light world dimming during playback.
- No change to panel sizes, panel placement in the scene, or the layout inside panels, except where the nav bar makes room for the switch.
- No change to the server, and no new API.
- No visual change to the 2D site outside the VR preview surfaces. The 2D reels player (`#sxReelsRoot` in `ui/assets/reels.html`) stays a carbon island in both modes. The VR preview surfaces are in scope, because the 2D switch plan left them for this one:
  - `.sx-immersive-preview-stage` and `.sx-vr-workbench-stage` in `web/src/styles/global.css`, which are painted in the old navy `#020612` today
  - `web/src/components/ui/VRPanelWorkbench.jsx`, the FLAT PANELS view
- No new photo or texture assets. Everything is drawn in code.
- No animated transition between modes. The swap is instant. The playback dim is the only fade.

## Anti-goals

The work fails, even if it technically runs, if any of these happen:
- Text on any VR panel is hard to read in either mode.
- The light world is a glaring white box that tires the eyes or washes out the video.
- VR flashes the wrong mode for a moment at entry or after a switch.
- Dark mode still looks like the old cold carbon (navy, cyan, chamfers, Orbitron) with the colours nudged.
- The Quest frame rate drops.

## Constraints

- **Token values come from the 2D site, unchanged.**
  - Light: the `:root:root` block of `web/src/styles/tokens.css`.
  - Dark: the `:root[data-theme='dark']` block.
  - No new colour values for panels or text. The world (sky, mountains, clouds, globe ocean) may use extra colours, derived from these tokens, and kept in one place in the VR code.
- **Fonts are the 2D site's:** Fraunces (display and brand), Instrument Sans (body), IBM Plex Mono (numbers and labels).
  - VR waits for them before the first paint, for about three seconds at most. If they have not arrived by then, VR paints with fallback faces and repaints once when they arrive. A blocked font host must never leave a panel blank.
  - The React host loads IBM Plex Mono at weights 400–600 only, so VR mono labels use 600 at most, in place of today's 700 and 800.
  - Hosts that load none of these fonts (the standalone `/api/reels/player` page and the legacy Streamlit app) keep working with fallback faces.
- **The first `:root {` block of `tokens.css` stays byte-identical.** `ui/tokens.py` and the parity test treat it as the contract with `reels.html`.
- **`<html data-theme>` stays the single switch.** It holds `'light'` or `'dark'`, and the saved choice lives in localStorage under `sx.theme`, read and written inside try/catch, as on the 2D site.
- **Text contrast reaches 4.5:1 on its surface in both modes.** The 2D tokens already pass this on `bg`, `surface` and `surface-2` (`web/tests/paper-ink-theme.test.js`). VR keeps text on those surfaces, or proves the pair it adds.
- **Quest frame budget holds.**
  - The world adds a handful of draw calls at most.
  - Nothing repaints a canvas every frame because of the theme.
  - A switch repaints each canvas once.
- **The VR modules still load in a bare VM**, as the existing VR tests require.
- Commit messages are plain prose with no Co-Authored-By or "Generated with" lines.

## How it works

### Where the mode comes from

- At entry, VR reads `<html data-theme>`. The 2D site sets it before first paint from `sx.theme`, or from the OS appearance when nothing is saved. `'dark'` means dark, and anything else means light, matching `currentTheme()` in `web/src/theme.js`.
- VR reads the mode before it creates the scene or paints any canvas. That way the first frame is already in the right mode.
- VR watches the attribute for changes. A change from either side repaints every VR canvas and swaps the world. This matters most in `/reels/immersive-preview`, where the 2D sidebar switch sits beside the live preview.

### The VR switch

- The nav bar gets a compact LIGHT / DARK switch at its right end. The six tabs narrow to make room; the bar itself keeps its size.
- Pressing it does what the 2D switch does:
  - it sets `<html data-theme>`
  - it saves `sx.theme`
  - it counts as the viewer's choice, so OS changes stop applying
- `web/src/theme.js` learns to follow the attribute when someone else changes it, so the sidebar switch and the `theme-color` meta tag are right when the viewer leaves VR. It does not change how anything looks. Apart from the VR preview surfaces listed under Non-goals, it is the only 2D code change.

### Panels

Every flat panel is restyled. Sizes and hit regions stay the same:

| Panel | File |
|---|---|
| Nav bar (1536×160) | `ui/assets/vr_shell_canvas.js` |
| Main panel (2048×1152): explore, search, tag, location, profile, pack, messages, thread, share, new chat, credits and rewards | `ui/assets/vr_shell_canvas.js` |
| Handoff dialog (sends the viewer to the 2D site for upload, settings and similar) | `ui/assets/vr_shell_canvas.js` |
| Controls dock and earth dock | `ui/assets/vr_ui_canvas.js` |
| Comments panel (560×920) | `ui/assets/vr_ui_canvas.js` |
| Overlay and caption (1024²) | `ui/assets/vr_ui_canvas.js` |
| Controller guide (440×1124) | `ui/assets/vr_ui_canvas.js` |
| Earth label (WORLD › place, RESET ROTATION) and scale bar | `ui/assets/vr_ui_canvas.js` |
| Earth preview card (512×716) | `ui/assets/vr_ui_canvas.js` |
| Load state, reticle and laser | `ui/assets/webxr_vr.js` |
| DOM overlay text input (inline carbon styles today) | `ui/assets/webxr_vr.js` |

The look follows the 2D site's components, not new inventions:
- Panels are paper (`surface`) on the page tone (`bg`), with hairline `rule` borders and `rule-strong` for emphasis.
- Corners are the 2D site's small radius, scaled so they look the same at reading distance. The chamfered corners go.
- Headings are in Fraunces, body text in Instrument Sans, and counts, times and tags in IBM Plex Mono.
- Active, hover, pressed and focus states copy the 2D sidebar and buttons in `web/src/styles/editorial.css`. That includes the vermilion accent and the yellow highlighter (`spot`) where the 2D site uses them.
- The ECHO mark in the nav bar uses the 2D site's brand treatment.
- Avatar discs keep the user's own colour with `on-spot` initials, as on the 2D site (commit `602a39f`).

Panels are paper in light mode, including the controls dock and earth dock under the screen. Text drawn on top of the video is different: captions, floating comments and the load state over the video use `on-media` on `media-scrim` in both modes, as the 2D reels player does. The video itself is never re-inked.

### VR preview surfaces in the 2D site

- The immersive preview stage and the workbench stage take the world's base tone for the current mode: cream in light mode, and the dark `bg` in dark mode. This way `/reels/immersive-preview` shows no navy before the first frame.
- The workbench overlay canvas keeps its stand-in gradient, because it stands in for a reel.
- `VRPanelWorkbench.jsx` follows `data-theme`, as the VR canvases do.

### The world

**Dark: a starry sky.**
- It works the same way as today, re-inked warm.
- The sky is the dark `bg` tone (#0c0b09) rather than navy.
- Stars are warm paper white rather than blue-white.
- There is no ground.

**Light: a creamy blue sky with distant mountains and clouds.**
- A sky dome fades from a pale, clear blue at the top to paper cream (#f2ede3) at the horizon.
- There is no ground. Below the horizon the dome fades on into cream mist, so looking down never shows a void.
- Distant mountains ring the horizon in two or three flat tones, paler with distance, like a print. They sit low, so the view ahead stays mostly sky.
- Flat, print-like clouds float above the mountains. They stay still and do not drift.
- There are no stars and no sun disc.
- No world colour is brighter than paper cream. The panels (#faf7f0) and the video stay the brightest things in view.
- **Dimming during playback.** While a video plays in the reels scene, the sky, mountains and clouds fade down to a dimmer, still warm tone. They fade back to full cream when the video pauses, ends or the viewer opens the shell.
  - The fade is short and smooth, never a jump, so it does not startle the viewer.
  - Panels and the video are not dimmed, so text keeps its contrast.
  - Dark mode does not dim, and neither does the earth scene, where no video plays.
- The ambilight glow around the video (`debugFlags.glow`, additive blending) is off in light mode. On cream it would lift the area around the video above paper and wash the picture out. Dark mode keeps it.

Both worlds apply to the reels scene and the earth scene alike. The globe floats in the same sky.

### Earth mode

| Part | Light (paper atlas) | Dark (warm night chart) |
|---|---|---|
| Globe base and fallback ocean (`paintEarthBase`, the 0x0d2a3f fallback) | Pale sea wash on cream land, grid in `rule` | Warm dark land and sea from the dark surfaces, grid in dark `rule` |
| Map tile grade (the "holo" shader, `installEarthTileShader`) | Re-lit as a printed atlas: cream land, pale sea, muted parks, ink line work and labels | Same classify-and-relight grade as today, with warm dark tones and paper-white line work in place of navy and cyan |
| Atmosphere (0x39d7ff today) | A faint ink rim, so the globe edge reads against the pale sky | A faint warm paper glow |
| Heat zones (`paintHeatZones`) | Vermilion accent, with `spot` for the hottest areas | The same, in dark-mode values |
| Tier colours (ORBIT, REGION, CITY, STREET) | `info`, `success`, `warn`, `accent` in light values | The same tokens in dark values |
| Earth label, scale bar, preview card | Panels as above | Panels as above |

`?earthstyle=raw` keeps passing tiles through untouched in both modes.

## My calls

The owner did not decide these; I chose them, and the owner should check them while reading:

1. VR follows the 2D site's mode at entry and has its own switch in the nav bar, at the right end.
2. Dark mode keeps an open starfield with no ground, rather than a night landscape.
3. In the light world, the sky below the horizon fades into cream mist, the clouds stay still, and there is no sun, trees or buildings.
4. The light globe is a paper atlas, with a pale sea wash on cream land, rather than an all-cream globe.
5. Tier colours map to the `info`, `success`, `warn` and `accent` tokens.
6. One small change to `web/src/theme.js`, so the 2D switch follows a change made in VR.
7. The mode swaps instantly, with no fade.
8. Chamfered corners give way to the 2D site's small radius.
9. Text over the video stays media style (`on-media` on `media-scrim`) in both modes. The panels around the video go paper.
10. The ambilight glow is off in light mode.
11. Fonts are waited for up to about three seconds, then fallback faces paint until the real ones arrive. Mono labels go no heavier than 600.
12. The VR preview stages in the 2D site follow the mode, as the earlier plan intended.

## Left to the builder

- **How VR holds two token sets.** Today `VRUICanvas.TOKENS` is one frozen object, read about 130 times in `vr_ui_canvas.js`. `vr_shell_canvas.js` reads it through `tokens()`, and `webxr_vr.js` through `echoHex()`.
- **How the parity test changes.** `web/tests/echo-token-parity.test.js` checks today that the VR tokens equal the first `:root` block. It must instead check the light set against `:root:root` and the dark set against `:root[data-theme='dark']`, while `reels.html` stays checked against the first block.
- **How the world is built:** sky dome, mountain and cloud geometry, and how they swap with the starfield.
- **How the tile grade gets its per-mode colours**, and how live tiles pick up a switch. Today the night-chart palette is fixed inside the shader. Light mode must read as a paper atlas whichever tile source the server reports (the `theme` hint from `/api/reels/map-tiles/attribution` can be `light` or `dark`).
- **Exact mountain and cloud shapes, the sky blue, and the sea wash**, within the constraints above.
- **The radius in canvas pixels**, and the switch's exact size in the nav bar.
- **How dim the light world goes during playback, and how long the fade lasts.** The builder tunes both in the headset, or in the preview when no headset is connected.

## How we will know it works

- **Automated tests:**
  - The parity test passes against both token blocks.
  - Every VR text and surface pair reaches 4.5:1 in both modes.
  - No old carbon literal is left in the VR files (`#08090a`, `0x020612`, `#39D7FF`, `#061D37` and the rest).
  - VR picks up `data-theme` at entry, and a switch writes the attribute and `sx.theme`.
  - The light world dims when playback starts, and comes back when it stops. Dark mode and the earth scene never dim.
  - The existing VR tests in `web/tests` still pass.
- **In the browser:**
  - `/reels/immersive-preview` in both modes, switching from the 2D sidebar and from the VR nav bar.
  - Screenshots of the reels scene, every shell section, the comments panel, the guide and earth mode in each mode.
  - This route needs an admin account.
- **In the headset**, if a Quest is connected:
  - A screenshot of each mode, a check that the light world is comfortable around a playing video, and a check that the frame rate holds.
  - If no Quest is connected, the work can finish on the browser checks. The final report then says that comfort and frame rate in the headset were not checked, and the owner decides before merging.
