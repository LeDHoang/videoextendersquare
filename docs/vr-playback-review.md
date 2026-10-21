# VR immersive playback and loading review

Date: 2026-10-21. Scope: read-only review of how a reel is loaded and played in the immersive (WebXR) player. No code was changed, and nothing here was measured on a headset. Every statement below comes from reading the code at the line numbers given. Behavior on a Quest still needs the device matrix in `docs/vr-reels-playback-investigation.md`.

This review closes the todolist item "Review VR immersive-mode reel playback and loading". It re-checks the findings in section 0 of the investigation doc against the current code, because that section's line anchors and several of its claims are out of date.

## How a reel loads and plays today

1. **Choosing the file.** `playbackFor` (`ui/assets/reels.html:2681`) returns the stereo rendition for a 3D post when the player is in VR (`wantsStereoSource()`) and the post has not failed in 3D. Otherwise it returns the normal file, with a CSS left-eye crop for a raw stereo file in 2D.
2. **Loading the active reel.** `loadVideo` (`:5478`) sets `video.src` to a cached blob URL if one exists for that index and URL, and to the network URL otherwise. It then calls `preloadNext`, tells the VR engine through `WebXRVR.onVideoChange()`, and starts playback. A rejected `play()` retries muted.
3. **Preloading the next reel.** `preloadNext` (`:5416`) points the hidden `#preloadVideo` element (`:2153`, `preload="auto"`) at the next reel. It does nothing for 1500 ms after a switch, so quick swiping does not start background transfers. For an image post it warms the cache with an `Image`.
4. **Blob cache.** The CACHE button, the `L` key and an automatic call at `:6847` run `preloadAllVideos` (`:5788`). It downloads the next two reels completely with `fetch(...).blob()` and keeps object URLs in `blobUrlMap`. `pruneBlobCache` (`:4209`) keeps only the current index plus the next two and revokes the rest. A fetch is cancelled through an `AbortController` when the feed changes.
5. **Entering VR.** `enterVR` (`ui/assets/webxr_vr.js:9176`) requests the session first, so a rejection leaves the 2D player alone. It then stops any desktop preview, builds a fresh canvas and renderer, binds the session, and installs the XR animation loop. The host callback `onEnterVR` runs `syncStereoSource` (`reels.html:3098`), which swaps a 3D post to its stereo file and resumes at the same playhead.
6. **Every XR frame.** The loop calls `uploadVideoFrame` (`webxr_vr.js:6079`). It draws the `<video>` into a 2D proxy canvas and uploads that as a texture. For stereo it uses one 2:1 or 1:2 proxy, and each eye samples its half. Uploads happen when the visual changed, when a new decoded frame arrived (`requestVideoFrameCallback`, `setupVideoFrameTracking` at `:7356`), or after a seek jump. Video uploads are capped at about 30 per second (`VR_VIDEO_UPLOAD_MIN_MS = 33`, `:736`). A freshly switched video waits up to 2.5 s for `readyState >= 3` before its first upload (`FRESH_VISUAL_MAX_HOLD_MS`, `:5810`), and the last frame stays on screen during the wait.
7. **Leaving VR.** The session `end` handler stops the loop and frame tracking, removes the canvas, calls `onExitVR`, and restores the desktop preview if its canvas is still attached.

## What has changed since the investigation doc

These items are described as problems in section 0 of `docs/vr-reels-playback-investigation.md` and no longer match the code.

- **Frame skipping is gone.** There is no `vrMinStride` or adaptive stride in `webxr_vr.js`. Upload gating is now "new frame or visual change", with the 33 ms cap.
- **The blob cache is bounded.** `pruneBlobCache` revokes old object URLs, and `preloadAllVideos` only fetches the next two.
- **Fetches can be cancelled.** `preloadController` aborts them when the feed changes.
- **Desktop glow stops in XR.** `updateDesktopGlow` (`:7127`) returns while `WebXRVR.isPresenting()` is true.
- **The comment overlay is throttled.** `refreshOverlayTexture` (`webxr_vr.js:6276`) re-renders only when the set of active comments or the hover target changes, and repaints for fades at most once per `VR_UI_MIN_INTERVAL` (100 ms).
- **Stereo has a single upload.** Both eyes share one texture through cloned views, so a frame is uploaded once.

## Problems, ranked

Each problem lists the Phase 0 item of `docs/todolist.md` it belongs to.

1. **No physical-device evidence for any of the above.** Every fix since the investigation doc was written is unverified on a Quest. This is the blocker for all other Phase 0 work. *Phase 0: "Complete the controlled physical-Quest playback matrix", "Verify bounded cache, cancellation, memory stability, buffering, frame pacing, and thermal behavior on device".*
2. **Cached blobs go unused after entering or leaving VR.** `syncStereoSource` repoints the hidden preload element to the right variant (it calls `preloadNext` at `reels.html:3141`). The blob cache is different: `blobFor` (`:2695`) only accepts a blob whose source URL matches, so blobs fetched for the 2D file are ignored once VR wants the stereo file, and the other way round. They stay in memory until `pruneBlobCache` drops them, and the new variant is downloaded again. *Phase 0: "Measure and control contention from hidden preload", "Verify bounded cache".*
3. **Two transfers can fetch the same reel.** The hidden `#preloadVideo` element and `preloadAllVideos` both download the next reel, one as a media element and one as a whole-file `fetch`. With the automatic call at `:6847` both run during normal playback. *Phase 0: "Measure and control contention from hidden preload".*
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
