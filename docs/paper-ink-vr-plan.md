# Paper & Ink in VR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repaint every VR panel, the world around the viewer and the globe in Paper & Ink, in a light and a dark version that follow the 2D site's `data-theme` switch and a new LIGHT / DARK switch in the VR nav bar.

**Architecture:** `vr_ui_canvas.js` holds two frozen token sets copied from `tokens.css` and an active set that `setTheme` swaps. Every canvas painter keeps reading `TOKENS`, so a switch is a set swap plus one repaint of each canvas. `webxr_vr.js` reads `<html data-theme>` before it builds the scene, watches the attribute, and owns the world: a warm starfield in dark mode, and a sky dome with mountains and clouds in light mode that dims during playback. All world colours live in one `WORLD_PALETTE`.

**Tech Stack:** Plain UMD scripts on 2D canvas and Three.js (WebXR), React 18 and Vite for the 2D host, `node --test` with `vm` for the VR modules, Vitest with Testing Library for `web/src`.

**Spec:** `docs/paper-ink-vr-design.md` (approved). The 2D switch it builds on is `docs/paper-ink-theme-switch-plan.md`.

## Where things stand

| Piece | State |
|---|---|
| 2D light/dark switch, `web/src/theme.js`, both token blocks | Done on `redesign/paper-ink-theme`. |
| VR canvases | One frozen carbon `TOKENS` (`vr_ui_canvas.js:2388`), chamfered corners, Archivo, JetBrains Mono and Orbitron. |
| VR world | Navy clear colour `0x020612`, cold starfield, cyan atmosphere `0x39d7ff`, navy "holo" tile grade. |
| VR preview stages in the 2D site | Navy `#020612` (`global.css:7525`, `7643`). |

## Global Constraints

- **Token values come from `web/src/styles/tokens.css`, unchanged.** Light is the `:root:root` block. Dark is that block overlaid with `:root[data-theme='dark']`, which redeclares colours only. The parity test in Task 1 is the check. No new panel or text colours.
- **World colours** (sky, mist, mountains, clouds, globe sea and land, atmosphere) live only in `WORLD_PALETTE` in `webxr_vr.js`, and no light-world colour is brighter than `#f2ede3`.
- **Keep the first `:root {` block of `tokens.css` byte-identical.** `reels.html` stays checked against it.
- **`<html data-theme>` is the single switch.** `'dark'` means dark; anything else, or no attribute, means light. The saved choice is localStorage `sx.theme`, read and written inside try/catch.
- **Fonts:** display and brand `'Fraunces', Georgia, …`, sans `'Instrument Sans', …`, mono `'IBM Plex Mono', …`, copied from `--sx-font-*`. Mono weight is 600 at most. Wait at most 3000 ms for the fonts, then paint with fallbacks and repaint once when they arrive.
- **Contrast is 4.5:1.** Accent, danger and info text never sits on `surface3` or `surfaceHover`. Those pairs fail: light accent/surface3 4.16, accent/surfaceHover 4.44, danger/surface3 4.43; dark accent/surface3 4.45, danger/surface3 4.32, danger/surfaceHover 4.47, info/surface3 4.31, info/surfaceHover 4.46. Hover and pressed fills carry ink-family text only. `spot` carries `onSpot` text only.
- **Quest budget:** the light world is 3 draw calls at most. Nothing repaints a canvas each frame because of the theme. A switch repaints each canvas once.
- **The VR modules load in a bare `vm` context.** Guard `getAttribute`, `setAttribute`, `MutationObserver`, `document.fonts` and `localStorage`; the test harness has none of them unless a test adds them.
- **No change** to behaviour, routes, controller mapping, panel sizes, placement or inner layout (except the nav bar switch), the server, or assets. The mode swap is instant; the playback dim is the only fade.
- **Carbon literals** that must not remain in `vr_ui_canvas.js`, `vr_shell_canvas.js` or `webxr_vr.js` (match case-insensitively):
  - `#08090a`, `#101214`, `#16191c`, `#1d2126`, `#24282d`, `#3a4047`, `#f2f3f5`, `#a4abb3`, `#8e959e`, `#646b74`, `#0a0a0a`
  - `JetBrains Mono`, `Archivo`, `Orbitron`
  - `#39D7FF`, `#4FE3C1`, `#FFC857`, `#FF8A5B`, `#121315`, `#1c1d1f`, `#ff6a52`, `#061D37`
  - `rgba(13, 14, 15`, `rgba(2,6,14`, `0x020612`, `0x0d2a3f`, `0x39d7ff`

  Allowed: the Quest controller art in `drawQuestController` (`#0D0E11`, `#1A1B1F`, `#222428`, `#2A2C32`, `#333640`, its `rgba(255,255,255,…)` and `rgba(255, 59, 31, 0.12)`). `#ff3b1f` is dark mode's accent and is allowed.
- Commit messages are plain prose with no Co-Authored-By or "Generated with" lines. Never push.

## Review Focus

1. **A switch mid-session**, from the 2D sidebar or the VR nav bar. Every canvas on show repaints once in the new mode, and a canvas hidden at the time paints in the new mode when it is next shown. Task 4 pins this.
2. **Fonts slow or blocked.** Panels paint with fallback faces after 3 s and repaint once when the fonts arrive; nothing stays blank or throws. Task 4 pins this.
3. **Storage blocked.** The VR switch still changes the mode for the session and throws nothing. Task 4 pins this.
4. **Entering VR with dark saved.** No canvas paints and no frame renders in light first. Task 4 pins this.
5. **Playback stops, the shell opens, or the scene goes to earth.** The light world fades back to full cream; dark mode never dims. Task 5 pins this.

---

### Task 1: Two token sets in `vr_ui_canvas.js`

**Files:**
- Modify: `ui/assets/vr_ui_canvas.js:2388-2422` (the `TOKENS` object) and the public API object that starts at line 2423.
- Modify: `web/tests/echo-token-parity.test.js:39-58`
- Create: `web/tests/vr-paper-ink.test.js`

**Interfaces:**
- Produces, on `window.VRUICanvas`:
  - `TOKEN_SETS: { light, dark }`. Each set is frozen, with frozen parts: `{ hex, rgba: { mediaScrim }, font: { display, sans, mono, brand }, space, radius: 4, radiusPx: 8 }`. `hex` has exactly these 26 keys: `bg, surface, surface2, surface3, surfaceHover, rule, ruleStrong, ink, ink2, ink3, inkMuted, accent, accentHi, onAccent, spot, spotSoft, onSpot, onMedia, success, successHi, warn, warnHi, danger, dangerHi, info, infoHi`. `space` keeps today's values. `dark.font` and `dark.space` are the light objects. `radiusPx` is the canvas-pixel radius; tune it in QA.
  - `TOKENS`, a getter on the API object that returns the active set. Inside the file, painters read a module-level `let TOKENS`, which starts as `TOKEN_SETS.light`.
  - `setTheme(mode: string): boolean`. `'dark'` selects dark and anything else light. It returns `true` when the active set changed.
  - `getTheme(): 'light' | 'dark'`

- [ ] **Step 1: Write the failing parity tests.** In `echo-token-parity.test.js`, replace `VRUICanvas.TOKENS matches tokens.css` with two tests. Parse the `:root:root` and `:root[data-theme='dark']` blocks the way `paper-ink-theme.test.js` does (`block(selector)`); keep `canonical`, `norm` and `camelToCss`.
  - `VRUICanvas light tokens match the :root:root block`. Against the light map:
    - `Object.keys(hex)` deep-equals the 26 keys above.
    - Each `hex[key]` equals `light[camelToCss(key)]`.
    - `rgba.mediaScrim` equals `--sx-media-scrim`.
    - Each `font[key]` equals `--sx-font-${key}`.
    - `` `${radius}px` `` equals `--sx-radius`.
    - `TOKEN_SETS.light` and its `hex` are frozen.
  - `VRUICanvas dark tokens match the dark block over the light one`: the same checks on `TOKEN_SETS.dark`, against `{ ...light, ...dark }`.
  - The `reels.html` checks against `canonical` stay as they are.

- [ ] **Step 2: Write the failing tests in `vr-paper-ink.test.js`.** Load the file with `vm.runInNewContext(source, { window })`, as the parity test does. Copy `luminance(hex)` from `paper-ink-theme.test.js`.
  - `setTheme swaps the active set`:
    - At load, `getTheme() === 'light'` and `TOKENS === TOKEN_SETS.light`.
    - `setTheme('dark')` returns `true`; then `TOKENS === TOKEN_SETS.dark` and `getTheme() === 'dark'`.
    - `setTheme('dark')` again returns `false`.
    - `setTheme('sepia')` returns `true` and selects light.
  - `VR text pairs reach 4.5:1 in both modes`. For each set, every pair is at least 4.5:1:
    - `ink, ink2, ink3, inkMuted, success, warn` on `surface3` and on `surfaceHover`
    - `onAccent` on `accent` and on `accentHi`
    - `onSpot` on `spot`
    - `onMedia` on `mediaScrim` composited over `#ffffff`, the worst case under a scrim
    The failure message names the mode, the pair and the ratio.

- [ ] **Step 3: Run the tests and expect them to fail**

Run: `cd web && node --test tests/echo-token-parity.test.js tests/vr-paper-ink.test.js`
Expected: FAIL. `TOKEN_SETS` is undefined and `setTheme` is not a function.

- [ ] **Step 4: Implement** the Interfaces block. Replace the carbon `TOKENS` object. The painters keep reading `TOKENS.hex.*`; the new sets hold every key they read today.

- [ ] **Step 5: Run the token tests and every VR test, and expect them to pass**

Run: `node --test tests/echo-token-parity.test.js tests/vr-paper-ink.test.js tests/webxr-earth.test.js tests/vr-*.test.js tests/reels-vr-*.test.js`
Expected: PASS. A VR test that pinned a carbon hex now sees a light value: change its expectation to read `TOKEN_SETS.light.hex.<key>`, never to the new literal.

- [ ] **Step 6: Commit**

```bash
git add ui/assets/vr_ui_canvas.js web/tests/echo-token-parity.test.js web/tests/vr-paper-ink.test.js
git commit -m "Paper & Ink VR: light and dark token sets with a theme switch"
```

Add any VR test files Step 5 changed to the `git add`.

### Task 2: Restyle the `vr_ui_canvas.js` panels

Covers the controls dock and earth dock, the comments panel, the overlay and caption, the controller guide, the earth label and scale bar, the earth preview card and the load-state helpers.

**Files:**
- Modify: `ui/assets/vr_ui_canvas.js`. The literals listed in Global Constraints sit at about lines 1247, 1325, 1378, 1403, 1838, 1886 and 2307–2308, and the tiers at 1973–1977. Leave `drawQuestController` (line 1703) alone.
- Modify: `ui/assets/webxr_vr.js:2120`, the engine's copy of `EARTH_TIERS`.
- Test: `web/tests/vr-paper-ink.test.js` and `web/tests/webxr-earth.test.js:6270` (the tier sync test).

**Interfaces:**
- Consumes: `TOKENS`, `TOKEN_SETS` and `setTheme` from Task 1.
- Produces:
  - `VRUICanvas.roundRectPath(ctx, x, y, w, h, r): void`. It builds a rounded-rectangle path and does not fill or stroke.
  - Each `EARTH_TIERS` entry has `tone: 'info' | 'success' | 'warn' | 'accent'` for ORBIT, REGION, CITY and STREET, in that order, and no `color`. Painters resolve the colour as `TOKENS.hex[tier.tone]`.

**The look**, copied from `web/src/styles/editorial.css`:
- Panels are `surface` on `bg`, with a 1-canvas-pixel-scaled `rule` hairline and `ruleStrong` for emphasis. Corners use `roundRectPath` with `radiusPx`; no chamfers.
- Headings use `font.display`, body text `font.sans`, and counts, times and tags `font.mono` at weight 600 or lighter.
- Hover fills `surfaceHover` and pressed or active fills `surface3`, with ink-family text only.
- The active tab or segment is `ink` text with a 3-pixel-scaled `accent` underline. Resting is `ink2`, hover `ink`.
- Captions, floating comments and the load state over the video use `onMedia` on `rgba.mediaScrim`.
- Avatar discs keep the user's colour with `onSpot` initials.

- [ ] **Step 1: Write the failing tests in `vr-paper-ink.test.js`.** Copy `recordingCtx()` from `vr-shell-canvas.test.js:14` and extend it to record each `fillRect`, `fill` and `fillText` with the `fillStyle` and `font` at the time. Call each renderer with the arguments `VRPanelWorkbench.jsx:313-376` passes, in both modes (`setTheme` before each render).
  - `vr_ui_canvas.js paints no carbon literal`: read the source, cut out the body of `drawQuestController`, and assert that none of the Global Constraints literals appears, case-insensitively.
  - `VR panels use the paper fonts`. Over every recorded `font`:
    - None names `JetBrains Mono`, `Archivo` or `Orbitron`.
    - Every font naming `IBM Plex Mono` has weight 600 or less; `bold` counts as 700.
  - `panels paint their base in the mode's surface`. For the controls dock, earth dock, comments panel, guide, earth label and earth preview card, in each mode:
    - One of the fills is `TOKEN_SETS[mode].hex.surface`.
    - No fill is the other mode's `surface`.
  - `hover and pressed fills carry ink text only`. Render the controls dock with a hovered and a pressed button. Whenever the most recent fill before a `fillText` is `surface3` or `surfaceHover`, the text's `fillStyle` is one of `ink, ink2, ink3, inkMuted, success, warn` for that mode.
- [ ] **Step 2: Change the tier sync test** at `webxr-earth.test.js:6270` to compare `name|max|tone` across the two `EARTH_TIERS` copies.

- [ ] **Step 3: Run the tests and expect them to fail**

Run: `cd web && node --test tests/vr-paper-ink.test.js tests/webxr-earth.test.js`
Expected: FAIL on the literal scan, the fonts, the base fill, the hover text and the tier `tone`.

- [ ] **Step 4: Implement** the look above and `roundRectPath`. Replace each carbon literal with the token it stood for. Give both `EARTH_TIERS` copies `tone`, and make `tierColor` (`webxr_vr.js:6175`) return `TOKENS.hex[tier.tone]` through `getUICanvas()`. Keep `chamferPath` exported until Task 3, because the shell still calls it.

- [ ] **Step 5: Run every VR test and expect them to pass**

Run: `node --test tests/vr-paper-ink.test.js tests/webxr-earth.test.js tests/vr-*.test.js tests/reels-vr-*.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/assets/vr_ui_canvas.js ui/assets/webxr_vr.js web/tests/vr-paper-ink.test.js web/tests/webxr-earth.test.js
git commit -m "Paper & Ink VR: restyle the docks, comments, guide, overlay and earth panels"
```

### Task 3: Shell canvas and the VR switch

**Files:**
- Modify: `ui/assets/vr_shell_canvas.js`: `FALLBACK` (21–27), `navRects` (47), `shape()` (343), the nav bar (461–524), `resolveNavHit` (525), the main panel sections, the handoff dialog and the exports (1496).
- Modify: `ui/assets/vr_shell.js`, `handleHit` near line 617.
- Modify: `ui/assets/vr_ui_canvas.js`: remove `chamferPath` and its export.
- Test: `web/tests/vr-shell-canvas.test.js`, `web/tests/vr-shell-state.test.js`

**Interfaces:**
- Consumes: `TOKENS`, `getTheme()` and `roundRectPath` from Tasks 1–2.
- Produces:
  - `VRShellCanvas.themeSwitchRects(): { light: Rect, dark: Rect }`, the two segments at the right end of the 1536×160 bar. `navRects()` still returns the six tabs, narrowed so that the last tab ends before `light.x`.
  - `resolveNavHit(x, y)` returns `{ action: 'theme', arg: 'light' | 'dark' }` inside a segment.
  - `create(deps)` in `vr_shell.js` accepts `deps.setTheme(mode)`. `handleHit({ action: 'theme', arg })` calls `d.setTheme(arg)` when `d.setTheme` exists.

**The switch:** a segmented pair labelled `LIGHT` and `DARK`, in `font.mono` at 600. Resting labels are `ink2`. The selected segment, read from `getTheme()`, is filled `ink` with `bg` text.

**The ECHO mark:** the wordmark is in `font.brand`. Light strokes and fills become `ink`, `#ff3b1f` becomes `accent`, and `#08090a` cut-outs become `ink`, matching the 2D re-ink in `editorial.css`.

`FALLBACK`, used when `VRUICanvas` is absent, takes the light hex values and the paper font stacks.

- [ ] **Step 1: Write the failing tests in `vr-shell-canvas.test.js`.** Extend `recordingCtx()` as Task 2 did.
  - `nav bar ends in a LIGHT / DARK switch`:
    - `resolveNavHit` at each segment's centre returns the theme action with `'light'` and `'dark'`.
    - Each tab's centre still resolves to its own nav action.
    - No tab rect overlaps either segment, and the right edge of `dark` is at most 1536.
  - `the switch shows the active mode`. With `VRUICanvas.setTheme('dark')`, render the nav bar:
    - The text `DARK` is drawn in `bg`, after a fill in `ink`.
    - The text `LIGHT` is drawn in `ink2`.
    - Both labels use IBM Plex Mono at 600 or lighter.
    - Repeat the check in light mode.
  - `the ECHO mark takes the mode's ink and accent`. In light mode, no nav bar fill or stroke is `#ff3b1f` or `#08090a`, and the wordmark font names Fraunces.
  - `shell panels use paper tokens and fonts`. Render the nav bar, every main panel section the existing tests render, and the handoff dialog, in both modes:
    - One fill is the mode's `surface`.
    - The font rules from Task 2 hold.
  - `vr_shell_canvas.js paints no carbon literal or chamfer`: the source contains no Global Constraints literal, and `chamferPath` appears in neither `vr_shell_canvas.js` nor `vr_ui_canvas.js`.
- [ ] **Step 2: Write the failing test in `vr-shell-state.test.js`.** `a theme hit calls setTheme`: create the shell with `loadShell().create({ setTheme: (m) => calls.push(m) })`, call `s.handleHit({ action: 'theme', arg: 'dark' })`, and assert `calls` deep-equals `['dark']`. With `create({})`, the same hit does not throw.

- [ ] **Step 3: Run the tests and expect them to fail**

Run: `cd web && node --test tests/vr-shell-canvas.test.js tests/vr-shell-state.test.js`
Expected: FAIL. `themeSwitchRects` is not a function, and the theme action is unknown.

- [ ] **Step 4: Implement** the Interfaces block, the switch, the ECHO mark and the paper look from Task 2. `shape()` uses `ui.roundRectPath` with `TOKENS.radiusPx`.

- [ ] **Step 5: Run every VR test and expect them to pass**

Run: `node --test tests/vr-*.test.js tests/reels-vr-*.test.js tests/webxr-earth.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/assets/vr_shell_canvas.js ui/assets/vr_shell.js ui/assets/vr_ui_canvas.js web/tests/vr-shell-canvas.test.js web/tests/vr-shell-state.test.js
git commit -m "Paper & Ink VR: shell panels and a LIGHT / DARK switch in the nav bar"
```

### Task 4: Mode plumbing, the font gate and the 2D follow

**Files:**
- Modify: `ui/assets/vr_ui_canvas.js`: add `waitForFonts`.
- Modify: `ui/assets/webxr_vr.js`:
  - `echoHex` fallbacks at 3984, 3991, 5204 and 5227
  - `initThreeScene` (4948): the clear colour and background at 4981 and 4988
  - the shell deps near 6276–6332
  - `getPreviewState` (6819)
  - the DOM input `cssText` (10543)
  - `__test` (10686)
- Modify: `web/src/theme.js`, `web/src/theme.test.js`
- Test: `web/tests/vr-paper-ink.test.js` and `web/tests/webxr-earth.test.js`, including `loadRenderer` (125).

**Interfaces:**
- Consumes: `setTheme`, `getTheme` and `TOKENS` from Task 1, and `deps.setTheme` from Task 3.
- Produces:
  - `VRUICanvas.waitForFonts(fontSet, timeoutMs, onPaint): void`:
    - With no `fontSet`, or no `fontSet.load`, it calls `onPaint()` once, synchronously.
    - Otherwise it loads `["16px Fraunces", "16px 'Instrument Sans'", "600 16px 'IBM Plex Mono'"]` and calls `onPaint()` once when they settle or when `timeoutMs` passes, whichever comes first.
    - If the timeout won, it calls `onPaint()` once more when the load settles later.
    - A rejected load counts as settled. It never throws.
  - In `webxr_vr.js`:
    - `readPageTheme(): 'light' | 'dark'`
    - `applyVRTheme(mode): void`. It calls `ui.setTheme(mode)`. When that returns `true`, it marks every canvas cache dirty and recolours the scene. The caches are `shellPainted`, `vrGuideUploaded`, `lastOverlayKey`, `lastEarthLabelKey`, `lastEarthPreviewUpdate = -1e9`, `earthMapDirty`, and the dock and comments keys. The scene parts are the clear colour, the background, the laser, the reticle and the DOM input styles. Tasks 5 and 6 add the world and the globe here.
    - `setVRTheme(mode): void`. It writes `sx.theme` to localStorage in try/catch, sets `data-theme` on `document.documentElement` if `setAttribute` exists, and then calls `applyVRTheme(mode)`. It is passed to the shell as `setTheme`.
    - `getPreviewState().world = { theme }`
    - `__test.setVRTheme`
  - `loadRenderer(options)` gains three options:
    - `options.theme`: `documentElement` gets `getAttribute` and `setAttribute` backed by that value.
    - `options.fonts`: becomes `mockDocument.fonts`.
    - `options.beforeRenderer(window)`: called after the canvas modules load and before `webxr_vr.js` runs, so tests can wrap renderers.

**Behaviour:**
- Call `readPageTheme()` and `applyVRTheme()` at the top of `initThreeScene`, before the clear colour, the background or any canvas.
- If `MutationObserver` exists, observe `document.documentElement` with `attributeFilter: ['data-theme']` and call `applyVRTheme(readPageTheme())`. Disconnect it where the renderer removes its other listeners.
- Font gate: `fontsSettled` starts `false`. Call `waitForFonts(document.fonts, 3000, …)`; its callback sets `fontsSettled = true` and marks the caches dirty. Canvas updates skip while `fontsSettled` is `false`. Without `document.fonts` the gate opens at once, so existing tests are unaffected.
- The `echoHex` fallbacks become the light values: ink `#17140f`, accent `#c2250e`.
- Use bare `localStorage` and `MutationObserver` behind `typeof` checks. The test harness passes globals at context level, not on `window`.
- `theme.js`, in `useTheme`: a `MutationObserver` on `data-theme` sets the state to `currentTheme()` and updates the `theme-color` meta tag. If `sx.theme` is saved, it also sets `picked.current = true`. It never writes `data-theme`, which would loop.

- [ ] **Step 1: Write the failing `waitForFonts` tests** in `vr-paper-ink.test.js`. Use `mock.timers` from `node:test` for `setTimeout`.
  - `fonts: no font set paints at once`: `waitForFonts(undefined, 3000, fn)` calls `fn` once before it returns.
  - `fonts: a fast load paints once`: the load resolves, then the timer passes 3000 ms; `fn` was called once.
  - `fonts: a slow load paints at the timeout and again on arrival`: at 2999 ms `fn` has 0 calls, at 3000 ms 1 call, and after the load resolves 2 calls.
  - `fonts: a rejected load paints once and does not throw`
- [ ] **Step 2: Write the failing renderer tests** in `webxr-earth.test.js`, after the frame test at line 385. For the counting tests, wrap every `render*` function on `window.VRUICanvas` and `window.VRShellCanvas` in `beforeRenderer`. Each wrapper counts its calls and records `VRUICanvas.getTheme()` at call time.
  - `VR starts in the page's mode`: use `loadRenderer({ theme: 'dark', withShell: true, beforeRenderer })`, then `init`, `startPreview` and one frame.
    - `getPreviewState().world.theme === 'dark'`.
    - Every recorded call saw `'dark'`, which pins Review Focus 4.
  - `a data-theme change repaints each canvas once`. Pass a fake `MutationObserver` in `globals` that keeps its callback.
    - Run 5 frames and note which renderers ran (the visible set).
    - Run 5 more frames and record the call counts as `base`.
    - Set the attribute to `'dark'`, fire the callback, run 5 frames and record `after`.
    - Each renderer in the visible set has `after - base === 1`, and the rest have 0.
    - Then `setSceneMode('earth')` and run frames. The earth label and preview renderers saw `'dark'`.
  - `the VR switch writes the attribute and sx.theme`. Pass a `localStorage` stub in `globals` and call `__test.setVRTheme('dark')`.
    - The mock's `data-theme` is `'dark'`.
    - `localStorage.getItem('sx.theme') === 'dark'`.
    - `world.theme === 'dark'`.
  - `the VR switch works when storage throws`: with `setItem` throwing, `setVRTheme('dark')` does not throw and `world.theme === 'dark'`.
  - `canvases wait for the fonts`. Pass `options.fonts` with a `load` that returns a promise the test resolves.
    - Frames before it resolves call no wrapped renderer.
    - After it resolves, the next frame paints the visible set.
- [ ] **Step 3: Write the failing Vitest** in `src/theme.test.js`. `follows a data-theme change made elsewhere`:
  - Render `useTheme`.
  - In `await act(async () => { html.dataset.theme = 'dark'; })`, the attribute changes.
  - Then `result.current[0] === 'dark'` and the meta content is `'#0c0b09'`.
  - With `sx.theme` saved before the change, a later OS `matches: false` change leaves `'dark'`. Use the matchMedia stub from the existing OS test.

- [ ] **Step 4: Run the tests and expect them to fail**

Run: `cd web && node --test tests/vr-paper-ink.test.js tests/webxr-earth.test.js`
Then: `npx vitest run src/theme.test.js`
Expected: FAIL. `waitForFonts` is not a function, `world` is undefined, and the hook stays `'light'`.

- [ ] **Step 5: Implement** the Interfaces block and the behaviour above.

- [ ] **Step 6: Run the tests and expect them to pass**

Run: `node --test tests/vr-*.test.js tests/reels-vr-*.test.js tests/webxr-earth.test.js tests/echo-token-parity.test.js`
Then: `npx vitest run src/theme.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/assets/vr_ui_canvas.js ui/assets/webxr_vr.js web/src/theme.js web/src/theme.test.js web/tests/vr-paper-ink.test.js web/tests/webxr-earth.test.js
git commit -m "Paper & Ink VR: follow data-theme, wait for fonts, and keep the 2D switch in step"
```

### Task 5: The world: warm starfield, light sky and playback dim

**Files:**
- Modify: `ui/assets/webxr_vr.js`:
  - `initThreeScene` (4948)
  - the starfield (5267–5314)
  - the ambilight (544, 5066, 10159)
  - `applySceneVisibility` (8170)
  - the animation loop (9980)
  - `applyVRTheme` and `getPreviewState` from Task 4, and `__test`
- Test: `web/tests/webxr-earth.test.js`

**Interfaces:**
- Consumes: `applyVRTheme`, `getPreviewState().world` and `loadRenderer` options from Task 4.
- Produces, in `webxr_vr.js`:
  - `WORLD_PALETTE = { light: {…}, dark: {…} }`, the one place for world colours. Starting values, to tune in QA:
    - light: `skyTop: '#cfe0ec'`, `horizon: '#f2ede3'`, `mist: '#e9e3d6'`, `mountains: ['#dad8cf', '#cac8be', '#b9b8ae']` (far to near), `cloud: '#f2ede3'`
    - dark: `sky: '#0c0b09'`, `star: '#f5f1e8'`
    - Task 6 adds `earth` to each.
  - `DIM_AMOUNT = 0.45` and `DIM_FADE_MS = 600`, to tune in QA.
  - `worldDimTarget({ mode, scene, paused, shellOpen }): number`. It returns `DIM_AMOUNT` when the mode is `'light'`, the scene is `'reels'`, the video is not paused and the shell is closed. Otherwise it returns 0. The caller passes `paused: video.paused || video.ended`, and with no video `paused` is `true`.
  - `stepDim(current, target, dtMs): number`. It moves linearly toward the target at `1 / DIM_FADE_MS` per ms and never overshoots.
  - `getPreviewState().world = { theme, dim }`
  - `__test.worldDimTarget`, `__test.stepDim`, and `__test.worldObjects(): { sky, mountains, clouds, stars, glow }`, which reports the `visible` flag of each.

**The light world:**
- **Sky:** a `BackSide` sphere with vertex colours: `skyTop` overhead, `horizon` at the horizon, and `mist` below it. `depthWrite: false`.
- **Mountains:** one mesh with vertex colours, a ring of three bands, `mountains[0]` farthest and palest. The silhouette is a fixed sum of sines (no `Math.random`). They sit low, under about 8° above the horizon.
- **Clouds:** one merged mesh of flat, still shapes in `cloud`, above the mountains.
- These are 3 draw calls. Build them once and toggle `visible`.
- **Dim:** each frame, `dim = stepDim(dim, worldDimTarget(…), dt)`. Scale the three materials' colours by `1 - dim`. Panels and the video are untouched.

**As shipped (QA redesign):** the flat sky, bands and clouds above read as a dated cartoon, so the light world became a golden hour over a sea of cloud. It is 2 draw calls, built once and toggled:
- **Sky:** a shader on the `BackSide` sphere. A low sun (azimuth 55°, elevation 4.5°) with a warm glow, a rose belt and a blue shadow band opposite, and a drifting deck of lit cloud overhead from a baked noise texture.
- **Sea of cloud:** drawn by the sky shader below the horizon, a lumpy deck whose billows catch the sun on one face and shade the hollows behind them.
- **Mountains:** one polar-grid mesh of ridged and eroded noise, warped off the lattice, low hills near and tall massifs far, parting where the sun sets. Sun, soft shadow, snow and valley occlusion are baked into vertex colours at build time; the shader adds gullies, strata, backlit rims, haze and the cloud lapping at their feet.
- `WORLD_PALETTE.light` holds the sky, cloud, sea, rock and snow colours. `__test.worldObjects()` reports `{ sky, mountains, stars, glow }`, and `__test.worldMeshes()` returns the two meshes.
- **Dim:** a shared `uTint` uniform scales both meshes by `1 - dim`.

**The dark world:** today's starfield in `star`, with `sky` as the clear colour and background, and no ground.

Each world shows in both the reels scene and the earth scene. `applySceneVisibility` (8192) shows the starfield in every scene today. It becomes `visible = mode === 'dark'`, and the three light objects take `mode === 'light'`.

**Glow:** the ambilight rule at 8183 (`!isEarth && debugFlags.glow`) gains `&& mode === 'dark'`.

- [ ] **Step 1: Write the failing tests**
  - `dim targets only light playback in the reels scene`. Call `worldDimTarget` with each field flipped from `{ mode: 'light', scene: 'reels', paused: false, shellOpen: false }`, which gives `DIM_AMOUNT`. Flipping `mode` to `'dark'`, `scene` to `'earth'`, `paused` to `true` or `shellOpen` to `true` gives 0.
  - `dim fades without overshoot`:
    - `stepDim(0, 0.45, 300)` is about 0.5.
    - `stepDim(0.4, 0.45, 600)` is 0.45.
    - `stepDim(0.45, 0, 300)` is about −0.05 clamped to 0, so the result is 0.
    Read the expected values from `DIM_FADE_MS` as `0.45 * 300/600` and so on; do not hard-code the fade.
  - `the light world dims during playback and clears when it stops`. Use the video stub from the frame test at line 385, with `options.theme: 'light'`.
    - After frames covering 700 ms of playback, `world.dim` equals `DIM_AMOUNT`.
    - After `video.pause()` and 700 ms more, it is 0.
    - Repeat with the shell opened, and with `setSceneMode('earth')`; each returns to 0.
  - `dark mode never dims`: the same playback with `theme: 'dark'` keeps `world.dim === 0`.
  - `each mode shows its own world`:
    - Light: `sky`, `mountains` and `clouds` are visible, and `stars` and `glow` are not.
    - Dark, in the reels scene with the default flags: `stars` and `glow` are visible, and the three light objects are not.
    - After `__test.setVRTheme` flips the mode, the flags flip too.

- [ ] **Step 2: Run the tests and expect them to fail**

Run: `cd web && node --test tests/webxr-earth.test.js`
Expected: FAIL. `worldDimTarget` is not a function and `world.dim` is undefined.

- [ ] **Step 3: Implement** the Interfaces block and the two worlds. `applyVRTheme` toggles the world objects and sets the clear colour and background from `WORLD_PALETTE`.

- [ ] **Step 4: Run the VR tests and expect them to pass**

Run: `node --test tests/webxr-earth.test.js tests/vr-*.test.js tests/reels-vr-*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/assets/webxr_vr.js web/tests/webxr-earth.test.js
git commit -m "Paper & Ink VR: warm starfield, light sky with mountains and clouds, and a playback dim"
```

### Task 6: Re-ink the globe

**Files:**
- Modify: `ui/assets/webxr_vr.js`:
  - the tint constants (1383–1395)
  - `installEarthTileShader` (1439), and its night palette at 1471–1476
  - `paintEarthBase` (1511)
  - `paintHeatZones` (1848)
  - the globe fallback `0x0d2a3f` (5355)
  - the atmosphere `0x39d7ff` (5377)
  - `applyVRTheme` and `__test`
- Test: `web/tests/webxr-earth.test.js`

**Interfaces:**
- Consumes: `WORLD_PALETTE`, `applyVRTheme` and `TOKENS`.
- Produces:
  - `WORLD_PALETTE[mode].earth = { land, sea, park, lineSoft, line, rim, rimOpacity, rimBlending, tintLift, tintHue, tintDepth }`:
    - light: land `#f2ede3`, sea `#d8e2e4`, park `#dfe3cf`, lineSoft `#d3cab8`, line `#45403a`, rim `#17140f` at low opacity with `NormalBlending`
    - dark: land `#1c1a16`, sea `#0c0b09`, park `#25221d`, lineSoft `#2e2a24`, line `#f5f1e8`, rim `#f5f1e8` as a faint glow with `AdditiveBlending`
    - The tint values replace `EARTH_TILE_TINT_LIFT`, `EARTH_TILE_TINT_HUE` and `EARTH_TILE_TINT_DEPTH`, per mode.
  - Shader uniforms `uEarthLand`, `uEarthSea`, `uEarthPark`, `uEarthLineSoft`, `uEarthLine` and `uEarthPaper` (1 in light, 0 in dark). The colour uniforms take linear values (each sRGB component to the power 2.2).
  - These uniforms and the three tint uniforms become module-level objects. Every block from `makeEarthTileUniforms` (4331) holds the same objects. Today it builds fresh ones per tile, so a switch would miss the tiles already on the globe.
  - `__test.earthGradeColors(): { land, sea, park, lineSoft, line }` as sRGB hex, read back from the uniforms, and `__test.makeEarthTileUniforms`.

**The grade, per tile source** (`uTileNight` is 1 for light rasters, the keyless OSM default):
- Light rasters: keep today's classify step. Its base colours come from `uEarthLand`, `uEarthSea` and `uEarthPark`, and its line work is a mix from `uEarthLineSoft` to `uEarthLine`. This one branch gives the paper atlas in light mode and the warm night chart in dark mode.
- Dark rasters (keyed CARTO) in dark mode: today's tint chain with the dark tint values.
- Dark rasters in light mode (`uEarthPaper` is 1): map brightness to a mix from `uEarthLand` to `uEarthLine`, so dark land becomes paper and bright lines become ink. The labels layer gets the same mapping, keeping its alpha. Light glyphs on a dark halo then become ink on paper.

**Other painters:**
- `paintEarthBase`: draws the sea wash and land, with the grid in `TOKENS.hex.rule`.
- Fallback globe: `earth.sea`.
- `paintHeatZones`: `accent`, with `spot` for the hottest band.
- Tier colours: from Task 2.
- A switch sets `earthMapDirty` (Task 4) and updates the uniforms and the atmosphere.

- [ ] **Step 1: Write the failing tests**
  - `earth grade follows the mode`:
    - Under light, `earthGradeColors()` deep-equals the five light `earth` values.
    - After `__test.setVRTheme('dark')`, it deep-equals the dark ones.
  - `tiles already on the globe take a switch`:
    - Build two blocks with `makeEarthTileUniforms(null, true)`. Their `uEarthLand` is the same object, and so is their `uTileTintLift`.
    - Switch the mode. Block `a`'s `uEarthLand.value` is the new land colour in linear, and `uEarthPaper.value` matches the mode.
  - `the tile shader reads the palette uniforms`, by source regex, as the test at line 5039 does:
    - The source declares `uniform vec3 uEarthLand` and `uniform float uEarthPaper`.
    - The fixed night colours (`vec3(0.070, 0.150, 0.235)` and the other two) are gone.
  - `raw tiles stay untouched in both modes`: repeat the existing `earthstyle: 'raw'` check (`webxr-earth.test.js:3888`) under `theme: 'light'` and again under `'dark'`.
  - `webxr_vr.js paints no carbon literal`: the source contains none of the Global Constraints literals.

- [ ] **Step 2: Run the tests and expect them to fail**

Run: `cd web && node --test tests/webxr-earth.test.js`
Expected: FAIL. `earthGradeColors` is not a function, and the scan names `0x020612` and the rest.

- [ ] **Step 3: Implement** the Interfaces block and the painters above.

- [ ] **Step 4: Run every VR test and expect them to pass**

Run: `node --test tests/webxr-earth.test.js tests/vr-*.test.js tests/reels-vr-*.test.js tests/echo-token-parity.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/assets/webxr_vr.js web/tests/webxr-earth.test.js
git commit -m "Paper & Ink VR: re-ink the globe as a paper atlas and a warm night chart"
```

### Task 7: VR preview surfaces in the 2D site

**Files:**
- Modify: `web/src/styles/global.css:7525` and `:7643`
- Modify: `web/src/components/ui/VRPanelWorkbench.jsx` (the effects at 456, 483 and 490)
- Modify: `web/tests/css-guardrails.test.js:11`
- Test: `web/tests/paper-ink-theme.test.js`

**Interfaces:**
- Consumes: `useTheme()` from `web/src/theme.js`, and `VRUICanvas.setTheme` from Task 1.

- [ ] **Step 1: Write the failing test** in `paper-ink-theme.test.js`. `VR preview stages take the page tone`: the `.sx-immersive-preview-stage {` and `.sx-vr-workbench-stage {` rules in `global.css` each declare `background: var(--sx-bg);`.

- [ ] **Step 2: Run the test and expect it to fail**

Run: `cd web && node --test tests/paper-ink-theme.test.js`
Expected: FAIL, because the backgrounds are `#020612`.

- [ ] **Step 3: Implement**
  - Change both backgrounds to `var(--sx-bg)`.
  - In `VRPanelWorkbench.jsx`, call `const [theme] = useTheme();`. Add an effect on `[theme]` that calls `UI.setTheme(theme)` and redraws the way the existing effects do.
  - The stand-in gradient in `posterCache` (262–273) stays, because it stands in for a reel.

- [ ] **Step 4: Run the guardrail and expect it to fail**

Run: `node --test tests/css-guardrails.test.js`
Expected: FAIL, reporting that `color-no-hex` went down to 17.

- [ ] **Step 5: Lower the baseline** in `css-guardrails.test.js` to the number the failure reports. Expect 17. Then run `node --test tests/css-guardrails.test.js tests/paper-ink-theme.test.js` and `npx vitest run`, and expect them to pass.

  `VRPanelWorkbench` has no unit test, because it draws through script-loaded globals. Task 8 checks it in the browser in both modes.

- [ ] **Step 6: Commit**

```bash
git add web/src/styles/global.css web/src/components/ui/VRPanelWorkbench.jsx web/tests/css-guardrails.test.js web/tests/paper-ink-theme.test.js
git commit -m "Paper & Ink VR: preview stages and the flat-panel workbench follow the theme"
```

### Task 8: QA

**Files:** none in the repo. Screenshots go to the scratchpad.

- [ ] **Step 1: Run the full suite and build**

```bash
cd web && PATH=/opt/homebrew/bin:$PATH npm test
```

```bash
npx vite build
```

```bash
../../../.venv/bin/python -m pytest -q tests/test_ui_tokens.py
```

Expected: all pass. Run the last command from the worktree root.

- [ ] **Step 2: Start the app**
  - API: `.venv/bin/uvicorn server.app:app --port 8000`
  - Vite: `npx vite --port 5186 --strictPort`

- [ ] **Step 3: Check `/reels/immersive-preview` in both modes**, signed in with the admin test account. Take a screenshot of each of these in each mode:
  - the reels scene, with a video playing and paused
  - every shell section and the handoff dialog
  - the comments panel and the controller guide
  - the earth scene, with the label, scale bar, preview card and tiers
  - the FLAT PANELS workbench

- [ ] **Step 4: Switch mid-session** from the 2D sidebar, then from the VR nav bar. Each switch changes every canvas, the world and the globe in one step. The sidebar switch and the `theme-color` meta tag agree afterwards.

- [ ] **Step 5: Check the edge cases**
  - Hard-reload with dark saved. Record with the Performance panel; no light frame appears.
  - Block `fonts.googleapis.com` in the network panel. Panels paint after about 3 s.
  - Tune these and write the final values back into the code:
    - `DIM_AMOUNT` and `DIM_FADE_MS`
    - `radiusPx`
    - the sky blue, mountains and sea wash

- [ ] **Step 6: Check contrast.** Run the scratchpad `audit.js` on the 2D page in both modes. For the VR canvases, the Task 1 contrast test is the check; review the screenshots for any text that is hard to read.

- [ ] **Step 7: Headset.** If a Quest is connected:
  - Capture each mode with `metavr` device screenshots.
  - Check that the light world is comfortable around a playing video.
  - Check that the frame rate holds.

  If no Quest is connected, say so in the report. The owner decides before merging.

- [ ] **Step 8: Stop both servers.**

### Task 9: Ship

- [ ] Ask the owner, then merge `redesign/paper-ink-theme` into `palette-test`. Do not target `main`, and do not push. The merge commit message lists:
  - what changed in each mode
  - the tuned dim, radius and world values
  - the QA results, including whether the headset was checked

---

## Out of scope

- VR behaviour, layout, panel sizes and placement, except the nav bar switch.
- The 2D reels player (`#sxReelsRoot`), which stays carbon, and the 2D site outside the VR preview surfaces.
- Server changes, including a theme saved to the account.
- An animated transition between modes.
- New photo or texture assets.

## Open decisions

1. **The standalone `/api/reels/player` page has no `data-theme`**, so VR opens in light there. The alternative is to read `sx.theme` when the attribute is missing.
2. **Fonts on the standalone player and in Streamlit.** These hosts load no Paper & Ink fonts, so VR paints with fallback faces there. The alternative is to add the font links to those pages.
3. **Dim amount and fade length.** They start at 0.45 and 600 ms and get tuned in Task 8.

## Size

About 16 files. Most of the change is in the three VR scripts, roughly +900 / −450 lines, with about +400 lines of tests. The 2D changes are under 40 lines.
