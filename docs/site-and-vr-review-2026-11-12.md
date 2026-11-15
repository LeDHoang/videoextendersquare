# Site and VR reels review, 2026-11-12

Scope: the VR reels player and the main public pages on production (`https://echomultiverse.com`), with a focus on latency and video quality. No source file was changed. This review reports the difference from `docs/vr-playback-review.md` (last updated 2026-11-10); it does not repeat what that file already settled.

## Baseline

- Production runs VR engine `v8.30-20261110-vr-fixes-integration`. The served `webxr_vr.js` has the same hash as `ui/assets/webxr_vr.js` on `dev` (`400445ea5dd7`). Schema `20261111_0022`.
- Headset: Quest 3S, Horizon OS v209, OculusBrowser 154.1.0.32.54, signed out.
- Network: Taiwan to Oregon through Cloudflare. A round trip to the API costs about 270 ms. `navigator.connection` on the Quest reported `3g`, 0.4 Mbps, 300 ms. A 9.8 MB file downloaded at about 11.6 Mbps.
- Production feed, read from `/api/reels` (3 pages): 203 posts, 44 videos and 159 image posts.

Each finding is tagged: **measured** (this review, on production), **code** (read from the source, not run), or **carried** (from the 2026-11-10 review, not re-measured).

## What works now

All measured on the Quest 3S on production, one pass each unless stated.

- **Frame pacing is fixed and deployed.** Framebuffer scale 1.25 (4200x2200 layer). Median 90 fps for images and videos, app time 7.8 ms, GPU 0.8. In a 5-minute soak: median 90 fps, 4 of 305 seconds under 85 fps, median 1 stale frame per second.
- **Dock uploads are fixed and deployed.** 3 per second (max 5).
- **Stereo reels play in VR.** Three 4092x2046 side-by-side H.264 reels held 89 to 91 fps. This was not covered before.
- **Memory is flat over five enter and exit cycles.** Browser total: 705 MB in 2D, 1038 to 1286 MB in VR, 877 to 985 MB after exit (one reading of 1276 MB after cycle 3, back to 926 MB after cycle 4). JS heap stayed at 25 to 28 MB. Problem 5 of the earlier review (no dispose at session end) does not leak in practice.
- **Warm switches are fast.** The player's own timing gave 103 to 292 ms to the first frame for 6 video switches, 5 of them from the preloader.
- **The main pages load without console errors** on desktop Chrome: `/reels`, `/explore`, `/explore/tag/comedy`, `/explore/location/miami--usa`, `/profile/test22`, `/packs/<id>`. No horizontal scroll.

## Full reel run in VR, 06:39 to 06:52 UTC

A driven run on production: 600 s with AUTO advance, then 150 s pressing NEXT every 5 s. In all, 118 reel changes: 106 images and 12 videos. The headset screen was recorded for 3 minutes, and the headset log was kept. The probe navigated the existing tab, so this was a fresh page load after the viewer restarted Quest Browser, which had cleared the drops (finding 5).

Two capture loads shared the headset's Wi-Fi with the player. The screen recorder ran from about 35 to 216 s of the run. The 70 MB recording was then pulled over Wi-Fi adb from about 216 to 479 s. The figures below are split by those windows. The clean window (after 479 s, which holds the whole NEXT phase) is the one to use for what a viewer sees.

### Measured

| Change | n | Time to the new picture, p50 / p90 / max |
|---|---|---|
| Image, clean window | 54 | 1559 / 4377 / 5724 ms |
| Image, from a video, whole run | 11 | 1559 / 3577 / 5260 ms; 3 of 11 ready at once |
| Video, from video or image | 12 | 110 / 391 / 627 ms |
| All changes, NEXT phase (clean window) | 39 | 1018 / 3558 / 5724 ms |
| Image, while the recorder ran | 13 | 2883 / 7194 / 8157 ms |
| Image, while the recording was pulled | 33 | 2027 / 4278 / 5260 ms |
| Image, whole run | 106 | 1875 / 4503 / 8157 ms |

The time runs from the page's src change to the moment the VR bitmap exists. Until then, the engine keeps the old picture on screen. In the clean window, and in the 2 changes before the recorder started, 71% of image changes took more than 1 s. A dry run 25 minutes earlier gave 788 to 1149 ms for 9 image changes. The slowest minutes and all 8 sample timeouts fall in the two capture windows.

A video change is fast because the hidden preloader already holds the next video. An image change is slow because the VR bitmap is almost never ready (next section). This is the slow "video to image" change the viewer noticed: 8 of 11 such changes waited for a full download, and the median over all 11 was 1.6 s.

- **Frame pacing held.** `VrApi` read 90/90 fps every 30 s for the whole run, with 0 to 5 stale frames, GPU level 4 and 37 to 38 °C. The session never left `visible`, and it never ended. 0 dropped video frames on 10 videos.
- **One video rebuffered badly.** `...Legacy-Lightbike-Scene-4K..._1080p.mp4` stalled 4 times, for 21 s in all, within 30 s of play. The browser held the first 9.1 MB from an earlier visit. The rest came from a Cloudflare MISS, 12.2 MB in 34.9 s (about 350 KB/s). This was at about 151 to 173 s, while the recorder ran, so the recorder may have made it worse. Two more stalls were short: 0.6 s at the start of a reel that had 13.9 s buffered, and 1.2 s on a MISS file. This matches the "buffering while loading" that the viewer reported: a 1080p master from a cold edge, on a link that cannot sustain it.
- **Images are the network load.** The VR image path downloaded 149 MB of PNG in 156 requests over 12.5 minutes. Each PNG is 1080 px wide and 0.5 to 1.35 MB. Body throughput per request in the clean window was p10 328, p50 758 and p90 1645 KB/s, so one image takes 0.4 to 3 s to arrive (p50 420 KB/s while recording, 317 KB/s while pulling). Time to first byte was short (p50 156 ms, Cloudflare HIT); the body is what takes the time. Decode was 11 to 82 ms, which is not the problem.
- **Files downloaded twice.** 45 of 120 image files went over the wire twice, 43 MB extra. 41 of them were two VR fetches of the same file, which is cause 1 below. Only 4 were a VR fetch plus an `<img>` load; the `<img>` path carried 8.0 MB in 9 requests in all, because the browser cache served it the rest.

The fixes below remove the wait whatever the link speed.

### Why an image change waits (code and measured)

Only 12 of 106 image changes found their bitmap ready. 34 had been prefetched and were downloaded again at the change. 60 were never prefetched. The causes:

1. **The single prefetch slot is overwritten before it is used.** `showImage` calls `preloadNext(idx)` (`ui/assets/reels.html:5943`) before `WebXRVR.onVideoChange()` (`:5947`). For an image, `warmNext` runs at once and calls `vrImagePrefetch` for the following post's cover (`:5909`). `vrImagePrefetch` releases the one entry it holds (`:3333`), which is the cover that is about to be shown. The engine then asks `vrImageSource` (`:3339`) for that cover, finds no match and fetches it again. This applies to every image post followed by another image post. The probe logged the next cover's fetch 1 ms before the current cover's refetch. A change from a video to an image hits it too: `loadVideo` prefetches the image while the video plays, then `showImage` replaces it.
2. **Slides 2 and later of a post are never prefetched for VR.** `showImageSlide` warms the next slide with `new Image()` only (`:2981`). Each slide change in VR downloads and decodes the slide at the moment it should appear. 60 of the 106 image changes had no VR prefetch at all, which fits this path. (The analyzer's own split into "new post" and "next slide" is a heuristic. It labels 60 changes as slides, but 5 of those found a ready bitmap, so they were probably new posts that it misfiled.)
3. **The `<img>` and the VR bitmap use separate downloads.** The VR path fetches with `cache: 'reload'` because the `<img>` already holds a copy loaded without CORS, and R2 sends no `Access-Control-Allow-Origin` to a request without `Origin`. That cached copy fails the CORS check (comment at `:3310`). In this run the cost was small: 4 files, because the browser cache served most `<img>` loads.
4. **On VR entry during a video, the next image is not prefetched.** `syncStereoSource` re-warms only when the next item is not an image (`:3433`).
5. **The files are large for what they show (finding 4).** 1 MB PNGs, while a WebP or AVIF at the same 1080 px is about a tenth of that.

### Fix candidates

- Consume the current cover before warming the next item: call `WebXRVR.onVideoChange()` before `preloadNext`, or hold a small cache of bitmaps keyed by URL (current, next post, next slide) in place of one slot.
- Prefetch the next slide's VR bitmap, as is already done for the next post.
- WebP or AVIF renditions (finding 4, task 4).
- Lower priority: load the `<img>` with `crossorigin="anonymous"` and serve images with CORS for every request (`Access-Control-Allow-Origin` plus `Vary: Origin`, or a fixed `*`), then drop `cache: 'reload'`. One download then serves both.
- For video stalls: the 2k rendition (finding 1) halves the bytes, and immutable caching (finding 7) keeps the edge warm longer. A MISS at 350 KB/s still cannot sustain a 1080p master; a rung picked by measured throughput is the lasting fix (finding 3).

### Probe gaps

- 8 of 750 one-second samples timed out, all between 243 s and 472 s, while the recording was pulled over adb. The events in those drains were lost: image changes between about 220 and 240 s are missing, and the per-minute XR frame counts from the page are skewed. Frame pacing is taken from `VrApi`.
- 4 image changes have no ready time, because their bitmap event was not captured.
- Two videos have no first-frame time in the table, although both played (from the samples: 4092x2046 and 3840x3840, playing within 2 s).
- The image counts as "new post" or "next slide" come from a heuristic; the totals and the hit and miss counts do not.

## Findings, ranked

### 1. No VR rendition exists on production (measured, code) — high

None of the 44 videos has a `vr2k_url`. The headset therefore always plays the master.

- Masters: median 16.9 Mbps, 32 of 44 above 8 Mbps, 21 above 20 Mbps, 24 are 3840x3840 HEVC at 22 to 54 Mbps.
- The 2k rendition is built only when a post is published (`server/routers/uploads.py:420-444`). The boot requeue passes `vr2k=False` (`uploads.py:342-344`), so nothing published before 2026-11-10 gets one, and there is no backfill script.
- Effect: on this link every master above about 10 Mbps rebuffers on a cold play. The player logic that picks the 2k file (`ui/assets/reels.html:2887`) is deployed and never runs.

Fix: a `scripts/batch_vr2k.py` backfill (same shape as `scripts/batch_stereo_mono.py`), run once on the VPS.

### 2. A cold `/reels` visit waits about 6 s before the first video byte is requested (measured) — high

Desktop Chrome, first visit, times from navigation start:

| Step | Start | Duration |
|---|---|---|
| HTML first byte | 0 | 751 ms |
| App JS and CSS | 767 ms | 944 ms |
| Route chunks, `/api/auth/me` | 1742 ms | 437 ms |
| `/api/reels/player-inline` (86 KB), `/api/reels` | 2225 ms | 516 ms |
| Nine player scripts, one after another | 2760 ms | 3223 ms |
| First video request | 6034 ms | |

- `runScripts` awaits each script before it adds the next (`web/src/utils/playerScripts.js:5`). Nine requests in series cost nine round trips.
- `quest_controller_img.js` is 635 KB and loads first, on every device. Only the VR controller guide uses it.
- `three.min.js` (213 KB) and `webxr_vr.js` (169 KB) also load before the 2D video starts.
- There is no `preconnect` to `media.echomultiverse.com` (`web/index.html`).

The scripts are cached as immutable, so a returning visitor does not pay this. A new visitor does, every time.

Fix: fetch the scripts in parallel and run them in order; start the 2D video before the VR scripts; load the controller image only when VR starts; add the preconnect.

### 3. The 2D player has one file per reel and no adaptive rendition (measured, code) — high

`playbackFor` returns `entry.url` for every 2D viewer (`ui/assets/reels.html:2895`). A desktop viewer received the 3840x3840 HEVC master for a 654 px wide player. A phone on mobile data gets the same file, or the 2160p H.264 proxy at up to 12 Mbps when it cannot decode HEVC.

Fix, in order of cost: serve the existing 2k rendition to 2D viewers as well; then add a 720p or 1080p rung picked by viewport and `navigator.connection`; HLS only if the ladder grows.

### 4. Image posts are PNG files of about 1 MB (measured) — high

- 159 image posts, all PNG, median 0.97 MB, largest 3.2 MB, 1080 px wide.
- For an image post `preview_url` and `poster_url` are the same full PNG, so Explore tiles download the full file. Six tiles took 1.9 to 3.2 s each.
- In VR, 12 reels downloaded 35 MB of PNG in 37 requests; median 832 ms each, longest 3.3 s.
- They are also soft in the headset (carried): 1080 px wide against a 2048 px video texture.

Fix: WebP or AVIF at publish and in a backfill: a 720 px tile image, a 1080 px 2D image and a 2048 px VR image.

### 5. "VR drops to 2D": no crash in the logs; one drop traced to the dock EXIT button (measured, code) — open

Reported during this review. What was checked:

- Headset log for 2026-11-12 from 00:13: no browser or renderer crash, no low-memory kill of the browser, no WebGL context loss. Every session end in the log matches a step of this review. The one browser kill was a deliberate restart at 12:48.
- 5-minute soak in VR (150 s passive, 150 s with a swipe every 3 s, 79 reel changes): the session stayed `visible`, no exception, no tab crash.
- Sentry has only the server project. Nothing in the browser reports errors, so a drop on a viewer's headset leaves no trace.

Three ways the session ends without the viewer asking, found during the review:

1. **The headset loses tracking.** With the cameras covered, Quest showed "Finding position in room" after about 110 s in VR. The session went `visible-blurred`, then `hidden`, and the runtime moved it to `STOPPING`. The viewer sees passthrough and a system dialog. This is the only unrequested drop that was observed.
2. **A failed list request unmounts the player (code).** `ReelsPage` replaces any failed `/api/reels` call with an empty list (`web/src/pages/ReelsPage.jsx:140`). An empty list renders the "NO REELS FOUND" state in place of `ReelsPlayer` (`:472`). The player's cleanup then calls `WebXRVR.exitVR()` (`ui/assets/reels.html:7750`). The request runs again when the viewer id changes, and `AuthContext` sets the user to null on any failed `/api/auth/me` (`web/src/hooks/AuthContext.jsx:15`). So a short network or server failure during a deploy can end VR and show an empty page. `ReelsPlayer` guards its own refetch while presenting, but not this path.
3. **A stuck session request.** After an immersive request was left pending, every later `requestSession` failed with `NotSupportedError` until Quest Browser was restarted. This came from the probe, but a viewer who taps VR while a system dialog is up may reach the same state.

A watcher now runs against the headset tab and logs every session end with its cause (see "Watcher" below). The next drop will show which of these it is, or a fourth.

Fix for 2: keep the last good list when a refetch fails, and never unmount the player while it is presenting.

#### Update, 06:00 to 06:20 UTC, with a person in the headset

The viewer reports that the drop happens at the end of an image or video reel, signed in or not.

- **One drop was caught, and it was the dock EXIT button.** At 06:12:24 the session ended with this stack: `XRSession.end` from `exitVR` (`ui/assets/webxr_vr.js:11979`), from `executeControlButton` case `exit` (`:12342`), from `onVRSelect` (`:11489`), from a three.js controller `select` event. A controller trigger or a hand pinch landed on EXIT. It was not a crash, and no page code ended the session on its own. It is not yet known whether the press was meant.
- **The end of a reel calls no exit (code).** A video's `ended` handler and an image post's dwell timer both run `finishViewTracking('complete')` and then `nextVideo('autoplay')` (`ui/assets/reels.html:6881`, `:3062`). That path posts the view, the event and the reward claim, fetches the next feed page if needed, and loads the next item. None of these calls `exitVR`, `leaveImmersiveModes` or `dispatchNavigation`. A failed reward claim with 401 or 403 sets `currentUser` to null but does not leave VR.
- **The engine ends a session in only three places (code):** the dock EXIT button (`webxr_vr.js:12342`), a shell hand-off to a 2D page (`:8400`), and a failed `setSession` at entry (`:11847`). The player template adds its cleanup on unmount (`reels.html:7750`) and the DOM-overlay paths for share, report and navigation.
- **A dock resize does not move EXIT (code, ruled out).** `controlsCanvasSize` fits the dock to the live buttons, and image items drop the seek row (`ui/assets/vr_ui_canvas.js:510`). But `layoutControlsDock` keeps the dock's top edge in place when it gets shorter (`webxr_vr.js:2840`), and the width stays the same because EXIT is always live. EXIT, in the top-right corner, stays where it was, so a press aimed at another button cannot land on it through a resize.
- **The 451 Mbps reel played without a crash.** `Testray3.2.mp4` played in VR without a decode error, but it stalled: 0.6 s of playback after 22 s, 1.9 s buffered.
- **After a sign-in, the first VR exit jumps to another reel (code, measured).** `ReelsPlayer` holds back a change of viewer id while VR is active. On exit it applies the change, fetches `/api/reels/player-inline` again and injects a new player, which starts on a different reel. At 06:12:33 VR was entered again on `re_Travis Scott - MODERN JAM.mp4` instead of `Testray3.2.mp4`.
- **`/api/rewards/reels/claim` returns 503 on production** (06:10:40, 06:12:01, 06:18:06). The client retries with backoff and then shows "REWARDS UNAVAILABLE RIGHT NOW". It does not end VR.

The watcher was extended (v2) to settle the open question. For each session it now logs every `select`, `selectstart`, `selectend` and `squeeze` with the input source (left or right, hand or controller, profile), each input-source change, each reel change with where the outgoing reel stood, and `console.error` output (React logs caught render errors there). The input logging starts at the next VR entry after the watcher attaches.

Fix candidates, once the next drop confirms the path: if it is EXIT again, make EXIT a hold or a two-step press in VR; apply a held-back viewer change without reloading the player.

#### Update, before 06:39 UTC

The viewer closed Quest Browser fully and reopened it, and the drops stopped. The tab used for the earlier tests had been open for several hours, across many VR entries and an earlier stuck session request. Stale state in that tab or browser process is the leading suspect. The 12.5-minute run that followed, on a fresh page load in the restarted browser, never left VR (see "Full reel run in VR"). The cause is still not known; the watcher stays useful for the next report.

### 6. One reel in the public feed is 282 MB for 5 s (measured) — medium

`Testray3.2.mp4`: 5760x5760 HEVC, 451 Mbps. It played in VR once during the drop tests (finding 5) without a decode error, but stalled after 0.6 s of playback. A viewer who lands on it downloads up to 282 MB, and the Quest may not decode it. There is no upper limit on resolution or bitrate for a published file.

Fix: unpublish or re-encode it, and reject or re-encode masters above a set limit at publish.

### 7. Media cache settings (measured) — medium

- Media is served with `Cache-Control: public, max-age=86400` (`server/media_store.py:35`). File names carry a timestamp and hash, so they could be `max-age=31536000, immutable`. After one day the browser revalidates each file with a round trip.
- Three files requested from Taiwan were all `cf-cache-status: MISS`, with 0.9 to 1.3 s to first byte. With few viewers the edge is cold for most first plays.

### 8. A 4K decoder holds about 145 MB, and two run at once (measured) — medium

The codec log shows 144.6 MB for one 4092x2046 H.264 decoder. The active video and the hidden preloader each hold one. `QC2V4l2Codec ... queueOutputs: Allocation failed!` still appears on every video (carried); playback continued. During the enter and exit cycles Android's low-memory killer removed 8 cached background apps. The 2k rendition (finding 1) lowers this.

### 9. Smaller items

- **Every page makes 5 start-up API calls** (`billing/catalog`, `auth/me`, `config`, `health`, `messages/capabilities`), about 270 ms each from Asia, including for signed-out viewers who use neither billing nor messages. (measured)
- **`/api/reels` first byte was 1.1 to 1.6 s** on three anonymous page requests, each an edge MISS. The 30 s edge cache helps only when another viewer asked in the last 30 s. (measured)
- **`/api/reels/diag` returns 404** about once a second with `?xrdiag=1`. (carried)
- **The pack page cover filled the left half of its frame** in one screenshot. The browser pane was hidden at the time, which delays lazy loading, so this needs a second look. (measured, not confirmed)
- **No spatial (colour and depth) version exists on production.** No post has a `depth_url`, so the VR default added on 2026-11-11 was not exercised.

## Still open from earlier reviews

| Item | State |
|---|---|
| Frame pacing at scale 1.5 | Fixed, deployed, re-measured |
| Dock repaint rate | Fixed, deployed, re-measured |
| Preloader cleared at each switch, warm-up on an image post | Fixed, deployed |
| Link estimate by median | Deployed; never runs in normal use (only the `L` preload feeds it) |
| 2k rendition | Code deployed; no files on production (finding 1) |
| Session-end dispose | No leak over 5 cycles; closed |
| Head-locked screen spans about 89°, panels draw through the dome | Open (`docs/ui-open-items.md`) |
| Quest checklist in `docs/todolist.md` (dock aim and resize, Earth, guide) | Open; needs a person in the headset |

## Not covered

- Signed-in pages (`/upload`, `/messages`, `/wallet`, `/settings/profile`, `/moderation`). No credentials were entered on production.
- Phone width and Quest Browser in 2D mode.
- A cold video switch in VR with the cache emptied. Rebuffer time was measured only for the 12 videos in the full run; earlier figures in `docs/vr-playback-review.md` still stand.
- Sharpness and comfort by eye, controllers and hand tracking. The headset lay on a surface for every pass.
- The spatial colour and depth path, Earth view and Reel Packs in VR. The 451 Mbps reel played once, briefly (finding 6).
- Desktop timings came from a hidden browser pane. Lazy loading starts late there, so the Explore tile timings are per file, not per page.

## Limits of these numbers

- One device, one network, one pass per figure unless stated.
- Frame pacing comes from `VrApi` in logcat. Switch times come from the page's own clock. The driver ran over Wi-Fi adb, which adds about 300 ms to each of its steps, so its own timestamps were not used for latency.
- Most video files were already in the Quest's disk cache.

## Changes made to the headset

- `svc power stayon true`: the screen stays on while charging.
- `am broadcast -a com.oculus.vrpowermanager.prox_close`: the proximity sensor reads as worn.
- `adb tcpip 5555`: adb also listens on Wi-Fi. USB adb dropped three times about 22 s after VR started, with a kernel USB reset on the headset; Wi-Fi adb held.
- Quest Browser was force-stopped once and reopened on `/reels?xrdiag=1`.

To undo:

```bash
adb shell svc power stayon false
```

```bash
adb shell am broadcast -a com.oculus.vrpowermanager.automation_disable
```

```bash
adb usb
```

## Watcher

`docs/perf-probes/2026-11-12-vr-review/watch.mjs` attaches to the Quest tab and appends to `output/vr-review-2026-11-12/watch/watch.jsonl`. It changes no page behaviour. For each immersive session it logs the start, each visibility change and the end. An end is labelled `page code` with a call stack when `XRSession.end()` or `WebXRVR.exitVR()` was called, and `browser or headset (no page caller)` otherwise. It also logs page loads, uncaught errors, `console.error` output, video errors, WebGL context loss and tab crashes. Version 2 adds every XR select and squeeze with its input source, input-source changes, and reel changes with the outgoing reel's position. It installs onto a page an older watcher already hooked, so it can restart without a reload.

```bash
adb forward tcp:9222 localabstract:chrome_devtools_remote
```

```bash
node docs/perf-probes/2026-11-12-vr-review/watch.mjs output/vr-review-2026-11-12/watch/watch.jsonl
```

## Files

`docs/perf-probes/2026-11-12-vr-review/`:

- `watch.mjs`: the session-end watcher.
- `cycles.mjs`: browser memory over VR enter and exit cycles.
- `soak.mjs`: a VR soak, passive and then a swipe every 3 s.
- `reelrun.mjs`: the full reel run. It loads `/reels` in the Quest tab, enters VR, runs AUTO and then NEXT presses, and records per-change timing, image fetch and decode, video events, XR frame gaps and every media response. Usage: `node reelrun.mjs <out.json> [autoSeconds] [nextSeconds] [nextEveryMs]`.
- `reelrun_analyze.py`: summarises a `reelrun.mjs` capture by kind of change, with rebuffers, frame gaps and media responses.

The playback pass used `docs/perf-probes/2026-11-10/vr-playback/run3/verify.mjs` with `NO_OVERRIDE=1`. Captures are in `output/vr-review-2026-11-12/` (`prod-d`, `cycles`, `soak`, `watch`, `reelrun`), which git ignores. `reelrun/` holds `run1.json`, its analysis `run1.analysis.txt` and the 3-minute headset recording `reelrun1.mp4` (1280x720 of both eye buffers; the recorder cannot encode the native size).

## Proposed tasks

1. **VR image changes without a wait.** Fix the prefetch order, prefetch the next slide, and serve images with CORS so one download serves the `<img>` and the VR bitmap. "Full reel run in VR". The largest latency gap found: 1.6 s median on 54 image changes in the clean window, and only 12 of 106 image changes ready at once. The CORS part is lower priority.
2. **Backfill the 2k VR rendition and serve it to 2D viewers.** Findings 1, 3 and 8.
3. **Cold start of `/reels`.** Parallel script loading, the VR scripts and controller image after the first frame, preconnect to the media host. Finding 2.
4. **Image renditions.** WebP or AVIF in three sizes at publish, with a backfill. Finding 4.

Next after these: keep the player mounted when the list request fails (finding 5), a publish limit on resolution and bitrate (finding 6), immutable media caching (finding 7), and browser error reporting so drops on a viewer's headset are recorded.
