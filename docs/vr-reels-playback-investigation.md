# VR Reels Playback Investigation — Quest 3S over USB

> On-device diagnosis of choppy + low-quality immersive WebXR reels playback on
> Meta Quest 3S connected via USB-C adb reverse. Documents the root cause, every
> fix attempted (what worked / what regressed), the live telemetry harness built
> to diagnose it, and the USB debugging workflow for future sessions.

---

## 1. The reported problem

- **Symptoms:** VR immersive reels playback is choppy; video quality looks "bad."
  Streaming (no preload) felt *less* choppy than preloading all reels.
- **Hardware:** Meta Quest 3S (Snapdragon XR2 Gen 2, **Adreno (TM) 740** GPU,
  ~1832×1920 per-eye panel, ~8 GB RAM), connected to a Mac host over USB-C.
- **Stack:** Vite dev server `:5173` + FastAPI `:8000`; the reels player inlines
  `ui/assets/webxr_vr.js` into the page HTML per request (`server/routers/reels.py`).
  Video served byte-for-byte off disk via Starlette `StaticFiles` at `/media/*`.

---

## 2. Root cause (telemetry-confirmed)

A live telemetry harness was added to the XR render loop (`webxr_vr.js: _postDiag`)
that POSTs ~1 Hz to `/api/reels/diag` (server in `server/routers/reels.py`).
CDP cannot see the Quest tab while it's in an immersive WebXR session, so the page
self-reports. Sample read while playing the Tron master in VR:

| Metric | Value | Meaning |
|---|---|---|
| `xrFrames` | ~22/sec | XR loop delivering only ~22 frames (target 72–90 → ~70% dropped) |
| `dtMedMs` | ~45 | median XR frame interval (should be ~11–14) |
| `dtMinMs` | ~5.5 | frames with **no** upload are fast → GPU can keep up |
| `dtMaxMs` | 73–115 | frames **with** a texture upload stall badly |
| `texUploads` | ~15–20/sec | fix #1 gating is working (not 90/sec) |
| `newDecoded` | ~30/sec | decoder keeps up (Tron is 30 fps) |
| `pqDropped` | 0–4 cumulative | **decode is NOT the bottleneck** |
| `videoW/H` | 3840×3840 | true 4K confirmed on-device |
| `gl.renderer` | Adreno (TM) 740 | Quest 3S GPU |
| `uploadMaxMs` | 0.1–0.2 | `texImage2D` JS time is **non-blocking** |
| `proxyW` (2048 vs 3840) | both stall ~112ms | **stall is size-independent** |

### Conclusion

The stall is a **GPU pipeline sync** that fires once per decoded frame when
`gl.texImage2D` *re-specifies* a texture that is currently being sampled by the
render draws. It is:

- ❌ **NOT decode** — `droppedVideoFrames ≈ 0`.
- ❌ **NOT DMA bandwidth** — uploading 56 MiB (3840²) and 16 MiB (2048²) stall
  identically (~112 ms). Size-independent.
- ❌ **NOT the JS upload cost** — `texImage2D` returns in 0.1 ms (non-blocking);
  the stall manifests later when the GPU samples the re-specified texture.
- ❌ **NOT network** — preload stores blobs in memory; stalls persist.

So **8K would be strictly worse** (same fixed flush cost, 4× the DMA, zero visible
gain on the ~1832 px/eye panel). The Quest 3S display physically cannot resolve
beyond ~2K per eye — 4K is already ~2× oversampled.

The "quality bad" half is a **separate, bitrate** problem: the 4K masters are
starved (Travis 5.8 Mbps, Tron 11.4 Mbps vs the 14 Mbps encoder target) → soft /
banded on a 4 m VR screen. **Resolution is already 4K; the fix is more bits, not
more pixels.**

---

## 3. Fixes attempted

### ✅ Fix #1 — Gate texture uploads to decoded frames (`webxr_vr.js`)
The original guard re-uploaded every XR frame because it keyed on
`videoElement.currentTime` (a float that updates continuously):

```js
// BEFORE (bad): uploads ~90×/sec
if (hasNewVideoFrame || vt !== lastVideoTime) { gl.texImage2D(..., videoElement); }

// AFTER: keys on getVideoPlaybackQuality().totalVideoFrames (ticks once per
// decoded frame) → uploads ~30×/sec. Zero quality loss (still full 4K).
const vf = videoElement.getVideoPlaybackQuality?.()?.totalVideoFrames ?? -1;
if (hasNewVideoFrame || vf !== lastVideoFrameCount) { gl.texImage2D(...); }
```
**Result:** necessary and correct (cut uploads ~3×) but **insufficient alone** —
each remaining 4K upload still stalls ~100 ms.

### ⚠️ Fix #2 — Cap the GL texture to 2048² via a proxy canvas
Draw the video into a 2048² 2D canvas (`drawImage`, GPU-side) then upload *that*
(16 MiB instead of 56 MiB). 4K masters stay on disk; only the in-VR texture is
capped. Invisible on the Quest 3S panel.
**Result:** `proxyW=2048` confirmed active, but `dtMax` stayed ~112 ms — **the
stall is size-independent, so this gave no smoothness gain.** Reverted from the
hot path (the proxy canvas + `VR_TEX_CAP` vars remain for future use). Could
still be re-enabled purely as a quality/quality tradeoff knob.

### ❌ texSubImage2D experiment — REGRESSED (black screen)
Tried updating the texture in place (`texSubImage2D` after a one-time
`texImage2D` allocation) to avoid the re-specification flush. On the Quest's
WebGL1 + Adreno/Chromium build this produced a **black screen (audio only)** —
the in-place update left the texture unrenderable. Reverted to direct
`texImage2D(videoElement)` (known-good, video visible). The re-spec-flush
hypothesis therefore remains **unconfirmed**.

### ✅ Fix #3 — Bitrate bump (`core/tooling.py`)
Raised the HEVC encoder target 14 → **24 Mbps** (maxrate 16→26, bufsize 32→48;
libx265 CRF 24→20) for VR-grade crispness. **Affects future renders only** —
existing masters on disk are not re-encoded (transcoding an already-encoded HEVC
stream adds generation loss without restoring baked-in softness; the real
quality fix for existing reels is to **re-render from source** through the
pipeline at the new bitrate).

### ✅ Fix #4 — Preload next-2, not all (`ui/assets/reels.html`)
The CACHE button used to fetch *every* filtered reel (~210 MiB of blobs) into
Quest RAM, which triggered blob eviction → the active video re-fetched byte
ranges over the slow adb-over-USB tunnel mid-playback (why streaming felt
smoother than preloading). Changed `preloadAllVideos` to fetch only a **sliding
window of the next 2 reels** (resident set ≤3 blobs).

### ⚙️ Fix #5 — OES external video texture (zero-copy) — ON-DEVICE: ext unavailable in WebGL1 → WebGL2 upgrade added
The only path that can eliminate the per-frame GPU sync is **zero-copy**: bind the
`<video>` decoder surface directly as a `TEXTURE_EXTERNAL_OES` and sample it with
`samplerExternalOES` in the shader — no `texImage2D`, no re-spec, no DMA, no sync.

Implemented in `webxr_vr.js` as a **dual-path, feature-detected** change:
- **On-device finding (logcat-confirmed):** the Quest Browser's **WebGL2 context
  cannot establish an XR compositor client**. On entering, the system logs
  `ImmersiveAppChangedCallback: com.oculus.browser, -1` and
  `OnForegroundVrAppClient: uid -1 pid -1 hasImmersiveApp 0`, then auto-exits the
  session ~0.7s later (`ImmerseApp -> InHomeVr`) — the "flash then thrown out."
  (WebGL1 `extOES:false` too — see above.) So neither the OES external nor the
  WebGL2 in-place path can run in *this* browser build. `VR_GL_MODE='auto'`
  therefore **prefers WebGL1** to restore a working session; WebGL2 remains
  available only when forced with `VR_GL_MODE='2'`.
- **WebGL2 upgrade (in code):** `initGL` now requests `webgl2` first (falls back
  to `webgl` for non-Quest devices) and selects **GLSL ES 3.00 variants of all 7
  shaders** (`VERT_V2/FRAG_V2/EXT_FRAG_V2/STAR_{VERT,FRAG}_V2/GLOW_{VERT,FRAG}_V2`).
  On WebGL2, `OES_texture_external` may be exposed → external path; else it arms
  the **`subimage`** path: allocate the 4K texture once, then `texSubImage2D`
  in place per decoded frame (valid API on WebGL2, same avoid-the-re-spec goal).
  `texTarget` now reports `'external' | 'subimage' | '2d'`.
- Telemetry reports `texTarget`, `gl.extOES`, `gl.glVersion`. Kill switch:
  `VR_TEX_MODE='2d'` forces the old path.

**Verify on-device** (`curl -s localhost:8000/api/reels/diag`): expect
`gl.glVersion` → `"WebGL 2.0 …"` and `texTarget` → `'external'` (best) or
`'subimage'`. Success = `dtMaxMs` collapses to ≈`dtMedMs` (~11–14ms, not 73–115ms)
on upload frames, `xrFrames` → 60+, `pqDropped` ≈ 0, video visible. If black →
set `VR_TEX_MODE='2d'` and retest; if `subimage` still stalls → the re-spec
hypothesis is wrong and the remaining lever is `VR_TEX_CAP` (2048²) size-cap.

---

## 4. The in-headset telemetry harness

Because CDP hides the Quest tab during immersive WebXR (see §5), the page
self-reports:

- **Client:** `webxr_vr.js` `_postDiag(time)` (called every `onXRFrame`) accumulates
  XR frame intervals + texture-upload count + decode stats, and `fetch(...,
  {keepalive:true})` POSTs a snapshot to `/api/reels/diag` ~1 Hz.
- **Server:** `POST /api/reels/diag` stores the latest payload in a module-level
  `_diag` dict; `GET /api/reels/diag` returns it.
- **Read live from the host:**
  ```bash
  watch -n1 'curl -s http://localhost:8000/api/reels/diag | python3 -m json.tool'
  ```

Fields: `xrFrames, dtMedMs, dtMinMs, dtMaxMs, over20, texUploads, uploadMaxMs,
drawMaxMs, proxyW, newDecoded, pqTotal, pqDropped, videoW, videoH, ct, gl{}`.

---

## 5. USB debugging workflow (Quest 3 / 3S → Mac)

### 5.1 adb reverse (device `localhost` → host)

```bash
# One-time per session (resets if adb server restarts / device reconnects)
~/Library/Android/sdk/platform-tools/adb reverse tcp:5173 tcp:5173   # Vite frontend
~/Library/Android/sdk/platform-tools/adb reverse tcp:8000 tcp:8000   # FastAPI backend
adb reverse --list                                                    # verify
```
On the Quest Browser open `http://localhost:5173/reels`. `localhost` is a secure
context, so WebXR works over plain HTTP. (The legacy Streamlit ports 8501/8502
are unused by this stack.)

### 5.2 Chrome DevTools Protocol (CDP) — 2D mode only

The Meta Quest Browser exposes `@chrome_devtools_remote`:

```bash
adb shell cat /proc/net/unix | grep devtools                       # find the socket
adb forward tcp:9222 localabstract:chrome_devtools_remote          # bridge to host
curl http://localhost:9222/json/version                            # Chromium version
curl http://localhost:9222/json | python3 -m json.tool            # list tabs
```
Connect a CDP client to a tab's `webSocketDebuggerUrl` to evaluate JS, read
console logs, etc. A zero-dependency probe lives at `debug-quest.cjs`
(node 26 global `fetch` + `WebSocket`); `debug-quest-newtab.cjs` spawns a fresh
controllable tab via `Target.createTarget` (existing VR tabs are hidden).

⚠️ **Limitation:** while a tab is in an **immersive WebXR session**, it is hidden
from `/json` and `Target.getTargets` (only extension/UI targets remain). Use the
in-page telemetry harness (§4) to read live VR metrics instead.

### 5.3 Device-level diagnostics

```bash
adb exec-out screencap -p > quest_view.png          # headset screenshot
adb logcat -d -s OculusBrowser:V chromium:V WebXR:V  # engine logs
adb logcat -d | grep -iE "oom|low.?memory|kill"      # memory pressure
```

### 5.4 Reload discipline (critical)

The reels player inlines `webxr_vr.js` into the page HTML per request, so a
**full tab close + reopen** is required to run new JS — a soft reload inside an
active WebXR session keeps the old inlined code alive (confirmed by `t_ms` not
resetting). Exit VR → close tab → fresh tab → re-enter.

---

## 6. Master file bitrate reference (`output/testpipeline/`, ffprobe)

| Master | Codec | Resolution | Bitrate | Note |
|---|---|---|---|---|
| `square_King Von - Back Again` | HEVC | 3840² | 28.8 Mbps | best in folder |
| `luma_square Ukraine drone` | HEVC | 3840² | 25.8 Mbps | 2 s clip |
| `square_The Weeknd - Popular` | HEVC | 3840² | 11.4 Mbps | near target |
| `square_Tron Legacy` | HEVC | 3840² | 11.4 Mbps | near target |
| `square_Project-X` | HEVC | 3840² | 11.0 Mbps | near target |
| `square_Travis Scott - MODERN JAM` | HEVC | 3840² | **5.8 Mbps** ⚠️ | starved → soft |
| `..._001_1080p_cropped` | **H.264** | 1080×778 | 13.1 Mbps | raw ingest, NOT 4K/square |

New renders target **24 Mbps** (`core/tooling.py`). Re-render the starved masters
from source to realize the quality gain.

---

## 7. Quick verification

```bash
# Servers up?
curl -s http://localhost:5173/api/health; curl -s http://localhost:8000/api/health
# New encoder target in effect?
rg "24M|crf" core/tooling.py
# Preload windowed?
curl -s 'http://localhost:8000/api/reels/player?folder=testpipeline' | rg "NEXT 2|sliding window"
# Live VR telemetry?
curl -s http://localhost:8000/api/reels/diag | python3 -m json.tool
```

## 8. Key file:line references

- Texture upload guard (fix #1): `ui/assets/webxr_vr.js` `onXRFrame`
- Video texture paths (fix #5): `webxr_vr.js` `initGL` (WebGL2 + GLSL ES 3.00), `EXT_FRAG`/`EXT_FRAG_V2`, `drawVideoGrid`, `onXRFrame` (`subimage` via `texSubImage2D`)
- Telemetry POST + fields: `ui/assets/webxr_vr.js` `_postDiag` (now incl. `texTarget`, `gl.glVersion`, `gl.extOES`)
- Diag endpoint: `server/routers/reels.py` `post_diag` / `get_diag`
- Encoder bitrate: `core/tooling.py` `HEVC_CANDIDATES`
- Preload window: `ui/assets/reels.html` `preloadAllVideos` / `updatePreloadStatus`
- CDP probes: `debug-quest.cjs`, `debug-quest-newtab.cjs`, `debug-quest-targets.cjs`
