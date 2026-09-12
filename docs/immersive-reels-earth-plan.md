# Immersive Reels Preview and Earth Activity Mode

Last updated: 2026-09-12 UTC

## Status

- [x] Persistent implementation record created before code changes.
- [x] Location activity API and recent-trending feed implemented.
- [x] Shared desktop/XR scene lifecycle implemented.
- [x] Desktop immersive preview route implemented.
- [x] VR Earth mode and location interaction implemented (device validation pending).
- [x] Automated tests completed.
- [ ] Physical Meta Quest validation completed.

Current milestone: Earth visualization enhancement and automated verification complete; physical Quest acceptance remains.

Enhancement milestone (2026-09-12):

- [x] Replace point markers with blended geographic heat zones.
- [x] Restyle the low-resolution natural map as a high-clarity blue holographic globe and increase sphere tessellation.
- [x] Keep the Earth pole/horizon upright during every drag, wheel, thumbstick, and idle-spin path.
- [x] Show a world-space popup on location hover and autoplay/cycle up to three muted recent reels from that city.
- [x] Promote the existing dock action into an unmistakable `EARTH MAP` button inside VR Reels controls.
- [x] Preserve the existing pulsing starfield without adding or replacing the sky background.
- [x] Add regression coverage and complete frontend/build/generated-player checks before this resumed pass.

Next action: validate the completed Earth mode on physical Quest hardware, recording Quest Browser/Horizon OS versions, controller and pinch behavior, hover-popup playback/readability, and stable 72 Hz telemetry in this file.

## Persistent Project Record

- Treat this file as the durable source of truth.
- Update it after every implementation milestone, after tests or Quest-device validation, whenever assumptions or blockers change, and before ending a work session.
- Keep the checklist, progress log, verification results, known issues, and explicit next action current so a later session can resume safely.

## Summary

- The existing Quest experience uses custom WebXR/WebGL1 with a head-locked curved reel screen, starfield, ambilight, controller ray, transport dock, guide, and comments panel.
- Add a creator/developer preview route at `/reels/immersive-preview`.
- Add a dedicated Earth activity mode inside the existing XR session.
- Protect the existing video path: the globe performs no rendering work while closed.

## Implementation

### Shared scene and desktop preview

- Refactor the renderer into a shared scene core with separate XR and desktop drivers while preserving `window.WebXRVR`.
- Add preview lifecycle, camera-mode, reduced-motion, and scene-mode APIs.
- Render the same live reel, geometry, shaders, panels, globe data, and callbacks used on Quest.
- Default to Headset POV, with mouse/touch head-look, orbit inspection, side-by-side stereo diagnostics, reset, fullscreen, and reduced-motion controls.
- Link the preview from “Quest & Tools”; keep it out of public navigation.
- Label it as scene/layout parity rather than Quest optics or performance emulation.

### VR Earth mode

- Add a prominent `EARTH MAP` control to the immersive Reels dock; while Earth is open it becomes `BACK TO REELS`, and after selecting a location it becomes `ALL LOCATIONS`.
- Opening it pauses the reel, suspends video uploads and ambilight, hides reel panels, and displays a world-anchored tabletop globe approximately 1.3 m ahead and 0.4 m below eye level.
- Present a full globe recessed into a rim so it appears as an upward-facing hemisphere.
- Use the bundled public-domain Natural Earth raster as geographic source data, but render it through a higher-density blue holographic globe treatment rather than displaying the low-resolution raster directly.
- Render up to 128 blended location heat zones in one lazily-created heat texture; zones communicate activity through area, intensity, color, and contour rings rather than point dots.
- Show text plus a muted world-space reel preview for the hovered location, cycling through up to three recent location-tagged videos while the hover remains active.
- Idle-spin around 3°/second, pausing during interaction and when reduced motion is enabled.
- Support controller trigger-drag, thumbstick rotation, feature-detected pinch-drag, desktop mouse, and touch.
- Constrain all globe interaction to yaw so geographic north remains upright.
- Keep the camera stationary throughout interaction.
- Selecting a location loads its feed in-place, closes Earth mode, and plays its top recent reel.
- Preserve and restore the original feed, index, cursor, and playback state through an “All locations” action.

### Location activity and feeds

- Add `GET /api/reels/locations/activity?window_days=7&limit=128`.
- Return city-level aggregates: slug, name, country, centroid coordinates, active/new reel counts, score, and normalized heat.
- Use a seven-day window and 48-hour decay half-life:
  - New post: 2.
  - Unique qualified daily view: 1.
  - Like/comment: 3.
  - Save: 4.
  - Share/share-sent: 2/5.
- Ignore impressions, playback starts, skips, and negative feedback.
- Normalize heat logarithmically against the 95th-percentile location score.
- Fall back to media modification time for legacy posts and existing city coordinates when precise metadata is unavailable.
- Never expose per-post precise coordinates; omit unresolved locations.
- Extend the feed API with `sort=recent_trending` and `window_days=7`.
- Abort stale requests, revoke obsolete blobs, reset pagination safely, and retain recommendation attribution during feed switches.

## Tests and Acceptance

- Test scoring, decay, normalization, coordinate fallback, safety filtering, and recent ranking.
- Test geographic projection, heat-zone hit-testing, drag gestures, reduced motion, control-panel entry/return actions, and renderer cleanup.
- Test location feed replacement/restoration, cancellation, cursor handling, and empty/error states.
- Verify the desktop preview works without `navigator.xr` and matches XR scene transforms.
- Validate controller and pinch interaction on physical Quest hardware.
- Confirm normal Reels mode gains no globe draw calls.
- Require Earth mode to hold 72 Hz with video uploads paused.
- Record Quest Browser/Horizon OS versions and telemetry here.
- Baseline frontend build/tests pass; focused backend unittest coverage runs in `comfy-venv`.

## Assumptions

- Retain the custom WebXR/WebGL1 stack; do not migrate to IWSDK or Three.js.
- Preserve the existing reel-screen size and head-lock behavior during this work.
- The preview is a creator/developer tool.
- Location activity is aggregated at city level; no precise per-post coordinates are exposed.

## Verification Notes

- 2026-09-12: `npx -y metavr docs search` was attempted for Quest Browser WebXR, hand input, performance, and spatial layout. The published package reported that `linux-x64` is unsupported (supported platforms listed: macOS ARM/x64 and Windows x64). Exact Quest API behavior must therefore be re-verified through Meta MCP or a supported host before physical-device acceptance.
- 2026-09-12: Repeated the mandatory Meta documentation lookup before continuing implementation; `metavr` still reports no Linux x64 platform binary.
- 2026-09-12: Final mandatory Meta documentation lookup again failed with `unsupported platform "linux-x64"`; no authoritative Meta citation or connected-device query was available in this environment.
- 2026-09-12: Re-ran the mandatory lookup for the heat-zone, hover-preview, and upright-globe enhancement. The current `metavr` package still reports `linux-x64` as unsupported; implementation therefore remains pending verification through Meta MCP or a supported host.
- 2026-09-12: On the resumed final pass, the mandatory Meta lookup could not start because this host no longer exposes `npx`; authoritative Meta verification therefore remains a physical/supported-host release gate.
- 2026-09-12: Existing frontend baseline was previously green with `npm run build` and `npm test`.
- 2026-09-12: System Python could not collect recommendation tests because `argon2` was missing; the repository virtual environment did not contain `pytest`.
- 2026-09-12: `./comfy-venv/bin/python -m unittest test_reels_discovery.py` passed all 14 tests, including scoring weights, 48-hour decay, logarithmic heat normalization, coordinate fallback, unresolved-location omission, safety filtering, and recent-trending order.
- 2026-09-12: Final `web/npm test` passed 15 tests total: 13 Node tests plus 2 Vitest component tests. Coverage includes desktop startup without `navigator.xr`, GPU cleanup, geographic projection, marker hit-testing/drag, reduced motion, dormant Earth rendering, paused video uploads in Earth mode, stale Earth-response rejection, and location-feed state restoration/cancellation.
- 2026-09-12: Final `web/npm run build` passed with 163 transformed modules.
- 2026-09-12: `node --check` passed for `ui/assets/webxr_vr.js` and `ui/assets/reels_feed_state.js`; the actual transformed JavaScript returned by `/api/reels/player-inline` also passed `node --check -`.
- 2026-09-12: Python byte-compilation passed for the modified backend/view files, and `git diff --check` reported no whitespace errors.
- 2026-09-12: Enhancement verification completed before the resumed pass: the focused Earth renderer suite passed 10 tests, the full frontend suite passed 16 Node tests plus 2 Vitest tests, the production Vite build passed, and both the renderer file and generated inline-player JavaScript parsed successfully.
- 2026-09-12: Resumed final pass re-ran the available backend checks successfully: `test_reels_discovery.py` passed 14/14 and `tests/test_recommendations.py` passed 7/7. The resumed shell has no `node`, `npm`, or alternate JavaScript runtime on `PATH`, so the already-green frontend/build checks could not be repeated in this shell.
- Quest Browser version: pending physical-device validation.
- Horizon OS version: pending physical-device validation.
- Earth-mode frame-rate and draw/upload telemetry: pending physical-device validation.

## Progress Log

### 2026-09-12 — Implementation start

- Re-read the required Quest verification, WebXR, performance, comfort, interaction, spatial-layout, and accessibility guidance.
- Confirmed the implementation will retain the current custom WebGL renderer and use feature detection for optional hand input.
- Created this durable plan before modifying application code.

### 2026-09-12 — Location activity backend

- Added `GET /api/reels/locations/activity?window_days=7&limit=128` with city-only centroids and no per-post coordinates.
- Added weighted positive-signal scoring, a 48-hour half-life, seven-day default/30-day cap, and media-mtime fallback for legacy posts.
- Added `sort=recent_trending` and `window_days` to list, paginated feed, tag/location detail, and full/inline player entry points.
- Expanded the static coordinate fallback to every seeded city.
- Added and passed focused tests; Python syntax compilation is clean.

### 2026-09-12 — Shared renderer, desktop preview, and location feed switching

- Added a shared `renderSceneView` path with a non-XR canvas driver, Headset POV and orbit cameras, pointer/touch look controls, side-by-side stereo diagnostics, reset, fullscreen, and reduced-motion APIs.
- Added lazy Earth geometry, texture, recessed rim, one batched marker buffer, hover/selection labels, idle rotation, controller/thumbstick/pinch-compatible select handling, and desktop mouse/touch rotation.
- Added the private `/reels/immersive-preview` route and linked it only from the existing “Quest & Tools” panel.
- Added cancellable location feed replacement and exact All Locations restoration of playlist, index, cursor, parameters, mute/auto mode, playback time, and playback state.
- Added explicit GPU resource deletion and listener/request cleanup; entering XR now stops an active desktop preview.
- Added the Natural Earth public-domain source/license note.
- Verification: `node --check ui/assets/webxr_vr.js` passed; the injected Reels script parse check passed; `web/npm run build` passed; `web/npm test` passed (4 tests total).

### 2026-09-12 — Final regression coverage and lifecycle hardening

- Added renderer regression coverage for desktop startup without WebXR, GPU resource deletion, zero Earth draws in normal Reels frames, paused video texture uploads in Earth frames, and stale activity-response rejection.
- Added feed-state regression coverage for recent-trending location parameters, recommendation attribution, pagination restoration, and cancellation generations.
- Prevented duplicate `requestVideoFrameCallback` loops across preview/XR restarts and cancel the active callback during teardown.
- Preserved the embedded player's DOM listener/observer cleanup when composing the SPA runtime cleanup wrapper.
- Added generation guards for Earth activity and location-selection promises, and clear cached markers on reopen, so stale data cannot alter or be selected in a newer scene.
- Paused image-reel dwell timers while Earth is open and restored their prior playback state when returning to Reels.
- Increased the minimum heat-marker hit target to approximately 62 mm on the globe surface for more reliable controller and hand-ray selection.
- Added failed-preview initialization cleanup and restoration of pre-Earth playback when an XR session exits directly from Earth mode.
- Final automated verification passed: frontend build; 15 frontend tests; 14 backend tests; renderer/feed-helper/generated-inline JavaScript checks; Python byte-compilation; and `git diff --check`.

### 2026-09-12 — Earth visualization enhancement started

- Accepted follow-up requirements to replace marker dots with activity zones, redesign the map as a sharper blue holographic globe, lock the Earth upright, add hover-triggered autoplay reel previews, and make the existing in-VR Earth control more prominent.
- Confirmed the pulsing starfield is already rendered in both Reels and Earth scene modes and should remain unchanged.
- Chose a lazily composed holographic map/heat texture so all zones remain part of one globe draw and no Earth GPU work is introduced before Earth mode opens.
- Applied comfort/accessibility constraints from the immersive design guidance: stable horizon, world-anchored popup in the 1.2–1.5 m focal range, muted media, readable high-contrast labels, and a reduced-motion fallback.

### 2026-09-12 — Earth visualization enhancement completed

- Replaced discrete point markers with blended, intensity-scaled geographic heat zones and contour rings in one lazily composed globe texture.
- Converted the source map into a higher-resolution blue holographic treatment with cyan coastlines and a geographic grid, and increased globe tessellation for a cleaner silhouette.
- Constrained every rotation path to yaw only so north remains upright and the user-facing horizon never rolls or pitches.
- Added a world-space hover popup that debounces location changes, aborts stale requests, autoplays muted recent location reels, cycles through up to three items, and presents a static frame in reduced-motion mode.
- Added a prominent glowing `EARTH MAP` action directly to the immersive Reels control dock. The same target reads `BACK TO REELS` in Earth mode and `ALL LOCATIONS` after entering a location feed.
- Kept the existing pulsing starfield renderer unchanged as the background for both Reels and Earth scenes; no second sky/background layer was added.
- Added regression coverage for the dock action, holographic heat-zone state, upright rotation, hover-preview cancellation/cycling, and continued star rendering while main reel uploads are paused.
- Verification before resume: focused Earth suite 10/10, full frontend suite 16 Node + 2 Vitest, production build, renderer parse, generated-player parse, and whitespace checks passed. Verification after resume: 14/14 location tests and 7/7 recommendation/player tests passed.

## Known Issues / Release Gates

- Current immersive video playback has an unresolved frame-pacing investigation documented in `docs/vr-reels-playback-investigation.md`.
- Automated render-path tests confirm the Earth renderer is dormant in Reels mode and video texture uploads pause while Earth mode is open; physical telemetry confirmation is still required.
- Physical Quest validation remains a release gate: controller interaction, hand pinch behavior, `EARTH MAP` control readability/activation, heat-zone and popup readability, muted popup playback, seated reachability, stable 72 Hz operation, and session-exit behavior.
- Current Meta documentation verification remains a release gate because the required `metavr` package has no Linux x64 binary in this environment; repeat through Meta MCP or a supported macOS/Windows host.
