# Load profile after the bottleneck fixes, 2026-11-11

The same probes as `docs/perf-probes/2026-11-11/` (the "before" run, release `4e05762`), run again on release `69d86cddbe33`. That release carries the bottleneck fixes from `docs/perf-probes/2026-11-11/bottlenecks.md` (merged in `ccd83a2`) and the deploy-script fix (`69d86cd`).

**Status:** the loopback half is done. The edge half (`load.py`, about 95 minutes from the Taiwan network) is not run yet; section 2 is a placeholder until it is.

## Summary

- **Session starts went from 136 to 156 per minute to about 375 per minute, about 2.5 times more.** A session start here is `/`, `/api/config`, `/api/auth/me`, `/api/reels`, the player and one feed page, measured on the VPS without the edge.
- **`/api/reels` is no longer the bottleneck.** Its rate went from 4.7 to 6.1 rps to 86 to 90 rps, and p95 at 10 connections from 2608 ms to 130 ms.
- **The limit is now three routes at 14 to 16 rps each:** `/api/reels/feed`, `/api/reels/player` and `/api/reels/player-inline`. They now cost most of a session. Past one or two connections their latency grows in step with concurrency, which is requests queueing on one busy process.
- **The other measured routes gained 30 to 80%:** feed 10.5 to 12.3 → 15 to 16 rps, player 8.1 to 9.6 → 14 to 14.6, creators 16 to 20 → 22 to 26.
- **The app is still bound to one CPU core.** While loaded it held about 100% CPU (p50 101%, p90 113%), with 9 short samples above 150%. Postgres stayed at about 14% (p90 18%, one sample at 66%).
- **No errors.** 70 steps up to 50 connections, every response 200.

## Method

- **Tool:** `loopback.py` in this folder, run on the VPS against `127.0.0.1:8000`. No Cloudflare, no tunnel and no network round trip, so the times are server time. Each request sends its own `CF-Connecting-IP`, which keeps the feed and creators routes under their 60 per minute per-IP limit.
- **Steps:** 1, 2, 5, 10, 15, 25 and 50 connections, 20 s each. The "before" run stopped at 25 (or 15 for `reels` and `session`), where p95 passed 3 s.
- **When:** 2026-11-11, about 14:07 to 14:33 UTC. The script ran detached on the VPS (`setsid nohup`), so the laptop's connection did not affect it.
- **Release:** `69d86cddbe33`, read from `/opt/echo` on the VPS.
- **New targets** that the "before" run did not have: `player_inline` (`/api/reels/player-inline`, the route the SPA loads), `tags`, `locations_activity`, `search_suggest`, and `session_spa` (the session with `player-inline` in place of `player`).
- **CPU:** `docker stats` every 10 to 12 s (`raw/loopback-cpu.log`). The sampler ran about 6 minutes past the probe's end, so its idle tail is in the file. The CPU figures above use only the samples above 50%.

## 1. Loopback on the VPS

### Before and after, per route

| Route | Ceiling before (rps) | Ceiling after (rps) | p95 at c=1 before → after (ms) | p95 at c=10 before → after (ms) |
|---|---|---|---|---|
| `/api/reels` | 4.7 to 6.1 | 86 to 90 | 273 → 14 | 2608 → 130 |
| `/api/reels/player` | 8.1 to 9.6 | 13.8 to 14.6 | 135 → 98 | 1450 → 762 |
| `/api/reels/feed` | 10.5 to 12.3 | 14.9 to 16.3 | 104 → 80 | 1118 → 739 |
| `/api/recommendations/creators` | 16 to 20 | 22.5 to 26.4 | 63 → 57 | 734 → 543 |
| session (6 requests) | 136 to 156 / min | 369 to 387 / min | 512 → 203 (session) | 4850 → 1924 (session) |

### Session starts

| c | Sessions per min, before | after | Session p95 before (ms) | after | after, SPA variant |
|---|---|---|---|---|---|
| 1 | 156.0 | 328.8 | 512 | 203 | 202 |
| 2 | 156.1 | 375.7 | 938 | 366 | 348 |
| 5 | 146.7 | 377.5 | 2391 | 973 | 993 |
| 10 | 140.0 | 375.8 | 4850 | 1924 | 1848 |
| 15 | 135.8 | 378.1 | 7387 | 2736 | 2668 |
| 25 | | 387.2 | | 4068 | 4318 |
| 50 | | 369.3 | | 8346 | 8483 |

One worker with no network delay reaches 329 session starts per minute, so one session start now costs about 0.18 s of server time, down from about 0.385 s. The SPA variant (`player-inline`) costs the same.

### All steps after the fixes

Milliseconds.

| Target | c | Requests | Good rps | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|
| reels_feed | 1 | 298 | 14.87 | 66 | 80 | 93 | 137 |
| reels_feed | 2 | 327 | 16.29 | 118 | 152 | 208 | 319 |
| reels_feed | 5 | 323 | 15.9 | 316 | 380 | 402 | 443 |
| reels_feed | 10 | 311 | 15.1 | 658 | 739 | 789 | 848 |
| reels_feed | 15 | 329 | 15.76 | 953 | 1039 | 1073 | 1097 |
| reels_feed | 25 | 347 | 16.24 | 1524 | 1670 | 1703 | 1806 |
| reels_feed | 50 | 365 | 15.81 | 3084 | 3357 | 3386 | 3402 |
| creators | 1 | 457 | 22.82 | 42 | 57 | 72 | 81 |
| creators | 2 | 529 | 26.44 | 75 | 91 | 99 | 124 |
| creators | 5 | 500 | 24.81 | 197 | 264 | 287 | 337 |
| creators | 10 | 479 | 23.73 | 410 | 543 | 605 | 663 |
| creators | 15 | 473 | 23.05 | 641 | 836 | 915 | 998 |
| creators | 25 | 472 | 22.8 | 1006 | 1672 | 2143 | 2908 |
| creators | 50 | 493 | 22.51 | 1869 | 3796 | 5154 | 8755 |
| reels | 1 | 1753 | 87.61 | 11 | 14 | 20 | 180 |
| reels | 2 | 1785 | 89.2 | 21 | 31 | 37 | 322 |
| reels | 5 | 1750 | 86.59 | 54 | 71 | 86 | 568 |
| reels | 10 | 1793 | 89.15 | 107 | 130 | 383 | 572 |
| reels | 15 | 1742 | 86.45 | 165 | 201 | 552 | 788 |
| reels | 25 | 1826 | 90.09 | 269 | 301 | 565 | 770 |
| reels | 50 | 1763 | 86.31 | 550 | 952 | 1091 | 1195 |
| player | 1 | 239 | 11.92 | 82 | 98 | 121 | 163 |
| player | 2 | 290 | 14.46 | 136 | 163 | 193 | 255 |
| player | 5 | 288 | 14.17 | 349 | 423 | 479 | 558 |
| player | 10 | 299 | 14.53 | 681 | 762 | 803 | 864 |
| player | 15 | 290 | 13.77 | 1083 | 1186 | 1215 | 1302 |
| player | 25 | 306 | 14.17 | 1747 | 1924 | 1963 | 1968 |
| player | 50 | 340 | 14.6 | 3384 | 3510 | 3530 | 3550 |
| player_inline | 1 | 260 | 12.97 | 76 | 90 | 105 | 119 |
| player_inline | 2 | 282 | 14.05 | 139 | 166 | 206 | 243 |
| player_inline | 5 | 281 | 13.81 | 359 | 462 | 503 | 515 |
| player_inline | 10 | 283 | 13.75 | 718 | 825 | 886 | 896 |
| player_inline | 15 | 296 | 14.11 | 1064 | 1142 | 1184 | 1205 |
| player_inline | 25 | 309 | 14.27 | 1749 | 1837 | 1865 | 1906 |
| player_inline | 50 | 324 | 13.87 | 3589 | 3786 | 3843 | 3888 |
| tags | 1 | 1449 | 72.42 | 13 | 18 | 21 | 104 |
| tags | 10 | 1519 | 75.56 | 131 | 151 | 221 | 257 |
| tags | 50 | 1528 | 73.63 | 668 | 746 | 765 | 845 |
| locations_activity | 1 | 377 | 18.82 | 51 | 66 | 76 | 127 |
| locations_activity | 10 | 418 | 20.48 | 476 | 578 | 663 | 767 |
| locations_activity | 50 | 463 | 20.71 | 2395 | 2534 | 2545 | 2591 |
| search_suggest | 1 | 649 | 32.43 | 30 | 37 | 44 | 122 |
| search_suggest | 10 | 650 | 32.07 | 306 | 357 | 513 | 575 |
| search_suggest | 50 | 687 | 31.92 | 1545 | 1697 | 1744 | 1753 |

Every step for `tags`, `locations_activity`, `search_suggest`, `session` and `session_spa` is in `raw/loopback.log`.

## 2. Through the edge

Not run yet. To fill this section, run `load.py` from the Taiwan network (Cloudflare colo TPE, as in the "before" run), so the round trip matches:

```
for m in latency ramp mixed; do python3 load.py $m; done
```

The Vietnam network checked on 2026-11-11 was not usable for this. It routed to colo CDG (Paris), lost 5 to 10% of pings, and had `/api/healthz` TTFB p95 of 2 s at one connection.

## Capacity in users

Loopback figures only. The edge adds the client's round trip to each request but does not lower the server's ceiling; in the "before" run, edge and loopback ceilings agreed.

- **Measured ceiling:** about 375 session starts per minute, with a feed page included. Before the fixes it was 136 to 156.
- **Concurrent session starts:** 5 in flight keep session p95 under 1 s; p95 over all their requests is 359 ms. 10 keep session p95 under 2 s.
- **Simultaneous viewers, estimated** with the same assumptions as the "before" report. Half of the process's 60 s per minute is the budget. A viewer costs about one feed page per minute (about 65 ms now) plus an occasional tag, location or search request: roughly 0.08 to 0.12 s per viewer per minute. A session start costs about 0.18 s.
  - 250 viewers take 20 to 30 s per minute. Or 150 viewers plus 60 arrivals per minute take about 12 to 18 s plus 11 s.
  - So roughly 150 to 250 simultaneous viewers with 30 to 60 arrivals per minute, against about 150 viewers and 30 to 40 arrivals before. This is an estimate, not a measurement. It leaves out `POST /api/events` and signed-in traffic, as before.

## Raw data

- `raw/loopback.log`: one JSON line per step.
- `raw/loopback-cpu.log`: the container CPU and memory samples, UTC times.
- `raw-cancelled/`: partial output from runs that were stopped on unstable networks. Do not use it.
