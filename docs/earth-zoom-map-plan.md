# Earth Zoom Map Plan — Google-Maps-Style Zoom for the VR Globe

Status: **v1 implementation complete 2026-09-22** (Z0–Z4 below); **v2 refinement in progress
2026-10-02** — see §0 for the review findings and build order driving the current work.
Supersedes nothing; extends the Earth View Subsystem (§4.1 of
`docs/threejs-vr-implementation-plan.md`).
Aligns with `docs/todolist.md` items "Open city/event Packs directly from Earth while
retaining city-level location privacy" and "Pilot travel, restaurant, and city packs
connected to Earth".

---

## 0. Earth Zoom v2 — keep it a globe, make the text readable (2026-10-02)

### Review findings that triggered v2

The v1 zoom (Z0–Z4, commits `04a64ce` + `075a909`) works end-to-end but reads as "raw" on
review:

1. **Curvature disappears.** `applyEarthZoom` scaled the real sphere by `S` up to 16384,
   pinning the focus 1.15 m from the head. At S=64 the radius is already 43 m; by street
   zoom it's 11 km. Inside the ~49-tile view that's a flat wall, not a globe.
2. **Face-on wall posture.** The focus normal pointed straight at the head
   (`zoomEarthTo`). No horizon, no limb, no atmosphere — the cues that say "you're on a
   planet" were absent.
3. **Text was unreadable, structurally:**
   - OSM standard tiles are 256 px with dark glyphs in white halos; the CPU per-pixel
     restyle (`earthHoloTile*`) thresholded these into bright blobs that rang and fattened
     no matter how it was tuned.
   - Tile textures used `LinearFilter` with no mipmaps/anisotropy — text shimmered and
     aliased under VR resampling, worse at oblique angles.
   - Tile zoom selection (`log2(S)+3.3`) gave ~4.6 tiles across the FOV — too low a pixel
     density for 256 px labels.
4. **Motion feel.** Linear-in-S easing (tap: 450 ms lerp; continuous: 0.18/frame lerp) over
   a 1→16384 range front-loads badly: it jumps then crawls. Needs log-space easing.
5. **Holes while streaming.** Zoom-band changes left new tiles empty with only the 25%
   hologram showing through; no parent-level fallback.
6. **Commit hygiene.** `075a909` bundled unrelated capture/upload scripts — flagged to the
   owner, not touched without approval. Top-down was still `?topdown=1`-gated with a known
   0–48° bearing error (no roll DOF in yaw/pitch).

Decisions locked in with the owner: tile source → CARTO `dark_nolabels` +
`dark_only_labels` @2x; posture → past country zoom the globe tilts down "like a table"
with a curved horizon and atmosphere glow.

### v2 approach (implementation contract and verification gates below)

- **A. Curvature-preserving zoom ("tiny planet" warp).** Decouple map scale `S` (drives
  tile zoom/text size) from the rendered sphere radius: `R_vis(S) = R0 · S^0.45` (capped
  ~6 m). Angular magnification `k = R0·S / R_vis` warps surface points around the focus
  (`earthWarpLocal`/`earthUnwarpLocal`, mirrored in GLSL via `onBeforeCompile`) so the map
  is pixel-accurate at the focus while the sphere's curvature stays visible (horizon
  falloff past ~100°, far side never drawn). At S=1, k=1 and R_vis=R0 — the legacy globe
  reproduces exactly.
- **B. Tilted "table" posture, quaternion pose.** Replace yaw/pitch with a quaternion
  `earthQuat` while zoomed; tilt ramps 0°→~55° over S∈[2,16] (map sits ~35° below eye
  level), full basis (normal + north tangent) so bearing is exact — resolves the 075a909
  0–48° bearing bug. Grab-pan rotates about the axis ⟂ (prevHit, curHit) so the grabbed
  point stays under the laser; `?topdown=1` retires as the new default zoomed-drag
  behavior; dock gets a `NORTH UP` reset.
- **C. Legible map:** CARTO @2x split into `base`/`labels` layers, composited client-side
  per tile slot (no CPU pixel loop), GPU shader tint toward holo cyan on the base only,
  mipmaps + anisotropic filtering for oblique legibility, `?earthstyle=raw` bisection kept.
- **D. Horizon LOD, no holes.** Multi-level visible set (ring 2 at `tileZ`, `tileZ−2`,
  `tileZ−4`), parent-tile UV-subrect fallback instead of the hologram linger, additive
  Fresnel atmosphere rim at `R_vis·1.03`.
- **E. Motion polish.** Log-space zoom easing, zoom-about-the-pointer, breadcrumb +
  scale-bar label.
- **F. Commit hygiene.** Capture/upload scripts in `075a909` flagged, not moved without
  owner approval.

This document is the repository source of truth for v2. The remaining-work plan below
supersedes conflicting v1 formulas, budgets, and interaction descriptions in §§1–12.
Those sections and the older progress log are historical context, not v2 acceptance evidence.

### v2 progress log

| Step | Status | Verification | Notes |
|---|---|---|---|
| 1. Server: layered tile routes + CARTO defaults | ✅ **done** (2026-10-02) | `pytest tests/test_map_tiles.py` 17/17 green | `server/routers/map_tiles.py`: `/api/reels/map-tiles/{layer}/{z}/{x}/{y}.png` with `layer ∈ {base, labels}`, legacy route aliases `base`; `SX_MAP_TILES_URL`/`SX_MAP_LABELS_URL` default to CARTO `dark_nolabels`/`dark_only_labels` @2x (`{s}` a–d rotation); disk cache keyed per layer + upstream-template hash (provider swap invalidates stale-style tiles); attribution → "© OpenStreetMap contributors © CARTO", `layers` field added to `/attribution` |
| 2. Client: dual-texture GPU tint, mipmaps/anisotropy, drop CPU restyle | ✅ **done** (2026-10-03, owner decision: GPU) | node 144/144 (R5 shader-string + coarse-base-only + sampling tests); headless-Chrome raw-vs-holo bisection captures | `installEarthTileShader`: base tinted in-shader (screen-lift + multiply-hue, `earth-tile-holo-v1`), labels sampled untinted by own alpha; canvas draws raw base only (size cap); `?earthstyle=raw` = strength 0. Coarse parent bands skip labels fetch (base-only). `applyEarthTileSampling` unchanged (mips + aniso ≤8, tile-only) |
| 3. Warp math (CPU) + GLSL + pins/heat/hit-test through the warp | ✅ **done** (2026-10-03) | warp-contract tests (derivative=k, monotonic, ≤1e-6 rad round-trip, S=1 identity); R2 coincidence test; headless-Chrome WebGL2 zero-error run (99/99 tiles live) | Half-angle `2·atan(k·tan(θ/2))` CPU+GLSL contract was already landed (plan's clamp note was stale); added `uEarthCapStart/End` uniforms (was hardcoded), `earth-half-angle-adaptive-v4`, `frustumCulled=false` on deformed meshes, overlay/hit coincidence across scales |
| 4. Quaternion pose, table tilt, grab-pan, north-up | ✅ **done** (2026-10-03, owner decision: `?topdown=1` alias) | tilt-ramp + alias-parity + hand-switch/antipode tests; dock suite 6/6 | `earthQuat` + North Up full-basis path kept; yaw/pitch remain legacy telemetry at S=1. Added: tilt endpoint/monotonic tests, alias-parity (flag off/on identical), controller-switch guard, antipodal-delta reject. Quat-authoritative core preserved via North Up guard |
| 5. Multi-level LOD, parent fallback, atmosphere rim | ✅ **done** (2026-10-03, owner decisions: wrap, 12-at-once, 128 MB) | quadrant-UV test, wrap + crossing-bbox tests (client + `test_map_activity.py`), memory-bound test, stale-slot test; live 99/99 | Dateline `x`-wrap in visible set + crossing `west>east` bbox (server `_parse_bbox`/`_in_bbox` wrap-aware); numbered-quadrant fallback UV fixture; ≤6 slots / ≤12 HTTP documented; 128 MB byte budget w/ LRU tiebreak + budget-hold parking (fallback covers, no churn); Fresnel rim spec (BackSide + depthTest, renderOrder 4, 1.03·Rvis) |
| 6. Log easing, zoom-about-pointer, breadcrumb/scale bar, HUD, docs | ✅ **done** (2026-10-03) | long-frame + miss-stability + truncation/license + bar-hide tests; full suite below | 100 ms dt clamp; miss keeps focus (documented stable-center); attribution + zoom-share reservation (never truncated); scale-bar UNAVAILABLE hide contract. Docs reconciled in R8 |
| 7. Verification evidence (2026-10-03) | ✅ automated + browser done; **headset blocked** | `node --check` ×2; node 144/144 + dock 6/6; pytest 190/190; vitest 13/13; `diff --check`; headless Chrome (SwiftShader WebGL2) globe + street + raw + orbit captures in `logs/`, harness + stub in `reports/` | Live S=512 Da Nang: band 12, 99/99 ready, 49 dual-label, 51.7 MB, 0 failures, 0 errors. **Blocked:** Quest HTTPS pass (`adb devices` empty, no hardware); comfort/frame-budget on device unmeasured — not claimed |
| 8. Warp-visibility fix (2026-10-03, owner review: warp smear + halos) | ✅ **done** | node 146/146 (ramp + stand-down tests); headless fix-vs-repro captures `logs/earth-fix2-*.png` | Root causes: full-k warp smeared the low-res base wherever tiles were absent (pre-tile zooms + offline), and heat rendered k× too big. (a) `earthEffectiveK`: exact globe at S≤2, log-blend to full k over S∈[2,4]; stands down to 1 whenever tiles are degraded/disabled (zoom then grows a clean globe; cap lifts so far side stays hittable; geometry keys + uniforms follow live). (b) Heat canvas radii + sprite scales divide by k_eff (hit-testing already geographic, unchanged). Owner screenshots also showed MAP OFFLINE with working activity ⇒ tile-upstream failure in their backend runtime, not client code: proxy + CARTO verified healthy live (`/attribution` 200 with `layers`, base/labels 200s, vite → :8000 correct). If it recurs: hard-reload, then `curl localhost:8000/api/reels/map-tiles/attribution` — no `layers` field means a pre-v2 backend is serving (restart uvicorn); `SX_MAP_TILES_ENABLED=0` or no outbound HTTPS to `*.basemaps.cartocdn.com` gives the same label |
| 9. Provider switch: keyless OSM default (2026-10-03, owner: still offline) | OK done | pytest 17/17 (rewritten defaults); node 147/147; live OSM tile viewed (Norwich/Haarlem labels); end-to-end headless vs fresh backend 99/99 + logs/earth-osm-real-orbit.png (Da Nang streets on the curved globe) | Root cause found in pixels: anonymous CARTO returns API KEY REQUIRED placeholders for every tile (verified dark_nolabels 200 + PNG text) - the v2 CARTO default could never show streets. Fix: DEFAULT_UPSTREAM back to keyless OSM standard (labels baked in); labels default empty = fast 404, client renders base-only via the tested nonfatal path; CARTO split layers opt-in with a keyed template. Attribution now dynamic (OSM-only unless a CARTO template is configured; client upgrades its HUD credit from /attribution). GPU tint deepened (EARTH_TILE_TINT_DEPTH 0.55) so light OSM raster lands steel-cyan, pixel-verified (132,170,182) in-headless. BE+FE restarted (both were stale: backend predated layered routes); owner tab needs a hard reload for the new bundle |
| Historical note | — | — | Steps 3–6 rows above dated 2026-10-02 described the pre-build partial state and are superseded by the 2026-10-03 rows. Original R0–R8 checklist (§below) is retained as the acceptance spec; all gates pass except the explicitly blocked headset gate |

---

## Remaining v2 implementation plan — ordered work and acceptance gates

### Scope, evidence, and execution rules

- Planning update: **2026-10-02**. No implementation completion is implied by this checklist.
- Latest independently executed review command: `node --test web/tests/webxr-earth.test.js`
  **120/120 passed**. Existing mocked tests do not prove shader compilation, visual
  alignment, true pointer anchoring, north-up accuracy, or headset performance.
- Backend 17/17 and older browser captures in the logs above are historical evidence;
  rerun relevant checks against the final v2 build. Do not combine historical counts
  into a new validation claim.
- Inspect the current diff before editing; preserve owner changes. No billing changes,
  unrelated VR roadmap work, automatic commits, or capture-script relocation.
- For Quest-specific API/device work, verify current authoritative Meta documentation
  first. Previous CLI verification did not complete; record unavailable tooling or
  access explicitly rather than claiming verification. Discover actual connected devices
  before any device commands. Generic CPU math and desktop browser tests are separate gates.
- Keep implementation and evidence resumable: for each R-step record files changed,
  exact commands/results, screenshots where relevant, unresolved issues, and next action.
  Status vocabulary: **pending → implemented → automated verified → browser verified →
  headset verified**. Mark complete only when its applicable gates pass.

### R0 — Establish reproducible baseline and audit the partial implementation

**Files:** `ui/assets/webxr_vr.js`, `ui/assets/vr_ui_canvas.js`,
`web/tests/webxr-earth.test.js`, `server/routers/map_tiles.py`, `tests/test_map_tiles.py`.

- [ ] Inventory every radius, scale, pose, forward/inverse geography, tile geometry,
  ray-hit, overlay, cleanup, and fetch-generation assumption. Trace mouse and XR paths.
- [ ] Verify actual THREE version/material chunks and existing browser-probe tooling;
  do not assume shader injection points or invent launch commands.
- [ ] Run Earth tests and baseline `make test`; record pre-existing failures separately.
- [ ] Capture the actual served asset/build identity to prevent stale-bundle verification.
- [ ] Audit current tile layer composition, parent/LOD code, atmosphere material, and
  pointer/drag paths before deciding which partial changes to retain.

**Exit:** a concrete call-site inventory and reproducible baseline; no unsupported
claims that existing helpers mean an end-to-end feature is complete.

### R1 — Define and test an invertible warp contract

**Files:** renderer math helpers and Earth tests. **Depends on:** R0.

Use `R0 = 0.676 m`, `S ∈ [1,16384]`, `Rvis = min(R0*S^0.45,6 m)`,
`k = R0*S/Rvis`. Keep geographic unit directions distinct from rendered unit directions.
The local derivative of angular magnification at the focus must equal `k`.

- [ ] Replace the present `atan(k*tan(min(theta,0.49π)))` clamp. It is not global identity
  at S=1 and collapses far-side geography into a near-side band.
- [ ] Recommended contract to implement/test: `theta' = 2*atan(k*tan(theta/2))`, inverse
  `theta = 2*atan(tan(theta'/2)/k)`. Prefer equivalent `atan2`/dot-product forms to avoid
  singular arithmetic. With `d = dot(f,n)`, a stable forward cosine is
  `d' = ((1+d)-k*k*(1-d))/((1+d)+k*k*(1-d))`; reconstruct the tangent robustly.
- [ ] Special-case identity S=1, focus, antipode, and degenerate tangents. No NaNs,
  arbitrary normalized zero vectors, angular folding, or invented antipode tangents.
- [ ] Separate math validity from visibility: identity globe is unrestricted at S=1;
  zoomed map uses a rendered cap with proposed soft fade 90°→100°. Define a continuous
  transition into cap clipping, and reject outside-cap interaction. The cap is not a
  substitute for camera backface/occlusion tests. Tune cap appearance only after R7.
- [ ] Lock tests for identity, focus invariance, monotonicity, round trips, local
  derivative, and finite results at every selected scale and geographic edge case.

**Exit:** one explicit CPU/GLSL contract; CPU round-trip angular error ≤1e-6 rad on
valid nondegenerate samples; identity holds over the full sphere, including far side.

### R2 — Integrate the warp across rendering, overlays, and hit-testing

**Files:** renderer, Earth tests, browser probe if needed. **Depends on:** R1.

- [ ] Apply matching GLSL math to base-globe material through actual supported shader
  chunks; update focus/k/cap uniforms as live state changes. Preserve base texture UVs
  in geographic space. Handle normals, cap fade/discard, material program caching, and
  reset/cleanup. CPU-reference comparisons alone do not prove GLSL execution.
- [ ] Choose exactly one deformation path per drawable: shader-deformed geographic
  geometry or CPU-deformed geometry, never both. Base-globe tessellation must resolve
  the shrinking source cap at maximum zoom; if it cannot, use a focus-local adaptive
  patch or another explicitly tested representation rather than trusting coarse triangles.
- [ ] Forward-warp pins, heat centers/extents, selection rings, and all surface anchors.
  Orient overlays to rendered surface normals; hold intended world sizes/offsets
  constant using Rvis, not S. Keep labels/previews outside globe scaling as appropriate.
- [ ] Raycast the actual visible sphere, select nearest valid positive hit, inverse
  rotate and inverse warp into geography. Reject hidden cap/back-side hits, then use
  geographic zone matching with zoom-aware hit radii. Audit +5 cm hit-shell parallax.
- [ ] Refresh geometry/uniforms on focus and scale changes even within the same tile
  band; protect asynchronously loaded tiles against stale pose/geometry generations.
- [ ] Fix bounding spheres/frustum culling for shader deformation. Audit maximum-zoom
  float precision and tile seams; use focus-local coordinates if required by measurements.

**Exit:** known geographic samples coincide across base, tiles, pins, heat, and hits;
real browser shaders compile with no errors; world-size variation ≤2% for fixed-size
pins; selected overlay centers hit their expected zones at every test scale.

### R3 — Make quaternion pose authoritative; finish tilt, North Up, and grab-pan

**Files:** renderer, `ui/assets/vr_ui_canvas.js`, Earth and relevant dock tests.
**Depends on:** R2.

- [ ] Preserve legacy globe rotation at S=1, but use a normalized quaternion as the
  authoritative zoomed pose; stop reconstructing away roll from yaw/pitch each frame.
- [ ] Derive geographic east/north from focus latitude/longitude. Map normal and north
  tangent to a right-handed table/view basis; define deterministic polar behavior.
- [ ] Ramp tilt smoothly 0°→55° over S=2→16 without changing the locked comfort anchor.
  Test that the viewer stays outside the sphere and the viewed surface faces the viewer.
- [ ] Wire `earth_north_up` to a visible **NORTH UP** Earth-only dock button. Reflow
  controls without collisions, test hit rectangles/visibility/dispatch, and leave reels
  controls unchanged. Keep north-up pose through subsequent frames and zoom changes.
- [ ] Implement grab-pan from ray/surface geometry and an anchored geographic grabbed
  point. Account for warp/translation, not just Euler deltas or an unwarped cross product.
  Normalize quaternion updates; handle misses, antipodal deltas, and controller changes.
- [ ] Make zoomed pan default; document whether `?topdown=1` is retained as a compatible
  alias or retired. Drag threshold/release must not trigger a tap or open feed.

**Exit:** north-bearing error ≤0.5° on nonpolar fixtures; deterministic poles; grab
anchor reprojection error ≤2 desktop pixels for valid hits; no jumps on release,
North Up, reset, scene exit, or rapid changes. Headset feel remains an R7 gate.

### R4 — Complete LOD coverage and true parent-tile fallback

**Files:** renderer tile scheduler/materializer/cache and Earth tests. **Depends on:** R2.

- [ ] Use ring-2 sets at z, z−2, z−4 as the starting budget, not a proof of coverage.
  Derive visible warped-cap coverage from camera/pose; deduplicate low zoom levels and
  handle Mercator limits, x wrapping, and dateline crossing. Polar regions outside
  Mercator coverage must deliberately use the base globe, not broken tile requests.
- [ ] For each missing fine tile, find the nearest ready ancestor at zp. For
  `q=2^(z-zp)`, ancestor coordinates are `floor(x/q), floor(y/q)` and subrect origin
  `(x mod q)/q, (y mod q)/q`, extent `1/q`. Verify the actual texture V orientation
  with a numbered-quadrant fixture; do not guess flipY semantics.
- [ ] Share ancestor textures without mutating shared UV state or double-disposing.
  Keep fallback until child readiness, then transition without blank frames. Parent
  base/labels must stay paired; label failures remain nonfatal.
- [ ] Avoid overlapping opaque coarse/fine surfaces: explicit coverage masks/patch
  ownership or verified depth ordering and transitions. Radius offsets alone are not
  accepted as a cure for z-fighting at oblique views.
- [ ] Prioritize visible/fallback work over prefetch; bound **HTTP requests**, not just
  tile slots (each pair can issue two requests). Start with ≤6 simultaneous requests.
- [ ] Recompute memory budget for 512² RGBA + mips (~1.33 MiB per composite texture),
  plus retained source layers, canvases, fallback and prefetch. Use a proposed ≤128 MiB
  tile-texture working budget, with explicit count/byte eviction; validate/tune on device.
- [ ] Preserve offline recovery, stale-generation cancellation, abort/disposal, cache
  adoption, attribution, `?earthmap=0`, and scene cleanup. Audit immutable URL/provider
  cache behavior: disk template hashes alone do not invalidate browser/edge caches;
  document purge requirements or add tested URL versioning if provider switching needs it.

**Exit:** quadrant/subrect tests pass; fine-tile failures retain geographic parent
coverage; no unintended holes or z-fighting within tiled coverage; bounded traffic and
memory; no retained tile resources after cleanup or repeated scene cycles.

### R5 — Finish legible tile styling and a real atmosphere rim

**Files:** renderer materials/composer and Earth/browser tests. **Depends on:** R2, R4.

- [ ] Resolve the step-2 mismatch explicitly: implement base-only GPU tint as originally
  planned, retaining separate untinted labels, OR record canvas compositing as an
  intentional accepted deviation after visual/performance evidence. Do not label canvas
  operations as shader tint. Do not restore per-pixel CPU restyling.
- [ ] Verify color space, label alpha, mipmap/filter settings, anisotropy availability,
  base-only fallback, raw-style bypass, and OSM/CARTO attribution in the actual renderer.
- [ ] Replace any uniformly additive shell with view-dependent Fresnel rim behavior at
  approximately 1.03*Rvis. Specify sidedness, depth test/write, opacity, cap handling,
  and render ordering. Avoid glow over label centers or through hidden globe surfaces.

**Exit:** labels remain readable without halos/shimmer; raw and styled comparisons
confirm label preservation; atmosphere is strongest at the limb, not a washed-out disk.

### R6 — Finish anchored motion, breadcrumb, and calibrated scale bar

**Files:** renderer/dock tests and docs. **Depends on:** R3–R5.

- [ ] Preserve log interpolation `exp(lerp(log(S0),log(S1),ease(t)))`; make continuous
  smoothing elapsed-time based, not frame-count based. Test 30/60/90 Hz equivalence,
  exact endpoints, reversals, cancellation, min/max clamping, and long-frame recovery.
- [ ] Before pointer zoom, capture geographic hit and target ray/screen point. Solve
  pose/translation each animation step so that point remains projected under pointer
  while enforcing outside-sphere and comfort constraints. Do not silently substitute
  focus-to-center zoom. Define a stable center fallback when the pointer misses.
- [ ] Verify identical behavior for mouse wheel and XR grip/stick; no focus reset mid
  gesture, no head-motion-following world anchor, no effect on reels input mappings.
- [ ] Show WORLD → location/region breadcrumb with zoom progress, North Up/reset access,
  offline status, and attribution. Prevent truncation from dropping critical information.
- [ ] Replace uncalibrated kilometre copy with a visible scale bar: inverse-project its
  surface endpoints and compute great-circle distance using Earth radius 6371 km.
  Pick a 1/2/5 nice distance and size the bar accordingly; show metres below 1 km.
  Hide/label unavailable when endpoints miss the valid surface. Normalize rendered units
  by R0 if using a local analytic approximation, and verify against the inverse geometry.

**Exit:** pointer anchor stays within 2 desktop pixels through valid zoom gestures;
scale distance agrees with endpoint geography within 2%; readable bar and breadcrumb
without collisions at supported panel sizes; no tap/drag/feed regressions.

### R7 — Extensive function, form, and performance verification

**Depends on:** each preceding implementation gate. Evidence goes in gitignored
`reports/` or `logs/`; reusable browser probes go in `scripts/` and are documented in
`scripts/README.md`. Inspect existing tooling before choosing browser commands.

| Dimension | Required fixtures / actions | Pass evidence |
|---|---|---|
| Warp/precision | S=1,2,4,8,16,64,256,512,4096,16384; focus, near focus, limb, antipode; equator, ±60°, poles, ±180° | New math tests, CPU/GLSL sampled agreement, no NaNs/folding, finite seam geometry |
| Rendering alignment | Known geographic markers over numbered tiles and real CARTO coast/city/street samples | Real WebGL compilation and captures; tiles, overlays and laser hits agree |
| Pose/input | North Up, reset, tap, drag/release, wheel, XR grip+stick, misses, pan across dateline, changing focus mid-animation | Assertions on bearing/anchor; interaction trace; no accidental feed opens |
| Streaming | Delay/fail base, fail labels, delay children, ancestor substitution, rapid z changes, offline→online | Network fixture tests; no stale tiles/holes; no uncontrolled refetch loops |
| Visual form | Globe/regional/city/street, raw/styled, face-on/table-oblique; dense labels, low-activity region, selected/hovered heat | Before/after screenshots at identical camera/viewport; readable text, curved horizon, subtle limb glow, no seams/z-fighting |
| HUD | Long names, offline label, attribution, North Up and scale bar | Full-panel captures and hit-rectangle tests; no overlap or clipped required copy |
| Lifecycle/budget | Repeated Earth↔reels transitions, reset during loads, canceled gestures; maximum zoom | Resource/request counters and trace; disposal, bounded texture bytes and concurrency |
| Privacy/regression | Clustering band/bbox/dateline, city privacy floor, open feed, Earth disabled, raw mode, reels controls | Existing and new tests pass; no precision leakage or unrelated behavior change |
| Headset | HTTPS build on an actually discovered Quest device; globe→street→globe and oblique pan/zoom | Recorded device/browser/build, screenshots, comfort observations and frame/memory measurements |

**Automated validation sequence:**
1. `node --check ui/assets/webxr_vr.js` and `node --check ui/assets/vr_ui_canvas.js`.
2. `node --test web/tests/webxr-earth.test.js`, plus discovered relevant dock tests.
3. `make test` (repository-supported backend/full web suite; never repo-wide pytest).
4. `git --no-pager diff --check`.
5. Run finite browser verification against the identified current build, recording shader
   errors, network fixture results, screenshots, and counters. Mock THREE tests cannot
   replace this step.

**Visual acceptance:** readable street names at normal viewing distance; recognizable
curvature/horizon in zoomed views; no pin/heat drift, flashing seams, flat glow wash,
clipped HUD, or accidental far-side selections. Review captures, not merely file existence.

**Headset acceptance:** no observed discomfort during repeated full zoom/pan/reset trips;
text/laser targets usable; scene stays within the measured device/browser frame budget.
Record refresh rate and p50/p95 frame timings, draw calls, memory estimates, and request
peaks. Do not invent a universal Quest FPS target or certify comfort from desktop emulation.
If hardware/access is unavailable, mark **headset gate blocked**, not done.

### R8 — Reconcile documentation and hand off for owner review

**Depends on:** R7 results (including explicit blocked gates).

- [ ] Update this progress table with actual per-step evidence and outstanding items;
  correct historical contradictions without rewriting historical test results.
- [ ] Update current architecture summary in `docs/threejs-vr-implementation-plan.md`
  and operator controls/provider flags in `RUNNING.md`; reconcile relevant beta/roadmap
  references only where this requested work changes their stated behavior.
- [ ] Document final warp/cap math, authoritative pose, tile coverage/fallback semantics,
  real request/memory budgets, scale bar, raw/disabled compatibility, and offline behavior.
- [ ] Document probe invocation, served build identification, validation limitations,
  intentional deviations (especially canvas vs GPU tint), and remaining device gates.
- [ ] Review the diff for accidental owner-work changes and unrelated scripts; provide
  owner a concise feature/evidence/blocker summary. **Do not commit automatically.**

### Remaining-work checklist summary

| Order | Deliverable | Initial state | Required completion gate |
|---|---|---|---|
| R0 | Baseline + code-path audit | pending | reproducible baseline and inventory |
| R1 | Invertible identity-safe warp contract | partial helpers | new numerical tests |
| R2 | Matching GLSL + overlay/hit integration | partial | numerical + real WebGL alignment |
| R3 | Quaternion/table/North Up/grab-pan | partial | bearing/anchor tests + UI/browser interaction |
| R4 | Coverage + parent subrect fallback + budgets | partial/unconfirmed | streaming fixtures + browser seams/resources |
| R5 | Styling decision + Fresnel atmosphere | partial | shader/material tests + visual comparison |
| R6 | Anchored zoom + calibrated HUD | partial | frame-rate/anchor/scale tests + browser interaction |
| R7 | Full function/form/device verification | pending beyond 120-test baseline | recorded tests, captures, measurements; blockers explicit |
| R8 | Current docs + owner handoff | this plan updated; rest pending | truthful evidence and owner review, no auto-commit |

---

## Historical v1 Progress Log (not v2 completion evidence)

| Phase | Status | Verification | Notes |
|---|---|---|---|
| Z0 tile proxy backend | ✅ **done** (2026-09-22) | `tests/test_map_tiles.py` 13/13 green; live app TestClient: attribution 200, bad-zoom 400, `earth-texture` still 200 | `server/routers/map_tiles.py` (new), registered in `server/app.py`. Env: `SX_MAP_TILES_ENABLED/URL/CACHE_DIR`. Header-safe `(C)` attribution (© breaks latin-1 header tooling); © kept in JSON route. Per-IP fetch budget counts upstream misses only |
| Z1 zoom state machine | ✅ **done** (2026-09-22) | node `webxr-earth.test.js` 90/90; full web 121/121 + vitest 13/13; pytest 171/171 | `ui/assets/webxr_vr.js` v8.18: `earthZoom 1→16384`, comfort anchor (focus surface pinned 1.15 m from head; group slides back), focus rotation solver (pitch clamped ±1.2, best-effort), tap dispatch (zoom below city band / select at it / zoom-point on open globe), grip+stickY + wheel zoom, dock `OPEN FEED`/`ZOOM OUT`/`GLOBE RESET` (earth-only, `isControlVisible` sceneMode param), pins counter-scale to constant world size, label/preview re-parented to scene root. **Mapping fix:** original plan formula `2.4·log2(S)+1` would need ~1000 visible tiles at street zoom; replaced with `tileZ = log2(S)+3.3` (constant ~4.6 tiles across the FOV → bounded 7×7 sets), `EARTH_ZOOM_MAX` 48→16384 so z17 street level is reachable. Cross-zoom max test updated |
| Z2 slippy tile layer | ✅ **done** (2026-09-22, pending on-device pass) | node 90/90 incl. Z2 mercator/geometry/visible-set/crossfade/materialize/degrade+recover; web 121/121; vitest 13/13 | Forked a compact tile layer into `webxr_vr.js` instead of vendoring `three-slippy-map-globe` (§7.1 fork clause): curved Mercator-correct sphere patches (8×8 segs, float32-safe), `tileGroup` child of `earthMesh`, same-origin `/api/reels/map-tiles/{z}/{x}/{y}.png` (Z0 proxy), 49-tile visible sets (ring 3) + LRU 140, ≤6 concurrent fetches, 150 ms re-plan throttle, crossfade band S∈[4,8] **gated by load progress** (base lingers ≥25% until tiles stream), offline degrade after 4 consecutive failures → `MAP OFFLINE — CITY VIEW` label + 5 s probe re-arm (transient loss heals), OSM attribution in the label whenever tiles are visible, `?earthmap=0` bisection flag. Server proxy Z0 unchanged |
| Z3 backend (zoom/bbox + privacy) | ✅ **done** (2026-09-22) | `tests/test_map_activity.py` green (14 tests: geohash vectors, precision bands, bbox, k-anonymity, no-leak) | `server/routers/reels.py`: `zoom`/`bbox` params, `_cluster_activity_rows` (cell-center centroids), city-row privacy floor at z≥12 |
| Z3 client code (§8.3, no tests yet) | ✅ **done** (2026-09-22) | code only — `node webxr-earth` 90/90 has zero Z3 coverage | `webxr_vr.js`: heat sprites (individual meshes ≤64, **not** InstancedMesh), band-tracked refetch (300 ms debounce, abort+generation), `zoom-cluster` tap dispatch, OPEN FEED drill-in, cluster label copy; `__test` seams exposed |
| Z3a client tests | ✅ **done** (2026-09-22) | `node webxr-earth` **101/101** (11 new Z3); pytest 185/185; vitest 13/13 | `web/tests/webxr-earth.test.js` `─── Z3` block: band mapping, 300 ms debounce (single timer), stale-generation drop + explicit abort assert, scene-exit drop, sprite rebuild/fade/hover-boost, `zoom-cluster` tap drill, OPEN FEED routing, cluster label copy, cleanup teardown. Deviations locked in: sprites are individual meshes ≤64 (not InstancedMesh/256); 3-step tint, not full `earthHeatStyle` ramp |
| Z3b geohash-extent sizing + bbox | ✅ **done** (2026-09-22) | `node webxr-earth` **104/104** (3 new); client cell centers bit-exact vs server (`ezs42`/`xn7m`/`ww8p`/`u4pr`); pytest 185/185; vitest 13/13 | `earthGeohashCellBounds/AngularRadius` + `max(cell, heat floor)` blend; `earthVisibleBbox()` (tile-set anchor/ring, dateline-clip safe) wired into `earthActivityUrl`. **Measured finding:** for all server-emitted precisions (2–5) the heat base dominates (p2 cell ≈ 0.1098 rad ≈ floor 0.11), so sizing is behavior-preserving — heat already covered every cell. Open follow-up (not started): city-row radius at street zoom (0.11–0.23 rad blobs swallow the ~0.015 rad view; empty-globe taps mis-hit) — needs a zoom-aware cap + on-device feel check |

| Z4a breadcrumb + idle prefetch (code) | ✅ **done** (2026-09-22) | `node webxr-earth` **107/107** (3 new Z4 + Z2 materialize updated for prefetch traffic); pytest 185/185; vitest 13/13; `emulate_webxr_session.cjs` success (session lifecycle; note: long-running dev browser served a stale cached v8.17 bundle — needs hard reload, unrelated to this change) | `earthZoomPercent` (log-scale 0–100) + `WORLD › NAME · %` titles via new `getEarthLabelTitle` seam (detail line + license suffix untouched); `maintainEarthTilePrefetch` side-cache (4 center children, idle-gated, silent errors, cleared on retire/degrade/flag-off/cleanup) adopted with zero refetch on zoom-in; `materializeEarthTile` shared builder (+ prefetch-race guard). Deliberately skipped: next-zoom cluster prefetch (payloads ≤128 rows; debounced band fetch is fast) |
| Z4b docs | ✅ **done** (2026-09-22) | — | §4.1 Earth Zoom Map summary, RUNNING.md env table (`SX_MAP_TILES_*`, `SX_MAP_MIN_CELL_REELS`, `?earthmap=0`), to-beta.md provider decision + Quest pass, todolist.md comfort entry |
| Intensive verification pass | ✅ **done** (2026-09-22) | pytest 185/185, node 109/109, vitest 13/13; 52 server probe checks + 30 client probe checks green; 4/4 mutations caught | Found + fixed **refetch starvation**: per-frame `scheduleEarthActivityRefetch` re-armed the 300 ms timer, so band fetches never fired while frames ran (cluster heat stuck at globe granularity in production) — now fires once per band entry + skips when settled back; 2 regression tests added (`webxr-earth.test.js`). Also removed a dead queue-push on failed prefetch adoption. Probe scripts live outside the repo (tmp); mutations applied + reverted, tree verified clean |
| On-device Quest pass | ⬜ pending (manual) | — | Z2 tile sharpness + Z4 comfort round trip; needs HTTPS/Quest Browser (see to-beta.md gate). Not committable from here |
| Review + commit | ⬜ pending (owner) | — | full uncommitted tree held for owner review per 2026-09-22 instruction; do not commit from agent sessions |
| Follow-up: zoom facing-sign fix | ✅ **done** (2026-09-22) | node 118/118 incl. strengthened facing/outside asserts; screenshot-verified (ball-in-front with tiles vs prior empty starfield) | `zoomEarthTo` aimed the focus outward normal ALONG the view axis, stranding the globe center behind the head (viewer inside the ball; map surface backface-culled → invisible in correct renderers). Now aims BACK along the axis (surface→head): center stays on the far side, viewer outside looking at the near wall head-on. Solver contract unchanged; Z1 solver test untouched |
| Experiment: top-down street view (`?topdown=1`) | ✅ **done, default off** (2026-09-22) | node 118/118 (5 new); live-Chrome pan verified (focus 139.65→130.68 grab-correct, release ≠ tap) | At city zoom+: drag pans focus (grab feel, axis-locked) + immediate exact re-face; per-frame tracking converges residual tilt; relaxed pitch clamp (2.9) for polar foci; tap/dispatch/cleanup untouched. Known limit: bearing 0–48° off north-up (needs roll DOF — structural, out of scope). Needs on-device feel check |
| Follow-up: hover-at-every-zoom fixes | ✅ **done** (2026-09-22) | node 121/121 (2 new); live-Chrome hover verified globe (zone 2, "98% HEAT") + street S=512 (zone 0, OSM label); pytest 185/185; vitest 13/13 | Three stacked causes: (1) cluster rows lacked `slug` → host preview/select guards returned early (fixed: slug aliases hottest member); (2) XR laser path never published hovered zones → new `updateEarthHoverFromRay` choke point shared by laser + mouse paths (camera-fallback ray drives visuals only, never clobbers hover); (3) hit-sphere 8%-of-radius inflation swallowed the head past S≈21 so rays exited far-side → absolute +5 cm shell; city-row radii attenuate past S=256 so street hover/tap stay precise |
| Follow-up: holographic tile restyle | ✅ **done** (2026-09-22, tuned 2026-09-22) | `node webxr-earth` **113/113**; pytest 185/185; vitest 13/13; real-tile visual check (z6 coast + z17 street labels legible) | OSM raster re-graded per-pixel into the globe palette at load (`earthHoloTileClass/Pixel`, composer with cyan edges, fresh canvas per tile, raw fallback, `?earthstyle=raw` bisection). Ink/paper classes keep street labels and roads legible on the dark ramp. **Tuning:** ink is uniformly bright `(200,240,255)` (threshold 0.5) after review showed ramped cores reading as black-text-on-white-border ringing — legibility over gradient continuity |

---

## 1. Goal & UX Vision

Today the VR earth is a 0.676 m holographic sphere with ~20 city heat zones and cone pins
(`ui/assets/webxr_vr.js`). It answers "where in the world is activity?" but nothing deeper.

Target experience (Snap Map × Google Earth, in VR):

1. User opens EARTH MAP → full globe with heat blobs (current behavior, unchanged).
2. User points at a heat blob / any point on the globe and **zooms** — the globe smoothly
   grows toward them (the user never moves; the world comes to the user).
3. Past a zoom threshold the holographic texture cross-fades into a **real basemap**
   (OpenStreetMap raster tiles draped on the sphere): countries → regions → cities →
   **street-level detail with real street names** (raster tiles include labels for free).
4. Heat overlay stays visible on top of the basemap at every zoom, getting **more
   granular as you zoom in** (Snap Map behavior: regional blobs split into
   neighborhood blobs).
5. At city zoom, tapping a zone keeps the current flow: preview billboard → accept →
   location feed plays in reels mode.

### What is realistically achievable

| Layer | Globe (z0–5) | Country (z5–8) | City (z9–13) | Street (z14–17) |
|---|---|---|---|---|
| Basemap detail | current canvas | tiles | tiles | tiles (street names) |
| Heat granularity | region clusters | sub-region | city + neighborhood* | city + neighborhood* |
| Selectable target | cluster (zoom-in) | cluster (zoom-in) | city feed | city feed / pack |

\* Neighborhood-level heat only when reels carry exact `lat/lon` metadata AND a
k-anonymity threshold is met (§8 Privacy). **Street-level *map* detail: yes.
Street-level *positions of individual reels/users*: no** — that is a deliberate privacy
decision, same as Snapchat (Snap blurs exact positions; heat is aggregate-only).

---

## 2. Current State (anchors)

- `ui/assets/webxr_vr.js` v8.17:
  - Constants: `EARTH_RADIUS 0.676`, `EARTH_MAP_W/H 2048×1024`, `EARTH_PIN_CAP 64` (l. 14–24).
  - Base texture: Natural Earth photo (`/assets/earth-natural-1024x512.jpg` →
    `/api/reels/earth-texture`) restyled per-pixel; procedural fallback always renders (l. 931–1046).
  - Heat zones painted onto the single equirect canvas (`paintHeatZones`, l. 1104–1152;
    `earthHeatStyle` ramp l. 915–928).
  - Pins: cone meshes at `locationToUnit(lat, lon)` (l. 1156–1185).
  - Hit test: CPU `raySphereHit` + angular-radius zone match, inverse-rotated so hover
    tracks the dragged globe (l. 1295–1343).
  - Drag machine: 280 ms hold / flick engage, single-axis lock, yaw `dx·1.7`, pitch
    `dy·2.24` clamp ±1.2 (l. 1345–1370).
  - Scene: `earthGroup` at `(0, 1.12, −1.3)`; label + preview billboards are **children
    of the group** (l. 1774–1852).
  - Data: `loadEarthActivity()` → `GET /api/reels/locations/activity?window_days=7&limit=128` (l. 3447–3472).
- `server/routers/reels.py`:
  - `/locations/activity` (l. 1773–1795) → privacy-safe **city centroids** with
    log-normalized `heat` (p95 denominator), `active_reel_count`, `new_reel_count`.
  - `/locations/{location_key}` (l. 1797+) → exact city feed (existing select target).
  - Reel metadata already supports optional `location.lat/lon/osm_id` (l. 957–963).
- `ui/assets/reels.html` (l. 5226–5241): host callbacks `onEarthOpen/onEarthClose/
  onPreviewLocation/onSelectLocation`.
- `ui/assets/vr_ui_canvas.js`: dock `CTRL_BUTTONS` incl. `EARTH MAP` (l. 57–58);
  earth preview canvas renderer.
- Tests: `web/tests/webxr-earth.test.js` (node:test + vm, mocked canvas/GL — the harness
  to extend). `make test` = `pytest -q tests` + `cd web && npm test`.
- three.js r186 vendored via esbuild: `web/src/vr/three_bundle_entry.js` →
  `ui/assets/three.min.js` (zero-CDN, offline-capable packaging — tiles are runtime
  *data*, handled with explicit degradation, §7.4).

---

## 3. Reference: How Snapchat's Snap Map Heatmap Works

From Snap's patent US11782574B2 ("Map-based graphical user interface indicating
geospatial activity metrics") and public reporting:

- **Signal**: density of snaps submitted to "Our Story" (public) per geographic
  "catchment area" — an aggregate count, never individual positions.
- **Color ramp**: blue (sparse) → yellow → orange → red (dense). Continuous ramp over a
  normalized per-region score.
- **Per-zoom recomputation**: heat is aggregated *at every zoom level*, so blobs resolve
  into finer blobs as you zoom in (country glow → city glow → neighborhood glow). This
  is the key mechanic to copy: **cluster granularity is a function of zoom**.
- **Exploration**: pinch-zoom into a blob; at close zoom, individual story thumbnails
  surface as circular icons at POIs (with jittered/fuzzy coordinates).
- **Privacy**: exact user positions are never rendered; heat is regional aggregation
  with thresholds (areas with too little activity show nothing).

Mapping to ECHO: our "Our Story submissions" = recent positive reel activity
(`_recent_activity_by_path`, already implemented with 48 h half-life). Our basemap =
OSM tiles (Snap uses Mapbox). Our heat ramp already exists (`earthHeatStyle`).

---

## 4. Architecture Overview

```
Quest browser (WebXR)
└─ webxr_vr.js  Earth Mode
   ├─ Zoom state machine      earthZoom 1 → 48, focus lat/lon, eased transitions
   ├─ Base globe (existing)   2048×1024 canvas, holographic style      [zoom < ~4]
   ├─ Tile layer (new)        slippy-map quadtree on sphere, OSM tiles [zoom ≥ ~4, crossfade]
   ├─ Heat sprites (new)      instanced radial-gradient quads, angular size [zoom ≥ ~6]
   ├─ Pins/clusters (adapted) counter-scaled, zoom-aware clustering
   └─ Label/preview/dock      moved out of scaled group (world-anchored)
        │ HTTPS (same origin, Cloudflare edge cache in front)
        ▼
FastAPI backend
   ├─ GET /api/reels/locations/activity  + ?zoom=&bbox=  → zoom-clustered heat rows
   └─ GET /api/reels/map-tiles/{z}/{x}/{y}.png  → disk-cached proxy → OSM (or configured provider)
```

---

## 5. Phase Z0 — Tile Proxy Backend (server-only, no client risk)

New file `server/routers/map_tiles.py` (auto-registered by `server/app.py` router scan, l. 110).

**Route**: `GET /api/reels/map-tiles/{z}/{x}/{y}.png`

- Validate: `0 ≤ z ≤ MAX_Z` (default 17), `0 ≤ x,y < 2^z`; else 400.
- Config (mirror `os.environ.get("SX_…")` pattern from `server/social/auth.py`):
  - `SX_MAP_TILES_URL` — upstream template, default `https://tile.openstreetmap.org/{z}/{x}/{y}.png`.
  - `SX_MAP_TILES_CACHE_DIR` — default `data/map_tiles/` (gitignored).
  - `SX_MAP_TILES_ENABLED` — default `1`; `0` → 404 (client falls back to holographic globe).
- Cache: check disk first; on miss fetch upstream with a policy-compliant
  `User-Agent: EchoVR/1.0 (<contact>)` (OSM tile-usage policy requirement), 5 s timeout,
  store atomically (tmp + rename), serve `FileResponse` with
  `Cache-Control: public, max-age=604800, immutable`. Tiles are immutable → edge caching
  via Cloudflare (topology already decided in `docs/to-beta.md`) makes repeat zooms free.
- Upstream failures → 502 with short `Retry-After`; **never 500** (globe must always render —
  same contract as `/earth-texture`).
- Response header `X-Map-Attribution: © OpenStreetMap contributors` + a
  `GET /api/reels/map-tiles/attribution` JSON route for the client to render attribution.
- Tests: `tests/test_map_tiles.py` — validation bounds, cache hit/miss (mock upstream via
  `httpx.MockTransport` or monkeypatched fetch fn), disabled flag, upstream-failure 502.

**Cost**: $0 at beta scale with disk + edge caching. Pre-launch decision (add to
`docs/to-beta.md` checklist): stay on OSM policy limits vs. MapTiler/Mapbox key
(`SX_MAP_TILES_URL` swap, no code change).


---

## 6. Phase Z1 — Zoom State Machine & Interaction (no tiles yet)

All in `ui/assets/webxr_vr.js` unless noted. This phase alone ships "hover a zone →
globe grows until the zone fills your view" with the existing canvas/heat look.

### 6.1 Zoom state

```js
let earthZoom = 1;            // 1 = full globe … EARTH_ZOOM_MAX (48)
let earthZoomTarget = 1;      // eased toward each frame (cubic-out, ~450 ms)
let earthFocus = null;        // {lat, lon} the zoom is centered on, null = current view axis
let earthZoomAnim = null;     // {t0, fromZoom, toZoom, fromYaw/Pitch, toYaw/Pitch}
```

- Scale mapping: `S = earthZoom`; globe world radius `= EARTH_RADIUS * S`.
- **Comfort anchor**: keep the surface point facing the user at a fixed ~0.9–1.3 m:
  reposition `earthGroup` each frame so `distance(head, focusSurfacePoint) =
  SURFACE_DIST`. The globe center slides back along the focus normal as it grows —
  reads as "zooming into a map", never as "a ball flying at your face".
  `reducedMotion` → instant jumps (existing flag, l. 42).
- Zoom→tile-level mapping (drives Z2 and Z3):
  `tileZ = clamp(round(2.4 * log2(S) + 1), 0, 17)` → S=1→z1, S=4→z6, S=16→z11 (city),
  S=48→z14/15 (street). Tunable constant; expose in `__test` surface.

### 6.2 Focus rotation

Zooming to `{lat, lon}` animates `earthYaw/earthPitch` so the target faces the camera
(solve yaw/pitch from `locationToUnit` — inverse of the existing forward mapping),
composited with the scale ease in one `earthZoomAnim`. Manual drag during an animation
cancels it (existing drag machine already edge-triggers).

### 6.3 Controls (earth mode only; reels-mode mapping untouched)

Current earth-mode bindings: hold-drag = rotate, stick = rotate, B = dock toggle,
trigger tap on zone = select feed. Proposed additions:

| Input | Action | Conflict check |
|---|---|---|
| **Grip + stickY** | continuous zoom in/out (0.04/frame, same feel as screen scale) | grip+stickY is reels screen-scale; free in earth mode — verify in `processXRInput` |
| **Trigger tap on zone** (zoom < city band) | zoom into that zone (Snap pinch equivalent) | changes current tap=select; select moves to city band (below) |
| **Trigger tap on zone** (zoom ≥ city band) | current select flow (preview → accept → feed) | unchanged at depth |
| **Trigger tap on empty globe** | zoom in one step centered on hit point | new |
| **Dock buttons** (vr_ui_canvas.js `CTRL_BUTTONS`) | `ZOOM −`, `GLOBE ⟲` (reset to S=1), `OPEN FEED` (when zone selected) | dock re-stations in earth mode already |
| Desktop preview | wheel = zoom, drag = rotate | OrbitControls pinch coexists; headset-POV maps wheel to `earthZoom` |

Tap-vs-zoom disambiguation reuses the tremor-immune tap detector (distance-from-press,
`EARTH_TAP_CHORD 0.06`) — no new gesture recognition needed.

### 6.4 Counter-scaling children

Pins, label, preview billboard currently inherit group scale. At S=16 a 7 cm pin would be
a 1.1 m cone. Fix: per-frame (or per zoom-change) set `pin.scale.setScalar(baseScale / S)`
and **move `earthLabelMesh` + `earthPreviewMesh` out of `earthGroup` to the scene root**
(they are billboarded to the viewer anyway — positions become world-anchored next to the
docked controls, same station they already use).

### 6.5 Zoom band behavior without tiles

Cap this phase at `EARTH_ZOOM_MAX_TILELESS = 8` (the 2048 px canvas stays legible to
~country scale). Heat zones already shrink visually as the globe grows (canvas texels
stretch) — acceptable to z≈6; Z3 replaces them with sprites past that.

### 6.6 Tests (extend `web/tests/webxr-earth.test.js`)

Zoom ease math, focus-rotation solver (target faces camera after animation),
comfort-anchor distance invariant, counter-scale invariant (`pinWorldSize` constant
across S), tap-at-low-zoom→zoom vs tap-at-city-band→select dispatch, animation cancel on
drag, reduced-motion instant jump, `cleanup()` resets the full zoom machine (mirror the
existing drag-machine teardown test).


---

## 7. Phase Z2 — Slippy-Map Tile Layer (the Google-Maps part)

### 7.1 Library choice

Vendor **`three-slippy-map-globe`** (MIT, zero deps beyond three, ~8 KB src) into the
esbuild bundle: add to `web/src/vr/three_bundle_entry.js` exports, rebuild
`ui/assets/three.min.js` (keeps zero-CDN packaging). It renders a quadtree of raster
tiles on a sphere, `tileUrl: (x, y, l) => …`, `minZoom 0 / maxZoom 17`,
manual `level` override, `clearTiles()`.

**Spike first (½ day)**: the library's automatic zoom uses `updatePov(camera)` camera
proximity in *its own* frame. We drive zoom from our state machine while the group is
scaled/rotated, so: set `.level` manually from `tileZ` (§6.1) and feed `updatePov()` a
**synthetic camera** placed along the focus normal at the matching proximity, in the
tile-globe's local frame. If the internals resist, fork the ~300-line module into
`web/src/vr/slippy_globe.js` (it is small; a quadtree tile layer is well-understood).

### 7.2 Integration

- Tile globe = second sphere mesh, radius `EARTH_RADIUS * 1.001` (avoid z-fighting),
  inside `earthGroup` so it inherits yaw/pitch/scale for free.
- `tileUrl` → same-origin `/api/reels/map-tiles/{z}/{x}/{y}.png` (dev vite proxy → :8000
  already used by other `/api` calls).
- **Crossfade band** S ∈ [4, 8]: base canvas opacity 1→0, tile layer 0→1
  (`transparent` materials, one scalar uniform per frame — cheap). Below the band the
  holographic look is the identity; above it, real geography.
- Graticule/scanline overlay stays on top at low opacity until S≈8 (brand continuity).
- **Attribution**: `© OpenStreetMap contributors` line added to the earth label canvas
  whenever the tile layer is visible (license requirement, not optional).

### 7.3 Quest performance budget

- Visible tile meshes cap ≈ 64; each 256² RGBA ≈ 256 KB GPU → ≤ 16 MB. Fine.
- Concurrent tile fetches ≤ 6; in-memory LRU ≈ 256 tiles; prefetch the 4 children of the
  focused tile one level down during idle frames.
- Draw-call gating already zeroes earth draws in reels mode and pauses video uploads in
  earth mode — tiles only ever render with the video decoder idle.
- New debug flag following the existing pattern: `?earthmap=0` disables the tile layer
  for on-device bisection (alongside `?lock=0`, `?overlay=0`, …).

### 7.4 Offline / airgapped degradation

Tile fetch fails or `SX_MAP_TILES_ENABLED=0` → tile layer hides, crossfade never starts,
zoom keeps working on the holographic canvas (Z1 behavior), label shows
`MAP OFFLINE — CITY VIEW`. Zero uncaught paths; mirrors the `/earth-texture`
fallback contract.


---

## 8. Phase Z3 — Zoom-Aware Heat Clustering (Snap mechanic)

### 8.1 Backend: extend `/api/reels/locations/activity`

Add optional `zoom` (0–17) and `bbox=w,s,e,n` params to the existing route
(`server/routers/reels.py` l. 1773 — same handler, backward compatible: no `zoom` =
current response verbatim).

- Cluster key = geohash of each reel's location, prefix length by zoom:
  z0–2 → precision 1–2 (continent), z3–5 → 3 (country), z6–8 → 4 (region),
  z9–11 → 5 (city), z≥12 → existing city rows unchanged.
- Each cluster row: `{kind: 'cluster', geohash, lat, lon (centroid), heat,
  active_reel_count, location_count, sample_names[:3]}`. Heat = existing
  log1p/p95 normalization computed **within the bbox result set** (Snap's per-zoom
  renormalization).
- `bbox` filter before clustering so payloads stay small at high zoom.
- Reuse `_activity_decay` / `_recent_activity_by_path` unchanged.

### 8.2 Privacy guardrails (hard requirements)

- **Never** return reel-level or user-level coordinates; cluster centroids only.
- K-anonymity: sub-city cells (geohash ≥ 6, only possible when reels carry exact
  `lat/lon`) are suppressed unless `active_reel_count ≥ SX_MAP_MIN_CELL_REELS`
  (default 3). City-level rows keep current behavior (they are already city centroids).
- Centroid jitter: round cluster centroids to the geohash cell center, not the raw mean.
- Document in the route docstring; tests in `tests/test_reels_discovery.py` style
  (extend or new `tests/test_map_activity.py`): suppression below k, cell-center
  rounding, no `rel_path`/user fields leak in rows.

### 8.3 Client: heat sprites + cluster navigation

- Replace canvas-painted heat with **instanced heat sprites** once S ≥ 6: one quad per
  cluster, oriented tangent to the sphere at the cluster normal, angular size from
  geohash cell size (so blobs cover their true geographic extent at any zoom), additive
  blending, color from the existing `earthHeatStyle` ramp (blue-cyan → amber → red,
  state rings for hover/selected). `THREE.InstancedMesh` + custom shader or per-instance
  color; cap 256 instances. Canvas heat (S < 6) stays for the globe identity.
- Pin builder switches data source by zoom: clusters (low z) vs cities (high z);
  cluster pins show `location_count` in the hover label (`PARIS REGION · 6 CITIES · 82% HEAT`).
- Tap dispatch (§6.3): `kind=cluster` → zoom to cluster; `kind=city` at city band →
  existing `selectEarthLocation` → feed.
- Refetch on zoom-band change only (debounced 300 ms, generation-guarded like
  `earthActivityGeneration`, abortable like `earthActivityAbort`).

---

## 9. Phase Z4 — Polish, Comfort, Docs

- **Comfort**: all motion is object-motion (globe), never camera-motion; eased ≤ 500 ms;
  `reducedMotion` instant. On-device comfort check joins the existing Quest checklist in
  `docs/todolist.md` (earth tap/drag entry).
- **Breadcrumb label**: `WORLD › SE ASIA › DA NANG` + zoom % in the earth label canvas.
- **Idle prefetch**: after any zoom settles, prefetch child tiles + next-zoom clusters.
- **Docs**: update §4.1 of `docs/threejs-vr-implementation-plan.md`; env flags in
  `RUNNING.md`; if a debug/verify probe is added (e.g. `scripts/verify_map_tiles.cjs`),
  register it in `scripts/README.md` per AGENTS.md.
- **Verification**: extend `web/tests/webxr-earth.test.js` (Z1/Z3 math), pytest for Z0/Z3
  routes, `scripts/emulate_webxr_session.cjs` for the click-path, then manual Quest pass.


---

## 10. File Touch List

| File | Change | Phase |
|---|---|---|
| `server/routers/map_tiles.py` | **new** — tile proxy + attribution | Z0 |
| `tests/test_map_tiles.py` | **new** — proxy tests | Z0 |
| `ui/assets/webxr_vr.js` | zoom state machine, focus solver, counter-scaling, tile layer, heat sprites, control bindings | Z1–Z3 |
| `ui/assets/vr_ui_canvas.js` | `ZOOM −` / `GLOBE ⟲` / `OPEN FEED` dock buttons, attribution line, breadcrumb label | Z1/Z4 |
| `web/src/vr/three_bundle_entry.js` | export vendored slippy-map module; rebuild `three.min.js` | Z2 |
| `server/routers/reels.py` | `zoom`/`bbox` params + clustering on `/locations/activity` | Z3 |
| `tests/test_map_activity.py` | **new** — clustering + privacy tests | Z3 |
| `web/tests/webxr-earth.test.js` | extend for all client math | Z1–Z3 |
| `ui/assets/reels.html` | host callback surface only if cluster-tap needs it (aim: none) | Z3 |
| `docs/threejs-vr-implementation-plan.md`, `RUNNING.md` | doc updates | Z4 |

## 11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| OSM tile-policy abuse | Same-origin proxy + disk cache + Cloudflare edge cache; compliant UA; `SX_MAP_TILES_URL` swap to a paid provider pre-launch (decision logged in `docs/to-beta.md`) |
| Offline/airgapped Quest breaks | Tile layer is additive; full Z1 experience works with zero network (§7.4) |
| Library zoom math fights our scaled group | Manual `.level` + synthetic-POV camera; fork the small module if needed (§7.1) |
| Quest GPU/texture pressure | 64-tile cap, LRU, fetch ≤ 6 concurrent, earth-only draw calls (§7.3) |
| Privacy regression from finer heat | K-anonymity + cell-center rounding + no raw coords; tests enforce (§8.2) |
| Tap-to-zoom vs tap-to-select confusion | Zoom-band dispatch + `OPEN FEED` dock button; on-device feel check added to the existing Quest checklist |

## 12. Suggested Build Order

1. **Z0** (½–1 day) — pure backend, independently shippable.
2. **Z1** (1–2 days) — the wow moment; no new dependencies.
3. **Z2** (1–2 days incl. spike) — real map detail to street level.
4. **Z3** (1–2 days) — Snap-style granular heat.
5. **Z4** (½–1 day) — polish + docs + Quest pass.

Each phase is demoable on its own and leaves `make test` green.

---

## 13. Earth Zoom V3 Implementation & Verification

The v2 map zoom architecture underwent a comprehensive review and v3 upgrade (see [earth-zoom-v3-plan.md](file:///Users/hoangleduc/Documents/[ez]/Coding/VR%20Tiktok/videoextendersquare/docs/earth-zoom-v3-plan.md)):
1. **Full-Globe Drag Fix**: Resolved pointer drag direction unwrapping in `updateEarthDrag` so full-globe rotation is preserved at $S=1$.
2. **Network Resilience & Offline Tripwire Fix**: Raised consecutive failure tripwire to 8 and upstream timeout to 10s. Wheel zoom no longer triggers spurious "MAP OFFLINE" events.
3. **LOD Z-Fighting Elimination**: Coarse fallback parent tiles assigned `renderOrder = 1` and $0.2\text{ mm}$ inward offset, while fine child tiles render at `renderOrder = 2`, preventing blurry ancestor tiles from rendering over sharp street maps.
4. **BufferGeometry Churn Elimination**: Added 50ms interval clamping to tile geometry updates in `updateEarthTiles`, eliminating ~6,000 BufferGeometries/sec churn during active zoom.
5. **Architectural Tabletop Pan & Orbit Reset**: Verified smooth $55^\circ$ table tilt posture at street zoom ($S=512$, $z=12$), tabletop grab-pan, and clean reset back to full orbital globe view with post-reset drag responsiveness.
6. **Full Test Suite & Live CDP Probes Green**: 185 web node tests + 13 vitest tests passing; 190 backend pytest tests passing; live headless Chrome probe passing with visual evidence in `logs/debug-earth-danang-screenshot.png` and `logs/debug-earth-reset-screenshot.png`.

