# Load and latency profile, 2026-11-11

A profile of production `echomultiverse.com` through the public edge: latency per path at one connection, a concurrency ramp per path, and a session-start mix. It answers how many users the single app process serves and what p95 and p99 they see.

Related docs:
- `docs/performance-latency-profile-2026-10-29.md`: the baseline, with loopback capacity runs on the VPS (sections 3 and 9).
- `docs/perf-probes/2026-11-10/README.md`: latency by location after the named tunnel.

## Summary

**Max parallel users.** Taking "p95 TTFB of every request under 1.5 s" as the limit, the app holds **5 session starts in flight at once, about 110 per minute**. The hard ceiling is 15 in flight, about 160 per minute, where `/api/reels` p95 passes 3 s. For people already watching, the estimate is about 150 simultaneous viewers plus 30 to 40 arrivals per minute (see "Capacity in users"; estimated, not measured).

- **A session start here is** `/`, `/api/config`, `/api/auth/me`, `/api/reels` and `/api/reels/player`. It leaves out the feed page, which is rate limited per IP. With a feed page added, the loopback run on the VPS measured a ceiling of 136 to 156 per minute (section 5), so the 110 becomes about 95 to 105.
- **These rates are upper bounds.** The load was closed-loop: each worker waits for its answer before the next request. Real arrivals come in bursts, and bursts at the same average rate have worse tails.
- **`/api/reels` is the bottleneck: 4.4 rps.** The other reels routes saturate at 6 to 8 rps. Past the plateau, latency grows in step with concurrency, which is requests queueing on one busy process.
- **Capacity is 12 to 20% below the 2026-10-30 loopback run, and the drop is in the server.** At 10 connections on loopback, `/api/reels` went from 5.6 to 4.8 rps, the player from 10.2 to 8.1 and the feed from 12.1 to 10.7 (section 5). The cause is not identified here.
- **The limit is one CPU core.** Under load the app process holds about 110% CPU on a 4 vCPU box, and Postgres stays under 20%.
- **Light routes are not a limit.** `healthz`, `/`, `/api/config` and `/api/auth/me` held p95 under 420 ms at 50 connections and about 170 rps, where the client's round-trip time capped the rate.
- **No errors.** 72692 requests, all 2xx, with no app 429 and no Cloudflare challenge or block.

## Method

- **Tool:** `load.py` in this folder, standard library only. Each worker thread keeps one HTTPS connection (HTTP/1.1) and sends requests back to back. TTFB runs from sending the request to the response headers; total includes reading the body. Percentiles cover 2xx responses only.
- **Client:** a Mac on a network in Taiwan, Cloudflare colo TPE. Warm TTFB to `/api/healthz` was p50 232 ms and p95 260 ms just before the run. That round trip is inside every figure below. Server time is roughly TTFB minus 235 to 265 ms.
- **When:** 2026-11-11, 04:22 to 06:00 UTC. Latency ran first, then the ramp, then the mix.
- **Deployed release:** `4e05762` (the release tag on the Sentry transactions of this window).
- **Latency:** one connection per path, 250 good samples or 120 s, whichever came first. The two rate-limited routes ran at 50 requests per minute for up to 300 s. With 250 samples, p99 is the third-slowest request.
- **Ramp:** 13 paths at 1, 2, 5, 10, 15, 25 and 50 connections, 25 s per step. A path stopped after the first step whose p95 TTFB passed 3 s or whose non-2xx share passed 2%.
- **Mix:** each worker loops over the five session-start requests in order, 50 s per step, same stop rule.
- **Server side:** Sentry transaction durations for the same two hours (sampled).

**Not covered**
- Signed-in, mutating, job, upload and SSE routes. No account was used against production.
- Media under load. Media is served by R2 and the edge, not the VPS; it has latency figures only.
- `POST /api/events`. The player sends it for each reel viewed, so its cost is missing from the viewer estimate below.

## 1. Latency per path, one connection

Milliseconds.

| Target | Path | n | TTFB p50 | p95 | p99 | max | Total p50 | p95 | p99 | Bytes |
|---|---|---|---|---|---|---|---|---|---|---|
| healthz | `/api/healthz` | 250 | 268 | 397 | 763 | 1401 | 268 | 397 | 763 | 11 |
| readyz | `/api/readyz` | 250 | 265 | 328 | 346 | 789 | 265 | 328 | 346 | 151 |
| health | `/api/health` | 250 | 266 | 286 | 325 | 385 | 266 | 286 | 325 | 814 |
| config | `/api/config` | 250 | 268 | 291 | 333 | 379 | 268 | 291 | 333 | 1312 |
| auth_me | `/api/auth/me` | 250 | 233 | 252 | 281 | 343 | 233 | 252 | 281 | 13 |
| reels | `/api/reels` | 226 | 411 | 578 | 752 | 948 | 508 | 678 | 851 | 37661 |
| reels_feed | `/api/reels/feed` | 249 | 386 | 524 | 605 | 1120 | 386 | 525 | 606 | 5247 |
| player | `/api/reels/player` | 220 | 440 | 533 | 619 | 759 | 520 | 627 | 822 | 85303 |
| player_script | `/api/reels/player-script/webxr_vr.js` | 250 | 343 | 440 | 518 | 539 | 431 | 531 | 637 | 168973 |
| tags | `/api/reels/tags` | 250 | 373 | 510 | 531 | 616 | 373 | 510 | 531 | 551 |
| tag_detail | `/api/reels/tags/music-video` | 189 | 517 | 686 | 778 | 785 | 614 | 806 | 830 | 9290 |
| locations | `/api/reels/locations` | 250 | 372 | 513 | 565 | 595 | 372 | 513 | 565 | 387 |
| locations_activity | `/api/reels/locations/activity` | 250 | 381 | 544 | 673 | 999 | 381 | 545 | 674 | 1505 |
| location_detail | `/api/reels/locations/miami--usa` | 250 | 485 | 616 | 626 | 720 | 486 | 616 | 627 | 3897 |
| map_attribution | `/api/reels/map-tiles/attribution` | 250 | 271 | 366 | 527 | 581 | 271 | 366 | 527 | 156 |
| earth_texture | `/api/reels/earth-texture` | 250 | 236 | 259 | 517 | 888 | 345 | 582 | 1999 | 1315120 |
| social_feed | `/api/feed` | 250 | 304 | 405 | 420 | 436 | 307 | 406 | 421 | 5033 |
| creators | `/api/recommendations/creators` | 249 | 328 | 465 | 549 | 1081 | 328 | 465 | 550 | 1144 |
| search_suggest | `/api/search/suggestions?q=a` | 250 | 409 | 555 | 617 | 622 | 409 | 555 | 617 | 2486 |
| packs | `/api/packs` | 250 | 297 | 339 | 415 | 501 | 298 | 339 | 415 | 1529 |
| billing_catalog | `/api/billing/catalog` | 250 | 265 | 286 | 306 | 408 | 266 | 287 | 306 | 1366 |
| msg_capabilities | `/api/messages/capabilities` | 250 | 266 | 287 | 302 | 334 | 266 | 287 | 303 | 320 |
| user | `/api/users/test22` | 250 | 282 | 318 | 521 | 610 | 282 | 318 | 522 | 240 |
| user_posts | `/api/users/test22/posts` | 250 | 278 | 324 | 438 | 655 | 279 | 325 | 438 | 994 |
| post | `/api/posts/96ed4274-cd80-48f8-bf25-1cc83d271189` | 250 | 277 | 313 | 416 | 518 | 278 | 314 | 417 | 748 |
| post_comments | `/api/posts/96ed4274-cd80-48f8-bf25-1cc83d271189/comments` | 250 | 247 | 283 | 412 | 491 | 247 | 283 | 412 | 84 |
| spa_index | `/` | 250 | 237 | 279 | 322 | 429 | 237 | 280 | 322 | 1291 |
| spa_reels | `/reels` | 250 | 270 | 297 | 392 | 408 | 270 | 297 | 392 | 1292 |
| spa_js | `/assets/index-BI8arfhy.js` | 250 | 286 | 376 | 499 | 523 | 351 | 429 | 529 | 120137 |
| spa_css | `/assets/index--WnOc6JG.css` | 250 | 258 | 312 | 427 | 993 | 274 | 336 | 728 | 38442 |
| media_poster | a poster JPEG on `media.` | 250 | 248 | 353 | 447 | 720 | 280 | 487 | 886 | 39294 |
| media_mp4_1MB | first 1 MB of an MP4 on `media.` | 250 | 117 | 140 | 192 | 277 | 325 | 563 | 1330 | 1048576 |

## 2. Concurrency ramp per path

Milliseconds. "c" is the number of connections, each sending requests back to back.

| Target | c | Requests | Good rps | TTFB p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|
| healthz | 1 | 86 | 3.43 | 275 | 331 | 460 | 460 |
| healthz | 2 | 192 | 7.61 | 255 | 286 | 353 | 370 |
| healthz | 5 | 494 | 19.6 | 242 | 279 | 320 | 338 |
| healthz | 10 | 916 | 36.24 | 270 | 313 | 357 | 565 |
| healthz | 15 | 1395 | 55.23 | 267 | 308 | 379 | 579 |
| healthz | 25 | 2210 | 87.53 | 275 | 313 | 339 | 588 |
| healthz | 50 | 4481 | 176.52 | 270 | 341 | 446 | 648 |
| spa_index | 1 | 82 | 3.26 | 285 | 362 | 531 | 531 |
| spa_index | 2 | 187 | 7.43 | 261 | 308 | 347 | 350 |
| spa_index | 5 | 454 | 17.96 | 272 | 295 | 327 | 361 |
| spa_index | 10 | 921 | 36.5 | 268 | 302 | 375 | 688 |
| spa_index | 15 | 1361 | 53.93 | 271 | 301 | 355 | 465 |
| spa_index | 25 | 2308 | 91.31 | 266 | 301 | 362 | 539 |
| spa_index | 50 | 4542 | 179.75 | 264 | 311 | 452 | 1617 |
| config | 1 | 84 | 3.33 | 283 | 319 | 519 | 519 |
| config | 2 | 198 | 7.89 | 243 | 267 | 295 | 313 |
| config | 5 | 485 | 19.21 | 245 | 287 | 331 | 370 |
| config | 10 | 954 | 37.78 | 247 | 287 | 336 | 486 |
| config | 15 | 1380 | 54.6 | 253 | 325 | 470 | 527 |
| config | 25 | 2249 | 89.11 | 272 | 315 | 385 | 495 |
| config | 50 | 3988 | 157.58 | 294 | 418 | 509 | 696 |
| auth_me | 1 | 101 | 3.98 | 241 | 271 | 420 | 432 |
| auth_me | 2 | 183 | 7.27 | 265 | 314 | 412 | 447 |
| auth_me | 5 | 442 | 17.51 | 270 | 313 | 497 | 2139 |
| auth_me | 10 | 913 | 36.17 | 265 | 300 | 325 | 412 |
| auth_me | 15 | 1376 | 54.5 | 265 | 290 | 323 | 408 |
| auth_me | 25 | 2237 | 88.33 | 269 | 319 | 374 | 686 |
| auth_me | 50 | 4298 | 170.33 | 275 | 353 | 480 | 849 |
| reels | 1 | 37 | 1.46 | 546 | 708 | 923 | 923 |
| reels | 2 | 66 | 2.61 | 603 | 817 | 842 | 842 |
| reels | 5 | 90 | 3.43 | 1240 | 1399 | 1475 | 1475 |
| reels | 10 | 111 | 4.16 | 2194 | 2364 | 2385 | 2474 |
| reels | 15 | 123 | 4.42 | 3184 | 3359 | 3531 | 3635 |
| player | 1 | 38 | 1.51 | 464 | 661 | 720 | 720 |
| player | 2 | 89 | 3.51 | 435 | 619 | 817 | 817 |
| player | 5 | 157 | 6.16 | 634 | 841 | 870 | 880 |
| player | 10 | 192 | 7.38 | 1205 | 1465 | 1549 | 1578 |
| player | 15 | 201 | 7.71 | 1800 | 2110 | 2211 | 2258 |
| player | 25 | 212 | 7.75 | 2595 | 4048 | 5017 | 5253 |
| tags | 1 | 61 | 2.43 | 374 | 569 | 679 | 679 |
| tags | 2 | 104 | 4.13 | 452 | 649 | 839 | 839 |
| tags | 5 | 184 | 7.19 | 718 | 872 | 1098 | 1100 |
| tags | 10 | 211 | 8.27 | 1159 | 1466 | 1670 | 2654 |
| tags | 15 | 200 | 7.61 | 1842 | 2356 | 4914 | 5483 |
| tags | 25 | 213 | 7.83 | 2895 | 4411 | 5731 | 8445 |
| locations_activity | 1 | 55 | 2.17 | 412 | 612 | 743 | 743 |
| locations_activity | 2 | 86 | 3.44 | 529 | 717 | 851 | 851 |
| locations_activity | 5 | 146 | 5.78 | 867 | 1119 | 1183 | 1190 |
| locations_activity | 10 | 149 | 5.77 | 1672 | 2012 | 3827 | 4197 |
| locations_activity | 15 | 144 | 5.57 | 2616 | 3070 | 5140 | 6070 |
| social_feed | 1 | 74 | 2.94 | 308 | 426 | 631 | 631 |
| social_feed | 2 | 154 | 6.09 | 309 | 357 | 410 | 441 |
| social_feed | 5 | 364 | 14.43 | 318 | 421 | 550 | 845 |
| social_feed | 10 | 543 | 21.41 | 435 | 639 | 713 | 1023 |
| social_feed | 15 | 542 | 21.32 | 666 | 899 | 949 | 1002 |
| social_feed | 25 | 540 | 20.9 | 1137 | 1446 | 1590 | 1761 |
| social_feed | 50 | 554 | 20.59 | 2316 | 3499 | 4331 | 5981 |
| search_suggest | 1 | 62 | 2.46 | 379 | 511 | 568 | 568 |
| search_suggest | 2 | 94 | 3.69 | 513 | 651 | 667 | 667 |
| search_suggest | 5 | 147 | 5.8 | 901 | 961 | 977 | 977 |
| search_suggest | 10 | 175 | 6.73 | 1495 | 1719 | 1794 | 1818 |
| search_suggest | 15 | 176 | 6.82 | 2162 | 2398 | 4246 | 4551 |
| search_suggest | 25 | 184 | 6.73 | 3539 | 4714 | 5833 | 5915 |
| packs | 1 | 88 | 3.51 | 278 | 285 | 379 | 379 |
| packs | 2 | 166 | 6.63 | 294 | 330 | 418 | 467 |
| packs | 5 | 405 | 16.05 | 294 | 350 | 436 | 1025 |
| packs | 10 | 722 | 27.72 | 328 | 427 | 539 | 2594 |
| packs | 15 | 927 | 36.6 | 376 | 553 | 672 | 1429 |
| packs | 25 | 947 | 37.2 | 640 | 834 | 933 | 1212 |
| packs | 50 | 972 | 37.15 | 1293 | 1961 | 2467 | 3088 |
| user_posts | 1 | 92 | 3.66 | 267 | 286 | 325 | 325 |
| user_posts | 2 | 171 | 6.8 | 281 | 307 | 346 | 409 |
| user_posts | 5 | 426 | 16.9 | 283 | 323 | 346 | 613 |
| user_posts | 10 | 838 | 33.14 | 289 | 332 | 384 | 604 |
| user_posts | 15 | 1216 | 48.11 | 294 | 361 | 470 | 678 |
| user_posts | 25 | 1657 | 65.43 | 347 | 527 | 630 | 2563 |
| user_posts | 50 | 1801 | 70.43 | 671 | 965 | 1172 | 1394 |
| post_comments | 1 | 86 | 3.42 | 285 | 302 | 351 | 351 |
| post_comments | 2 | 180 | 7.16 | 271 | 301 | 324 | 362 |
| post_comments | 5 | 454 | 17.97 | 267 | 305 | 363 | 405 |
| post_comments | 10 | 875 | 34.65 | 275 | 317 | 370 | 819 |
| post_comments | 15 | 1288 | 50.94 | 282 | 329 | 408 | 672 |
| post_comments | 25 | 2001 | 79.12 | 293 | 401 | 515 | 635 |
| post_comments | 50 | 2292 | 90.06 | 513 | 738 | 845 | 1061 |

Ceilings read from the table:

| Path | Max good rps | Highest c with p95 TTFB under 3 s |
|---|---|---|
| `/api/reels` | 4.4 | 10 (p95 2364) |
| `/api/reels/locations/activity` | 5.8 | 10 (p95 2012) |
| `/api/search/suggestions` | 6.8 | 15 (p95 2398) |
| `/api/reels/player` | 7.7 | 15 (p95 2110) |
| `/api/reels/tags` | 8.3 | 15 (p95 2356) |
| `/api/feed` | 21 | 25 (p95 1446) |
| `/api/packs` | 37 | 50 (p95 1961) |
| `/api/users/{username}/posts` | 70 | 50 (p95 965) |
| `/api/posts/{id}/comments` | 90 | 50 (p95 738) |
| `healthz`, `/`, `/api/config`, `/api/auth/me` | 158 to 180, limited by the client | 50 (p95 311 to 418) |

## 3. Session-start mix

Milliseconds. One session is the five requests in sequence on one worker.

| c | Session starts/min | Session p50 | p95 | p99 | reels TTFB p95 | player TTFB p95 | config TTFB p95 |
|---|---|---|---|---|---|---|---|
| 1 | 25.9 | 2278 | 2645 | 3303 | 615 | 635 | 292 |
| 2 | 59.5 | 1958 | 2456 | 2735 | 799 | 603 | 350 |
| 5 | 111.2 | 2679 | 3323 | 4092 | 1234 | 937 | 350 |
| 10 | 146.6 | 3944 | 5175 | 5348 | 2132 | 1610 | 419 |
| 15 | 159.6 | 5751 | 6843 | 7038 | 3281 | 1997 | 554 |

Throughput flattens between 10 and 15 workers at about 150 to 160 sessions per minute. While the reels routes queue, `/api/config` and `/api/auth/me` slow down only a little (p95 554 ms and 532 ms at 15 workers), so a saturated process still answers light requests.

## 4. Server side (Sentry)

Transaction durations over the two hours, in milliseconds. For ramped routes the figures mix the one-connection samples with the saturated steps, so their p95 shows queueing in the process. Routes that were not ramped show the cost of one request.

| Transaction | p50 | p95 | p99 |
|---|---|---|---|
| `/api/reels` (ramped) | 843 | 2837 | 2967 |
| `/api/search/suggestions` (ramped) | 822 | 3360 | 4045 |
| `/api/reels/locations/activity` (ramped) | 539 | 2486 | 2780 |
| `/api/reels/tags` (ramped) | 520 | 2851 | 3632 |
| `/api/reels/player` (ramped) | 462 | 2507 | 3904 |
| `/api/feed` (ramped) | 373 | 2165 | 3164 |
| `/api/reels/tags/{tag_name}` | 209 | 336 | 346 |
| `/api/reels/locations/{location_key}` | 177 | 317 | 358 |
| `/api/reels/feed` | 89 | 128 | 214 |
| `/api/reels/locations` | 81 | 216 | 224 |
| `/api/recommendations/creators` | 47 | 99 | 196 |
| `/api/posts/{post_id}`, `/api/users/{username}` | 7 to 10 | 9 to 13 | 13 to 14 |
| `/api/reels/player-script/{name}`, `/api/reels/earth-texture` | 6 to 8 | 8 to 11 | 11 to 27 |
| `/api/billing/catalog`, `/api/messages/capabilities`, map attribution | 2 to 3 | 3 | 3 to 5 |

The server-side p95 of the ramped routes matches the client-side TTFB at saturation, so the delay is in the app process and not in the tunnel or the client's link.

## 5. Loopback on the VPS

Run on the VPS against `127.0.0.1:8000` with `loopback.py`, 07:31 to 07:45 UTC, 20 s per step. No Cloudflare, no tunnel and no network round trip, so the times are server time. Each request sent its own `CF-Connecting-IP`, which keeps the feed and creators routes under their 60 per minute per-IP limit. "session" is the five session-start requests plus one feed page. Milliseconds.

| Target | c | Requests | Good rps | p50 | p95 | p99 | max | Sessions per min / session p95 |
|---|---|---|---|---|---|---|---|---|
| reels_feed | 1 | 223 | 11.13 | 87 | 104 | 221 | 225 |  |
| reels_feed | 2 | 249 | 12.31 | 155 | 246 | 299 | 307 |  |
| reels_feed | 5 | 238 | 11.8 | 404 | 559 | 630 | 1041 |  |
| reels_feed | 10 | 217 | 10.65 | 926 | 1118 | 1206 | 2394 |  |
| reels_feed | 15 | 217 | 10.48 | 1403 | 1608 | 1841 | 3651 |  |
| reels_feed | 25 | 224 | 10.55 | 2167 | 3842 | 5050 | 5236 |  |
| creators | 1 | 404 | 20.18 | 42 | 63 | 183 | 210 |  |
| creators | 2 | 404 | 20.15 | 77 | 216 | 227 | 231 |  |
| creators | 5 | 384 | 19.1 | 233 | 374 | 428 | 444 |  |
| creators | 10 | 360 | 17.64 | 562 | 734 | 851 | 981 |  |
| creators | 15 | 331 | 15.96 | 912 | 1265 | 1414 | 1732 |  |
| creators | 25 | 350 | 16.47 | 1446 | 2261 | 2774 | 3676 |  |
| reels | 1 | 122 | 6.09 | 144 | 273 | 284 | 285 |  |
| reels | 2 | 108 | 5.35 | 341 | 538 | 567 | 591 |  |
| reels | 5 | 102 | 4.97 | 1016 | 1240 | 1389 | 1706 |  |
| reels | 10 | 98 | 4.76 | 2078 | 2608 | 3326 | 3326 |  |
| reels | 15 | 100 | 4.7 | 3161 | 3955 | 5194 | 5194 |  |
| player | 1 | 169 | 8.42 | 115 | 135 | 259 | 269 |  |
| player | 2 | 193 | 9.64 | 199 | 304 | 349 | 356 |  |
| player | 5 | 184 | 9.11 | 527 | 699 | 1046 | 1068 |  |
| player | 10 | 167 | 8.1 | 1217 | 1450 | 2562 | 2583 |  |
| player | 15 | 176 | 8.27 | 1773 | 2059 | 3475 | 3685 |  |
| player | 25 | 181 | 8.14 | 2676 | 4733 | 8175 | 9903 |  |
| session | 1 | 312 | 15.6 | 80 | 148 | 287 | 301 | 156.0 / 512 |
| session | 2 | 324 | 15.61 | 116 | 363 | 494 | 614 | 156.1 / 938 |
| session | 5 | 300 | 14.67 | 196 | 1119 | 1340 | 1466 | 146.7 / 2391 |
| session | 10 | 300 | 14.0 | 257 | 2275 | 2449 | 3407 | 140.0 / 4850 |
| session | 15 | 318 | 13.58 | 539 | 3309 | 3662 | 5816 | 135.8 / 7387 |

- **Ceilings:** `/api/reels` 4.7 to 5.0 rps, `/api/reels/player` 8.1 to 9.6, `/api/reels/feed` 10.5 to 12.3, `/api/recommendations/creators` 16 to 20.
- **A session start with a feed page saturates at 136 to 156 per minute.** One worker with no network delay already reaches 156 per minute, so one session costs about 0.385 s of server time.
- **The limit is one CPU core.** App CPU sat at 105 to 113% during the saturated steps and Postgres at 5 to 17% (`raw/loopback-cpu.log`). The VPS has 4 vCPU; the single Python process uses one.
- **Against the 2026-10-30 loopback run:** `/api/reels` at 10 connections 5.6 → 4.8 rps, player 10.2 → 8.1, feed 12.1 → 10.7. That is 12 to 20% lower, so the drop is in the server and not in the edge path. The cause is not identified here.
- **Edge and loopback agree.** `/api/reels` reaches 4.4 rps through the edge and 4.7 to 5.0 on loopback; the player 7.7 and 8.1 to 9.6.
- The first run sent one IP per worker, so the single-worker feed and creators steps were rate limited; those two were rerun with an IP per request. The first run's log is `raw/loopback-reels-player-session.log`.

## Capacity in users

The measured limit is the rate of session starts, because opening the app is the expensive part and watching reels loads R2, not the VPS.

- **Measured:** 160 session starts per minute at saturation; 110 per minute with `/api/reels` p95 at 1.2 s; 60 per minute with no queueing. Each figure is for the five-request mix without a feed page.
- **Concurrent requests:** 5 session starts in flight keep every request's p95 under 1.3 s. 10 keep it under 2.2 s. 15 pass 3 s.
- **Simultaneous viewers, estimated.** The process has 60 s of app time per minute; this budget uses half, about 30 s, to keep p95 low.
  - Assumed viewer: one feed page per minute (12 reels per page, about 90 ms of server time) plus an occasional tag, location or search request. That is 0.1 to 0.15 s per viewer per minute.
  - A session start with a feed page costs about 0.385 s (section 5).
  - 150 viewers take 15 to 22 s, and 30 to 40 arrivals per minute take 12 to 15 s. Together that is about 27 to 37 s.
  - The viewer model is an assumption. It leaves out `POST /api/events` and anything a signed-in viewer adds (comments, likes, messages), and the feed ceiling of 10.5 to 12.3 rps (section 5) caps feed pages at about 630 to 740 per minute if nothing else is running.

## Raw data

- `raw/latency.json`, `raw/ramp.json`, `raw/mixed.json`: full results per step, with status counts.
- `raw/loopback-*.log`, `raw/loopback-cpu.log`: the loopback steps and the container CPU samples taken during the first loopback run.
- `raw/*.log`: the same, one line per step as printed.
- `raw-aborted/`: a partial earlier run from Vietnam (colo SIN) that was stopped when the network degraded. Do not compare its tail figures.

Rerun from this folder. Move `raw/` aside first, because each mode overwrites its JSON file:

```
for m in latency ramp mixed; do python3 load.py $m; done
```
