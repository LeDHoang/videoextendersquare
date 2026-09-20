# VR Black-Square Glitches — Investigation Record (Quest 3, Three.js engine v8.3 → v8.10)

> Living document: every observed data point, every eliminated hypothesis, and every
> fix attempted for the in-headset black square/rectangle glitches, with the evidence
> that decided each step. Companion to `docs/vr-reels-playback-investigation.md`
> (the earlier choppiness/bitrate investigation — different symptoms, same device class).

> **Current status (2026-09-20)**: engine `v8.10-20260920-firstframe-hold`. All GL-side
> paths exonerated by flags + telemetry. Active theory: decoder resync garbage in the
> first frames after src-swaps (fixed by holding for `HAVE_FUTURE_DATA`). Awaiting
> on-device confirmation of v8.9/v8.10 + the `?domoverlay=0` compositor test.

**Hardware**: Meta Quest 3 (Snapdragon XR2 Gen 2 / Adreno 740), 90 Hz compositor.
**Method**: in-headset observation + `GET /api/reels/diag` (~1 Hz XR telemetry POSTed
from the render loop while presenting) watched live from the host during test runs.
**Reload discipline**: full tab close + reopen between builds (the player inlines
`webxr_vr.js` per request; soft reloads inside XR keep stale code).

---

## 1. Symptom history

| # | Report | Resolution / evolution |
|---|---|---|
| 1 | Reels window not perpendicular / too small, no size/distance control in VR | Fixed v8.3 (lock-to-viewer, grip+stick scale/distance) |
| 2 | LOCK button changes nothing | Fixed v8.3 (per-frame lock application) |
| 3 | AUTO button never shows LOOP | Fixed v8.3 (live `getAutoNext()` labels) |
| 4 | No popup comments left of player | Fixed v8.3 (overlay quad + click-to-open) |
| 5 | Comments panel wrong side + dead, guide panel missing | Fixed v8.3 (panel LEFT + interaction, guide RIGHT) |
| 6 | **Panels behind/overlaid by the reels window** (on-device v8.3) | Fixed v8.4 (paint-order ladder; tandem rig reverted to legacy-exact lock in v8.5 per owner) |
| 7 | **Controller photo missing from guide** (on-device v8.3) | Fixed v8.4 (asset + plumbing were intact; consumer restored) |
| 8 | **Black squares/shapes in VR** (on-device v8.3) | → this investigation (v8.4–v8.10) |
| 9 | **Panel text softer than legacy** (on-device v8.3) | Fixed v8.4 (legacy `LINEAR`/no-mipmap sampling) |
| 10 | Laser highlight ≠ click target; reticle half-circle (on-device v8.5) | Fixed v8.6 (right-preferred stored ray; depth-free reticle + 0.02 m pullback) |

---

## 2. Black squares — observed facts (owner-reported, in-headset)

- **Shape/location**: square or rectangular, mostly left side, left-bottom quartile of the screen.
- **Timing**: mostly at the beginning of reels and during rapid prev/next switching; **absent when looping the same reel**.
- **Duration**: too fast to screenshot.
- **Shrink test**: grip+stick shrink the screen, then switch — squares stay the **same size** (done correctly: shrink-then-switch, not shrink-during-steady).
- **Bitrate test**: no difference between high-bitrate (King Von 28.8 Mbps) and starved (Travis 5.8 Mbps) masters.
- **Panel state**: panels closed during tests; squares not noticed with the comments panel open.
- **Modes**: feed mode (pack mode is the same playlist path in VR — no difference).
- **v8.9 partial fix (owner-confirmed)**: freeze-then-cut works — no squares *between* hard switches — but the **first few frames of each new reel still show squares**.

---

## 3. Live telemetry captures

All captures via `curl http://localhost:8000/api/reels/diag` while presenting.
Fields: `xrFrames` (frames/s), `dtMaxMs` (worst frame interval that second),
per-second `videoUploads / overlayUploads / dockUploads / panelUploads`,
`transChanges` (source-change notifications), `transClears` (black-clear fills),
`transNotReady` (frames waiting on not-ready video).

### 3.1 Steady playback, `?dockfreeze=1` (v8.7)

```
frames=90-91  dtMax=12–22.5ms  vid=89-91/s  ov=bursts 0–11/s  dock=0
chg=0 clr=0 notready=0   locked  scale 4  dist 2.24  subimage
```

90 fps sustained, no stalls. `dockUploads: 0` confirms dockfreeze works.
Overlay fires in 0–11/s bursts as time-synced popups enter/leave their window.

### 3.2 Rapid switching, no flags (v8.7)

```
frames=74–88  dtMax=24–93ms  vid=25–60/s  ov=0–10/s  dock=9–10/s
chg=2–4/s  clr=4–8/s  notready=21–42/s
```

Frames sag, 55–93 ms spikes, video element buffering ~25–45% of frames.
Note the **inverse** signature: uploads *drop* when glitches appear.

### 3.3 Steady playback, `?overlay=0`, flags verified in payload (v8.7)

```
frames=90–91  dtMax=12–13.6ms  vid=90–91/s  ov=0  dock=9
chg=clr=notready=0   flags.overlay=False
```

Clean. Overlay mesh verifiably never built.

### 3.4 Hard rapid switching, `?domoverlay` not yet existing (v8.7, worst run)

```
frames=74–88  dtMax=22–93ms (many 60–90ms spikes)  vid=21–66/s
chg=1–5/s  clr=2–10/s  notready=7–50/s
```

Near-permanent buffering storm. Owner reported worse glitches than ever in this window.

### 3.5 Key telemetry finding (all runs)

`videoUploads == xrFrames` in steady state: the video texture re-uploaded **every
XR frame (~90/s)**. Root cause in code: `shouldUploadVisual` keyed on the
`currentTime` float, which advances continuously while playing — defeating the
decoded-frame gate (legacy Fix #1, lost in the v8 rewrite). Fixed in v8.9
(§5.3); expect ~source-fps after.

---

## 4. Elimination matrix

| Hypothesis | Test | Verdict + evidence |
|---|---|---|
| Source macroblocking (bigger 4 m screen exposes encode blocks) | Shrink-then-switch; Von-vs-Travis bitrate A/B | **DEAD.** Squares stay fixed-size (§2 shrink); no bitrate difference (§2). Both would scale/track bitrate. |
| Overlay quad/texture (v8.3 addition, full-screen transparent pass, 10 Hz churn) | `?overlay=0`, verified absent via diag flags; panel-open suppresses it | **DEAD (mostly).** Squares persisted with the mesh never built (§3.3 run + owner report). Panel-open correlation noted but contradicted by the flag test. |
| Ambient glow fill-rate (5.36 m additive quad) | `?glow=0` | **DEAD.** Persisted. |
| Face-following motion (per-frame re-posing) | `?lock=0` (fixed screen) | **DEAD.** Persisted. |
| `texSubImage2D` driver bug (three r186 same-size re-uploads; investigation doc precedent) | `?vrTexMode=respec` (forces full `texImage2D`, legacy path) | **DEAD for video.** Persisted. (Confirmed three r186 branches `texSubImage2D:texImage2D` on re-upload — `ui/assets/three.min.js`.) |
| Dock texture tears | `?dockfreeze=1` (0 uploads, telemetry-verified) + squares seen in that window | **DEAD.** Persisted with zero dock uploads. |
| Comments panel texture | Panel closed in all square-positive runs (invisible meshes skip render) | **DEAD.** |
| Guide texture | Static (one upload/session); `?guide=0` exists but squares occur without any re-upload | **DEAD** (no mechanism for repeat transient squares). |
| DOM-overlay compositor layer (bottom-anchored 360 px div, never bisected; legacy code identical but old browser may never have granted it) | `?domoverlay=0` (v8.8; skips div + layer request) | **OPEN.** Untested on-device at time of writing. |
| Decoder resync garbage in first frames after src-swap | v8.9 freeze-then-cut (killed between-switch squares ✓); v8.10 first-frame hold | **ACTIVE THEORY.** Fits: transition-only, survives all GL flags (it's *in the decoded content*), too fast to screenshot. Location nuance below. |
| Loading-pipeline contention (blob prune/refetch + preload races over USB) | Telemetry (`transNotReady` storms); v8.9 preload backoff | **CONTRIBUTING (confirmed storm), not the squares directly.** Causes the buffering windows in which resync garbage appears. |

### 4.1 Location nuance (left-bottom quartile, fixed-size)

Unresolved to pixel precision (too fast to screenshot). Candidates, ranked:
1. First-decoded-frame garbage regions (decoder-dependent placement; HEVC resync artifacts commonly appear as block bands in the lower/left picture areas on tile-based decoders).
2. Partial-frame presentation during `HAVE_CURRENT_DATA`-only states (removed as a class by the v8.10 `HAVE_FUTURE_DATA` gate — confirm on-device).
3. Compositor-layer artifact (settled by the pending `?domoverlay=0` run).

---

## 5. Fixes implemented (engine `ui/assets/webxr_vr.js` unless noted)

### v8.4 — Upload churn + sampling + paint order
- **Dirty-only overlay** (`refreshOverlayTexture`): re-render/re-upload only when the popup
  ID-set or hover changes; fade repaints ≤10 Hz only while visible; zero popups → zero
  uploads. Killed the v8.3 ~10 Hz 1024² churn (keyed on `currentTime`). Counter:
  `renderStats.overlayUploads`.
- **Legacy sampling**: `LinearFilter` + `generateMipmaps: false` on all 10 `CanvasTexture`s
  (`applyLinearSampling`; legacy set `LINEAR`/no-mipmaps everywhere) — crisper text, no
  mipmap regen per re-upload.
- **Paint-order ladder**: `depthTest: false` + `renderOrder` screen 0 / overlay 2 / dock 3 /
  comments+guide 4 (legacy drew reels with `DEPTH_TEST` effectively off).
- **Curvature z-scale**: uniform `scale.set(s,s,s)` (legacy `R_world = R·scale`).
- **Controller photo**: `renderGuideCanvas` consumes live `window.QUEST_CONTROLLER_B64`
  (542×900, already injected) + dirty-flag re-upload; vector fallback preserved.
- **Respec A/B**: `setVideoUploadMode('subimage'|'respec')` + `?vrTexMode=respec` (dispose per
  upload → forced full `texImage2D`).
- **XR telemetry**: frame intervals + upload counters POSTed ~1 Hz to `/api/reels/diag`
  (`postXRDiag`, `resetXRDiag`).

### v8.5 — Legacy-exact lock + bisection flags
- Reverted the v8.4 tandem rig: locked = head screen + room-fixed UI at the default spot
  (`getLockedAnchor` + lock branches verbatim); unlocked = screen-relative UI.
- Flags: `?lock=0 ?overlay=0 ?guide=0 ?glow=0` (`debugFlags`, `readDebugFlags`,
  `lockApplies()`, seams `get/setDebugFlags`). Each removes one v8.3+ subsystem.

### v8.6 — Laser ray unification + reticle (separate report, same device round)
- Right-preferred shared laser, stored-ray clicks (`activeRayOrigin/Dir/Handedness`,
  `pickPointerSource`, `chooseSelectRay`); beam/reticle `depthTest: false` + 0.02 m
  reticle pullback. Not square-related; listed for completeness.

### v8.7 — Transition diagnostics
- `?dockfreeze=1` (dock paints once, `dockFreezePainted`), `?glowprobe=0` (kills the
  800 ms `getImageData` readback sync), per-texture counters
  (`dockUploads/panelUploads/guideUploads`), transition counters
  (`transChanges/transClears/transNotReady`, the last counting buffering frames) —
  all in the diag payload.

### v8.8 — DOM-overlay bisection
- `?domoverlay=0`: skips the overlay div + omits the feature/layer from session options;
  comment-keyboard ADD degrades to a dock notification. Test pending.

### v8.9 — Loading-pipeline fixes
- **Hold-last-frame**: black clears are session-start-only (`hasDisplayedVisual`); switches
  hold the prior visual until the new source is ready (owner-confirmed: freeze-then-cut,
  no squares between hard switches).
- **Decoded-frame gating** (legacy Fix #1 port): uploads key on `totalVideoFrames`
  (`decodedFrameCount`/`lastVideoFrameCount`) with a 0.25 s seek-jump backstop
  (~90/s → ~source fps; paused seeks never go stale).
- **Rapid-flight preload backoff** (`reels.html`): `preloadNext` skips background transfers
  within 1500 ms of navigation (`lastSwitchTime` in `nextVideo`/`prevVideo`).

### v8.10 — First-frame hold (current)
- Fresh video visuals wait for `HAVE_FUTURE_DATA` (readyState ≥ 3) before the first
  upload, holding the previous frame meanwhile (`freshVisualSince`, 2.5 s wall-clock
  cap `FRESH_VISUAL_MAX_HOLD_MS`, `force` bypasses). Steady visuals upload at ≥ 2
  unchanged. Rationale: post-swap `HAVE_CURRENT_DATA` frames can be resync garbage.

---

## 6. Open items

1. **On-device confirmation of v8.9/v8.10** (hold-frame, decoded gating, first-frame hold):
   full tab close + reopen → rapid-switch 1 min → expect freeze-then-cut with clean
   first frames, `transClears` ≈ 1/session, `videoUploads` ≈ 30/s, lower `dtMaxMs`.
2. **`?domoverlay=0` compositor test** (full tab close + reopen): squares gone → remove the
   overlay request permanently and rework VR comment posting; squares persist → layer innocent.
3. **W4.2 deferred**: 2× backing-store supersample for dock/comments/guide canvases — only
   if text is still soft after the v8.4 sampling fix; costs ~4× UI upload bytes.
4. **Unimplemented (from the parent investigation, still relevant)**: abortable LRU blob
   cache with revocation discipline; abort stale blob fetches on navigation (currently only
   location transitions abort); Quest rendition selection (1536²/2048²) instead of raw 4K
   masters over USB.

## 7. Reusable on-device protocol

1. Full tab close + reopen (reload discipline — the player inlines JS per request).
2. Append flags to the page URL before entering VR (`?overlay=0`, `?dockfreeze=1`,
   `?glowprobe=0`, `?lock=0`, `?vrTexMode=respec`, `?domoverlay=0`).
3. Host watches live: `curl -s http://localhost:8000/api/reels/diag` (payload echoes
   `flags`, so flag uptake is verifiable — never trust a flag test without checking).
4. Exercise: steady loop (baseline) → rapid prev/next bursts (glitch windows) →
   shrink-then-switch (size test) → high-vs-starved-bitrate reels.
5. Report: square presence per configuration + `dtMaxMs` + per-texture deltas + answers to
   feed/pack, panel open/closed, precise location/size/duration.

## 8. Key references

- Engine: `ui/assets/webxr_vr.js` — upload path (`uploadVideoFrame`, `shouldUploadVisual`,
  `clearPendingTexture`, `onVideoChange`), overlay (`refreshOverlayTexture`), flags
  (`debugFlags`, `readDebugFlags`, `lockApplies`), telemetry (`postXRDiag`),
  version `v8.10-20260920-firstframe-hold`.
- UI canvases: `ui/assets/vr_ui_canvas.js` (`renderOverlayCanvas`, `filterOverlayComments`,
  `renderGuideCanvas`).
- Host loading: `ui/assets/reels.html` (`loadVideo`, `nextVideo`/`prevVideo`,
  `currentVisualSource`, `preloadNext`, `pruneBlobCache`, `preloadAllVideos`).
- Injection: `server/routers/reels.py` (`/player`, `/player-inline`, `/diag`).
- Docs: `docs/vr-reels-playback-investigation.md` (parent),
  `docs/threejs-vr-implementation-plan.md` (§8 build log),
  `docs/v8.3-vr-parity-restore-plan.md`, `docs/v8.4-vr-device-fixes-plan.md`.
- Probes: `scripts/verify_v83_parity_live.cjs` (26/26 green on v8.10),
  `scripts/debug-quest.cjs` (CDP video-decode stats, 2D mode).
