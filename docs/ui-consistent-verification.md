# UI-consistent branch: verification report

Branch `UI-consistent` (cut from `3dreels`), verified 2026-10-17 (Quest headset 2026-10-18) against the ECHO design system artifact.
Scope was UI only: tokens, CSS, class names, presentational wrappers, copy and icons. No routes, API calls, state, handlers, shortcuts or XR session logic changed.

## Method

- `make test` (pytest + vitest) after every workstream and after the verification fixes.
- Headless sweep (`reports/ui-consistent/verify/`, gitignored): 21 routes × 1440 / 768 / 375 px on the branch (Vite :5173) and on a `3dreels` base checkout (Vite :5174), both against the same backend on :8000. Per page it records horizontal overflow, undefined `var(--sx-*)` reads, font families in use, Orbitron and Chakra Petch usage, WCAG text contrast below AA, rounded corners, targets under 44 px, unnamed controls, images without alt, `h1`, title, console errors and keyboard focus rings.
- Live browser-pane checks: login, sidebar (Escape closes, focus returns), folder dropdown keyboard, reels player tokens, comments drawer, More panel, reels dock breakpoint (1100 vs 1099 px), immersive preview (authed shots from the sweep).

## Results (base → branch)

| Check | Base | Branch |
|---|---|---|
| Undefined `--sx-*` variables | 8 on every route | 0 on every route |
| Orbitron usage | 8 elements | wordmark only (header, sidebar hero, auth mark) |
| Chakra Petch | messages 2, settings 5, wallet 5 | 0 |
| Low-contrast text, 2D routes | present | 0 on every route |
| Low-contrast text, reels player | 10 | 8 (see exceptions) |
| Rounded corners | widespread | auth pages 0; remaining are pinned or listed below |
| Targets under 44 px (compare @375) | 12 | 5 (44 px applied under `pointer: coarse`) |
| Overflow, pack editor @1440 | 333 px | 0 |
| Unnamed controls, pack editor | 5 | 0 |
| Images without alt, focus-ring failures | 0 | 0 |

Console errors seen on both sides are environmental: 429 on `/api/messages/events` (the sweep's own polling) and 503 on `/api/rewards/reels/claim`.

Fixes made during verification (commit `style(ui): square explore chrome and rest-state icon button glow`):
- `sx-xh-*` chrome (stats, chips, toolbar, tabs, segmented control, icon buttons) on Explore, Tag and Location was still 2–3 px rounded; now square.
- `.sx-icon-btn` glowed at rest and used `#000000`; glow now only on hover / focus-visible, text uses `--sx-on-accent`.

## Quest 3S headset (USB, Chrome DevTools Protocol)

Run 2026-10-18 on a Quest 3S over USB debugging: OculusBrowser 152.1 (Chrome 152), 1280 × 670 viewport, dpr 1, `pointer: coarse` and `hover: hover` both match. The branch Vite server (:5173) and backend (:8000) were bridged with `adb reverse`; DevTools was reached with `adb forward tcp:9222 localabstract:chrome_devtools_remote`. Each route was opened in a fresh tab, probed with `Runtime.evaluate` and captured with `Page.captureScreenshot` (`reports/ui-consistent/verify/quest/`, gitignored).

| Check | Result |
|---|---|
| Console errors and exceptions (`/reels`, `/`, `/explore`, `/login`, `/immersive`, `/wallet`) | 0 on every route |
| Fonts | Archivo, Archivo Black, JetBrains Mono and Orbitron 900 load |
| Tokens | `--sx-bg #08090a`, `--sx-accent #ff3b1f`, `--sx-ink #f2f3f5`, `--sx-on-accent #0a0a0a`; body background matches |
| Chakra Petch, horizontal overflow | 0 on every route |
| Reels pinned values | `.action-btn` 8 px, `.reels-cluster` 12 px, `#vrBtn` purple, `#modeBtn` intact; 4K video plays (3840 wide) |
| `VRUICanvas.TOKENS` | present (`hex`, `font`, `space`, `radius`) |
| Reels player low contrast / rounded | 12 / 12, the known reels gaps below |

Fixed from this run (commit `style(ui): move header action and auth submit glow to hover/focus`): the header UPLOAD button (`.sx-top-action-btn`) and the auth SIGN IN submit (`.sx-au-submit`) glowed at rest. Both predate the branch. Re-checked on the headset: no resting glow.

Wordmark re-check on the headset (2026-10-18, 1280 px, `/explore`, `/reels`, `/wallet`): Orbitron 900 loads, the wordmark is 133 px wide with no clipping, no horizontal overflow and no overlap with header controls. The backend was not running for this check, so `/api/*` calls returned 500 through the Vite proxy; those errors are not UI regressions.

Not covered on the headset: the browser was not signed in (authed routes redirect to `/login`; no credentials were entered), no immersive XR session was entered (it needs a user gesture in the headset), and this was HTTP over `adb reverse`, not the Quest HTTPS gate.

Wordmark (commit `style(ui): set header wordmark in Orbitron`): the header wordmark (`.sx-top-brand`) was Archivo Black while the sidebar hero and auth mark used Orbitron. It now uses `--sx-font-brand`, so all three wordmarks match. Fit checked in the browser pane at 1440, 1100, 1099, 768, 701, 700, 641, 640, 375, 341 and 320 px: no horizontal overflow, no clipping and no overlap with header controls. The tightest gap to the next control is 20 px (641-701 px). Below 341 px the wordmark text is hidden by design and only the logo shows.

## Accepted exceptions (pinned by tests or owner decision)

- Reels `#vrBtn` purple `#A855F7` (4.15:1) and `#modeBtn.active` `#FF3B1F`.
- Reels `.action-btn` 8 px and `.reels-cluster` 12 px radii (`web/tests/reels-docked-column.test.js`).
- Bottom nav `#f2f3f5` literals (`reels-pack-visual.test.js`).
- Earth map colours (data-viz exception), map attribution kept legible.
- Emoji reactions.

## Gap closure (2026-10-18)

One commit per workstream on `UI-consistent`; `make test` green after each (pytest 347, vitest 355, reels node tests).

| Gap | Result |
|---|---|
| Reels drawer contrast and surface | `.drawer-tab.active`, comment submit and time buttons now on-accent or accent-hi (>= 4.5:1); drawer uses `--sx-surface-hover`, docked column uses `--sx-bg` |
| Reels side-panel radii | `.reels-side`, avatar, chips, stats and edge chevron are square |
| PREV / NEXT at 701-820 px | Not clipped; they overlapped the action bar. They move to the left edge in that range. 1100 px docked layout unchanged |
| Avatar initials | Text colour picked by luminance (on-accent or ink), background colour unchanged |
| Reels raw hex | Mapped to ECHO tokens (new `sxTok` / `readableOnDark` helpers for the canvas cards); pinned `#A855F7`, `#FF3B1F` (`#modeBtn.active`) and bottom-nav `#f2f3f5` stay |
| VR canvas | HUD reads `VRUICanvas.TOKENS`: square radii, flat accent play button, no glow, drawn glyphs (chat, globe, lock, audio) instead of emoji, notification strip now drawn, long words hard-break in `wrapTextLines`, comment colours AA. Laser, pointer and reticle use the accent token. DOM comment input restyled; `📍` dropped from the location notice |
| IMMERSIVE PREVIEW / Spatialize emoji | New `VrIcon` (`svg/vr-headset.svg`, `currentColor`) |
| Studio | Connecting state has `role="progressbar"`; `StudioLoading` moved to `.sx-studio-loading*` classes; transport glyphs are SVG; Tag and Location feed errors use `.sx-error-box` |
| Pack editor @768 | Overflow 324 px to 0. Cause: long unbroken reel titles in the library grid (`overflow-wrap: anywhere`). The "no `h1` @1440" finding was a sweep timing artefact (skeleton still showing); the loaded page has `CREATE REEL PACK` |
| Document titles | `useDocumentTitle` + `routeTitle`, called once in `App`: "Explore · ECHO", "#viral · ECHO", "@name · ECHO", and so on |
| Explore chip touch targets | Under `pointer: coarse` an invisible `::before` grows creator, owner and share chips to 44 px (measured: 30 px chip, hit at 5 px above and below, not at 9 px). The sweep still counts them: it measures visible boxes only |
| `make build` / `make streamlit` | `server/static` rebuilt (gitignored, serves the branch bundle on :8000); Streamlit starts and answers 200 on :8501 |
| Quest headset | HUD canvases rendered on OculusBrowser through CDP and captured (`reports/ui-consistent/verify/quest/`): square chrome, glyphs, notification strip, wrapped long word |

## Known gaps (not fixed on this branch)

- `.sx-explore-loc-link` chips (22 px) sit inside an `overflow: hidden` container, so the coarse-pointer hit-area expansion is clipped there. Left as is.
- Reels: `#vrBtn` purple (4.15:1) and the pinned radii stay by test. A few raw hex values with no matching token remain in `reels.html` (listed by `grep -nE '#[0-9a-fA-F]{6}' ui/assets/reels.html`).
- The pack editor `EmptyState` and loading skeleton have no `h1`.
- Not run: IWER emulator, an immersive XR session on the headset (needs a hand gesture in the headset; the HUD was verified by rendering its canvases), HTTPS Quest gate.
- `server/static 2` (empty directory) left alone.

## Functional bugs found (report only, not fixed)

Triage order: legacy-1 first.

- **legacy-1 (security):** `/vr-video-path-ab?master=` reflects its parameter unvalidated into HTML and a JS string with no auth (`server/routers/reels.py` ~2789-2823).
- **studio-3:** RENDER re-enables while a paid job is still running, so a second click can double-charge.
- **social-5:** the pack editor shows CREATE while the edited pack loads or fails; SAVE then POSTs a new pack.
- **discovery-12 / 13:** fetch failures show as empty results; admin-only tools are visible to every visitor.
- Ops: stray empty `server/static 2` directory; stale Oct 5 build in `server/static`; `SX_PUBLIC_URL` default leaks into the password reset email; no 404 page; native `prompt` / `confirm` / `alert` dialogs in profile and moderation.

The full list is in the plan (`Functional bugs found`).
