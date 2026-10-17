# UI-consistent branch: verification report

Branch `UI-consistent` (cut from `3dreels`), verified 2026-10-17 against the ECHO design system artifact.
Scope was UI only: tokens, CSS, class names, presentational wrappers, copy and icons. No routes, API calls, state, handlers, shortcuts or XR session logic changed.

## Method

- `make test` (pytest + vitest) after every workstream and after the verification fixes.
- Headless sweep (`reports/ui-consistent/verify/`, gitignored): 21 routes × 1440 / 768 / 375 px on the branch (Vite :5173) and on a `3dreels` base checkout (Vite :5174), both against the same backend on :8000. Per page it records horizontal overflow, undefined `var(--sx-*)` reads, font families in use, Orbitron and Chakra Petch usage, WCAG text contrast below AA, rounded corners, targets under 44 px, unnamed controls, images without alt, `h1`, title, console errors and keyboard focus rings.
- Live browser-pane checks: login, sidebar (Escape closes, focus returns), folder dropdown keyboard, reels player tokens, comments drawer, More panel, reels dock breakpoint (1100 vs 1099 px), immersive preview (authed shots from the sweep).

## Results (base → branch)

| Check | Base | Branch |
|---|---|---|
| Undefined `--sx-*` variables | 8 on every route | 0 on every route |
| Orbitron usage | 8 elements | 1 (wordmark only) |
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

## Accepted exceptions (pinned by tests or owner decision)

- Reels `#vrBtn` purple `#A855F7` (4.15:1) and `#modeBtn.active` `#FF3B1F`.
- Reels `.action-btn` 8 px and `.reels-cluster` 12 px radii (`web/tests/reels-docked-column.test.js`).
- Bottom nav `#f2f3f5` literals (`reels-pack-visual.test.js`).
- Earth map colours (data-viz exception), map attribution kept legible.
- Emoji reactions.

## Known gaps (not fixed on this branch)

- Reels drawer: accent text on the drawer is about 4.04:1 (`.drawer-tab.active`, comment time buttons, "SIGN IN" submit). The drawer background `#1b1c1d` is not an exact token. PREV / NEXT are partly clipped at 760 px.
- Reels side panel radii: `edge-chevron` 8 px, `reels-side` 8 px, `side-chip` 4 px, `side-stats` 6 px. Avatar initials below AA.
- About 121 raw hex values remain in `ui/assets/reels.html`, plus canvas card colours.
- `webxr_vr.js` does not yet read `VRUICanvas.TOKENS` everywhere.
- The "IMMERSIVE PREVIEW" label still carries a 🥽 emoji.
- StudioStage transport glyphs, JobRunner / StudioLoading progress, and Tag / Location `.sx-error-box` were not adopted.
- Pack editor overflows by 324 px at 768 px on both base and branch (pre-existing).
- Every route's document title is "ECHO"; pack editor @1440 has no `h1`.
- Not run: IWER / Quest emulator, `make streamlit`, `make build` (so `server/static` still holds the stale Oct 5 bundle).

## Functional bugs found (report only, not fixed)

Triage order: legacy-1 first.

- **legacy-1 (security):** `/vr-video-path-ab?master=` reflects its parameter unvalidated into HTML and a JS string with no auth (`server/routers/reels.py` ~2789-2823).
- **studio-3:** RENDER re-enables while a paid job is still running, so a second click can double-charge.
- **social-5:** the pack editor shows CREATE while the edited pack loads or fails; SAVE then POSTs a new pack.
- **discovery-12 / 13:** fetch failures show as empty results; admin-only tools are visible to every visitor.
- Ops: stray empty `server/static 2` directory; stale Oct 5 build in `server/static`; `SX_PUBLIC_URL` default leaks into the password reset email; no 404 page; native `prompt` / `confirm` / `alert` dialogs in profile and moderation.

The full list is in the plan (`Functional bugs found`).
