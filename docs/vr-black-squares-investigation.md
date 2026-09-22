# VR Black-Square Glitches — Investigation Record (Quest 3, Three.js engine v8.3 → v8.17)

> Living document: every observed data point, every eliminated hypothesis, and every
> fix attempted for the in-headset black square/rectangle glitches, with the evidence
> that decided each step. Companion to `docs/vr-reels-playback-investigation.md`
> (the earlier choppiness/bitrate investigation — different symptoms, same device class).

> **Current status (2026-09-22)**: engine `v8.17-20260922-full-minimal` —
> **CONFIRMED.** The `default` session (§3.11) ran v8.16 (minimal session +
> AA ON) flashing throughout, then v8.17 (full minimal stack) clean — with
> device-grounded `sessionFeatures` proof in diag. MSAA resolve on the XR
> layer is the isolated flash variable across all 7 sessions; everything else
> (content, pacing, decoder pool, UI traffic, session features alone) is
> eliminated or decoupled. Between-switch squares remain fixed by v8.9/v8.10.
> Between-switch squares remain fixed by v8.9/v8.10.

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
- **Immersive preview (2D) is clean (owner, 2026-09-22)**: the same reels, same
  engine, same upload code render with **no flashes** in the desktop 2D preview
  (`startPreview` path). Fault is Quest-XR-pipeline-specific, not in the
  stream, the decoded content, or the scene logic — consistent with the §3.8
  A/B verdict and the `?vrtex=video` fix direction.
- **`?vrtex=video` still flashes (owner, 2026-09-22, §3.9)**: direct texture,
  paused video, clean pacing, zero decoder failures, blackdetect-clean file —
  flashes persist. Canvas path, decoder pool, and frame loop all exonerated.

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

### 3.6 First instrumented capture session (2026-09-20, rig §7.1, Quest 3S)

Symptom update first: owner review of the composited capture
(`com.oculus.vrshell-20260920-234026-0.mp4`, 113.6 s @ 30 fps) reframed the
"black squares" — the perceived artifact is a **black-out of the video screen
content** (the screen quad is at `screenScale=4` and fills the whole FOV, so a
black texture flash reads as "full black screen"; earlier square reports were
partial versions of the same). ffmpeg `blackdetect` over the recording found:

| Video t | Event | UTC | Diag at that second |
|---|---|---|---|
| 6.33–7.23 s | full black 0.9 s (laser + popup gone too) | 16:40:32 | `dtMax=154.2ms xrF=70` — huge frame-loop stall |
| 31.2 s | black 0.3 s, **popup overlay still visible** | 16:40:57 | `dtMax=24.4` clean 1 s window |
| 45.9 s | black 0.27 s | 16:41:12 | clean window |
| 72–79 s | flicker storm, ~20 black bursts of 2–6 frames | 16:41:38–45 | sustained `dtMax=62–67ms xrF=82–87` |

Key facts:
1. **Stall↔black correlation**: every dtMax spike window coincides with black
   frames; calm pacing (25–30 ms) elsewhere. The 154 ms stall at the 0.9 s
   full-black is the smoking gun for frame-loop stalls → missed submits.
2. **Partial-black frames show the overlay popup still rendered** (31.25 s
   frame): the app kept submitting frames — only the video-texture region went
   black. So at least some flashes are app-side texture state, not compositor
   blanking. The 6.3 s event was all-black including laser (entry-adjacent or
   compositor-level).
3. **Upload gate leak**: masters are 30 fps (ffprobe 3840×3840 avg 30/1), but
   `videoUploads=41–73/s` during steady playback — the v8.9 decoded-frame gate
   (`getVideoPlaybackQuality().totalVideoFrames` + rVFC) still over-triggers
   ~1.4–2.4× → up to ~1.2 GB/s of 16 MiB texture traffic, which loads the queue
   the readback then stalls behind.
4. **Prime suspect mechanism**: `updateGlowColor(time, 120)` runs inside the XR
   frame loop (`webxr_vr.js:2247`) and does `drawImage(video, 8×8)` +
   `getImageData` — a synchronous CPU↔GPU readback **every 120 ms** while
   presenting (`webxr_vr.js:1976`). All earlier `?glow=0` testing killed the
   glow *fill-rate*; the readback itself (`glowprobe:true` default) was active
   in every steady-playback run. Readback syncs inside a busy frame loop are a
   textbook cause of 60–150 ms stalls and intermittent invalid/late submits.
5. Rig lessons: metacam is absent on this device (`screencap` fallback works
   and captures the stereo eye-buffer surface); metavr `logcat --follow` buffers
   silently when piped (replaced by a `metavr log -n 400` poller,
   `logs/quest-square-logpoll.cjs`); `ovrgpuprofiler -t` requires
   `ovrgpuprofiler -e` **before** the browser app starts (rig change pending).

### 3.7 Second session (2026-09-21, v8.11 + `?glowprobe=0`) — app exonerated

v8.11 (software-backed probe + ~30/s upload throttle) confirmed live in diag.
91 samples over ~4 min of steady playback: **`dtMaxMs` flat at 16–18 ms the
whole session, `xrFrames` 90–91, `videoUploads` 27–38/s** (was 41–73/s) —
the app now submits flawlessly. **Black flashes still observed by the owner.**
Verdict: the flashes are generated **downstream of the frame loop** (browser
compositor / decode pipeline / XR runtime), not by app pacing.

Device-level fault found in the same session (first hard fault in this whole
investigation): the Qualcomm HEVC decoder logs ~4/s chronically through the
entire playing window (1,007 total, every minute):
`QC2V4l2Codec: [hevcD_N] queueOutputs: Allocation failed!` + Chromium
`VideoRenderQualityTracker` frame-timing warnings alongside. Earlier session's
logcat had zero such lines only because the user had already stopped playing
(`videoUploads=0`) before its poller started.

### 3.8 A/B session (2026-09-22, `ab` label) — direct path exonerated

`v1-ab-direct-video-texture` playing the same 3840² HEVC master family, 69 diag
samples over ~3.5 min: `dtMaxMs` max 30.0 / p95 27.2, `xrFrames` 88–92,
**owner-reported zero flashes across 2 runs**. Decoder allocation failures
still logged but at **38–72/min vs 200–262/min on the engine path (~4× lower)**.
Verdict: the flashes come from the engine's canvas-proxy round-trip (which
pins decoder output buffers ~4× harder), not from the file, the decoder
ceiling, or the app frame pacing. Fix: `?vrtex=video` direct texture (§5.3).

Owner challenge (§4): other Quest video sites play 4K/8K/16K cleanly. Real
differences: (a) they feed decoded frames through the browser's hardware
video-texture path (EGLImage, zero/low-copy) straight into GL; our engine does
video → 2D canvas blit → 16 MiB RGBA `texSubImage2D` re-upload on most XR
frames — an extra full GPU round-trip pinning output buffers; (b) the video
element feeds TWO consumers (the compositor/media pipeline + our canvas
drawImage); (c) our masters are 3840×3840 square HEVC — 78% more pixels than
standard 3840×2160 "4K", in a shape driver buffer pools may not size for.
So the allocation failures most likely indict **our pipeline's buffer demand**,
not the headset's decode ceiling. Decisive AB (`/api/reels/vr-video-path-ab`,
§7.2): same masters through a direct `THREE.VideoTexture` (the other-sites
path) in the same headset.

### 3.9 `?vrtex=video` session (2026-09-22, `vrtex` label) — flashes persist, everything measurable clean

Owner ran the reels page with `?vrtex=video`, reports flashes persist.
Capture session `quest-squares-2026-09-22T06-21-08-363Z-vrtex` (rig §7.1),
telemetry verified live:
- Flag uptake confirmed: `engine: v8.13-20260922-direct-video`, `flags.vrtex: True`.
- Frame loop clean: `xrFrames` 90–91, `dtMaxMs` 13–15 ms for 80+ straight
  seconds, `transNotReady/Chg/Clr` all 0.
- **Video paused the whole session**: `videoUploads` 0 for 80 samples;
  on-device caps ~10 s apart differ by YAVG 1.5 (identical frames).
- **Zero `QC2V4l2Codec` failures** in 8,626 logcat lines (vs ~4/s on the
  canvas path, ~1/s on the AB page). Decoder pool healthy.
- File on screen (`Tron-Legacy-Lightbike…_001_1080p.mp4`, 1920×1080 H.264):
  ffmpeg `blackdetect` over all 267 s → **0 black frames**. Content clean.
- On-device screencap (stereo eye buffers): full-FOV video in both eyes, laser
  reticle visible, no black in captured frames; a red sliver intrudes at the
  right edge of the right eye (dock/panel edge or reticle parallax — minor,
  unpursued).

Deduction: flashes occur with an idle video pipeline, healthy decoder, clean
file, clean pacing, direct texture. The canvas path, decoder pool pressure,
frame-loop stalls, file content, and (unchanged) app pacing are ALL
exonerated as necessary causes. What still runs: UI-canvas uploads (dock
**9–10/s every second**, overlay bursts), lasers/reticle/controllers/input,
telemetry POSTs, the capture rig's own 2s screencap loop — or the XR
compositor/system itself.

### 3.10 `?xrminimal=1` session (2026-09-22, `xrminimal` label) — FIXED

Owner: "significant less flashes — 1 or twice at the start, then no more;
loops clean; flashes between switches nonexistent." Capture session
`quest-squares-2026-09-22T06-53-12-928Z-xrminimal` (flag verified live:
`engine: v8.14-20260922-xrminimal`, `flags.xrminimal: True`), 493 samples
over ~25 min of reel-hopping across 5 reels:

| Window | Pacing | Decoder failures | Report |
|---|---|---|---|
| Reel 1, cold start (forced browser close) | dtMax med **57 ms** sustained | **325–327/min (5.4/s)** | the 1–2 flashes |
| Reels 2–5, incl. loops + switches | dtMax 24–30 ms, xrF 90–91 | declining 150 → 77/min | **zero flashes** |

Two accidental discoveries in the same session:
1. **Frozen diag**: the last 304 samples (15 min) are byte-identical
   (`dtMax 53.7, vid 26`) — the XR loop halted while the page kept decoding.
   Same instant the 306 on-device screencaps went 0-byte empty: the headset
   came off / session suspended. Rig lesson: the diag poller can't tell
   "halted loop" from "steady state" — future analysis must flag frozen
   payload runs (stale-detector pending in the rig).
2. **Failure explosion on halt**: decoder failures tripled (360 → ~1000/min)
   exactly when the XR loop stopped consuming frames — output buffers piled
   up unreleased. This confirms the pool-pressure model (§3.7–§3.8): failures
   scale with *unconsumed* decoder output, which is why the canvas path
   (drawImage holds each frame through the copy) starved the pool ~4× harder
   than the direct path.
3. **VrApi (compositor self-report)** during the degraded window:
   `App=3.74ms` (our engine renders in under 4 ms), `FPS=87/90`, `Stale=8`,
   Temp 36 °C, Free 1766 MB — the compositor says the app is fast and the
   device is healthy. More proof the app was never the bottleneck.
4. **Caps luminance scan**: 94 valid stereo caps, YAVG median 79.7, **zero
   black frames** — no flash caught in glass, consistent with the owner
   report (flashes only in the first minutes, before most caps mattered).

Verdict: **minimal session request fixes the flashes.** Shipped as the
default in v8.15 (§5). The 1–2 cold-start flashes remain a known quantity:
first reel after a forced browser close, concurrent `preloadVideo` decode of
the next reel + cold pipeline = the last contention window (§6).

### 3.11 `default` session (2026-09-22) — v8.16 flashes, v8.17 clean in one run

Labeled session `quest-squares-2026-09-22T07-50-49-400Z-default`, 479 samples
over 30 min. Owner hard-closed + reopened (fresh tab discipline), reports
flashes throughout on the default config, then "better now, no evident
flashes" after reloading into v8.17:
- **v8.16 window** (381 samples, minimal session + AA ON): flashes throughout
  (owner). dtMax med 27, decoder failures ~2–4/s. The v8.15 session-only split
  is insufficient — retracted as the fix.
- **Probe-pollution window** (58 zero-valued samples): the desktop parity
  probe POSTs engine-less diag entries to the shared endpoint. Excluded from
  analysis. Rig lesson: filter diag by `engine` — capture sessions must ignore
  foreign posts.
- **v8.17 window** (40 samples, ~2 min): `sessionFeatures` device proof —
  `requested: ["local-floor","local"]`, `granted: ["local","viewer","webxr",
  "local-floor"]` (no bounded-floor/hand-tracking/dom-overlay),
  `renderer: {alpha:false, antialias:false}`. Owner reports no evident
  flashes. Decoder failures persist (~4–5/s) — fully decoupled from flashes.
- **Caps**: 400 staged, 110 valid analyzed (YAVG median 64.5, zero black —
  2 s cadence misses sub-second transients); 290 empty in bursts. Empty
  screencaps cluster independently of XR-loop state (diag stayed live) —
  screencap-vs-compositor racing, mechanism unpursued.
- **Log scan** (83,644 lines, `default` session): 0 fatals, 0 crashes, 0 OOM,
  0 ANR, 0 thermal emergencies, 0 VrApi errors, 0 GPU-process crashes. Notable:
  `SurfaceForgerClientImpl: captureDisplay: no display buffer to dump` (262× —
  our screencap loop failing when the compositor has no buffer; explains the
  empty caps); `QC2Interface: Few parameters failed to configure` (25×,
  clustered 14:59–15:01 + 15:18–15:19 — Qualcomm codec-driver complaints from
  the media process, aligned with the decoder-failure spike; same pool-pressure
  story, still decoupled from flashes); `GpuProfilingService` SELinux denials
  (`avc: denied ... gpuprofserver_socket`) — `ovrgpuprofiler -t` is blocked by
  policy, not just ordering (rig lesson: stop relying on it). Camera HAL /
  tracking / sensor / battery entries are device noise.
- **AA isolation table** (all sessions): flashing runs all had MSAA on the XR
  layer (engine default); clean runs (AB page ×2, xrminimal labeled, v8.17
  window) all had it off. three r186 forces `alpha:true` on the layer
  regardless, so MSAA resolve is the isolated variable — consistent with
  fixed-position tile failures (original squares) and whole-layer failures
  (full black), all content-flag-immune.

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
| DOM-overlay compositor layer (bottom-anchored 360 px div, never bisected; legacy code identical but old browser may never have granted it) | `?domoverlay=0` (v8.8; skips div + layer request) | **DEAD (2026-09-21 owner run).** Squares/black-outs persisted during steady playback with the flag on (switching windows clean — consistent with v8.9 holds). Layer innocent for steady-playback flashes. |
| Blob eviction → mid-play re-fetch over USB | Loop-replay A/B | **DEAD (2026-09-21).** Flashes occur on loop replays (no fetches occur). |
| Glow `getImageData` readback sync inside the XR frame loop (every 120 ms while presenting, `webxr_vr.js:2247/1976`) — distinct from `?glow=0` fill-rate | `?glowprobe=0` during **steady playback** + capture rig; expect dtMax spikes to vanish with the flashes | **ACTIVE — top suspect.** §3.6 stall↔black correlation (154 ms @ 0.9 s full-black; 62–67 ms sustained during the 72–79 s storm); readback active in every prior steady run. |
| Upload-gate leak (~2× over-trigger, 41–73/s vs 30 fps source) | Capture-session telemetry; investigate rVFC rate on Quest browser | **FIXED in v8.11 (§3.7).** Now 27–38/s. |
| Glow `getImageData` readback sync inside the XR frame loop | `?glowprobe=0` + v8.11 software-backed probe | **DEAD as the flash cause (§3.7).** Pacing went perfectly flat (16–18 ms) yet flashes persisted. (The v8.11 changes stand — they fixed real pacing damage.) |
| Canvas-proxy upload path starves the HEVC decoder output pool | A/B (§3.8) + `?vrtex=video` (§3.9) | **DEAD as the flash cause (§3.9).** Direct path flashes identically with zero decoder failures, idle video pipeline, clean pacing. (v8.13 direct-texture stands as a perf improvement; AB page stays clean.) |
| Decoder resync garbage in first frames after src-swap | v8.9 freeze-then-cut (killed between-switch squares ✓); v8.10 first-frame hold | **DEAD as sole cause (2026-09-21 §3.6).** Flashes also occur mid-reel on loop replays during steady playback; between-switch transitions themselves are clean. |
| Loading-pipeline contention (blob prune/refetch + preload races over USB) | Telemetry (`transNotReady` storms); v8.9 preload backoff | **CONTRIBUTING (confirmed storm), not the squares directly.** Causes the buffering windows in which resync garbage appears. |
| Background `preloadVideo` decode of the next 4K reel (`reels.html:4136`, `preload="auto"`, never played) starves the decoder pool alongside the main decode | `QC2V4l2Codec` rate with/without background preload | **DEMOTED (§3.9).** Zero allocation failures coexisted with flashes (paused main video, preload presumably idle/finished). Still worth a `preload="metadata"` hardening pass — two concurrent 4K decodes remain the heaviest decoder load in the app. |
| Baked-in black frames in the video files | ffmpeg `blackdetect` over the on-screen file | **DEAD for the §3.9 file** (0 black frames in 267 s of the 1080p Tron rip). Other masters unchecked — spot-check any newly flash-positive file the same way. |
| UI-canvas upload traffic (dock repaints **9–10/s continuously**, overlay bursts, panels) while everything else idles | Screen-only session: `?vrtex=video` + `?overlay=0` + `?guide=0` + `?dockfreeze=1` + `?glow=0` | **OPEN — next test.** The only remaining engine-side load in §3.9 (AB page has none of it). |
| Capture-rig self-interference (on-device screencap every 2 s + Gallery/MediaScanner churn per shot) | Rig-off control: diag+logcat only, no `quest_caps` loop | **OPEN — cheap control.** Gallery errors logged per shot in §3.9 window. |
| XR compositor / FFR / timewarp / display / proximity-sensor blanking (Meta bug class; cf. their open Quest 2 browser-video flicker investigation) | Screen-only session first; if that still flashes with zero app-side load → Meta Feedback Center report with the §3.6–§3.9 evidence package | **OPEN — top suspect if the screen-only session flashes.** Consistent with: preview-clean (no XR stack on desktop), popup-survives-partial-black (separate compositor content), fixed-pixel size (eye-buffer/compositor space), zero app-side signal in §3.9. |

### 4.1 Location nuance (left-bottom quartile, fixed-size) — reframed by §3.9

The screen at `screenScale=4` fills the whole FOV, so a black-out of the video
region reads as "full black screen" while partial black-outs read as
"squares". Fixed pixel size under shrink + popup-survives-partial-black +
zero app-side signal all point at eye-buffer/compositor space, not scene
content. On-device stereo screencaps (§3.9) confirm full-FOV rendering in both
eyes. Pixel-precision pending a frame-caught flash (2 s cap cadence keeps
missing sub-second events; headset video recording remains the better trap).

### 4.2 Standards research (2026-09-22) — what video-in-VR sites do + known browser bugs

Owner challenge: "check online what's the standard for our use case."
Findings:

1. **The standard** (three.js `webxr_vr_video` example — what our flash-free
   AB page §3.8 replicated): direct `THREE.VideoTexture`, one plane, one
   render loop, **minimal session request** (`optionalFeatures:
   ['local-floor', 'local']`), default renderer options (antialias/alpha off).
   No UI-canvas meshes, no dom-overlay, no hand-tracking, no glow sampling.
2. **three.js #29294 "Left eye flickering in webxr" (2024, Quest 2/3)**:
   "left eye starts blinking with **clearColor**… frequency depends on CPU/GPU
   load… **best reproduced when the video with VideoTexture is playing**" —
   our exact symptom class (black = clear color, load-correlated, video-tied).
   Resolved by a headset reboot for that reporter; closed as device-side.
3. **Babylon.js "GUI elements cause flickering on Meta Quest 3 with WebXR
   multiview layers" (2025-26)**: Meta devs confirmed flicker classes in the
   Quest browser around render-target switching mid-session; one multiview
   flicker bug was fixed browser-side by Meta. (three r186 does not use
   OCULUS_multiview by default — 1 stray mention in our bundle — so not our
   path, but it confirms the browser has an active flicker-bug history.)
4. **Godot 2024 Quest black-void regression**: "Not all layers have valid
   content; visual artifacts might occur" — triggered by requesting
   **`bounded-floor`** in session options; switching to `local-floor` fixed
   it. Our engine requests `bounded-floor` every session (§5 enterVR).
5. **Engine vs AB page — the remaining deltas** after §3.9/§4 eliminations:
   session features (`bounded-floor` + `hand-tracking` + `dom-overlay`),
   renderer opts (`antialias:true`, `alpha:true`), per-frame lock re-posing,
   controller lasers/reticle, 1 Hz telemetry POST, UI-canvas uploads.
   The screen-only run (§6 item 1) removed the UI meshes and still flashed —
   narrowing to the session/renderer options + input/hand-tracking paths.
   v8.14 `?xrminimal=1` tests the session+renderer options directly.

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

### v8.10 — First-frame hold
- Fresh video visuals wait for `HAVE_FUTURE_DATA` (readyState ≥ 3) before the first
  upload, holding the previous frame meanwhile (`freshVisualSince`, 2.5 s wall-clock
  cap `FRESH_VISUAL_MAX_HOLD_MS`, `force` bypasses). Steady visuals upload at ≥ 2
  unchanged. Rationale: post-swap `HAVE_CURRENT_DATA` frames can be resync garbage.

### v8.11 — Readback-off + upload throttle
- **Software-backed glow probe**: `getContext('2d', { willReadFrequently: true })` on
  the 8×8 ambilight probe canvas — the 120 ms `getImageData` inside the XR frame
  loop can no longer flush/sync the GPU command queue (top black-flash suspect,
  §3.6/§4).
- **Video upload throttle**: `shouldUploadVisual` caps video uploads at ~30/s
  (`VR_VIDEO_UPLOAD_MIN_MS = 33`); visual changes and >0.25 s seek jumps bypass.
  Fixes the measured 41–73/s gate leak against 30 fps masters (§3.6).
- Version string `v8.11-20260921-readback-throttle`; `verify_v83_parity_live.cjs`
  updated and green.

### v8.12 — Self-describing diag
- Diag payload now carries `src` (current video basename) so capture sessions
  need no out-of-band narration; pairs with rig `start [label]` sessions.
- Version string `v8.12-20260921-diag-src`; `verify_v83_parity_live.cjs` updated
  and green.

### v8.13 — Direct video texture
- `?vrtex=video`: binds a direct `THREE.VideoTexture` of the video element to
  the screen instead of the canvas-proxy blit + `texSubImage2D` re-upload —
  the path other Quest video sites use, proven flash-free in the §3.8 A/B.
- Fresh elements wait for `HAVE_FUTURE_DATA` (v8.10 rule ported); steady
  elements stay bound (three uploads per render). Static cards/images and the
  session-start clear keep the canvas path (auto-rebind via `bindScreenMap`).
  Telemetry counts decoded frames into `videoUploads`. Debug-tint restore and
  session teardown handle both maps. Default OFF.
- **On-device result (§3.9): direct path flashes identically** — canvas-proxy
  exonerated as the flash cause. The path stands as a (verified, tested) perf
  improvement: keep flag-off default until the remaining suspects resolve.
- Regression test added (`web/tests/webxr-earth.test.js`: direct bind shows
  native dims, switch rebinds, static rebinds canvas).
- Version string `v8.13-20260922-direct-video`.

### v8.14 — Minimal XR session/renderer options
- `?xrminimal=1`: session request drops to `['local-floor', 'local']` (no
  `bounded-floor`, no `hand-tracking`, no `dom-overlay`) and the renderer is
  created with `antialias:false, alpha:false` — matching the three.js
  `webxr_vr_video` standard shape the flash-free AB page used (§4.2). Godot's
  2024 Quest black-void regression was triggered by `bounded-floor`; three
  #29294 documents clearColor flicker under video load on the same browser.
- Version string `v8.14-20260922-xrminimal`.

### v8.15 — Minimal session by default (the fix)
- §3.10 verdict: the `xrminimal` configuration fixed the flashes. Session
  features are now minimal unless `?xrfull=1` (legacy request restored).
  Renderer `antialias/alpha` left at engine defaults — no test has implicated
  them, and flipping them would regress desktop preview quality.
- Dropped features cost nothing the app consumes: no hand-joint reads, no
  bounds-geometry reads anywhere in the engine; the VR keyboard degrades to
  the existing dock notification (`?domoverlay=0` path).
- Seam allowlist extended (`vrtex`, `xrminimal`, `xrfull`); regression tests:
  session-defaults test + updated domoverlay session-options test.

### v8.16 — Keyboard gate for the minimal default
- Audit of the reduced request: `bounded-floor` (never consumed — no bounds
  reads) and `hand-tracking` (never wired — all input is controller lasers
  via `getController`; pinch-to-click never functioned) break nothing.
- `dom-overlay` did break one flow silently: `openVrKeyboard` gated only on
  the flag, so under the minimal default it focused an invisible field with
  no system keyboard. Now gates on the actually-granted session feature
  (`xrSession.enabledFeatures`) and shows `KEYBOARD NEEDS FULL SESSION
  (?xrfull=1)` instead. `?xrfull=1` restores the layer + keyboard.
- Version string `v8.16-20260922-kbd-gate`.

### v8.17 — Full minimal stack by default (current, the proper fix)
- The v8.15 session-only split was **insufficient**: a verified-fresh default
  tab (v8.16, minimal session confirmed in code + flags) flashed throughout
  like pre-fix, while the xrminimal run (minimal session AND AA-off) was
  clean. three r186 hardcodes `alpha:true` on the `XRWebGLLayer` regardless,
  isolating **MSAA resolve on the XR layer** (`antialias` from our context) as
  the remaining variable — consistent with fixed-position tile failures
  (squares) and whole-layer failures (full black), all content-flag-immune.
- Renderer default is now `antialias:false, alpha:false` (= the exact
  proven-clean configuration); `?xrfull=1` restores the entire legacy stack.
- Diag now carries `sessionFeatures: { requested, granted, renderer }` —
  permanent on-device proof of the session configuration behind each run.
- Regression tests: default-session-request test + default-renderer-opts
  test (76/76 node); 158/158 pytest + parity probe green.
- Version string `v8.17-20260922-full-minimal`.

---

## 6. Open items

1. ~~Default-stack confirmation~~ — DONE (2026-09-22, §3.11): v8.16 flashed
   throughout → v8.17 clean in the same session, with `sessionFeatures` proof.
   The v8.17 window was short (~2 min / 40 samples) — a longer clean run
   would harden it, but the AA on/off split is now 4-and-0 across sessions.
2. **Cold-start contention** (the 1–2 residual flashes): first reel after a
   forced browser close plays while `preloadVideo` decodes the next reel and
   the pipeline warms. Candidates: `preload="metadata"` on the warmer element
   (blob cache already warms the network — the decode-ahead is pure cost), or
   delaying the background load until the main reel is buffered. Small,
   well-isolated follow-up.
3. **Bisect deferred**: which of `bounded-floor` / `hand-tracking` /
   `dom-overlay` / MSAA actually triggered the flashes. Only needed if a
   dropped feature is wanted back (VR keyboard posting, hand input); the
   minimal set costs nothing the app currently consumes.
4. **Rig stale-detector**: flag frozen diag-payload runs at `stop` time
   (§3.10 lesson — 304 identical samples went unnoticed live).
5. **Meta Feedback Center report** — STOOD DOWN unless item 1 flashes. The
   evidence package (§3.6–§3.10) stays filed in-doc.
6. **`ovrgpuprofiler -e` before browser start** in the rig so `-t` samples land
   (FFR/GPU-stage state during flashes still unobserved).
7. ~~On-device confirmation of v8.9/v8.10~~ — freeze-then-cut confirmed by owner;
   between-switch squares gone (§3.6 era).
8. ~~`?domoverlay=0` compositor test~~ — DEAD (2026-09-21).
9. ~~Upload-gate leak~~ — FIXED in v8.11 (§3.7).
10. **W4.2 deferred**: 2× backing-store supersample for dock/comments/guide canvases — only
    if text is still soft after the v8.4 sampling fix; costs ~4× UI upload bytes.
7. **Unimplemented (from the parent investigation, still relevant)**: abortable LRU blob
   cache with revocation discipline; abort stale blob fetches on navigation (currently only
   location transitions abort); Quest rendition selection (1536²/2048²) instead of raw 4K
   masters over USB — also cuts the per-upload blit cost and decoder buffer pressure.

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

### 7.1 Instrumented capture rig (`scripts/debug-quest-square-capture.cjs`)

Automates evidence collection during a square-positive session (added 2026-09-20,
after v8.9/v8.10 left steady-playback squares unresolved). Artifacts land in
`reports/quest-squares-<UTC>[-<label>]/` (gitignored). **One session = one
condition: pass a label at `start`, never narrate timestamps.**

```
node scripts/debug-quest-square-capture.cjs start [label]  # device check + 4 samplers
node scripts/debug-quest-square-capture.cjs status         # sampler liveness + capture count
node scripts/debug-quest-square-capture.cjs stop           # kill samplers + pull headset VideoShots/Screenshots/caps + manifest
```

Standard AB labels: `engine` (our player, control), `ab-direct` (video-path A/B
page), `bare2d` (raw `/media/…` URL in 2D). The label is stored in the session
dir name + `manifest.json`; additionally the diag payload carries `engine`
(version) and `src` (current video basename, v8.12+) so every session folder is
self-describing with zero out-of-band narration.

Samplers started by `start` (all background, pidfile `logs/quest-square-capture.json`):
1. Logcat **poller** (5 s `metavr log` dumps, deduped by device timestamp) → `logcat.txt`.
   metavr `logcat --follow` buffers silently when piped — never use it for capture.
2. On-device screencap loop — ONE persistent `adb shell` on the device runs
   `screencap` every `CAP_INTERVAL_MS` into `/sdcard/quest_caps/` (self-terminates
   on `/sdcard/quest_caps_stop`); bulk-pulled at `stop` via raw `adb pull`
   (~33 MB/s; metavr per-file pulls cost ~15 s each, its dir-pull and
   tar-over-shell are broken). metacam is absent on this device; screencap
   captures the stereo eye-buffer surface. `CAP_COUNT` caps the loop (default 400 ≈ 20 min at 2 s).
3. `GET /api/reels/diag` at 1 Hz → `diag.jsonl` (correlates in-app telemetry with
   capture frames).
4. `ovrgpuprofiler -t` every `GPU_INTERVAL_MS` (default 15000) → `ovrgpuprofiler.txt`
   (live FFR-level/GPU-stage readout). `start` runs `ovrgpuprofiler -e` first —
   it only traces apps started after enabling, so **force-close the Quest Browser
   app after `start`** (the checklist prints this); `stop` runs `-d`.

### 7.2 Video-path A/B (`/api/reels/vr-video-path-ab`, temporary diagnostic)

Answers the §3.7 owner challenge ("other sites play 8K cleanly"). Minimal page
(`ui/assets/vr_video_path_ab.html`, inlined three.js, route in `reels.py`):
one 4 m plane at the default lock spot with a **direct `THREE.VideoTexture`**
of the master — no canvas proxy, no UI meshes, no readbacks — i.e., the path
other Quest video sites use. `?master=` (server, path under media root) or
`?src=` (client) pick the file; defaults to the largest master. POSTs the same
`/diag` shape with `engine: 'v1-ab-direct-video-texture'`, so the capture rig
works unchanged.

In-headset during the session: steady playback only (switching holds suppress squares
since v8.9), optionally hold the headset capture button to record video
(`/sdcard/Oculus/VideoShots/`, pulled by `stop`). Env overrides: `CAP_COUNT`,
`CAP_INTERVAL_MS`, `GPU_INTERVAL_MS`, `DIAG_URL`.

Next session (all conditions, steady playback, rig running, watch flashes +
`QC2V4l2Codec` rate in logcat):
- **A. Our engine** (control — flashes expected)
- **B. AB page, same master** — clean → our canvas-proxy path is the problem
  (implement `?vrtex=video` direct-texture in the real engine; no transcoding);
  flashes → the file/format is the problem (then transcode Quest renditions)
- **C. Bare 2D `<video>` of the same file** (open `/media/…` directly, fullscreen):
  isolates file/format vs the whole VR-GL path
- **D (optional): decoder-noise check** — do the `queueOutputs` lines also log
  during any clean playback? If yes at similar rates, they're background noise,
  not the cause.
- **A. Our engine** (control — flashes expected)
- **B. AB page, same master** — clean → our canvas-proxy path is the problem
  (implement `?vrtex=video` direct-texture in the real engine; no transcoding);
  flashes → the file/format is the problem (then transcode Quest renditions)
- **C. Bare 2D `<video>` of the same file** (open `/media/…` directly, fullscreen):
  isolates file/format vs the whole VR-GL path
- **D (optional): decoder-noise check** — do the `queueOutputs` lines also log
  during any clean playback? If yes at similar rates, they're background noise,
  not the cause.

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
