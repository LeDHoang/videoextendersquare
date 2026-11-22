# Quest 3 run on release 7ab15a6, 2026-11-22

A Quest 3 on a home connection, driven over USB through adb and the Quest Browser's DevTools protocol. The run asked two questions:

1. How fast does a first-time visitor get from the URL to a playing reel in VR?
2. Why do reels play choppy and "keep loading", even on a good connection?

The scripts and raw samples are in `raw-quest/`. `ttvr.mjs` times a cold open and the VR entry. `mon2.mjs` watches the player in VR for 240 s. It hooks every `<video>` event, samples the buffer and frame counters every 400 ms, and records each network transfer. `an2.py` turns its output into the stall and freeze columns below.

## Summary

- **Getting into VR is fast enough.** From a cold cache, the first XR frame comes 6.0 to 7.2 s after the URL is opened. The player is ready at 3.8 to 4.4 s. From the click on the VR button to the first XR frame takes 0.9 to 1.3 s.
- **The choppiness is the network, not the headset.** The heavy videos are 4K masters at 22 to 51 Mbps. Each one plays as a single progressive file. One file's download ran at about 9 to 13 Mbps, and 5.2 Mbps at the lowest. The decoder dropped no frames on any of these files, and the XR loop ran at about 89 fps.
- **"Keeps loading" is two separate things:**
  - **Mid-clip stalls.** A file above the link rate runs out of buffer. The worst case was 5 stalls and 17.9 s of waiting in a 15 s clip.
  - **The end-of-clip freeze.** The player's clock reaches the end before the last bytes arrive. The picture freezes on its last frame with no spinner, and the next reel starts only when the download finishes. The worst case was a 15.2 s freeze after a 6.7 s clip.
- **The 2k VR rendition is never played.** All 24 items in the feed have `vr2k_url: null`. If a post had one, the player still would not pick it, because the link estimate is fed only by the manual "Preload All" button.
- **Images are the original PNGs, and each is downloaded twice.** The WebP renditions are missing on R2. A CORS fetch and a no-CORS `<img>` cannot share one cache entry under `Vary: Origin`. In VR each image change showed the previous frame for 1.2 to 3.2 s.

## Time to VR

There were three cold runs, with no load test running. Before each run, the script cleared the DNS cache, the socket pool and the HTTP cache. Times are in ms from navigation start. The raw output is `raw-quest/ttvr-idle.json`.

| Run | TTFB | FCP | Player ready | First reel | VR click | XR start | First XR frame |
|---|---|---|---|---|---|---|---|
| 0 | 621 | 1412 | 3845 | 4522 | 4617 | 5359 | 5961 |
| 1 | 1237 | 1868 | 4380 | 5500 | 5658 | 6129 | 6564 |
| 2 | 622 | 1476 | 4001 | 6267 | 6287 | 6745 | 7203 |

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
- **End freeze s:** the time between the clock reaching the end and the next reel starting.

The probe's own byte count (`Network.dataReceived`) was 10 to 27% above the true file sizes, so the table does not use it.

| Video | Length (s) | MB | Mbps | dl s | Rate Mbps | Stalls | Stall s | End freeze s |
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

An earlier 150 s run (`mon1.json`) had one more case: `test_cas.mp4`, 6.7 s long. Its true size was not measured. The download took 59 s. Its picture froze at 6.7 / 6.7 for 37.5 s, and the feed moved on 180 ms after the transfer finished.

The rows show these patterns:

- **Files at or below about 14 Mbps played cleanly.** The one stall among them was 0.8 s.
- **Above about 20 Mbps, every file but one either stalled or froze at the end.** The heavier the file, the longer the wait. The exception was `camtestupload`, a 5.1 s clip. The probe did not record why it played cleanly.
- **The download time, not the clip length, sets how long a heavy reel stays on screen.** `12827489_fast` is 6.7 s long, but it held the screen for 26.5 s.
- **Frame drops were 0** on every file except the first, which dropped 24 of 120 frames during the VR entry.

### Why the end freeze shows no spinner

The files are laid out for streaming: `ftyp` and `moov` come first, then `mdat`, with the frames in order. So the layout is not what holds the clip back.

The cause is the download. The player's clock runs ahead of the downloaded data. At the last frames the clock stops at the clip's length, with 0 s of buffer ahead. `readyState` stays at 4 and no `waiting` event fires, so the VR loading overlay (`reelLoadState` in `webxr_vr.js`) never opens. `ended` fires only once the last bytes arrive, and `nextVideo('autoplay')` runs on `ended`. A screenshot taken during the `12827489_fast` freeze (`hang-10.png`, not committed) shows the last frame held, with no overlay.

### Why the 2k rendition is never played

The 2k rendition (`<stem>-2k.mp4`) is the file meant for this case. There are four reasons it never plays:

1. **It does not exist.** All 24 items in `/api/reels/feed` have `vr2k_url: null`. On R2, `<stem>-2k.mp4` returns 404 for the four heavy files probed: `12827489_fast`, `12492094_fast`, `12492094_3840_3840` and `test_cas`.
2. **The batch would not build all of them.** `scripts/batch_vr2k.py` builds the missing files only for posts where `vr2k_shrinks` (`server/media.py`) is true. That test is `width × height > eyes × VR2K_EYE_SIDE²`. The 3840² mono masters and `vc-2160-eye` pass it. The 4092×2046 side-by-side files (`h264-9-7mb`, `hevc-4-6mb`) do not, so they would keep only the master. The `12827489_fast`, `12492094_*` and `test_cas` files are not in `/api/reels/feed` or `/api/reels?limit=500`. They may not be posts at all, and this run did not check whether the batch covers them. The batch has not been run on production.
3. **The link estimate is never fed.** `noteDownload` is called only from `preloadAllVideos` (`reels.html`), the manual "Preload All" button. In normal play `vrLinkMbps()` stays at 0, which means "not measured", so the player keeps the master.
4. **The threshold is fixed.** The player drops to 2k only when the link is below 35 Mbps (`VR_MASTER_MIN_MBPS`). It does not compare the link with the file's own bitrate. The 36 to 51 Mbps masters above would stall on a 40 Mbps link too, and stay on the master.

### Images

`_image_entry` (`server/social/services.py`) sets `vr_url` to the `vr` rendition, or to the display URL when that rendition is missing. On R2, `<stem>-tile.webp`, `<stem>-2d.webp` and `<stem>-vr.webp` all return 404. So every image view loads the original PNG (0.7 to 1.5 MB). `scripts/batch_image_renditions.py` builds the renditions. It has not been run on production.

Each image is also fetched twice:

- `vrImageLoad` uses `fetch(url, {cache: 'reload'})`, a CORS request with an `Origin` header.
- The `<img>`, the slide warmer, the next-reel warmer and the backdrop all use no-CORS requests with no `Origin`.

R2 answers with `Vary: Origin`, so the two kinds of request cannot share a cache entry. Slides after the first in a multi-slide post are not prefetched for VR. `vrImagePrefetch` covers only the next reel's cover. The image downloads also compete with the video download on the same link.

## Recommendations

These are in order of effect on the choppiness. None of them are done. The first two change production data, and the rest change the player.

1. **Build the missing renditions on production.** Run `scripts/batch_vr2k.py` and `scripts/batch_image_renditions.py` (each has `--dry-run`). This gives the player a lighter file to fall back to, and cuts each image to its WebP size. Check first which of the heavy files above the batch covers.
2. **Add a lower rung, or a ladder.** Even a 2048-per-eye file can be above a 9 to 13 Mbps link. A rung at about 6 to 8 Mbps fits under every rate measured here except the 5.2 Mbps case. A ladder (for example about 4 Mbps, about 8 Mbps and the master) covers that case too.
3. **Feed the link estimate from real playback.** Note each video's transfer rate as it plays (bytes over time from `progress` and `buffered`), not only from Preload All.
4. **Choose the rendition by the file's bitrate.** Pick the master only when the measured link is above the master's own bitrate plus headroom, not above a fixed 35 Mbps.
5. **Show the loading overlay during the end freeze, or move on.** When the clock is at the end with no buffer ahead, open the overlay. Another option is to move to the next reel and let the download finish in the background.
6. **Load each image once.** Use `crossorigin="anonymous"` on the `<img>` and on every warmer, and drop `cache: 'reload'` from `vrImageLoad`. Prefetch the next slide for VR.
7. **Let the edge cache the player scripts and the font.** `three.min.js` and `webxr_vr.js` are `DYNAMIC` at the edge. The 4 MB Material Symbols font could be subset.

## Other findings

- **The 9 to 13 Mbps is from R2 to the headset, one stream per file.** The home connection may be faster across parallel streams. Range requests in parallel, or a lower bitrate, would make better use of it.
- **Four stale fal requests are re-polled about every 15 minutes.** Each poll returns 422. This is unrelated to playback.
