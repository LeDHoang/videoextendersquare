# Earth Zoom Map Plan — Google-Maps-Style Zoom for the VR Globe

Status: **implementation complete 2026-09-22** — all of Z0–Z4 coded, tested (`make test` green), and documented; pending the manual on-device Quest pass and owner review/commit (uncommitted tree held per instruction).
Supersedes nothing; extends the Earth View Subsystem (§4.1 of
`docs/threejs-vr-implementation-plan.md`).
Aligns with `docs/todolist.md` items "Open city/event Packs directly from Earth while
retaining city-level location privacy" and "Pilot travel, restaurant, and city packs
connected to Earth".

## Progress Log (updated per phase — resume here after a crash)

| Phase | Status | Verification | Notes |
|---|---|---|---|
| Z0 tile proxy backend | ✅ **done** (2026-09-22) | `tests/test_map_tiles.py` 13/13 green; live app TestClient: attribution 200, bad-zoom 400, `earth-texture` still 200 | `server/routers/map_tiles.py` (new), registered in `server/app.py`. Env: `SX_MAP_TILES_ENABLED/URL/CACHE_DIR`. Header-safe `(C)` attribution (© breaks latin-1 header tooling); © kept in JSON route. Per-IP fetch budget counts upstream misses only |
| Z1 zoom state machine | ✅ **done** (2026-09-22) | node `webxr-earth.test.js` 90/90; full web 121/121 + vitest 13/13; pytest 171/171 | `ui/assets/webxr_vr.js` v8.18: `earthZoom 1→16384`, comfort anchor (focus surface pinned 1.15 m from head; group slides back), focus rotation solver (pitch clamped ±1.2, best-effort), tap dispatch (zoom below city band / select at it / zoom-point on open globe), grip+stickY + wheel zoom, dock `OPEN FEED`/`ZOOM OUT`/`GLOBE RESET` (earth-only, `isControlVisible` sceneMode param), pins counter-scale to constant world size, label/preview re-parented to scene root. **Mapping fix:** original plan formula `2.4·log2(S)+1` would need ~1000 visible tiles at street zoom; replaced with `tileZ = log2(S)+3.3` (constant ~4.6 tiles across the FOV → bounded 7×7 sets), `EARTH_ZOOM_MAX` 48→16384 so z17 street level is reachable. Cross-zoom max test updated |
| Z2 slippy tile layer | ✅ **done** (2026-09-22, pending on-device pass) | node 90/90 incl. Z2 mercator/geometry/visible-set/crossfade/materialize/degrade+recover; web 121/121; vitest 13/13 | Forked a compact tile layer into `webxr_vr.js` instead of vendoring `three-slippy-map-globe` (§7.1 fork clause): curved Mercator-correct sphere patches (8×8 segs, float32-safe), `tileGroup` child of `earthMesh`, same-origin `/api/reels/map-tiles/{z}/{x}/{y}.png` (Z0 proxy), 49-tile visible sets (ring 3) + LRU 140, ≤6 concurrent fetches, 150 ms re-plan throttle, crossfade band S∈[4,8] **gated by load progress** (base lingers ≥25% until tiles stream), offline degrade after 4 consecutive failures → `MAP OFFLINE — CITY VIEW` label + 5 s probe re-arm (transient loss heals), OSM attribution in the label whenever tiles are visible, `?earthmap=0` bisection flag. Server proxy Z0 unchanged |
| Z3 backend (zoom/bbox + privacy) | ✅ **done** (2026-09-22) | `tests/test_map_activity.py` green (14 tests: geohash vectors, precision bands, bbox, k-anonymity, no-leak) | `server/routers/reels.py`: `zoom`/`bbox` params, `_cluster_activity_rows` (cell-center centroids), city-row privacy floor at z≥12 |
| Z3 client code (§8.3, no tests yet) | ✅ **done** (2026-09-22) | code only — `node webxr-earth` 90/90 has zero Z3 coverage | `webxr_vr.js`: heat sprites (individual meshes ≤64, **not** InstancedMesh), band-tracked refetch (300 ms debounce, abort+generation), `zoom-cluster` tap dispatch, OPEN FEED drill-in, cluster label copy; `__test` seams exposed |
| Z3a client tests | ✅ **done** (2026-09-22) | `node webxr-earth` **101/101** (11 new Z3); pytest 185/185; vitest 13/13 | `web/tests/webxr-earth.test.js` `─── Z3` block: band mapping, 300 ms debounce (single timer), stale-generation drop + explicit abort assert, scene-exit drop, sprite rebuild/fade/hover-boost, `zoom-cluster` tap drill, OPEN FEED routing, cluster label copy, cleanup teardown. Deviations locked in: sprites are individual meshes ≤64 (not InstancedMesh/256); 3-step tint, not full `earthHeatStyle` ramp |
| Z3b geohash-extent sizing + bbox | ✅ **done** (2026-09-22) | `node webxr-earth` **104/104** (3 new); client cell centers bit-exact vs server (`ezs42`/`xn7m`/`ww8p`/`u4pr`); pytest 185/185; vitest 13/13 | `earthGeohashCellBounds/AngularRadius` + `max(cell, heat floor)` blend; `earthVisibleBbox()` (tile-set anchor/ring, dateline-clip safe) wired into `earthActivityUrl`. **Measured finding:** for all server-emitted precisions (2–5) the heat base dominates (p2 cell ≈ 0.1098 rad ≈ floor 0.11), so sizing is behavior-preserving — heat already covered every cell. Open follow-up (not started): city-row radius at street zoom (0.11–0.23 rad blobs swallow the ~0.015 rad view; empty-globe taps mis-hit) — needs a zoom-aware cap + on-device feel check |
| Z3b geohash-extent sizing + bbox | ⬜ pending | — | `earthZoneAngularRadius`: `max(cell extent, 0.11 floor)` for clusters; `earthVisibleBbox()` → `&bbox=` in tile band |
| Z4a breadcrumb + idle prefetch (code) | ✅ **done** (2026-09-22) | `node webxr-earth` **107/107** (3 new Z4 + Z2 materialize updated for prefetch traffic); pytest 185/185; vitest 13/13; `emulate_webxr_session.cjs` success (session lifecycle; note: long-running dev browser served a stale cached v8.17 bundle — needs hard reload, unrelated to this change) | `earthZoomPercent` (log-scale 0–100) + `WORLD › NAME · %` titles via new `getEarthLabelTitle` seam (detail line + license suffix untouched); `maintainEarthTilePrefetch` side-cache (4 center children, idle-gated, silent errors, cleared on retire/degrade/flag-off/cleanup) adopted with zero refetch on zoom-in; `materializeEarthTile` shared builder (+ prefetch-race guard). Deliberately skipped: next-zoom cluster prefetch (payloads ≤128 rows; debounced band fetch is fast) |
| Z4b docs | ✅ **done** (2026-09-22) | — | §4.1 Earth Zoom Map summary, RUNNING.md env table (`SX_MAP_TILES_*`, `SX_MAP_MIN_CELL_REELS`, `?earthmap=0`), to-beta.md provider decision + Quest pass, todolist.md comfort entry |
| Intensive verification pass | ✅ **done** (2026-09-22) | pytest 185/185, node 109/109, vitest 13/13; 52 server probe checks + 30 client probe checks green; 4/4 mutations caught | Found + fixed **refetch starvation**: per-frame `scheduleEarthActivityRefetch` re-armed the 300 ms timer, so band fetches never fired while frames ran (cluster heat stuck at globe granularity in production) — now fires once per band entry + skips when settled back; 2 regression tests added (`webxr-earth.test.js`). Also removed a dead queue-push on failed prefetch adoption. Probe scripts live outside the repo (tmp); mutations applied + reverted, tree verified clean |
| On-device Quest pass | ⬜ pending (manual) | — | Z2 tile sharpness + Z4 comfort round trip; needs HTTPS/Quest Browser (see to-beta.md gate). Not committable from here |
| Review + commit | ⬜ pending (owner) | — | full uncommitted tree held for owner review per 2026-09-22 instruction; do not commit from agent sessions |
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

