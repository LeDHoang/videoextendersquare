# Quest 3 run on release 7ab15a6, 2026-11-22

A Quest 3 on a home connection, driven over USB through adb and the Quest Browser's DevTools protocol. The run asked two questions:

1. How fast does a first-time visitor get from the URL to a playing reel in VR?
2. Why do reels play choppy and "keep loading", even on a good connection?

The scripts and raw samples are in `raw-quest/`. `ttvr.mjs` times a cold open and the VR entry. `mon2.mjs` watches the player in VR for 240 s. It hooks every `<video>` event, samples the buffer and frame counters every 400 ms, and records each network transfer. `an2.py` turns its output into the stall and end-wait columns below. `par3.js` is the parallel download test. `ab-video.html`, `ab-video.mjs` and `ab-serve.mjs` are the bare `<video>` test.

## Summary

- **Getting into VR is fast enough.** From a cold cache, the first XR frame comes 6.0 to 7.2 s after the URL is opened. The player is ready at 3.8 to 4.4 s. From the click on the VR button to the first XR frame takes 0.9 to 1.3 s.
- **The choppiness is the network, not the headset.** The heavy videos are 4K masters at 22 to 51 Mbps. Each one plays as a single progressive file. One file's download ran at about 9 to 13 Mbps, and 5.2 Mbps at the lowest. The decoder dropped no frames on any of these files, and the XR loop ran at about 89 fps.
- **The limit is between the home connection and the Cloudflare edge.** It is not the headset's Wi-Fi, and it is not R2. Most video requests were edge cache hits, and 8 parallel streams from the headset still reached only 10.7 Mbps. See "Where the link limit is".
- **"Keeps loading" is two separate things:**
  - **Mid-clip stalls.** A file above the link rate runs out of buffer. The worst case was 5 stalls and 17.9 s of waiting in a 15 s clip.
  - **The slow end.** On some clips the player's clock runs ahead of the downloaded data and reaches the clip's end early. The remaining frames then come in at the download rate, about 7 fps, with no spinner. The next reel starts only when the download finishes. The worst case was 15.2 s at the end of a 6.7 s clip. It happens only to clips with no audio track, and only in an XR session. See "Why the slow end shows no spinner".
- **The 2k VR rendition is never played.** All 24 items in the feed have `vr2k_url: null`. If a post had one, the player still would not pick it, because the link estimate is fed only by the manual "Preload All" button.
- **Images are the original PNGs, and each is downloaded twice.** The WebP renditions are missing on R2. A CORS fetch and a no-CORS `<img>` cannot share one cache entry under `Vary: Origin`. In VR each image change showed the previous frame for 1.2 to 3.2 s.

## Time to VR

There were three cold runs, with no load test running. Before each run, the script cleared the DNS cache, the socket pool and the HTTP cache. Times are in ms from navigation start. The raw output is `raw-quest/ttvr-idle.json`.

| Run | TTFB | FCP | Player ready | First reel | VR click | XR start | First XR frame |
|---|---|---|---|---|---|---|---|
| 0 | 621 | 1412 | 3845 | 4522 | 4617 | 5359 | 5961 |
| 1 | 1237 | 1868 | 4380 | 5500 | 5658 | 6129 | 6564 |
| 2 | 622 | 1476 | 4001 | 6267 | 6287 | 6745 | 7203 |

In all three runs the first reel was an image post, so "First reel" is the image's `load` event.

An earlier set of three runs (`raw-quest/ttvr-cold.json`) ran while the proxy load test was on the VPS. It gave the first XR frame at 6.5 to 7.0 s, so the load test did not change the result much.

- **About 1.5 s goes on the player scripts.** `three.min.js` (220 KB) and `webxr_vr.js` (185 KB) come back `cf-cache-status: DYNAMIC`, so every cold open fetches them from the origin.
- **The Material Symbols font is 4 MB.** It loads on every cold open.
- From the click, `requestSession` resolves in 0.46 to 0.74 s, and the first XR frame follows about 0.45 to 0.6 s after that.

## Playback in VR

These are the videos the player reached in 240 s of natural play. Image posts were skipped 1.5 s after they were ready. The table columns are:

- **MB:** the file size, from the `content-length` of a `HEAD` request.
- **Mbps:** the file's average bitrate, from that size and the `ffprobe` duration.
- **dl s:** the time to download the whole file.
- **Rate Mbps:** the file size over the download time. For a light file, the browser can pause the download once its buffer is full. So for a light file this is only a lower bound on the link.
- **Stalls:** the number of `waiting` events after playback started.
- **End wait s:** the time between the clock reaching the end and the next reel starting. For a light file this is the normal 0.4 s hand-over. For a heavy file with no audio track, it is the slow end described below.

The probe's own byte count (`Network.dataReceived`) was 10 to 27% above the true file sizes, so the table does not use it.

| Video | Length (s) | MB | Mbps | dl s | Rate Mbps | Stalls | Stall s | End wait s |
|---|---|---|---|---|---|---|---|---|
| `wkbslx0shh8q7` | 14.8 | 1.9 | 1.0 | 7.2 | — | 0 | 0 | 0.4 |
| `SnapReels_studio` | 14.8 | 15.0 | 8.1 | 10.5 | 11.4 | 0 | 0 | 0 |
| `acatdancetest` | 10.5 | 12.0 | 9.1 | 10.7 | 9.0 | 1 | 0.8 | 0.4 |
| `nightclub` | 5.6 | 9.2 | 13.1 | 6.5 | 11.4 | 0 | 0 | 0.4 |
| `EbGiqvo…_studio_4k` | 5.0 | ≈9 | ≈14 | 21.7 | — | 0 | 0 | 0.4 |
| `…264-1920-eye` | 10.0 | 27.8 | 22.2 | 17.4 | 12.8 | 3 | 4.5 | 0 |
| `camtestupload` | 5.1 | 14.3 | 22.3 | 9.7 | 11.8 | 0 | 0 | 0 |
| `bW3F3oZ…_studio_4k` | 5.0 | ≈16 | ≈25 | 12.8 | — | 0 | 0 | 1.6 |
| `…Lil Durk & Prince Dre` | 15.0 | 53.9 | 28.8 | 33.5 | 12.9 | 5 | 17.9 | 0 |
| `12492094_3840_3840` | 9.2 | 41.2 | 35.8 | 35.1 | 9.4 | 0 | 0 | 5.2 |
| `…h264-9-7mb` | 2.2 | 9.8 | 36.1 | 15.1 | 5.2 | 2 | 1.6 | 0.4 |
| `12492094_fast` | 9.2 | 44.7 | 38.8 | 32.8 | 10.9 | 0 | 0 | 3.6 |
| `12827489_fast` | 6.7 | 42.7 | 51.3 | 27.0 | 12.7 | 0 | 0 | 15.2 |

The two `studio_4k` files could not be matched to a URL for a `HEAD` request. Their sizes (≈) are the probe's count divided by 1.2, so they are estimates.

An earlier 150 s run (`mon1.json`) had one more case: `test_cas.mp4`, 6.7 s long. Its true size was not measured. The download took 59 s. Its clock sat at 6.7 / 6.7 for 37.5 s, and the feed moved on 180 ms after the transfer finished.

The rows show these patterns:

- **Files at or below about 14 Mbps played cleanly.** The one stall among them was 0.8 s.
- **Above about 20 Mbps, every file but one either stalled or had a slow end.** The heavier the file, the longer the wait. The exception was `camtestupload`, a 5.1 s clip. Its download started 5.1 s before it came on screen, while the previous reel played. It played 0.1 s after it came on, and the download finished 0.7 s before the clip ended.
- **The download time, not the clip length, sets how long a heavy reel stays on screen.** `12827489_fast` is 6.7 s long, but it held the screen for 26.5 s.
- **Frame drops were 0** on every file except the first, which dropped 24 of 120 frames during the VR entry.

### Why the slow end shows no spinner

The files are laid out for streaming: `ftyp` and `moov` come first, then `mdat`, with the frames in order. So the layout is not what holds the clip back.

The cause is the download, but it shows up in two ways:

- **A normal stall.** The clock stops at the buffered end, `waiting` fires, `readyState` drops to 2, and the VR loading overlay (`reelLoadState` in `webxr_vr.js`) opens.
- **The slow end.** `currentTime` runs at wall-clock speed from the start, whatever is buffered, and reaches the clip's length while the buffered end is still about 2 s in. For `12827489_fast` in the 240 s run, the clock was at 3.19 s with 1.22 s buffered, and at 6.67 s with 1.85 s buffered about 5 s later. No `waiting` fires and `readyState` stays at 4 at the end, so the overlay never opens. The decoded frame count keeps rising, at about 7 fps, as the bytes arrive. So the clip plays the rest of its frames in slow motion, at the download rate, with the clock already at the end. `ended` fires only once the download finishes, and `nextVideo('autoplay')` runs on `ended`.

The slow end matched the audio track exactly. `ffprobe` of the clips in both runs:

| Clips | Streams | What happened |
|---|---|---|
| `12827489_fast`, `12492094_fast`, `12492094_3840_3840`, `bW3F3oZ…_studio_4k`, `test_cas` | HEVC 3840×3840, no audio | Slow end |
| `…Lil Durk & Prince Dre`, `camtestupload`, `…h264-9-7mb` and two other 4K clips with audio | Video and AAC audio | Normal stalls (`waiting`) |

A bare `<video>` page on the Quest isolates the cause. It plays `12827489_fast` as it is, and with a silent AAC track added (`ffmpeg -c:v copy`, 64 kb/s AAC), throttled to 10 Mbps. With `XR=1` the page also opens an immersive session that copies the video into a WebGL texture every frame, as the player does. The raw output is `raw-quest/ab-video-10mbps.json` and `raw-quest/ab-video-xr-10mbps.json`.

| Page | File | `waiting` events | Clock ahead of the buffer | Clock at the end | `ended` |
|---|---|---|---|---|---|
| 2D | No audio (original) | 66 | 0 s | 34.5 s | 34.95 s |
| 2D | Silent AAC added | 5 | 0 s | 37.8 s | 37.87 s |
| XR | No audio (original) | 1 | 32 s | 7.2 s | 34.66 s |
| XR | Silent AAC added | 5 | 0 s | 37.4 s | 37.57 s |

The XR run with no audio was made twice, with the same numbers to within 0.1 s. The raw file holds the second run. The first was read from the console output only.

So the slow end needs both things: a file with no audio track, and an immersive session that draws the video to a texture each frame. The test did not separate the session from the texture copy. In that case `currentTime` runs at wall-clock speed from the start, whatever is buffered. At 3.2 s the clock was at 2.56 s with only 0.61 s buffered. The clock reached the end at 7.2 s. The frames on screen (`requestVideoFrameCallback` `mediaTime`) followed the download instead, at about 5 to 6 fps, and the last one came at about 35 s. Only one `waiting` fired, before the first frame. With an audio track, the same XR page stalled normally: the clock stopped, `readyState` dropped to 2 and `waiting` fired each time.

The video was muted in every run. The player's `#reelsVideo` also starts muted. Whether an unmuted video behaves differently was not tested.

A player change that skipped to the next reel at the end was tried and withdrawn. On these clips it would cut each one to about 30% of its frames.

### Why the 2k rendition is never played

The 2k rendition (`<stem>-2k.mp4`) is the file meant for this case. There are four reasons it never plays:

1. **It does not exist.** All 24 items in `/api/reels/feed` have `vr2k_url: null`. On R2, `<stem>-2k.mp4` returns 404 for the four heavy files probed: `12827489_fast`, `12492094_fast`, `12492094_3840_3840` and `test_cas`.
2. **The batch would not build all of them.** `scripts/batch_vr2k.py` builds the missing files only for posts where `vr2k_shrinks` (`server/media.py`) is true. That test is `width × height > eyes × VR2K_EYE_SIDE²`. The 3840² mono masters and `vc-2160-eye` pass it. The 4092×2046 side-by-side files (`h264-9-7mb`, `hevc-4-6mb`) do not, so they would keep only the master. The `12827489_fast`, `12492094_*` and `test_cas` files are not in `/api/reels/feed` or `/api/reels?limit=500`. They may not be posts at all, and this run did not check whether the batch covers them. The batch has not been run on production.
3. **The link estimate is never fed.** `noteDownload` is called only from `preloadAllVideos` (`reels.html`), the manual "Preload All" button. In normal play `vrLinkMbps()` stays at 0, which means "not measured", so the player keeps the master.
4. **The threshold is fixed.** The player drops to 2k only when the link is below 35 Mbps (`VR_MASTER_MIN_MBPS`). It does not compare the link with the file's own bitrate. `12827489_fast` (51 Mbps) would stall on a 40 Mbps link too, and stay on the master.

### Images

`_image_entry` (`server/social/services.py`) sets `vr_url` to the `vr` rendition, or to the display URL when that rendition is missing. On R2, `<stem>-tile.webp`, `<stem>-2d.webp` and `<stem>-vr.webp` all return 404. So every image view loads the original PNG (0.7 to 1.5 MB). `scripts/batch_image_renditions.py` builds the renditions. It has not been run on production.

Each image is also fetched twice:

- `vrImageLoad` uses `fetch(url, {cache: 'reload'})`, a CORS request with an `Origin` header.
- The `<img>`, the slide warmer, the next-reel warmer and the backdrop all use no-CORS requests with no `Origin`.

R2 answers with `Vary: Origin`, so the two kinds of request cannot share a cache entry. Slides after the first in a multi-slide post are not prefetched for VR. `vrImagePrefetch` covers only the next reel's cover. The image downloads also compete with the video download on the same link.

## Recommendations

These are in order of effect on the choppiness. None of them are done. Recommendations 1, 2 and 5 change production data or the upload path. The rest change the player.

1. **Build the missing renditions on production.** Run `scripts/batch_vr2k.py` and `scripts/batch_image_renditions.py` (each has `--dry-run`). This gives the player a lighter file to fall back to, and cuts each image to its WebP size. Check first which of the heavy files above the batch covers. The rendition commands in `server/media.py` pass `-c:a aac` but add no audio source, so a rendition of a video-only master is also video-only. A rendition still above the link would keep the slow end in VR unless it gets a silent track too (see 5).
2. **Add a lower rung, or a ladder.** Even a 2048-per-eye file can be above a 9 to 13 Mbps link. A rung at about 6 to 8 Mbps fits under every rate measured here except the 5.2 Mbps case. A ladder (for example about 4 Mbps, about 8 Mbps and the master) covers that case too.
3. **Feed the link estimate from real playback.** Note each video's transfer rate as it plays (bytes over time from `progress` and `buffered`), not only from Preload All.
4. **Choose the rendition by the file's bitrate.** Pick the master only when the measured link is above the master's own bitrate plus headroom, not above a fixed 35 Mbps.
5. **Give the video-only files an audio track.** A silent AAC track (`ffmpeg -c:v copy`, no re-encode) turned the slow end into normal stalls in the XR test, so the loading overlay can open. It does not make the file lighter, so the stalls remain. New uploads with no audio could get the track at ingest, and the existing files could be remuxed by a batch. In the player, `currentTime` past the buffered end while playing can also be treated as a stall. The frame time from `requestVideoFrameCallback` gives the true position for that case.
6. **Load each image once.** Use `crossorigin="anonymous"` on the `<img>` and on every warmer, and drop `cache: 'reload'` from `vrImageLoad`. Prefetch the next slide for VR.
7. **Let the edge cache the player scripts and the font.** `three.min.js` and `webxr_vr.js` are `DYNAMIC` at the edge. The 4 MB Material Symbols font could be subset.

## Where the link limit is

Three checks were made after the 240 s run. Together they put the limit between the home connection and the Cloudflare edge.

- **The headset's Wi-Fi is not the limit.** `dumpsys wifi` shows Wi-Fi 6 on 5 GHz, an RSSI of −34 dBm, and a link speed of 1200 Mbps both ways.
- **R2 is not the limit.** The media is served from the nearest Cloudflare edge (`colo=SIN`). In the 240 s run, 12 of the 15 video requests were `cf-cache-status: HIT`. Only 3 were `MISS`.
- **Parallel streams help little.** From the headset, the same 42.7 MB file (`12827489_fast`, a `HIT`) was downloaded in four ways (`raw-quest/par3.js`):

| Mode | s | Mbps |
|---|---|---|
| 1 stream | 59.2 | 5.8 |
| 4 range requests in parallel | 44.0 | 7.8 |
| 8 range requests in parallel | 32.1 | 10.7 |
| 1 stream, again | 37.8 | 9.0 |

- **A laptop on the same connection did better, but not by much.** `curl` of the same file (through a local proxy) gave 11, 20 and 25 Mbps on three single-stream runs.

So the path to the edge carried about 6 to 25 Mbps during the run, and it varied from minute to minute. A speed test to a nearby server can show much more than that, because it does not cross the same path. Parallel range requests would not fix this. A lower bitrate would.

## Other findings

- **Four stale fal requests are re-polled about every 15 minutes.** Each poll returns 422. This is unrelated to playback.
