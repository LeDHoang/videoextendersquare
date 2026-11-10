# VR immersive playback and loading review

Date: 2026-10-21. Scope: read-only review of how a reel is loaded and played in the immersive (WebXR) player. No code was changed, and nothing here was measured on a headset. Every statement below comes from reading the code at the line numbers given. Behavior on a Quest still needs the device matrix in `docs/vr-reels-playback-investigation.md`.

Update 2026-11-10: the section "Device evidence, 2026-11-10" at the end of this file adds measurements from a Quest 3S and corrects problems 1, 6 and 7.

This review closes the todolist item "Review VR immersive-mode reel playback and loading". It re-checks the findings in section 0 of the investigation doc against the current code, because that section's line anchors and several of its claims are out of date.

## How a reel loads and plays today

1. **Choosing the file.** `playbackFor` (`ui/assets/reels.html:2720`) returns the stereo rendition for a 3D post when the player is in VR (`wantsStereoSource()`) and the post has not failed in 3D. Otherwise it returns the normal file, with a CSS left-eye crop for a raw stereo file in 2D.
2. **Loading the active reel.** `loadVideo` (`:5566`) sets `video.src` to a cached blob URL if one exists for that index and URL, and to the network URL otherwise. It then calls `preloadNext`, tells the VR engine through `WebXRVR.onVideoChange()`, and starts playback. A rejected `play()` retries muted.
3. **Preloading the next reel.** `preloadNext` (`:5499`) points the hidden `#preloadVideo` element (`:2165`, `preload="auto"`) at the next reel. It does nothing for 1500 ms after a switch, so quick swiping does not start background transfers. For an image post it warms the cache with an `Image`.
4. **Blob cache.** The CACHE button, the `L` key and an automatic call at `:6930` run `preloadAllVideos` (`:5871`). It downloads the next two reels completely with `fetch(...).blob()` and keeps object URLs in `blobUrlMap`. `pruneBlobCache` (`:4248`) keeps only the current index plus the next two and revokes the rest. A fetch is cancelled through an `AbortController` when the feed changes.
5. **Entering VR.** `enterVR` (`ui/assets/webxr_vr.js:9176`) requests the session first, so a rejection leaves the 2D player alone. It then stops any desktop preview, builds a fresh canvas and renderer, binds the session, and installs the XR animation loop. The host callback `onEnterVR` runs `syncStereoSource` (`reels.html:3137`), which swaps a 3D post to its stereo file and resumes at the same playhead.
6. **Every XR frame.** The loop calls `uploadVideoFrame` (`webxr_vr.js:6079`). It draws the `<video>` into a 2D proxy canvas and uploads that as a texture. For stereo it uses one 2:1 or 1:2 proxy, and each eye samples its half. Uploads happen when the visual changed, when a new decoded frame arrived (`requestVideoFrameCallback`, `setupVideoFrameTracking` at `:7356`), or after a seek jump. Video uploads are capped at about 30 per second (`VR_VIDEO_UPLOAD_MIN_MS = 33`, `:736`). A freshly switched video waits up to 2.5 s for `readyState >= 3` before its first upload (`FRESH_VISUAL_MAX_HOLD_MS`, `:5810`), and the last frame stays on screen during the wait.
7. **Leaving VR.** The session `end` handler stops the loop and frame tracking, removes the canvas, calls `onExitVR`, and restores the desktop preview if its canvas is still attached.

## What has changed since the investigation doc

These items are described as problems in section 0 of `docs/vr-reels-playback-investigation.md` and no longer match the code.

- **Frame skipping is gone.** There is no `vrMinStride` or adaptive stride in `webxr_vr.js`. Upload gating is now "new frame or visual change", with the 33 ms cap.
- **The blob cache is bounded.** `pruneBlobCache` revokes old object URLs, and `preloadAllVideos` only fetches the next two.
- **Fetches can be cancelled.** `preloadController` aborts them when the feed changes.
- **Desktop glow stops in XR.** `updateDesktopGlow` (`:7210`) returns while `WebXRVR.isPresenting()` is true.
- **The comment overlay is throttled.** `refreshOverlayTexture` (`webxr_vr.js:6276`) re-renders only when the set of active comments or the hover target changes, and repaints for fades at most once per `VR_UI_MIN_INTERVAL` (100 ms).
- **Stereo has a single upload.** Both eyes share one texture through cloned views, so a frame is uploaded once.

## Problems, ranked

Each problem lists the Phase 0 item of `docs/todolist.md` it belongs to.

1. **No physical-device evidence for any of the above.** Every fix since the investigation doc was written is unverified on a Quest. This is the blocker for all other Phase 0 work. *Phase 0: "Complete the controlled physical-Quest playback matrix", "Verify bounded cache, cancellation, memory stability, buffering, frame pacing, and thermal behavior on device".*
2. **Cached blobs go unused after entering or leaving VR.** `syncStereoSource` repoints the hidden preload element to the right variant (it calls `preloadNext` at `reels.html:3180`). The blob cache is different: `blobFor` (`:2734`) only accepts a blob whose source URL matches, so blobs fetched for the 2D file are ignored once VR wants the stereo file, and the other way round. They stay in memory until `pruneBlobCache` drops them, and the new variant is downloaded again. *Phase 0: "Measure and control contention from hidden preload", "Verify bounded cache".*
3. **Two transfers can fetch the same reel.** The hidden `#preloadVideo` element and `preloadAllVideos` both download the next reel, one as a media element and one as a whole-file `fetch`. With the automatic call at `:6930` both run during normal playback. *Phase 0: "Measure and control contention from hidden preload".*
4. **The cache downloads whole files into memory.** `fetch(...).blob()` has no byte limit, so a long 4K H.264 file for each of the next two reels sits in memory while the active video also decodes. The docs measured roughly 210 MiB for the older "preload all" version on an 8 GB device. The present window is smaller, but there is still no cap on bytes. *Phase 0: "Verify bounded cache ... memory stability".*
5. **Session end does not dispose GPU resources.** The `end` handler (`webxr_vr.js` after `:9396`) removes the canvas and stops the loop, but does not call `dispose()` on the video, stereo or eye textures or on the renderer. One teardown path does call `renderer.dispose()` (`:9524`); trace whether the session-end path reaches it before relying on repeated VR sessions staying flat in memory. *Phase 0: "memory stability".*
6. **The 33 ms upload cap limits 60 fps content to about 30 fps.** That is right for the 30 fps masters in the investigation doc, and wrong if any rendition is 60 fps. The cap is not tied to the source frame rate or the XR display rate. *Phase 0: "Remove normal-path decoded-frame skipping" (the stride was removed, but this cap is a smaller form of the same trade).*
7. **The first frame after a switch can wait 2.5 s.** The fresh-visual hold favors a clean first frame, and holds the previous frame on screen meanwhile. On a slow tunnel or a long file this reads as a freeze rather than a loading state. There is no loading indicator in VR for this wait. *Phase 0: "buffering".*
8. **Rendition choice is not automatic.** The player uses whichever file the post offers (`entry.url` or `entry.stereo_url`). It does not pick a rendition by device, codec support or bandwidth, and an HEVC file that Quest Browser rejects only shows an error message. *Phase 0: "select a validated Quest/browser rendition automatically".*
9. **Stale comments.** The comment above `preloadAllVideos` says "current + 1 ahead" while the code fetches two, and the button label reads "NEXT 2". Harmless, but it misleads the next reader.

## What to do next

Nothing here needs code before the device matrix is run. Order of work, all inside Phase 0 and VR Phases 0–6, which are out of scope for P2:

1. Run the Quest matrix with the existing telemetry and record the Quest Browser and Horizon OS versions.
2. Fix items 2 and 3 together: one preload mechanism, keyed by the variant (2D or stereo) that the next swipe will use, and dropped or refetched on enter and exit.
3. Add a byte cap and range requests (or drop the blob cache for the hidden-element preload alone) for item 4.
4. Trace and fix session-end disposal (item 5) with a memory snapshot before and after three enter/exit cycles.
5. Pick the rendition automatically (item 8) once the matrix shows which rendition holds frame pacing.

## Device evidence, 2026-11-10

This section extends the review with measurements from a headset. It does not replace the Quest matrix: it covers one device, one network and mono reels only.

### Setup

- Quest 3S, Horizon OS v209, OculusBrowser 154.1.0.32.54, connected over USB.
- Production site `https://echomultiverse.com/reels?xrdiag=1`, engine `v8.28-20261026-glow-probe-gpu-scale` (the same as commit `3a5585d`).
- The session ran at 90 Hz with a 5040x2640 projection layer (framebuffer scale 1.5), no foveation and no MSAA.
- The page was driven over the Chrome DevTools Protocol. Frame pacing comes from the `VrApi` lines in logcat, page state from a sampler injected into the tab, and the picture from `adb screenrecord`. The page clock and the recording agree to within about 0.05 s.
- The network gave the Quest about 4.8 Mbps for media during the runs.

### Frame pacing

The A/B runs looped one clip from a blob URL, so the network played no part. Each phase lasted 15 s. The 3840x3840 file is the production master (HEVC, 54 Mbps). The 2048x2048 file is a test encode of it (HEVC, 7.5 Mbps). Both presented 30 frames per second with none dropped.

| Framebuffer scale | Content | Compositor fps | Stale frames per second | App GPU time | GPU use |
|---|---|---|---|---|---|
| 1.5 (default) | image post, idle | 88.5–90 | 0–6.5 | 8.5–8.6 ms | 82–87% |
| 1.5 (default) | 3840x3840 video | 81 | 14 | 10.35 ms | 94% |
| 1.5 (default) | 2048x2048 video | 84 | 13 | 10.16 ms | 94% |
| 1.25 (`?vrfbs=1.25`) | image post, idle | 90 | 3 | 7.43 ms | 77% |
| 1.25 (`?vrfbs=1.25`) | 3840x3840 video | 90.5–91 | 2.5–3 | 8.2–8.3 ms | 82–83% |
| 1.25 (`?vrfbs=1.25`) | 2048x2048 video | 91 | 1–1.5 | 7.9–8.3 ms | 80–82% |

What this shows:

- **Still content holds 90 fps at the default scale. Video does not.** Uploading a video frame adds about 1.7 ms of GPU time at scale 1.5, and that pushes the frame over the 11.1 ms budget several times a second. In the free-running production passes, 4K video segments ran at 69–83 fps with 20–34 stale frames per second.
- **The framebuffer scale is the limiter, not the source resolution.** A 2048x2048 source gave almost the same pacing as the 3840x3840 master, because the engine caps the texture at 2048 either way. Scale 1.25 restored 90 fps for both.
- **The CPU is not the limiter.** The XR callback averaged 2.4–3.2 ms. The headset stayed at 38–39 °C with no throttling.
- A stale frame is re-projected by the compositor, so head rotation stays smooth. The cost is judder on the dock and on screen edges while the head moves.

Foveation (`?vrfov=1`), scale 1.35 and `?dockfreeze=1` were not measured. The headset lost room tracking, and Quest Browser then rejects `requestSession` with "The page is not visible".

### Loading and switch latency

- **Entering VR** took 1.4–1.7 s from the click to a presenting session, followed by one hitch of 237–350 ms.
- **A preloaded video** showed its first frame 110–130 ms after the switch. The recording shows the scene change at +0.13 s.
- **An image post in VR is downloaded twice, and the headset waits for the second copy.** The `<img>` loads the file without CORS. `vrImageSource` (`ui/assets/reels.html:3235`) then fetches it again with `cache: 'reload'` to build a bitmap, and the engine keeps the previous picture until that bitmap is ready. The next-image warmer (`warmNext`, `:5771`) only warms the no-CORS copy, so it does not help VR. In the recording the new image appeared 0.3–0.5 s after the click in the normal case. One switch took 4.8 s, because the fetch shared the connection with a 45 MB video preload. The 2D figure of 9–15 ms is the `<img>` load event and does not describe what the headset shows.
- **Videos rebuffer because the masters are far above the link rate.** The feed serves HEVC 3840x3840 at 22–54 Mbps and H.264 4092x2046 at 35.5 Mbps. A 5.1 s clip at 22 Mbps stalled twice (1.05 s and 3.14 s). A "Loading…" spinner is drawn over the frozen frame in VR during the stall.
- **The preload is partly wasted at the switch.** The hidden preload request (`bytes=0-`) was aborted when the reel became active, and the active element asked again from `bytes=9175040-`.

### Picture quality

- Video is sharp. The texture is 2048 wide for one eye's view, and the 5040x2640 layer does not lose detail from it.
- Image posts are soft. They are PNG files 1080 pixels wide, so they have about half the pixel density of a video when they fill the same screen.
- Scale 1.25 was not compared with 1.5 for sharpness by eye. That check needs a person in the headset.

### Changes to the ranked problems

- **Problem 1 (no device evidence)** now has evidence for frame pacing, switch latency and rebuffering on one device. Memory across sessions, stereo reels and the full matrix are still open.
- **Problem 3 (two transfers for one reel)** is confirmed in two forms: the double image download in VR, and the preload request that is aborted and repeated at the switch.
- **Problem 6 (33 ms upload cap)** does not limit the current feed, where every source is 24 or 30 fps.
- **Problem 7 (no loading indicator)** is wrong for rebuffering: the spinner exists. It still applies to image posts, where the old picture stays with no indicator.
- **Problem 8 (no rendition choice)** is the cause of the rebuffering above.

### New problems, ranked

1. **Video playback misses 90 fps at framebuffer scale 1.5.** Options: lower the default to 1.25, turn on foveation, or run video at 72 Hz. Each trades sharpness or motion smoothness for pacing, and only 1.25 has been measured.
2. **Masters are served directly to the headset.** A 2048x2048 rendition at about 8 Mbps looks the same in the headset (the texture cap is 2048) and needs one seventh of the bytes. This fixes rebuffering. It does not fix frame pacing.
3. **Image posts switch late in VR** (0.3–0.5 s, and seconds when a video preload is running), because of the second download.
4. **The dock texture is uploaded 10 times a second with no dirty check** (`updateUiTextures`, `ui/assets/webxr_vr.js:7979`). The cost is not measured.
5. **The 237–350 ms hitch after entering VR.** Low priority.

### Not covered

- Stereo (3D) reels. Every reel in these runs was mono.
- A video switch without a preload.
- Foveation, scale 1.35 and the dock upload cost (see above).
- Memory over repeated sessions (problem 5).
- The `QC2V4l2Codec ... Allocation failed!` warnings in logcat. Playback continued, and their meaning is not confirmed.

### Files

Scripts and small logs are in `docs/perf-probes/2026-11-10/vr-playback/`:

- `capture2.mjs`: enters VR over CDP, steps through reels and samples page and XR state.
- `ab.mjs`, `abrun.sh`, `abparse.py`: the A/B driver, its wrapper (logcat capture and phase markers) and the per-phase summary. `ab-base/` and `ab-fbs125/` hold the logcat and driver log of the two valid runs. A phase counts only when the driver logged it as clean; the first two video phases of `ab-base` were not playing the test clip.
- `vrapi.py`, `xr.py`, `timeline.py`: summaries of `VrApi` lines, XR frame samples and the page timeline.
- `run1-vrapi.txt`, `run2/vrapi.txt`: the `VrApi` lines of the two free-running passes.
- `run2/scenes.txt`, `run2/n2.jpg`, `run2/n5.jpg`, `run2/stall_strip.jpg`: scene-change times and frame strips from the recording.

The 78 MB recording, the capture JSON files and the full logcats are in `output/vr-playback-2026-11-10/`, which git ignores.

## Rerun on the integrated fixes, 2026-11-10

The fixes from the review were combined in the `vr-fixes-integration` worktree (staged, not deployed). They were tested on the same Quest 3S over USB debugging, on the production site, by replacing `reels.html` and `webxr_vr.js` in the headset's tab over CDP. Server changes (the 2k renditions, the diag endpoint) were not live, so the rendition path was tested with one hand-made 2k file.

Four passes ran the same reel list with the same driver: `prod-control` (production code), `int-default` (integration, default flags), `int-tex3840` (integration, texture cap 3840) and `int-r2k` (integration, with a 2048x2048 rendition served for one video). Two short passes followed: `dockprobe` (an instrumented `webxr_vr.js` that logs why the dock repaints) and `probe404` (a network listener for 4xx responses).

### Verified fixed

| | prod-control | int-default | int-tex3840 | int-r2k |
|---|---|---|---|---|
| Framebuffer scale | 1.5 | 1.25 | 1.25 | 1.25 |
| Video fps (median) | 86 | 90 | 90 | 90 |
| Video stale frames/s | 8 | 3 | 2 | 3 |
| Video app time | 9.8 ms | 8.1 ms | 8.1 ms | 8.1 ms |
| Video GPU load | 0.94 | 0.81 | 0.80 | 0.81 |
| Image fps / stale | 90 / 0 | 90 / 0 | 90 / 0 | 90 / 0 |
| Hitch after entering VR | 299 ms | 260 ms | 254 ms | 94 ms |

- **Frame pacing (new problem 1):** fixed by scale 1.25. Video now holds 90 fps.
- **Texture cap 3840:** the flag is applied and costs nothing measurable at scale 1.25 (90 fps, GPU 0.80).
- **Preload cleared at the switch (problem 3, second form):** in `int-default` the preloaded reel was not aborted at the switch. This is only partly proven. `int-tex3840` still aborted one reel's preload six times, with a 266 ms stall near entry. In `int-default` the Popular_Media `bytes=0-` request was cancelled twice (at 6.5 s and 7 s), and that switch took 6.2 s.
- **Double image download (problem 3, first form):** not a real double download. Each image has an `Image` request of about 350 bytes with no body, plus one full `Fetch`. The bytes move once.

### Not fixed

1. **The dock still repaints about 10 times a second during playback.** The dirty check in `updateUiTextures` works, but its key includes the seek position at 1/1024 of the duration (`webxr_vr.js`, `dockKey` index 7). `dockprobe` logged 310 key changes; index 7 changed on every one, the whole-seconds field on 37. Any reel shorter than about 100 s, and every image post on its 14 s timer, moves more than 1/1024 per 100 ms tick. Uploads: 9–10/s, the same as production. Frame rate is met, so this is low priority. Fix: cap the seek repaint (for example 4 Hz), use a coarser step, or draw the seek bar apart from the dock texture.
2. **The link estimate can pick the master on a slow link.** `noteDownload` in `reels.html` keeps only the last whole-file preload of 1 MB or more. One fast sample (a cache hit, or a hot CDN edge) sets 60 Mbps or more, and VR then plays the master. In `int-r2k` the 2k file (2.5 MB in 171 ms, 119 Mbps, served locally by the test) was followed by the 4092x2046 master, which stalled 920 ms and 975 ms and had its `bytes=0-` requests cancelled. The local serving is a test artifact, but the same thing happens with any cache hit. Fix: ignore disk-cache samples and use the minimum or median of the last few samples.
3. **Image posts are large and their time to first byte varies.** The PNGs are about 1 MB each (26–29 MB per pass). Time to first byte, median / p90: production pass 212 / 429 ms, `int-default` 1374 / 5942 ms, `int-r2k` 164 / 316 ms. Same code was fast and slow, so the spread is network or CDN, not the fixes. With files this size it still sets the image switch time (an image appears 1–1.6 s after the tap). Fix: serve WebP or a VR-sized image rendition.

### New findings

- **`/api/reels/diag` returns 404 about once a second in VR.** The beacon is `postXRDiag` in `webxr_vr.js`, sent only with `?xrdiag=1`. Production has no such endpoint. Probe-only and harmless, but it fills the console.
- The `int-r2k` 2k file decoded at 2048x2048 and drew its first frame. It resumed at 10.39 s of a 10.56 s clip and ended at once, so 2k playback was not watched for long. This pass does not prove the rendition's quality or its effect on rebuffering.
- Diag `src` often differs from the driver's reel label for image posts. They are slideshows that change slide about every 5 s. Production does the same; not a bug.

### Not covered

- Sharpness by eye: 2048 vs 3840 texture cap, scale 1.25 vs 1.5, 2k rendition vs master. This needs a person in the headset.
- Real 2k renditions on a slow link. This needs the server change deployed and the renditions generated.
- The dock upload rate while a reel is paused.
- The screen recordings (`rec.mp4`) of these passes were not reviewed frame by frame.
- Stereo reels and memory across sessions (still open from above).

### Files

`docs/perf-probes/2026-11-10/vr-playback/run3/`:

- `run.sh`: wraps one pass (logcat, warnings, screen recording, driver).
- `verify.mjs`: the CDP driver (override, enter VR, step reels, capture network and console).
- `hook.js`, `sample.js`: the page-side capture hook and the per-sample page state.
- `hunks.mjs`: applies the integration diff of `reels.html` and `webxr_vr.js` as text blocks for the override.
- `analyze.py`: the per-pass summary. Its `imgDupes` count and image `visMs` are not reliable (see above).
- `<pass>/summary.json`: the summary of each of the four main passes.

Captures, logcats and recordings are in `output/vr-playback-2026-11-10/run3/`, which git ignores.

## Why the loading notice shows more often (2026-11-10)

The VR "Loading…" notice appears when the active reel's `<video>` stays below `readyState` 2 for more than `LOAD_SPINNER_DELAY_MS` (500 ms), or when playback stalls for that long (`webxr_vr.js` `reelLoadState`). So the notice shows whenever a reel's first frame takes more than half a second, or when a reel rebuffers.

**Cold vs warm first frame on the Quest** (`docs/perf-probes/2026-11-10/vr-playback/cold/cold_first_frame.mjs`, live site, Taiwan network):

| Reel | Not in browser cache | In browser cache |
|---|---|---|
| Feed reel 1080×778 (edge HIT, TTFB 967 ms) | 1778 ms | 63 ms |
| 4092×2046, 15 s | 430 ms | 211 ms |
| 3840², 15 s | 377 ms | 116 ms |
| 2046² HEVC / H.264, 2 s | 124–170 ms | 70–75 ms |
| Image post 0.5–1 MB (fetch) | 166–572 ms | 10–12 ms |

The 2026-10-25 measurement of the same path, through `adb reverse` to a local server, gave a cold median of 96 ms. Every feed mp4 is faststart (`moov` before `mdat`), so the file layout adds no round trips.

**Causes, by case:**

1. **All cases, live site:** since 2026-11-07 media comes from `media.echomultiverse.com` (R2 behind the Cloudflare edge) over Wi-Fi. The current access network adds about 100 ms per round trip, with spikes to 394 ms, DNS outliers of 1–2 s, and one 11 s TLS handshake (see `../README.md`). A reel that is not in the browser cache now needs 0.4–1.8 s to its first frame, which crosses the 500 ms threshold. A reel in the cache still starts in 60–220 ms.
2. **vid→vid:** only the next reel is warmed, and only after the current one plays or after `PRELOAD_DELAY_MS` (1500 ms). A swipe before the warm-up finishes, a swipe back, or a jump from a list hits the cold path.
3. **img→vid:** the same rule. On an image there is no `playing` event, so the next video starts warming 1.5 s after the image shows. A quick swipe off an image lands on a cold reel.
4. **vid→img and img→img in VR:** the headset waits for its own bitmap fetch (`cache: 'reload'`), so a new image shows after 0.17–0.57 s on this network, and after several seconds when the network stalls (one fetch took 9 s in `int-default`). There is no notice for images; the old picture stays.
5. **During playback:** masters at 22–54 Mbps are above what this link delivers, so they rebuffer and the notice is drawn over the frozen frame (see "Videos rebuffer" above).
6. **Integration build only (not live):** `preloadNext` keeps a preloader that holds the reel now on screen. On auto-advance from the 4K reel, the active element sat at `readyState` 0 for about 2.8 s while the preloader held the same file at `readyState` 4. Two `bytes=0-` requests were cancelled and the switch took 6.2 s. The live code clears the preloader at once and reached `readyState` 2 within 605 ms in every switch of `prod-control`.

**Not a cause:** `3a5585d` (hold the old frame until `readyState` 3) and `b227329` (upload before draw). The notice looks at `readyState` 2, and in the cold probe `readyState` 2 and 3 arrived within 1 ms of each other. The list-order commits `b441a93` and `709cde1` change only the server order; the client warms whatever is next in that order.

**Limits:** most feed reels were already in the Quest's browser cache from the earlier passes, so only one fully cold reel was measured. The passes in `run3` were mostly cache hits too, so their switch times understate what a new viewer sees.

## Dock and link-estimate fixes on the Quest (2026-11-10, `v2-r2k`)

The dock fix (d38ce26) and the link-estimate fix (419009f) were applied to the `vr-fixes-integration` working tree, unstaged and uncommitted. Web tests passed: 581 node, 563 vitest. Pass `v2-r2k` repeated `int-r2k` on the same Quest over the same Wi-Fi.

- **Dock uploads: fixed.** Median 3/s (max 5), down from 9/s (max 10) in `prod-control`, `int-default` and `int-r2k`. Frame rate is unchanged: 90–91 fps, no stalls, no console errors.
- **Link estimate: not exercised on the device.** `noteDownload` runs only in `preloadAllVideos` (the `L` key). No pass pressed it, so no samples were taken and VR stayed on the 2k rendition, the same as in `int-r2k`. In `int-r2k`, the 4092x2046 file after the 2k file was the next reel (`vt0i6nuqNEo`), which has no 2k rendition. Its stall was not caused by the link estimate, so "Not fixed" item 2 has no evidence from the device. The fix is covered by unit tests only.
- **Side effect:** in normal VR use, nothing measures the link, so a reel with a 2k rendition always plays the 2k file. The master is chosen only after `L` preloads have given at least three samples of 1 MB or more, with a median of 60 Mbps or more.

## Preloader fix on the Quest (2026-11-10, `v3-preload`)

`preloadNext` in the `vr-fixes-integration` working tree (unstaged, uncommitted) now clears the preloader on every switch again, as the live code does. The integration-only rule that kept a preloader holding the reel now on screen was removed (cause 6 above). On an image post, the next reel is warmed at once instead of after `PRELOAD_DELAY_MS` (cause 3). Web tests passed: 581 node, 563 vitest. Pass `v3-preload` repeated `v2-r2k` on the same Quest over the same Wi-Fi.

- **img→vid warm-up: fixed.** The next video's first request started 713–721 ms after the swipe onto the image (4 of 4), down from 2.0–3.1 s in `prod-control`, `int-r2k` and `v2-r2k`. These figures compare the Mac's clock with the headset's and include their offset; the page-clock figures are in the next section. All 5 video switches were cache hits (`switchFromCache`), with switch times of 67–168 ms and first frames at 326–585 ms.
- **Held preloader: removed.** No switch sat at `readyState` 0. The worst video switch took 585 ms, against 6.2 s in `int-default`.
- **Not exercised in this pass:** auto-advance from the 4K reel and a fast swipe off an image. Both are covered in the next section.
- **Still seen:** one stall of 973 ms during the 4092x2046 master `Lyric Video` (cause 5). Its first bytes came from the preloader; the stall came later in the file, on a range request over Wi-Fi.
- 90–91 fps, dock 3/s (max 5), no console errors.

## Auto-advance and fast swipes on the Quest (2026-11-10, `v4-edge` to `v6-fast*`)

The driver gained a step script (`SPEC`: `end`, `fastN`), a feed order (`ORDER`) and events from the hidden preloader. All times below are from the page's own clock (`performance.now()`), on the committed integration build (16b9736) against the live build, over the same Wi-Fi. Every video file was already in the browser's disk cache.

- **Auto-advance from the 4K reel: no freeze.** In `v4-edge` the 3840x3840 reel played to its end. The next video showed its first frame 135 ms after `ended`. The preloader held it at `readyState` 4 and was cleared at the switch. The following auto-advance, video to image, showed the image in 2 ms.
- **Warm-up after landing on an image starts at once.** The preloader's `src` was set 10–20 ms after the click that showed the image (5 of 5 in `v4-edge`, `v5-fast`, `v6-fast150`, `v6-fast400`). On the live build it was set 1508 ms after the click (`prod-fast`). The 713–721 ms in `v3-preload` was the clock offset between the Mac and the headset, not a delay in the player.
- **Fast swipe off an image onto a video:**

| Time on the image | Integration: first frame after the second click | Live: first frame after the second click |
|---|---|---|
| about 180–210 ms | 115 ms (`v6-fast150`) | 492 ms (`prod-fast150`) |
| about 450 ms | 114 ms (`v6-fast400`) | 396 ms (`prod-fast400`) |

  On the integration build the preloader reached `readyState` 4 within 140 ms of the image showing, so the video was ready before the second click. On the live build the preloader had not started, and `loadedmetadata` alone took 333–353 ms.
- No console errors in any pass. The right reel played after every fast swipe.

**Limits:** one sample per cell. The feed order changed between page loads, so the two builds landed on different videos (integration: the 3840x3840 reel both times; live: a 2 s H.264 test clip and the 1080x778 reel). All files came from the disk cache, so a reel that needs the network was not measured in this case. The `end` step did not need its seek: the reels ended by themselves first.
