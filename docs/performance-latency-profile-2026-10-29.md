# Performance and latency profile — 2026-10-29

This is a profile of the production VPS as it ran on 2026-10-29. It covers latency from Vietnam and from seven VPN exit locations, server cost per request, capacity under load, database work per request (from Sentry), the browser load waterfall for `/reels`, and media delivery from R2. Prioritized recommendations are at the end.

Related docs:
- `docs/deploy-runbook.md`: the VPS, compose stack and tunnel setup this profile measured.
- `docs/to-beta.md`: release blockers and infrastructure verdicts.

## 1. Setup and method

**What was measured**
- **App:** the OVHcloud VPS in Hillsboro, Oregon (4 vCPU, 7.7 GB). It runs one uvicorn process (`deploy/entrypoint.sh`, `--workers 1`) behind a Cloudflare **quick tunnel** (`*.trycloudflare.com`). The named tunnel and custom domain do not exist yet.
- **Media:** the public R2 bucket through its `r2.dev` URL. The bucket location hint is `apac`.
- **Requests:** anonymous endpoints only. No sign-in was used against production.

**Client probe** (`probe.py`, curl-based)
- **Cold:** 12 requests, each in a fresh curl process. Each one pays DNS, TCP and TLS.
- **Warm:** 15 requests on one reused connection; the first is dropped. This shows request RTT plus server time.
- **Download:** two full downloads of a 10 MB MP4 from R2, for throughput.
- **Targets:**

| Target | Path | Size on the wire |
|---|---|---|
| healthz | `/api/healthz` | 11 B |
| feed | `/api/reels/feed` | 5 KB |
| reels | `/api/reels` | 41 KB (551 KB raw) |
| player | `/api/reels/player` | 1.1 MB (2.6 MB raw) |
| SPA index | `/` | 0.8 KB |
| SPA JS | `/assets/index-CJh6BpX3.js` | 114 KB |
| R2 poster | a 3840² poster JPEG | 93 KB |
| R2 MP4 | first 1 MB (range request) | 1 MB |

**Locations**
- Home in Vietnam, on the home ISP. Cloudflare serves it from Hong Kong (HKG).
- Seven Surfshark exits: Singapore, Tokyo, Sydney, Seattle, New York, London and Frankfurt.
- The egress Cloudflare colo was confirmed per run from `cdn-cgi/trace` and from the `cf-ray` header of each response.
- Runs took place from 22:44 to 23:43 local time (UTC+7): one run per location, p50 of 11–14 samples per target.

**Server side**
- Loopback requests on the VPS, which bypass Cloudflare.
- A closed-loop load generator (`load.py`) at 1–50 concurrent connections, with container CPU sampled during each step.
- Sentry traces for per-request DB spans.

**Browser:** a full `/reels` page load from Vietnam, read through the Resource Timing and Paint Timing APIs.

**Caveats**
- **The VPN adds a leg.** Every VPN result includes the path from Vietnam to the VPN exit, so cold numbers from VPN exits are much worse than a local user there would see. To remove that leg, the tables also give **edge+origin**: the warm TTFB p50 minus the TCP connect p50. TCP connect is one round trip to the Cloudflare edge, and that edge sits next to the VPN exit, so the remainder is about the edge→VPS round trip plus server time. A local user's warm TTFB is roughly edge+origin plus their own last-mile RTT (typically 10–30 ms).
- **VPN throughput is capped by the VPN tunnel**, not by R2 or the app.
- **The quick tunnel has no SLA.** A named tunnel uses the same Cloudflare-to-cloudflared path, so the edge→origin figures should carry over.

## 2. Latency by location

### Warm requests (connection already open)

All values are milliseconds and p50. Each cell is warm TTFB / edge+origin.

| Location (CF colo) | TCP to edge | ICMP ping to VPS | healthz | feed | reels | player | R2 poster |
|---|---|---|---|---|---|---|---|
| Home, Vietnam (HKG) | 28 | 277 | 206 / 178 | 329 / 302 | 431 / 404 | 480 / 453 | 165 / 106 |
| Singapore (SIN) | 48 | 294 | 293 / 245 | 383 / 335 | 419 / 371 | 823 / 775 | 159 / 112 |
| Tokyo (NRT) | 108 | 227 | 332 / 224 | 426 / 319 | 510 / 402 | 561 / 453 | 258 / 150 |
| Sydney (SYD) | 197 | 339 | 370 / 173 | 463 / 266 | 554 / 357 | 625 / 428 | 333 / 137 |
| Seattle (SEA/PDX) | 218 | 242 | 267 / 50 | 378 / 159 | 474 / 255 | 519 / 301 | 394 / 176 |
| New York (BOS) | 253 | 321 | 358 / 105 | 454 / 200 | 613 / 360 | 635 / 383 | 459 / 212 |
| London (LHR) | 214 | 349 | 390 / 176 | 525 / 311 | 582 / 368 | 929 / 715 | 533 / 320 |
| Frankfurt (FRA) | 221 | 372 | 433 / 212 | 535 / 314 | 623 / 402 | 964 / 743 | 782 / 562 |

Notes:
- **Home R2 traffic:** for media, the home connection reached R2 through Singapore (SIN), with a 59 ms TCP connect, not through HKG.
- **New York R2 traffic:** the New York exit's R2 requests landed on the Seattle colo.
- **Ping:** the ping column is a direct ICMP path over the public internet, not through Cloudflare. From home it is 277 ms, yet a warm healthz through the tunnel takes 206 ms. Cloudflare's backbone from HKG to Oregon is faster than the ISP's own route.

### Cold requests (new connection each time)

All values are milliseconds and p50.

| Location | healthz TTFB | feed TTFB | player total (1.1 MB) | SPA JS total (114 KB) | R2 1 MB total |
|---|---|---|---|---|---|
| Home, Vietnam | 283 | 408 | 1323 | 684 | 798 |
| Singapore | 458 | 552 | 1615 | 814 | 840 |
| Tokyo | 955 | 944 | 2587 | 1490 | 1879 |
| Sydney | 803 | 944 | 3460 | 1653 | 2877 |
| Seattle | 780 | 991 | 3664 | 1856 | 3796 |
| New York | 927 | 1002 | 4603 | 2319 | 4621 |
| London | 866 | 1144 | 4576 | 2055 | 3509 |
| Frankfurt | 1209 | 1067 | 4448 | 2374 | 3842 |

- **Most of the cold penalty is the handshake.** Cold minus warm healthz is about the DNS, TCP and TLS round trips, and those mostly ride the VPN leg. A real user in London or Seattle would see far less of it.
- **The penalty is still real for Vietnam.** From home, a cold request costs about 80 ms more than a warm one on small responses. The 1.1 MB player costs 1.3 s cold against 0.72 s warm.

### R2 throughput (10 MB download, two runs)

| Location | Mbps |
|---|---|
| Home, Vietnam | 27.7, 59.7 |
| Singapore | 54.7, 57.3 |
| Tokyo | 31.2, 28.7 |
| Sydney | 16.4, 14.9 |
| Seattle | 14.0, 12.0 |
| New York | 11.6, 12.0 |
| London | 14.1, 15.3 |
| Frankfurt | 13.9, 14.3 |

These numbers measure the path from Vietnam to the VPN exit as much as R2. The home figures are the trustworthy ones. The first home run was cold for that object (884 ms TTFB); the second took 266 ms.

### What the location data shows

- **Server time is the same everywhere.** Feed minus healthz is 90–135 ms from every location; on loopback it is 103 ms. `/api/reels` adds 130–255 ms (loopback 181 ms).
- **Edge→origin cost follows distance from Oregon:**

| Colo | Edge→origin (ms) |
|---|---|
| Seattle | 50 |
| New York | 105 |
| Sydney, London, HKG | ~175 |
| Frankfurt | 212 |
| Tokyo | 224 |
| Singapore | 245 |

  The main audience is in Vietnam and Asia, and it pays 175–245 ms on every API request before any server work.
- **R2 cost follows distance from the bucket.** The bucket is APAC and r2.dev is not edge-cached. Asia pays 106–150 ms, Seattle 176, New York 212, London 320 and Frankfurt 562.
- **Some colos add extra player TTFB.** Through SIN, LHR and FRA, the player's warm TTFB is about 530 ms above healthz. Elsewhere the gap is 230–280 ms. Server time does not explain the difference. A likely cause is the edge buffering the 2.6 MB uncompressed body before it starts compressing it, but this was not confirmed.

## 3. Server cost and capacity

### Single requests on loopback (no Cloudflare)

| Endpoint | p50 (ms) | p95 (ms) | Response size |
|---|---|---|---|
| `/api/healthz` | 0.8 | — | 11 B |
| `/api/reels/feed` | 103 | 230 | ~36 KB raw |
| `/api/reels` | 181 | 328 | 551 KB raw |
| `/api/reels/player` | 167 | 250 | 2.6 MB raw |
| SPA static | 2.2 | — | — |

### Load on loopback (one uvicorn worker)

| Endpoint | Concurrency | Throughput (rps) | p50 | p95 | p99 |
|---|---|---|---|---|---|
| healthz | 50 | 1413 | 32 ms | 42 ms | 157 ms |
| feed | 10 | 12.9 | 1.0 s | 1.4 s | 1.5 s |
| feed | 25 | 7.6 | 2.7 s | 6.1 s | 8.2 s |
| feed | 50 | 6.9 | 5.8 s | 12.7 s | 16.8 s |
| reels | 1 | 4.9 | 176 ms | 328 ms | 480 ms |
| reels | 10 | 4.1 | 2.3 s | 3.0 s | 8.4 s |
| reels | 25 | 4.0 | 5.8 s | 8.2 s | 12.6 s |
| player | 1 | 5.7 | 162 ms | 280 ms | 361 ms |
| player | 10 | 5.3 | 1.7 s | 2.1 s | 10.9 s |
| player | 25 | 5.3 | 4.1 s | 8.1 s | 18.1 s |

- **Rate limiting:** the feed's per-IP limit of 60 per minute (`server/routers/reels.py:1995`) returned 429 to part of the low-concurrency feed runs. The c=50 run spread its requests across IPs and got 200 on all of them. The feed ceiling is therefore about **7–10 rps** of real responses.
- **The bottleneck is Python CPU in the single app process, not the database.** App CPU peaked at 107–208%; Postgres stayed at 8–35%.
- **Workers cannot simply be added.** The runbook forbids adding workers: JobManager and the staged-upload registries live in-process (`docs/deploy-runbook.md`). Capacity has to come from less CPU per request.
- **The tunnel is not a limit.** Through the tunnel from Vietnam, healthz scaled to 220 rps at c=50 with a flat p50 of about 200 ms, which is the RTT. `/api/reels` at c=5 gave 4.3 rps (p50 1.07 s), the same ceiling as loopback.

**Rough user capacity.** One player open, one `/api/reels` and a feed page every few swipes add up to about 0.3–0.5 s of app CPU per session start. With about 100–200 sessions starting in the same minute, p50 latency moves into whole seconds.

### Database work per request (Sentry traces)

Observed rates of `http.server` transactions per hour during testing:

| Transaction | Per hour |
|---|---|
| feed | 1965 |
| events | 390 |
| player | 285 |
| `/api/reels` | 255 |
| view | 190 |

**`GET /api/reels/feed`** runs about 20 queries per request:
- **Repeated catalog lookups.** Several queries use IN-lists that cover all 201 posts on every request: `post_tags`, `posts JOIN users`, `post_recommendation_stats`, a `media_path` lookup and a hidden-paths scan. The `posts JOIN users` query also eager-loads columns the feed never uses, including `password_hash`.
- **Writes on every read.** A `recommendation_requests` row and impression rows are inserted on every request.
- **Rate limiter.** The DB-backed rate limiter (`server/social/auth.py:373`) adds 4 round trips per request.

**`POST /api/posts/{id}/view`** (`server/routers/social.py:1365`) runs about **177 DB spans per request**. The source is the N+1 in `_update_co_watch` (`server/social/recommendations/events.py:193`):
- **The loop.** For each of the viewer's 20 most recent affinity rows, it does a get-or-create on `CoWatchPair`, three counts, and two get-or-creates on `ItemSimilarity`.
- **Typical span counts per view:**

| Statement | Count |
|---|---|
| `item_similarities` selects | 38 |
| affinity counts | 34 |
| `co_watch` selects | 32 |
| other counts | 17 |
| inserts | 14 |

The view call fires on every reel the viewer watches, so this is the heaviest write path per user action.

Sentry trace explorer: https://ledhoang.sentry.io/explore/traces/?query=span.op%3Ahttp.server&project=4512324030889984

## 4. Browser load of `/reels` from Vietnam

| Milestone | Time |
|---|---|
| Navigation TTFB | 721 ms |
| DOMContentLoaded | 2009 ms |
| First Contentful Paint | 2732 ms |
| Largest Contentful Paint | 6660 ms |

The load runs as six strictly sequential stages; each one waits for the previous:

| # | Stage | Time window (ms) |
|---|---|---|
| 1 | HTML document | 0–721 |
| 2 | `index` JS and CSS | 735–2000 |
| 3 | Lazy route chunks, `/api/auth/me`, billing | 2024–2690 |
| 4 | `/api/reels` and config | 2706–3540 |
| 5 | `/api/reels/player` (1078 KB compressed) | 3544–5690 |
| 6 | First R2 media request | 5794 |

The player document alone is about 2.1 s of the 6.7 s LCP. Stages 3–4 are round trips that could overlap with stage 2.

Time to first frame, measured once the player was up:

| Media | Time to first frame |
|---|---|
| `SnapReels_fast` (3840² HEVC) | 1144 ms, 1191 ms |
| `reel1_23full` (1280) | 1080 ms, 620 ms |
| A 91 KB poster image | 953 ms |

## 5. Payload and caching findings

**The player is large and uncacheable.**
- `/api/reels/player` returns about 2.6 MB of HTML, 1.08 MB after Cloudflare compression. It sends `cache-control: no-store, no-cache, must-revalidate, max-age=0`, so every open downloads it again.
- Most of the body is vendored JS inlined into the template on each request (`server/routers/reels.py:2775-2796` in `reels_player`; the same in `reels_player_inline` around `:3011`):

| Script | Size |
|---|---|
| `quest_controller_img.js` | 866 KB |
| `three.min.js` | 816 KB |
| `webxr_vr.js` | 462 KB |
| `vr_ui_canvas.js` | 95 KB |

  Each request also re-reads these files from disk and runs several multi-megabyte `str.replace` passes. That is part of the player's 167 ms of server time.

**The SPA's hashed assets have no cache header.** `/assets/*` is mounted with plain `StaticFiles` (`server/app.py:305`).
- The responses carry only `ETag` and `Last-Modified`, so browsers revalidate them.
- Cloudflare reports `cf-cache-status: DYNAMIC` on every tunnel response, including the content-hashed `/assets/index-CJh6BpX3.js`.
- `/media` already uses `CachedStaticFiles` with a `Cache-Control` header, but `/assets` does not.

**R2 media is not edge-cached.** Responses from `r2.dev` carry no `cf-cache-status`, so every request goes back to the APAC bucket. That is why European and US media TTFB grows with distance (section 2). Cloudflare documents `r2.dev` as rate-limited and not meant for production. The planned `media.<domain>` custom domain (deploy runbook) would allow Cloudflare caching.

**Some MP4s are not faststart.**
- 25 of the 63 main MP4s (0.84 GB) have the `moov` atom at the end of the file. The player must fetch the file's tail before the first frame.
- All 47 explore variants and all 28 preview variants are faststart.
- The feed's `url` field points at the main file (HEVC), and `preview_url` is empty, so the main file is what plays.

## 6. Recommendations, in priority order

1. **Serve the player's vendored JS as separate, hashed, immutable files.** Replace the `__THREE_JS__`, `__QUEST_CONTROLLER_IMG_JS__`, `__WEBXR_VR_JS__` and `__VR_UI_CANVAS_JS__` inlining (`server/routers/reels.py:2775-2796` and `:3011-3015`) with `<script src>` tags carrying a CSP nonce. The player document drops from 1.08 MB to tens of KB, and repeat loads skip about 1 MB. From Vietnam this should save about 1.5–2 s on the first frame, and it cuts per-request server CPU.
2. **Give `/assets/*` a long immutable cache header.** Use `Cache-Control: public, max-age=31536000, immutable` (`server/app.py:305`), the same way `CachedStaticFiles` does for `/media`. With the named tunnel on a custom domain, Cloudflare can then cache these files at the edge.
3. **Move media to the `media.<domain>` custom domain with caching on.** Cached hits would remove the 106–562 ms R2 origin cost per request. Users in Europe and the US gain the most (300–560 ms on each media TTFB).
4. **Faststart the 25 non-faststart main MP4s.** Run `ffmpeg -c copy -movflags +faststart` on each, then re-upload. Add a check so new uploads are always faststart.
5. **Collapse the SPA waterfall.** Start `/api/reels` and config in parallel with the bundle, either by preloading them or inlining them into the HTML. Then load the player document directly instead of after them. This removes about 1.5 s of serial round trips from Vietnam.
6. **Cut CPU per request, because the worker count is fixed at 1.**
   - Cache the candidate and catalog data the feed rebuilds on every request, in process with a short TTL. This replaces the 201-post IN-list queries.
   - Cache the player template after its static substitutions.
   - Stop eager-loading `password_hash` and other unused user columns in feed queries.
   - If that is not enough, split the read-only routes (feed, reels, player) into a separate stateless service that can scale. JobManager and the upload registries stay in the single app process.
7. **Fix the view-path N+1.** Batch `_update_co_watch` (`server/social/recommendations/events.py:193`): load the 20 affinity rows, their pairs, and their similarity rows in a few set-based queries, and upsert in bulk. Alternatively, move it to a background task so `POST /view` returns at once.
8. **Move the rate limiter off the database.** There is exactly one app process, so an in-memory sliding window gives the same guarantees without 4 DB round trips per request (`server/social/auth.py:373`).
9. **Reconsider the hosting region.** From Oregon, every Asian API request pays 175–245 ms of edge→origin before any server work. If the audience stays mainly in Vietnam and Asia, an APAC VPS (for example Singapore) would cut that to tens of ms. The VPS would then sit next to the APAC R2 bucket too. Recommendations 1–5 are worth doing first, because they help every region.

## 7. Raw data

The probe scripts and raw JSON results were kept in the session scratchpad and are not committed. Rerun the probe from any network to compare:

```
python3 probe.py <label>          # writes results/<label>.json
python3 load.py http://127.0.0.1:8000 /api/reels/feed 25 15   # on the VPS
```

## 8. After the fixes (2026-10-30)

### What shipped

All five changes are on `vr-rea-playback` and deployed to the production VPS.

| Commit | Recommendation | Change |
|---|---|---|
| `2eb4294` | 1, 2 | The player loads its vendored scripts as separate hashed files, and `/assets/*` is served with a long immutable cache header. |
| `5ea1b9a` | 7 | The co-watch update on `POST /view` runs in a fixed number of queries. |
| `facc608` | 8 | The rate limiter counts in memory instead of in the database. |
| `0516157` | 6 (part) | The feed catalog loads plain columns instead of full `Post` entities. |
| `8ab896b` | 4 | New uploads are remuxed to faststart when published. |

The 25 existing non-faststart main MP4s were also remuxed in place with `ffmpeg -c copy -movflags +faststart` and re-uploaded to R2. This was a container-only change to the layout. No video stream was re-encoded.

The player document dropped from 1,101,464 bytes to 79,511 bytes.

### Latency by location, before and after

The same probe as section 2 was run again from home (Vietnam) and from each Surfshark location. "MP4 startup" is an estimate. It adds the time to fetch the ranges the player needs before the first frame: the head and the tail of the file before the fix, and only the head after. All times are in ms.

| Location | Ping | Player HTML, cold | Feed TTFB, cold | Feed TTFB, warm | `/api/reels`, cold | MP4 startup (est.) |
|---|---|---|---|---|---|---|
| Home (VN) | 277 | 1323 → 509 | 408 → 481 | 329 → 319 | 936 → 967 | 1217 → 375 |
| US Seattle | 238 | 3664 → 1763 | 991 → 855 | 378 → 374 | 1582 → 1626 | 5493 → 1801 |
| US New York | 318 | 4603 → 2070 | 1002 → 962 | 454 → 424 | 1967 → 2046 | 5841 → 1872 |
| UK London | 357 | 4576 → 1913 | 1144 → 948 | 525 → 478 | 1788 → 1731 | 5513 → 1835 |
| DE Frankfurt | 367 | 4448 → 2082 | 1067 → 932 | 535 → 482 | 2122 → 1880 | 5196 → 1877 |
| SG Singapore | 282 | 1615 → 930 | 552 → 448 | 383 → 332 | 965 → 1002 | 2856 → 1095 |
| JP Tokyo | 224 | 2587 → 1087 | 944 → 510 | 426 → 298 | 1424 → 1103 | 2828 → 1029 |
| AU Sydney | 377 | 3460 → 1559 | 944 → 1000 | 463 → 476 | 1607 → 1785 | 3546 → 1375 |

The player document is 2–2.5× faster everywhere, and the estimated MP4 startup is 2.6–3.3× faster. The feed and `/api/reels` timings are mostly unchanged. They are bound by distance to Oregon and by the per-request work, which these changes did not target.

### Time to first frame in the browser

Measured in Chrome as the time from setting `src` to `loadedmetadata` and to `canplay`. Each value is the median of three cache-busted loads. Format: meta/canplay, in ms.

| Location | reel1 | reel3 | SnapReels | FixatG | Travis | 12827489 |
|---|---|---|---|---|---|---|
| Home, before | 913/923 | 1073/1081 | 915/1069 | 919/1030 | 680/1100 | 1210/1296 |
| Home, after | 407/510 | 385/445 | 364/462 | 502/544 | 342/585 | 564/693 |
| Seattle, after | 1142/1161 | 1723/2172 | 1195/1263 | 1444/2194 | 1827/3275 | 1116/1627 |
| New York, after | 1858/2246 | 1839/2501 | 1725/2297 | 2589/3573 | 1603/2929 | 2954/3506 |
| London, after | 1760/2122 | 1827/2277 | 2156/2464 | 1237/1690 | 1453/2682 | 2796/3269 |
| Frankfurt, after | 1586/1905 | 1876/2306 | 1792/2350 | 1698/2152 | 1099/1169 | 2848/3551 |
| Singapore, after | 1006/1156 | 1036/1255 | 1086/1309 | 1236/1439 | 1027/1384 | 941/1225 |
| Tokyo, after | 754/766 | 1109/1283 | 1220/1398 | 1166/1443 | 514/1074 | 1614/1826 |
| Sydney, after | 1300/1483 | 1255/1448 | 1038/1217 | 1277/1562 | 1154/1830 | 540/665 |

From home, the first frame is about twice as fast. No browser measurement was taken at the VPN locations before the fix, so only the probe estimate above compares them. The US and Europe remain at 1.2–3.6 s because every media request goes back to the APAC R2 bucket (recommendation 3).

### Server capacity on loopback

The same load run as section 3 (15 s per step, one keep-alive connection per worker, on the VPS). "Good rps" counts only 200 responses. The p50 for the feed mixes fast 429 responses with real ones, so it is not comparable between runs.

| Route | Concurrency | Good rps before | Good rps after | p50 before | p50 after |
|---|---|---|---|---|---|
| `/api/reels/feed` | 25 | 7.0 | 11.0 | — | — |
| `/api/reels/feed` | 50 | 6.9 | 12.1 | 5837 | 2985 |
| `/api/reels` | 10 | 4.1 | 4.8 | 2279 | 1977 |
| `/api/reels` | 25 | 4.0 | 4.6 | 5836 | 4997 |
| `/api/reels/player` | 1 | 5.7 | 11.0 | 162 | 88 |
| `/api/reels/player` | 10 | 5.3 | 9.4 | 1742 | 984 |
| `/api/reels/player` | 25 | 5.3 | 10.0 | 4110 | 2243 |

The player route serves about twice as many requests, and the feed about 1.6–1.75× as many. A 429 from the in-memory limiter costs about 2.5 ms, against about 7.5 ms before. `/api/reels` gained only about 15%, because it still builds its full list on every request.

### Quality check

- Each remuxed file was compared with its original before replacement using `ffmpeg -f streamhash -hash sha256` over every stream. All 25 matched, so the audio and video packets are bit-identical.
- A browser test loaded each of the 25 files, read its resolution and duration, and seeked to the end. 24 passed with the expected values.
- `Testray3.2.mp4` timed out. It is HEVC Main at level 6.0 and 5760×5760, which is beyond the Mac's hardware decoder. That was true before the remux, and its `_proper_encoding` sibling plays.
- The originals are backed up on the VPS at `/home/debian/faststart-backup-2026-10-30`.

### Function check

- `make test` passed: 706 pytest, 399 node and 478 vitest tests.
- On `/reels`, the player initialised (`THREE` and `WebXRVR` present), a 1080p video played, and there were no console errors.
- `/explore` rendered 201 reels with no broken images.
- `/api/reels/feed` returned 200 with 12 items, all with tags, and `has_more` true.
- On the VPS, the app and Postgres containers were healthy, `readyz` reported schema `20261022_0017`, and the logs held no 5xx responses or tracebacks in the three hours after deploy.

### Caveats

- Each location was probed once before and once after. Network variance is visible: in Singapore, R2 TTFB rose from 298 to 882 ms on unchanged files, and in Tokyo everything was faster, including routes the fixes did not touch.
- R2 responses carry `max-age=86400`, so a browser or cache that fetched an old non-faststart file may keep it for up to 24 hours.
- The `RateLimitEvent` table is no longer written. It was left in place.

### Still open

- Recommendation 3 (`media.<domain>` with caching) and 9 (hosting region) need a domain and a decision. They are the main remaining wins for the US and Europe.
- Recommendation 5 (SPA waterfall) is not done.
- Recommendation 6 is only partly done. The feed still rebuilds its candidates on every request, and `/api/reels` still builds its full list.

## 9. Reels list fixes (2026-10-30, second deploy)

### What shipped

Deployed to production as `9d638e8`.

| Commit | Change |
|---|---|
| `a3e2010` | `/api/reels` serializes its ~600 KB response with pydantic-core (`response_model=dict`) instead of `jsonable_encoder`, which cost about 42 ms of the request in production. Image posters are checked with one `stat` instead of three. |
| `7feca1a` | Without a `?play=` deep link, `/reels` starts loading the player alongside `/api/reels` instead of after it. |
| `9d638e8` | `/reels` fetched `/api/reels` twice for anonymous visitors: once on mount, and again when `/api/auth/me` returned no user. The list now keys on the viewer id, so it is fetched once. |

### Server capacity on loopback

Same run as section 8. Only `/api/reels` was targeted; the feed and player rows matched section 8 within noise.

| Route | Concurrency | Good rps, section 8 | Good rps, now | p50 section 8 | p50 now |
|---|---|---|---|---|---|
| `/api/reels` | 1 | 5.6 | 5.8 | 158 | 120 |
| `/api/reels` | 10 | 4.8 | 5.9 | 1977 | 1634 |
| `/api/reels` | 25 | 4.6 | 5.9 | 4997 | 4086 |

`/api/reels` serves about 25% more requests under load, and a single request is about 40 ms faster. Against the first baseline (4.0 rps at 25), it is now about 1.5×.

### Browser load of `/reels` in production (from home, warm)

| | Before | After |
|---|---|---|
| `/api/reels` requests per page load | 2 | 1 |
| Player request starts | after the list returns | at the same time as the list (both at 881 ms) |
| List response | — | 882 → 1611 ms |
| Player response | — | 881 → 2053 ms |

### Function and quality check

- `make test` passed: 706 pytest, 399 node and 478 vitest tests.
- `/api/reels` through the tunnel returned 200 with the same keys, 201 items, and posters on all 159 images.
- `/reels` rendered 201 items and a playing video, with no console errors.
- A `?play=` deep link still waits for the list and opens the requested post.
- An anonymous visitor to `/reels?feed=following` is still redirected to `/login`.
- No media files were touched in this deploy.

### Location probes

Repeated on 2026-10-30 from an unfiltered network, against the section 7 runs. Ping to the VPS was higher than in section 7 at every location (for example 238 to 631 ms in Seattle), so absolute times are not comparable. The table compares warm time to first byte of `/api/reels` minus warm `/api/healthz` from the same run, which removes the shared network path and leaves the time the server spends building the list.

| Location (colo) | healthz warm, before → after | `/api/reels` warm, before → after | List time over healthz, before → after | Change |
|---|---|---|---|---|
| Home, Vietnam (HKG) | 209 → 238 ms | 403 → 377 ms | 194 → 139 ms | −55 ms |
| Seattle (SEA) | 279 → 276 ms | 464 → 385 ms | 185 → 109 ms | −76 ms |
| London (LHR) | 388 → 454 ms | 606 → 609 ms | 218 → 155 ms | −63 ms |
| Frankfurt (FRA) | 392 → 553 ms | 574 → 673 ms | 182 → 120 ms | −62 ms |
| New York (EWR) | 353 → 410 ms | 518 → 781 ms | 165 → 371 ms | not usable |
| Singapore (SIN) | 239 → 920 ms | 430 → 916 ms | 191 → −4 ms | not usable |

The four usable locations agree: building the list takes about 55 to 76 ms less per request, in line with the loopback drop at c=1 (158 to 120 ms p50). The New York and Singapore runs were taken on congested VPN servers, where healthz alone varied by more than the effect being measured. A first Frankfurt attempt was routed through Prague (PRG) and was discarded. Tokyo and Sydney were not repeated in this round.

The list payload is unchanged in size (41,700 to 41,706 bytes) and in content: production returns 201 items, all of them published posts.
