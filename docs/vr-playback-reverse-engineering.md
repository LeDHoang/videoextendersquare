# How YouTube VR and PlayaVR play video, compared with our reels VR

Date: 2026-10-25. Static analysis of the builds installed on the user's Quest, pulled over adb:

| App | Package / version | base.apk sha256 |
| --- | --- | --- |
| YouTube VR | `com.google.android.apps.youtube.vr.oculus` 1.89.09 (18909000) | `d4a7841e…0c175151` |
| PlayaVR | `com.swearl.playa` 3.2.0 (939) | `ac136e74…ba2ce65` |

Tools: jadx (Java), Ghidra 12.1.4 through REA (native code), `dwarfdump`, and a custom IL2CPP metadata parser.
Each finding below is labelled:
- **Observed**: read directly from code or data.
- **Inferred**: concluded from observed code but not traced end to end.
- **Unknown**: not found.

Nothing in this report comes from watching the apps run.

---

## 1. Exact buffer and readahead amounts

### PlayaVR: observed

PlayaVR's own native player, `libPlayaMedia.so` (sha256 `167ee728…be511a0`), ships with DWARF debug info, so constants and logic decompile cleanly.

Defaults parsed in `pm::Session::do_open`. Evidence: Ghidra pseudocode of `0x14373c`, and string search `ev_f25f1b71…`.

| Option (JSON key) | Default | Clamp | Meaning |
| --- | --- | --- | --- |
| `buffer_ahead_sec` | **30 s** | target ≥ 4 MB | Readahead target = byterate × 30 s, where byterate = file size ÷ duration |
| `max_buffer_mb` | **256 MB** | ≥ 20 MB | Readahead is capped at `max_buffer_mb − 16 MB` |
| back buffer | **8 MB** | — | Bytes kept behind the read position |
| `preroll_ms` | **3000** | — | Bytes needed before the first frame = min(byterate × 3 s, **512 KB**) |
| `startup_buffer_ms` | **0 (off)** | gives up after 30 s | Optional extra wait before play |
| `gapless_preroll` | off natively; C# literal sends `true` | only for clips ≤ 15 s, for at most 6 s after open | Waits until the rest of the file can download in ≤ 0.9× its remaining play time |
| `seek_preroll_ms` | 2000 | 0–10000 | Buffer required after a seek |
| `seek_max_walk_ms` | 2000 | 0–60000 | Maximum decode-forward distance from a keyframe on a seek |

The C# wrapper (`PlayaMediaOptions.get_Defaults`) can override these keys. Its literals are in the IL2CPP metadata, but the values are set in compiled IL2CPP code that was not disassembled (see Unknowns).

Fetch loop, from `BufferedSource::io_main` at `0x14fc60`, evidence `ev_2e3f23e4…`:
- It keeps **one sequential HTTP stream** and reads **256 KB** at a time. It does not issue a separate range request per chunk.
- It stops reading when the bytes ahead reach the target, or when the window reaches `max_buffer_bytes`. It then re-checks every 50 ms.
- A seek outside the window re-opens the stream at the new offset.
- If the index (`moov`) sits at the end of the file, a separate tail connection fetches up to 32 MB (`kTailMaxBytes`).
- Bandwidth estimate: an exponential moving average of each read's throughput, `bps = 0.2·inst + 0.8·bps`.

Stall and rebuffer logic, from `Session::pump` at `0x140fc0`:
- **Low water:** less than **3 s** of media buffered ahead. Below this, the starvation and slip detectors are active.
- **Dry:** less than max(0.25 s of media, 256 KB) ahead, or less than 40 ms in the audio ring, for more than **700 ms**. A dry state starts a stall.
- **Starvation:** while buffer is low, playback advanced less than 50% of the expected distance over 1 s.
- **Clock slip:** slip accumulates and decays with a 2 s half-life. A stall triggers above 500 ms of slip; with hysteresis, it clears below 250 ms.
- **Rebuffer target when a stall begins** = clamp((media byterate − download rate) × 60, 3 s, 15 s) of media.
  - If the previous stall ended less than 45 s ago, the target is the previous target × 2, up to 15 s.
  - The target never exceeds the bytes left in the file.
- **During the hold:** after 1.5 s, the target is re-estimated as `ahead + fill_rate × (12 s − held)`, clamped to 3–15 s.
- **Resume:** once the bytes ahead reach the target and at least 2 s have passed.
  - Resume after 1 s instead if the rest of the file can download in ≤ 0.9× its remaining play time ("gapless finish").
  - After a stall ends, late-frame dropping is suppressed for 1.5 s.

Decode queue (`kFrameQueueDepth = 3`):
- Normally the queue holds 3 frames, or fewer if the decoder reports that.
- Above 3840×2160 pixels (`0x7e9000`), the queue is cut to **1 frame**, so an 8K video doesn't keep three 8K frames in memory.
- Late-frame rule: a frame is dropped when its timestamp + 50 ms is behind the clock and a frame was presented less than 100 ms ago (`kLateDiscardMs = 50`).

Other DWARF constants:
- `kChunkSize` 256 KB, `kAvioBufferSize` 64 KB, `kForwardWaitSlack` 2 MB.
- `kWarmupFrames` 128, `kWarmupMaxWallMs` 2000.
- `kHardResyncMs` 200, `kMaxTrim` 0.05, which means the A/V clock is corrected by at most ±5% playback rate.

PlayaVR also bundles AVPro Video, an ExoPlayer wrapper used for HLS/DASH streams:
- `DefaultLoadControl.setBufferDurationsMs(min, max, playback, afterRebuffer)`, with values passed in from C#.
- `setInitialBitrateEstimate(Long.MAX_VALUE)`, so ABR starts at the highest rendition.
- A `VideoStreamLimiter` caps resolution and bitrate.

### PlayaVR: runtime capture (logcat + `Player.log`, 2026-10-25)

Three local files were played: a 1024² H.264 clip, a 3840² HEVC clip, and a 3840×7680 10-bit HEVC 360° clip (8K). No streamed video was played, because no stream source was available.

- **Observed: the options the C# layer sends.** All three opens logged the same options:

  ```
  {"prefer_hw": true, "render_event_present": true, "nv12_direct": true,
   "audio_rate": 48000, "audio_channels": 2, "audio_latency_ms": 42}
  ```

  - None of the buffering keys are sent: `buffer_ahead_sec`, `max_buffer_mb`, `preroll_ms`, `startup_buffer_ms`, `seek_*` and `gapless_preroll` are all missing. So the **native defaults listed above apply** (30 s ahead, 256 MB, 3000 ms preroll, gapless off).
  - This holds for local files. Whether a streamed open sends different options is still unknown.
- **Observed: network layer settings** (logged at startup, used for streams): HTTP/2 transport, a 64 MB cache with a 24 MB "recent window", and the engine's default source window.
- **Observed: open timings for local files.**

  | File | Probe | Decoder open | First frame after open |
  | --- | --- | --- | --- |
  | 1024² H.264 | 21 ms | 28 ms | 62 ms |
  | 3840² HEVC | 5 ms | 20 ms | 41 ms |
  | 3840×7680 HEVC 10-bit | 14 ms | 37 ms | 151 ms |

  Even 8K reaches the first frame in about 150 ms when the bytes are local. Startup cost in Playa is almost entirely the network.
- **Observed: render path.**
  - Every open logged `hw decoder opened: mediacodec/… (surface output — zero copy)`.
  - Each frame is then resolved on the GPU into an RGBA8 texture **at full source resolution** (`resolve target 3840x7680 RGBA8`).
  - 10-bit video is reduced to 8-bit in that step, and the app warns about banding.
  - A startup warning says `OpenGLES3 has no zero-copy path; frames will go through CPU readback`. The per-open lines contradict it, so it probably refers to a different output path (inferred).
- **Observed: frame pacing.** During the 4K² and 8K clips the compositor reported 72/72 FPS, with 0–3 stale frames per second and no tearing.

### YouTube VR: amounts are server-sent; not in the APK

- **Observed:** all readahead and prefetch policy arrives as protobufs inside `MediaFetchHotConfig` / `MediaFetchColdConfig`. The native C++ types are:
  - `ServerReadaheadConfig`, `MinReadaheadPolicy`, `ReadaheadBasedPrefetchPolicy`, `SabrPrefetchConfig`
  - `BandwidthEstimationConfig`, `NearestRankBandwidthEstimatorConfig`, `BandwidthSamplingPolicy`

  These are RTTI strings in `libgoogle3.so`. The Java classes are protobuf-lite with obfuscated fields, so there are no field names or defaults.
- **Unknown:** the numbers. Ghidra ran out of memory on the 13 MB `libgoogle3.so`, so any fallbacks used when fields are absent were not recovered. A runtime capture (Stats for Nerds, or a proxy on the `/initplayback` response) is the realistic way to get them.

### YouTube VR: runtime capture (logcat, 2026-10-25, Quest 3)

Two videos were played: a 147 s flat video (moving closer and further away) and an 84 s 360° video. The app logs every QoE ping URL (`YT.qoe`) and its player events (`YT.mlplayer`). The field meanings below are inferred from their values; YouTube does not document them.

- **Observed: buffer health (`bh`, seconds of media ahead).**
  - Flat video: 46.7 s at 31 s, then 54.5, 68.4, 70.0, and 57–58 s later.
  - 360° video: 40.1 s at 31 s, then 24.3 s at 61 s. At 61 s only 23 s of the video was left, so it had buffered to the end.
  - So the server-sent readahead target is **about 60–70 s**, roughly 2× Playa's 30 s default.
- **Observed: downloads come in bursts (`bwm` = bytes : seconds).**
  - Flat: 28.8 MB in 4.3 s (≈ 54 Mbps), 19.0 MB in 2.6 s (≈ 58 Mbps), then 0.4 MB in 0.2 s while the buffer was full.
  - 360°: 140.8 MB in 9.4 s (≈ 119 Mbps), then 18.3 MB in 1.1 s (≈ 134 Mbps).
  - The client fills the buffer at full link speed, then idles until it drops.
- **Observed: startup.** From `loadVideo` to `onPlaying`:
  - 666 ms for the flat video (first playback, so the decoder was created).
  - 761 ms for the 360° video (decoder reused).
  - Decoder setup itself (`MediaCodec ttff`) took 37–56 ms, so almost all of the startup time is network.
- **Observed: smoothness.** Dropped frames (`df`) were 0 at every report, including across format switches.

## 2. Thresholds the quality picker uses

### YouTube VR

- **Observed:** the client sets a **target viewport** from how large the virtual screen appears in the headset.

  `VideoContainer.c(w, h)` receives the screen's on-screen pixel size from native code (`onVirtualScreenPixelSizeUpdate`). It then requests `(w × 1.5, h × 1.5)`, but only when the height changes by **≥ 150 px**.

  The initial viewport is `max(1920, longSide/2) × max(1080, shortSide/2)`.

  So YouTube aims for 1.5× the pixels the screen actually covers in your view, and updates when you move closer or further away.
- **Observed:** formats are chosen by **SABR**, which is server-side ABR.
  - The client sends `ClientAbrState` (viewport, bandwidth estimate, buffer state, ~70 fields) with each media request, and the server picks the next format.
  - The client's bandwidth estimate comes from `NearestRankBandwidthEstimator`, a percentile over recent samples, configured by the server.
  - A `FALLBACK_TO_CABR` path (client ABR) exists.
- **Unknown:** the numeric switch-up/down thresholds and the percentile. They live on YouTube's servers or in server-sent config.
- **Observed at runtime: what was chosen.** All video was **AV1 on the hardware decoder** (`c2.qti.av1.decoder`) with Opus audio (itag 251). The itags are 398 = 720p, 399 = 1080p, 400 = 1440p, 401 = 2160p.

  | Time | Reported viewport (`view`) | Format chosen |
  | --- | --- | --- |
  | Flat, 0.8 s | 1920 × 1080 (the initial default) | 399 (1080p) |
  | Flat, 36 s | 3295 × 1720 (moved closer) | 400 (1440p) |
  | Flat, 52 s | 2484 × 1401 | 401 (2160p) |
  | Flat, 90 s | 1234 × 628 (moved away) | 398 (720p) |
  | Flat, 91 s | 1234 × 628 | 400 (1440p) |
  | 360°, 0.5 s | 2329 × 1047 | 401 (2160p), held to the end |

  - It ramps up one step at a time (1080 → 1440 → 2160), about 15 s apart, rather than jumping to the top.
  - Moving away dropped it straight to 720p, but it went back up to 1440p one second later with the same viewport. So the viewport is not a strict cap on its own. The server also weighs bandwidth and buffer.
  - The player reports `lmq.2160` (inferred: limit max quality = 2160). Even the 360° video stopped at 2160p. Whether that video also had an 8K rendition is unknown.
  - Switches either open a new decoder (37–45 ms) or reconfigure the existing one (`CODEC_REUSE_MODE_REUSE_WITH_RECONFIGURATION`). Neither caused a visible stall.

### PlayaVR

- **Observed:** there is no ABR for progressive files. One file plays at its own bitrate, and stability comes from the byterate-relative buffering above.
- For adaptive streams (AVPro/ExoPlayer), it uses ExoPlayer's stock `AdaptiveTrackSelection` (media3 1.4.1 defaults), wrapped in `LimitedAdaptiveTrackSelection` with a user or device resolution cap. Startup is at the highest rendition.

## 3. Does the video go straight to the Quest compositor as its own layer?

### YouTube VR: only for flat DRM video

- **Observed (Java, `ghg` and `VideoContainer`):** the secure surface (`onSecureSurfaceCreated`, `nativeGetSecurePlaybackSurface`) is selected only when both of these hold:
  - the projection is flat (RECTANGULAR_2D/3D), and
  - the format carries Widevine DRM.

  All other video, including all 360°/180° and normal flat video, goes through `SurfaceTexture`, then an OES external texture, which the native renderer samples into the eye buffers (`samplerExternalOES` shaders in `libyoutubevrjni.so`, with XR_FB_foveation).

  This path is zero-copy, but it is **not** a separate compositor layer.
- **Observed:** `libyoutube_vr_impress_jni.so` imports `XR_KHR_android_surface_swapchain`. `RenderViewToOpenXr` uses it for **UI panels**: Android Views are drawn into an OpenXR swapchain surface. Evidence `ev_e7c827a5…` and `ev_e5fda8a1…`.
- **Inferred:** the DRM path creates an android-surface swapchain (protected content) and submits it as a quad layer.
  - The strings XR_FB_composition_layer_* and EGL_EXT_protected_content support this.
  - The cylinder and equirect layer extensions are absent from the strings.
  - The native call chain was not traced.

### PlayaVR

- **Observed:** MediaCodec decodes to a `SurfaceTexture`. The OES texture is resolved into an RGBA8 render target, and Unity textures the 180/360 mesh with it (`GlesTextureSink`, "OES resolve program").
- If surface output fails, it falls back to buffer output with a CPU copy.
- There is no compositor layer for the video.

**Conclusion:** neither app relies on compositor layers for normal playback. What both do is **zero-copy decode: decoder → SurfaceTexture → GPU texture**, with no CPU readback or re-upload.

---

## 4. What this means for our reels VR

How our stack works today:
- One progressive MP4 per reel. Masters are **3840² HEVC** (hardware encoders capped at 24–26 Mbps; stream copy and the libx265 fallback are uncapped), `+faststart`. A 2160 H.264 `-preview.mp4` also exists.
- In VR, frames are drawn by default through a **2048² canvas proxy** (`drawImage`, then `CanvasTexture` upload, `webxr_vr.js:14,4899`).
- A direct `THREE.VideoTexture` is used only with `?vrtex=video`, and **only in the desktop preview loop** (`onPreviewFrame`). The XR render loop always calls `uploadVideoFrame()`, so in the headset the flag left mono on the canvas path and broke stereo (`commitTextureStereo` is skipped). The direct path has never run in XR.
- One hidden `<video>` is meant to preload the next reel, but `nextVideo`/`prevVideo` set `lastSwitchTime` and then call `loadVideo` → `preloadNext` in the same tick. The 1500 ms throttle sees ~0 ms, clears the preloader and returns, and nothing retries. In practice **the next reel is never preloaded** after a swipe or auto-advance.

Recommendations, in order of expected impact:

1. **Remove the per-frame copy.** Both apps are zero-copy, but we do `drawImage` plus a full texture upload every frame.
   - Make the direct `VideoTexture` path the default and keep the canvas proxy as a fallback.
   - Quality matters here too. Playa resolves at full source resolution (up to 3840×7680) and still holds 72 FPS. Our proxy is 2048² for mono (half the linear resolution of a 3840² master) and 2048 px per eye for stereo (a large loss for 4K/8K stereo). It also caps uploads at 30/s (`VR_VIDEO_UPLOAD_MIN_MS = 33`), so 60 fps sources play at 30.
   - The direct texture is just the `map` on the same `screenMesh`, so Dome, SQ Curve and Flat all keep working.
   - **WebXR media layers** (`XRMediaBinding`) would give the sharpest image, because the compositor samples the video once at panel resolution and skips our eye buffer. They are a poor fit as the default path:
     - Shapes are quad, cylinder and equirect only. Flat maps exactly to a quad layer. Dome uses a radial spherical-cap warp (`createScreenGeometry` mode 1) and SQ Curve is biaxial, so neither can be reproduced; an equirect layer only approximates them.
     - Layers composite outside our projection layer. Drawing the comments overlay or anything else on top of the video needs a punch-through (video layer behind, transparent hole in the projection layer).
     - It requires the `layers` session feature, which changes the session setup that v8.17 had to strip down to stop the flashes.
     - At most, it could be an optional Flat-mode enhancement. **Parked for later**; not part of the `vr-rea-playback` branch.
   - **Cheaper quality lever: foveation.** three.js defaults XR fixed foveation to `1` (maximum), and we never call `renderer.xr.setFoveation`. With Dome filling much of the view, the outer part of the reel is rendered at reduced resolution. Try `setFoveation(0)` (or a low value) and, if GPU headroom allows, `setFramebufferScaleFactor` above 1. Check frame pacing and flashes in the headset.
2. **Start after a small buffer.** Playa shows the first frame once min(3 s, **512 KB**) is buffered. Our reels can start equally fast if the first ~0.5–1 MB of the next one or two reels is already local.
   - Preload **two** reels ahead instead of one.
   - Fix the "skip if last switch < 1.5 s" throttle first: as written it cancels every preload (see above). Schedule the preload after the active reel starts playing instead.
   - `faststart` is already set, which matters: Playa needs a separate tail fetch when `moov` is at the end.
3. **Pick resolution from the panel's on-screen size, like YouTube.**
   - Compute the panel's projected pixel height per eye and request about 1.5× that, with ~150 px hysteresis.
   - This needs at least two renditions per reel. The 3840² master and the existing 2160 `-preview.mp4` are already two.
   - Today every mono reel plays the 3840² master in VR, even when the panel covers only part of the view.
4. **Cap the bitrate.** Playa's buffer rules are all "seconds of media", which only holds up if the bitrate is bounded.
   - Hardware-encoded masters are capped (24M/26M/48M), but stream-copied masters keep the source bitrate, and the libx265 fallback (CRF 20) and the H.264 preview have no `-maxrate/-bufsize`.
   - Add VBV caps, e.g. 3840² HEVC ≈ 26 Mbps and the 2160 preview ≈ 12 Mbps.
5. **Handle stalls with Playa's logic** if we take over buffering (MSE, or watching `buffered`/`waiting`):
   - Hold until 3–15 s ahead, scaled by the bandwidth deficit, and double the target if stalls repeat within 45 s.
   - For short reels (≤ 15 s), wait up to ~6 s until the whole clip can download in 0.9× its duration, then play without stalls.
6. **Serving.** A single keep-alive stream with large reads is what Playa does. Starlette `StaticFiles` with Range support already fits.
   - Add `Cache-Control: public, max-age=86400` on dev `/media` (R2 already sends it), so preloaded bytes are reused. Not `immutable`: file names are not content-addressed and derived files are rebuilt in place.

## 5. Results on the `vr-rea-playback` branch (Quest 3S, 90 Hz)

Every run is 2 minutes in AUTO mode, recorded with `scripts/debug-quest-square-capture.cjs` (`reports/quest-squares-<UTC>-<label>/`).
- `switchMs` is load start to the first decoded frame of the new reel. With 4–5 switches per run it is noisy, and each run plays different reels.
- `dtMax` is the worst frame gap per second (diag, 1 Hz).
- Stale is the sum of the VrApi `Stale=` counts in logcat.
- Run-to-run noise is large: the same canvas path scored 49 ms and 31.7 ms dtMax p90 in two runs.

| Label | Build / flags | switchMs median (max) | dtMax p90 | rows > 25 ms | Stale total | FPS min | Decoder errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `baseline` | v8.23, canvas proxy | 105 (124) | 49.0 | 23 | 342 | 79 | 0 |
| `s1-direct` | v8.24, direct (default) | 193 (339) | 43.6 | 20 | 386 | 81 | 0 |
| `s1-canvas` | v8.24, `?vrtex=canvas` | 196 (199) | 31.7 | 18 | 253 | 83 | 0 |
| `s1-fov1` | v8.24, direct, `?vrfov=1` | 121 (372) | 56.2 | 23 | 300 | 80 | 0 |
| `s1-fov05` | v8.24, direct, `?vrfov=0.5` | 97 (402) | 38.7 | 18 | 298 | 80 | 0 |
| `s1-fov0` | v8.24, direct, `?vrfov=0` | 177 (425) | 34.2 | 18 | 318 | 82 | 0 |
| `s2-preload` | v8.25 + preload fix | 108 (153) | 34.1 | 24 | 265 | 79 | 0 |
| `s4-cache` | v8.25 + Cache-Control | 69 (69), 1 switch | 32.2 | 7 | 105 | 87 | 0 |

**Step 1: direct texture.**
- In the headset the direct path binds the full source: mono 3840×3840 and SBS 4096×2048, with the eye textures as `VideoTexture` clones.
- Verified in headset screenshots: Dome, the comments overlay and image posts (still on the canvas).
- Frame pacing is within run-to-run noise of the canvas path.
- `switchMs` does not depend on the texture path. It is measured on the `<video>` element.
- Not yet compared at a fixed paused frame: direct vs canvas sharpness. The headset was resting pitched down, so the video was out of view.
- Both paths sample with `LinearFilter` and no mipmaps. A 3840² texture on a panel about 700 px wide is minified about 5×, so fine detail may shimmer. Step 5 (picking a smaller rendition for small panels) is the planned mitigation.

**Step 1: foveation.**
- The flag reaches the compositor layer. In the headset the session's `XRProjectionLayer.fixedFoveation` reads 1 with `?vrfov=1` and 0 by default; its texture is 3360×1760.
- VrApi's `Fov=` logcat field stays 0 in every run, so it does not report WebXR layer foveation.
- No foveation level changed frame pacing beyond noise. fov 0 was no worse than three's default of 1 (dtMax p90 34.2 vs 56.2; stale 318 vs 300).
- VrApi shows `GPU%≈0.23` while a reel plays, so the GPU has plenty of headroom.
- The default is now **0** (off), so the periphery renders at full resolution. `?vrfov=` overrides it.
- Possible follow-up, not on this branch: given the GPU headroom, `setFramebufferScaleFactor` above 1 could sharpen the eye buffer itself.

**Step 2: preload.**
- `preloadNext` now warms the next reel once the active reel fires `playing`, or after 1.5 s if it never starts. Each switch cancels the pending warm-up and clears the preloader, so rapid flicks still open no background transfers.
- In the headset the preloader reached `readyState` 4 with 2 s buffered. Entering VR still clears the preloader on purpose, so the first reel after entry has nothing warmed.
- All 5 switches in `s2-preload` were preloader hits (0 before). The median was 108 ms with a max of 153.
- The same reels in `s1-direct` took 339, 221, 193 and 156 ms. Now they take 108, 118, 62 and 153 ms.
- No decoder errors with the second 4K decoder warm, and pacing within noise.
- The planned idx+2 range fetch was not added. idx+1 already hits every switch in AUTO, so idx+2 would only help rapid flicks.

**Step 3: bitrate caps.** Every file VR plays now has a bounded bitrate.
- Stream copy: a square HEVC master is copied only when ffprobe reports `format.bit_rate` ≤ 26 Mbps. Above that, or when the bitrate is unknown, it is re-encoded.
- The libx265 fallback is now capped CRF: `-crf 20 -x265-params vbv-maxrate=26000:vbv-bufsize=48000`. A 2 s test encode came out at 26.2 Mbps.
- The H.264 preview (`make_web_preview`) gets `-maxrate 12M -bufsize 24M` for mono and `20M/40M` for stereo proxies. On a 6 s test window the mono preview dropped from 20.0 to 13.9 Mbps; the excess is the VBV start-up burst.
- The 2D-only left-eye rendition (`-mono`) is not capped. VR never plays it.
- Read-only survey of `output/`: 15 of 68 masters are over 26 Mbps, 8 of them square 3840² HEVC that the old gate stream-copied (max 54 Mbps). The 31 existing previews have a median of 36 Mbps and a max of 70 Mbps.
- Existing files were not re-encoded. The caps apply to new uploads, so no Quest run was needed for this step.

**Step 4: cache headers on dev `/media`.**
- Dev `/media` now sends `Cache-Control: public, max-age=86400`, the same value R2 uploads carry. It is not `immutable`, because previews and stereo proxies are rebuilt in place; the ETag still revalidates them.
- The live dev server returns the header on both the 200 and the 206 (Range) response.
- `s4-cache` (2 min, AUTO): the first reel was long, so the run has a single switch, a 69 ms preloader hit. Pacing was within noise (dtMax p90 32.2, FPS min 87) with 0 decoder errors. The effect on revisits (prev) was not measured separately.

## Unknowns and how to resolve them

| Unknown | Why it is still open | How to get it |
| --- | --- | --- |
| YouTube ABR thresholds | Server-sent; native fallbacks not decompiled (Ghidra ran out of memory on `libgoogle3.so`). The runtime readahead (≈ 60–70 s) and the formats chosen are now measured (see above) | Proxy the SABR traffic, or retry Ghidra headless with a larger heap |
| PlayaVR options for **streamed** video | Local playback is resolved: no buffer overrides are sent, so the native defaults apply. No stream was played | Open any HTTP(S) MP4 in PlayaVR while capturing `adb logcat`, then read the `opening: … (options …)` and `buffer target:` lines |
| YouTube DRM quad-layer internals | Native call chain not traced | Disassemble the `ImpressNativeController` secure-surface path |
| `kStallThreshold`, `kCatchupMarginMs`, `kDefaultSeekMaxWalkMs` symbols | Stored as variables, not constants. The effective values found inline in `pump`/`do_open` are listed above | Not needed for the recommendations |
