# Load profile on release 852ca88, 2026-11-22

A full probe of production after the `852ca88` deploy. It has five parts:

- An edge check of every anonymous route and the security headers.
- A player concurrency test, giving p95 and p99 per step.
- The loopback set from `2026-11-12/`, through the proxy and against the writer alone.
- A browser and Sentry check.
- A geo run from 8 locations: Vietnam with no VPN, then 7 Surfshark exits.

**Status:** done. The Los Angeles VPN run failed, so Seattle covers US West. Hong Kong was left out (see "Geo run").

## Summary

- **The release is healthy.** All 32 anonymous routes return 200, and the enforced CSP is in place. Media Range and CORS work. Every loopback and player step returned only 200, up to 150 concurrent players. No container restarted, and Sentry shows nothing new from this release.
- **The player routes are 28 to 39% slower than in the 11-12 run on `7bf201b`.** Through the proxy, the player fell from 29.3 to 21.2 rps, and player-inline from 30.8 to 20.0 rps. On the writer alone, the player fell from 17.7 to 11.8 rps, and player-inline from 17.5 to 10.6 rps. The p95 at 10 connections went up by the same share. This is the largest change in the run. A local profile puts the cause in code: on Postgres, player-inline went from 28.7 to 38.8 ms per request, +35% (see "Profile of player-inline"). Two fixes in the working tree bring it to 33.3 ms. They are not deployed.
- **Feed fell 17 to 19%, and session starts 23 to 28%.** Through the proxy, session starts fell from 770 to 596 per minute. On the writer alone they fell from 443 to 330 per minute. Both falls follow from the player and feed falls, because the session sequence includes both routes.
- **The other routes changed little.** reels, tags, creators and search/suggestions are within ±9%. locations/activity gained about 25%.
- **Max concurrent players: about 5 to 7 at an open p95 of 1 s or less, and about 15 at 2 s.** A cold `/reels` open (18 requests) saturates at about 650 to 730 opens per minute from 5 to 10 players up. More players wait longer, but none get an error.
- **`app-read` is the limit, at its 2-CPU cap.** Postgres and the proxy have room. The writer's DB pool hit 15 of 15 once during the writer-alone run.
- **From outside, the API costs about 0.3 to 1.1 s TTFB at p50, depending on the location.** Through the VPN, every exit outside Asia is noisy.
- **After `5c327ce`, the proxy rates held, but the writer-alone player routes fell 12 to 17%.** No request-path code changed. The cause is not known. One candidate is `recommendation_impressions`, which the probes grew to 2.2M rows that are never purged (see "After deploying 5c327ce"). The geo run was not comparable, and the Quest was not run.
- **After the session sweep (`6c3720e`), r3 is 1 to 13% above the r2 baseline, but still below the 11-22 run on most routes.** The player routes are back to the 11-22 level. The same deploy also carried a bugfix branch, so the gain cannot be put on the sweep alone (see "After the session sweep").
- **After the pipeline-context fix (`20bfb10`), r4 is 23 to 40% above r3 on the feed and player routes, on both paths.** The writer feed is at 22.5 rps, above the 11-12 run. The player routes are still below 11-12. The other routes are flat, and cold `/reels` opens still peak at about 730 per minute (see "After the pipeline-context fix").
- **The SPA's `/api/reels` request never hits the edge cache.** The SPA always sends `refresh=false`, and `server/edge_cache.py` treats any `refresh` parameter as a forced re-scan. So the response gets `private, no-store` and Cloudflare reports `BYPASS` in every location (see "Flags"). The fix is made in the working tree but not deployed.

## After deploying 7ab15a6

The same player and loopback set was run again on the VPS after `7ab15a6` was deployed. That release includes the two player-inline fixes (`f6928bc`) and the edge-cache fix (`d4da631`). The raw logs are in `raw-after-deploy/`. Every step returned only 200 again.

- **On the writer alone, the player routes recovered about two thirds of the fall.** The player went from 11.8 to 14.2 rps (+20%), against 17.7 on 11-12. player-inline went from 10.6 to 13.0 rps (+23%), against 17.5. The feed went from 15.1 to 18.1 rps (+19%). Session starts went from 330 to 381 per minute (+16%).
- **Through the proxy, the gain is smaller.** The player went from 21.2 to 22.9 rps (+8%), player-inline from 20.0 to 21.8 rps (+9%), and the feed from 27.8 to 32.7 rps (+18%). Session starts went from 596 to 686 per minute (+15%). The player and player-inline gains through the proxy are inside the ±9% run-to-run noise, so only the feed and session gains there are clear.
- **Max concurrent players is about the same.** Cold `/reels` opens still saturate at about 720 per minute. The 10-player request p95 fell from 236 to 204 ms.
- **The other routes are within ±9%.**
- **The SPA's first reels page is now cached at the edge.** `GET /api/reels?refresh=false` returns `public, max-age=0, s-maxage=30`. The first request is a `MISS` and the second is a `HIT`.

| Route | Writer 852ca88 (rps) | Writer 7ab15a6 (rps) | Proxy 852ca88 (rps) | Proxy 7ab15a6 (rps) |
|---|---|---|---|---|
| `/api/reels/feed` | 15.1 | 18.1 | 27.8 | 32.7 |
| `/api/reels/player` | 11.8 | 14.2 | 21.2 | 22.9 |
| `/api/reels/player-inline` | 10.6 | 13.0 | 20.0 | 21.8 |
| session, sessions per minute | 330 | 381 | 596 | 686 |
| session_spa, sessions per minute | 309 | 367 | 566 | 666 |

The Quest 3 run on this release is in `quest.md`. It covers the time to VR and why reels play choppy in the headset.

## After deploying 5c327ce

The VPS set, the edge probe and Sentry were run again on 2026-11-22 after `5c327ce` was deployed (containers up at 11:26–11:27 UTC). That release gives new video-only uploads and renditions a silent audio track. It does not change the request path. The raw logs are in `raw-5c327ce/`. Every step returned only 200.

- **Edge probe:** 43 of 44 checks pass. The one failure is SIT, as before.
- **Sentry:** nothing new from this release.
- **Browser check:** not rerun.
- **Through the proxy, every route is 2 to 8% below `7ab15a6`.** Each is inside the ±9% run-to-run band, but all ten moved in the same direction.
- **Max concurrent players is about the same.** Cold `/reels` opens peak at 687 per minute, against 718. At 150 players the open p95 is 22.6 s, against 21.0 s, and the per-request p95 is 4.3 s, against 3.6 s. The `player_inline` route is still flat at about 19 to 20 rps.
- **On the writer alone, the player routes fell again.** player-inline went from 13.0 to 10.8 rps (−17%), and its p95 at 10 connections from 877 to 1042 ms. The player went from 14.2 to 12.5 rps (−12%). Session starts fell 9 to 11%. The other routes are within ±9%.

| Route | Writer 7ab15a6 (rps) | Writer 5c327ce (rps) | Proxy 7ab15a6 (rps) | Proxy 5c327ce (rps) |
|---|---|---|---|---|
| `/api/reels/feed` | 18.1 | 17.8 | 32.7 | 32.0 |
| `/api/reels/player` | 14.2 | **12.5** | 22.9 | 21.7 |
| `/api/reels/player-inline` | 13.0 | **10.8** | 21.8 | 20.2 |
| `/api/reels/tags` | 78.9 | 71.9 | 139.9 | 131.0 |
| session, sessions per minute | 381 | 345 | 686 | 658 |
| session_spa, sessions per minute | 367 | 327 | 666 | 620 |

**The writer-alone fall is real. Its cause is not known.**

- `loopback.py player_inline` was run twice more against the writer. Only the console output of those two runs was read, so they are not in `raw-5c327ce/`. All three runs gave 10.5 to 10.8 rps, and the 1-connection p50 was 96 ms in the saved run, against 82 ms on `7ab15a6`. So it is not noise.
- No code on the request path changed between `7ab15a6` and `5c327ce`.
- Between the two writer runs, `recommendation_impressions` grew from 1.61M to 2.04M rows (+27%), and the recommendation sessions from 143k to 182k. The probes made almost all of these rows: each request is a new anonymous visitor.
- The table is now 2.2M rows and 2179 MB, with 842 MB in 8 indexes on random UUID keys. Postgres has `shared_buffers` of 128 MB, so the index pages no longer fit in its cache.
- These rows are never purged. `_purge_actor_history` in `server/social/recommendations/service.py` deletes an actor's expired sessions only when that same actor starts a new session. A one-time visitor never comes back, so their rows stay.

This makes table growth one candidate, but it does not explain the gap between the two paths. `app-read` runs the same route code against the same database, so it writes the same rows. Yet at 1 connection the proxy p50 for player-inline went only from 90 to 92 ms, while the writer's went from 82 to 96 ms. Something specific to the writer process may also be involved. A sweep of expired sessions and their impressions, followed by a new probe, would test the table-growth part (see "Flags").

**Geo run: not comparable.**

- Vietnam with no VPN (12:37 UTC, colo SIN, loc VN): the trace p50 / p95 was 112 / 1382 ms, against 59 / 119 ms. The 4 MB Range read ran at 0.58 MB/s, against 1.52 MB/s. The 1-player open p50 was 18.8 s, against 9.9 s, from 1 to 2 opens.
- Singapore (12:42 UTC): the trace p50 was 406 ms, against 66 ms, and 2 trace requests failed with no status. The 5-player open p50 was 28.8 s, against 10.5 s.
- A control from the Singapore exit showed a trace p50 of 1740 ms and 1.18 MB/s from a third-party download. Requests that end at the edge were slow too. Together with the slow Vietnam trace, this points to a slow client network at that hour rather than the origin.
- The raw files are kept in `raw-5c327ce/geo-*`. They are not used for any comparison.
- The other six locations were not run. Rerun them off-peak, near the 05:46 local time of the baseline. Run a location only if its trace p50 is within 1.5× of the baseline and no trace request fails.

**Quest: not run.** The headset was locked. The 19 existing originals still have no audio track until `scripts/batch_silent_audio.py` runs for real. So a rerun on the existing reels should match `raw-quest/`. Only new uploads test the fix.

## After the session sweep (r2, r3)

The VPS set was run twice more on 2026-11-24. The raw logs are in `raw-5c327ce/` with an `-r2` or `-r3` suffix. Every step returned only 200.

- **r2** ran at 12:53 ICT (05:53 UTC), before the sweep was deployed. It is the baseline for r3.
- **r3** ran at 14:10–15:16 ICT (07:10–08:16 UTC) on `6c3720e`. That deploy adds `sweep_expired_sessions()` to the writer's cleanup loop, plus a bugfix branch. The backlog of expired sessions was drained before the run.

| Route | Writer r1 (rps) | Writer r2 (rps) | Writer r3 (rps) | Proxy r1 (rps) | Proxy r2 (rps) | Proxy r3 (rps) |
|---|---|---|---|---|---|---|
| `/api/reels/feed` | 17.8 | 15.2 | 16.1 | 32.0 | 28.8 | 29.8 |
| `/api/recommendations/creators` | 24.7 | 18.1 | 20.2 | 41.3 | 33.4 | 38.4 |
| `/api/reels` | 86.3 | 68.2 | 74.4 | 136.7 | 114.5 | 123.5 |
| `/api/reels/player` | 12.5 | 11.4 | 12.2 | 21.7 | 21.0 | 22.2 |
| `/api/reels/player-inline` | 10.8 | 10.2 | 10.8 | 20.2 | 19.3 | 19.8 |
| `/api/reels/tags` | 71.9 | 55.2 | 60.8 | 131.0 | 97.8 | 103.9 |
| session, sessions per minute | 345 | 320 | 338 | 658 | 555 | 605 |
| session_spa, sessions per minute | 327 | 290 | 327 | 620 | 525 | 554 |

r1 is the 11-22 run on `5c327ce` (`loopback-writer.log`, `loopback-proxy.log`).

- **r3 is 1 to 13% above r2 on every route, on both paths.** The player routes gained 3 to 8%, which is inside the ±9% run-to-run band. creators, reels, tags and session_spa gained 9 to 13% on the writer.
- **r3 is still below r1 on most routes.** The player routes are back to r1. The feed, creators, reels and tags stay 9 to 18% below r1 on the writer. All are still well below the 11-12 figures.
- **Writer p95 at 10 connections in r3:** feed 703 ms, player 922 ms, player-inline 1020 ms. In r2 these were 774, 1019 and 1121 ms.
- **Max concurrent players:** the `player_inline` peak was 18.7 rps in r2 and 20.1 rps in r3. Cold `/reels` opens peaked at 629 and 731 per minute, against 687 in r1.
- **The gain cannot be put on the sweep alone.** The same deploy carried the bugfix branch, and r2 is a single run.
- **The table file did not shrink.** After the sweep, `recommendation_impressions` is 2540 MB with 839,674 live rows and 0 dead rows. A plain VACUUM frees the pages for reuse but keeps the file. `recommendation_sessions` is 237 MB (77,873 rows), `recommendation_requests` 105 MB and `engagement_events` 52 MB.
- **WAL during r3:** `pg_stat_wal` grew by 1.62 GB, with 450,211 full-page images.

**Locally, table size did not change player-inline.** `profile_inline.py` on Postgres 16 with `SEED_SESSIONS=185000` gave a median of 55.2 ms with 1851 MB of impressions, against 56.0 ms on an empty table. With `SWEEP=1` it gave 54.2 ms. The local Postgres has the default 128 MB `shared_buffers`, like prod, but the local disk and CPU differ. The logs are in `raw-5c327ce/profile-db/`.

The `geo-*-r2` and `control-*-r2` files are kept raw. They are not summarised here.

## After the pipeline-context fix (r4)

r4 ran on 2026-11-24 on `20bfb10`, which adds the `perf/pipeline-context-waste` branch to `6c3720e` (see "Less waste in `_pipeline_context`"). No other server code changed. The raw logs are in `raw-5c327ce/` with an `-r4` suffix. Every step returned only 200.

- The run was paused by the operator and resumed on another client network. Part 1 ran at 16:05–16:31 ICT (09:05–09:31 UTC): the player probe and the proxy routes up to `locations_activity`. Part 2 ran at 17:03–17:37 ICT (10:03–10:37 UTC): the last three proxy routes, then the full writer set. Only whole steps were kept. The load average was 0.15 before part 2. The pause marker is in `cpu-r4.log`.
- The probe runs on the VPS against loopback, so the client network does not enter the figures.

| Route | Writer r3 (rps) | Writer r4 (rps) | Proxy r3 (rps) | Proxy r4 (rps) |
|---|---|---|---|---|
| `/api/reels/feed` | 16.1 | **22.5** | 29.8 | **40.5** |
| `/api/recommendations/creators` | 20.2 | 20.6 | 38.4 | 38.0 |
| `/api/reels` | 74.4 | 74.6 | 123.5 | 124.6 |
| `/api/reels/player` | 12.2 | **15.7** | 22.2 | **27.3** |
| `/api/reels/player-inline` | 10.8 | **13.5** | 19.8 | **25.2** |
| `/api/reels/tags` | 60.8 | 59.4 | 103.9 | 102.4 |
| session, sessions per minute | 338 | **416** | 605 | **773** |
| session_spa, sessions per minute | 327 | **376** | 554 | **729** |

- **The routes that build a pipeline context gained 23 to 40%, on both paths.** The feed gained 40% on the writer and 36% through the proxy. The player gained 29% and 23%, and player-inline 25% and 27%. All are well outside the ±9% run-to-run band.
- **The other routes are flat.** creators, reels and tags are within ±3%. locations/activity went from 18.1 to 19.9 rps on the writer and stayed at about 19 through the proxy. search/suggestions stayed at about 27 on both paths.
- **Session starts gained 15 to 32%.** This follows from the feed and player gains, because the session sequence includes both routes.
- **Latency fell with the rates.** At 1 connection the writer p50 fell from 68 to 49 ms on the feed, 93 to 74 ms on the player and 95 to 77 ms on player-inline. At 10 connections the writer p95 fell from 703 to 505 ms, 922 to 725 ms and 1020 to 853 ms. At 50 connections it fell from 3166 to 2346 ms, 4364 to 3303 ms and 4775 to 3977 ms. The session p95 at 50 fell from 4065 to 3233 ms.
- **Max concurrent players: more requests per second, but the same cold opens.** The `player_inline` peak through the proxy went from 20.1 to 24.5 rps, about 1470 opens per minute against 1200. Cold `/reels` opens still peak at 731 per minute, and the open p95 at 10 players is 1150 ms, against 1154 ms. At 150 players the open p95 is 22.4 s, against 22.0 s. The per-request p95 fell from 273 to 136 ms at 10 players, and from 3893 to 3453 ms at 150. So a cold open is now held by something other than the pipeline-context routes.
- **Against r1 and 11-12.** On the writer, the feed, player and player-inline are now above r1 (17.8, 12.5 and 10.8 rps). The feed is also above 11-12 (18.6 rps). The player and player-inline are still below 11-12 (17.7 and 17.5 rps). creators, reels and tags stay 14 to 17% below r1 on the writer.
- **Unlike r3, this gain can be put on one change.** The deploy carried only the `perf/pipeline-context-waste` branch and docs. r4 is still a single run.

**Against the 11-12 run (`7bf201b`), before the drop.** The drop is the 11-22 run on `852ca88` (see "Results"). The feed is now above 11-12. The player has about two thirds of its drop back, and player-inline about half. player-inline is the largest gap left.

| Route | 11-12 (rps) | 11-22 (rps) | r4 (rps) | r4 as share of 11-12 | Share of the drop recovered |
|---|---|---|---|---|---|
| Writer `/api/reels/feed` | 18.6 | 15.1 | 22.5 | 121% | all, and more |
| Writer `/api/reels/player` | 17.7 | 11.8 | 15.7 | 89% | 66% |
| Writer `/api/reels/player-inline` | 17.5 | 10.6 | 13.5 | 77% | 42% |
| Writer session, sessions per minute | 443 | 330 | 416 | 94% | 76% |
| Writer session_spa, sessions per minute | 430 | 309 | 376 | 87% | 55% |
| Proxy `/api/reels/feed` | 33.6 | 27.8 | 40.5 | 121% | all, and more |
| Proxy `/api/reels/player` | 29.3 | 21.2 | 27.3 | 93% | 75% |
| Proxy `/api/reels/player-inline` | 30.8 | 20.0 | 25.2 | 82% | 48% |
| Proxy session, sessions per minute | 770 | 596 | 773 | 100% | all |
| Proxy session_spa, sessions per minute | 772 | 566 | 729 | 94% | 79% |

- **p95 at 10 connections, 11-12 against r4.** On the writer, the feed went from 594 to 505 ms, the player from 656 to 725 ms and player-inline from 629 to 853 ms. Through the proxy, the player went from 412 to 474 ms and player-inline from 434 to 471 ms. So the feed is faster than on 11-12, and the player routes are still slower.
- **The routes outside the pipeline have slipped since 11-22.** On 11-22 they were close to 11-12. They fell between r1 and r3, and r4 did not bring them back. On the writer, tags went from 81.2 (11-12) and 76.3 (11-22) to 59.4 rps, 73% of 11-12. reels went from 89.2 and 81.5 to 74.6 rps (84%). search/suggestions went from 33.2 and 31.7 to 28.0 rps (84%). creators went from 22.2 and 22.5 to 20.6 rps (93%). Through the proxy these routes are at 77 to 93% of 11-12. This is a second fall, apart from the original drop. Its cause is not known.
- **Cold opens cannot be compared with 11-12.** `player_probe.py` first ran on 11-22. Cold opens are unchanged since then, at about 730 per minute.

**Concurrency against 11-12.** The loopback probe logs the rate and p95 at each step from 1 to 50 connections, on both runs (`2026-11-12/raw/loopback-*.log` and `raw-5c327ce/loopback-*-r4.log`). The table gives the highest step with a p95 of 1 s or less.

| Route | Writer 11-12 | Writer r4 | Proxy 11-12 | Proxy r4 |
|---|---|---|---|---|
| `/api/reels/feed` | 15 | 15 | 25 | 25 |
| `/api/reels/player` | 15 | **10** | 25 | **15** |
| `/api/reels/player-inline` | 10 | 10 | 25 | **15** |
| session | 15 | 15 | 25 | 25 |
| session_spa | 15 | **10** | 25 | 25 |

- **The feed is better than on 11-12.** Its rate is higher, and its p95 is lower at every step from 2 connections up. Through the proxy, the p95 at 50 connections is 1506 ms, against 1753 ms.
- **Session starts through the proxy about match 11-12** on both rate and p95. On the writer they are 2 to 9% lower at each step.
- **The player routes are the gap.** Through the proxy they pass a p95 of 1 s at 25 connections, against 50 on 11-12. At 50 connections the player-inline p95 is 2639 ms through the proxy and 3977 ms on the writer, against 1790 and 3056 ms.
- **On every route the rate is flat from 5 to 10 connections up,** on both runs. Past that point more connections only add wait. Every step returned only 200.

## Results

The ceiling is the highest rate across the steps. The 11-12 numbers are from `docs/perf-probes/2026-11-12/README.md` (release `7bf201b`).

| Route | Writer 11-12 (rps) | Writer 11-22 (rps) | Proxy 11-12 (rps) | Proxy 11-22 (rps) | p95 at c=10, writer / proxy, 11-22 (ms) |
|---|---|---|---|---|---|
| `/api/reels/feed` | 18.6 | 15.1 | 33.6 | 27.8 | 715 / 578 |
| `/api/recommendations/creators` | 22.2 | 22.5 | 41.3 | 44.3 | 557 / 352 |
| `/api/reels` | 89.2 | 81.5 | 142.2 | 142.8 | 149 / 88 |
| `/api/reels/player` | 17.7 | **11.8** | 29.3 | **21.2** | 910 / 607 |
| `/api/reels/player-inline` | 17.5 | **10.6** | 30.8 | **20.0** | 1024 / 593 |
| `/api/reels/tags` | 81.2 | 76.3 | 132.9 | 137.0 | 157 / 112 |
| `/api/reels/locations/activity` | 21.4 | 26.8 | 20.7 | 27.1 | 464 / 434 |
| `/api/search/suggestions?q=a` | 33.2 | 31.7 | 32.1 | 33.4 | 382 / 339 |
| session, sessions per minute | 443 | 330 | 770 | 596 | n/a |
| session_spa, sessions per minute | 430 | 309 | 772 | 566 | n/a |

The 11-12 p95 at c=10, writer / proxy, was 594 / 468 for the feed, 656 / 412 for the player and 629 / 434 for player-inline. Every step returned only 200.

## Max concurrent players

`player_probe.py` runs on the VPS, through the proxy on `127.0.0.1:8080`, with no Cloudflare in between. Each worker is one player that opens back to back, with steps of 20 s. A target stops when its per-request p95 passes 3 s or any non-200 comes back.

**`player_inline` alone** (the SPA's player route):

| Players | rps | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---|---|---|---|
| 1 | 9.7 | 100 | 125 | 189 |
| 2 | 18.7 | 103 | 132 | 163 |
| 5 | 20.1 | 222 | 387 | 433 |
| 10 | 19.2 | 511 | 790 | 963 |
| 15 | 18.2 | 805 | 1000 | 1066 |
| 25 | 19.8 | 1237 | 1396 | 1479 |
| 50 | 19.6 | 2524 | 2766 | 2852 |
| 75 | 18.7 | 3889 | 4501 | 4599 |

The route is flat at about 20 rps from 2 players up, so extra players only queue. The test stopped at 75 players, where p95 passed 3 s.

**`player_open`**, a cold `/reels` open by a first-time visitor. It is 18 requests in a row: the shell, the boot API calls, player-inline, the first reels page and the ten player scripts, with no browser cache.

| Players | Opens per minute | Open p50 (ms) | Open p95 (ms) | Open p99 (ms) | Per-request p95 (ms) |
|---|---|---|---|---|---|
| 1 | 326 | 180 | 217 | 257 | 95 |
| 2 | 522 | 221 | 283 | 371 | 107 |
| 5 | 680 | 428 | 624 | 720 | 139 |
| 10 | 728 | 807 | 1266 | 1462 | 236 |
| 15 | 672 | 1248 | 1972 | 2472 | 345 |
| 25 | 652 | 2189 | 3470 | 3666 | 603 |
| 50 | 649 | 4211 | 6944 | 7163 | 1143 |
| 75 | 629 | 6546 | 10943 | 11466 | 1710 |
| 100 | 609 | 7711 | 15076 | 15240 | 2069 |
| 150 | 630 | 14208 | 21501 | 21771 | 3954 |

Every request returned 200: 1,962 at 1 player, and 3,150 to 4,446 per step from 2 players up.

What this means:

- About 5 to 7 players can open `/reels` at the same moment with an open p95 of 1 s or less. About 15 can at 2 s or less.
- Throughput tops out at about 650 to 730 opens per minute. Past 10 players, each extra player only adds wait.
- These are players opening back to back. Real viewers open once, then watch for tens of seconds, so many more viewers fit than these numbers show. The limit applies to a burst of new arrivals.
- These numbers are from loopback. A real visitor also pays the trip to Oregon (see "Geo run"). Their browser opens several connections, not one.

## CPU

`docker stats` and `/proc/loadavg` were sampled every 8 s (`raw/cpu.log`). Each cell is mean / p95 / max.

| Phase | Time (UTC) | `app-read` | `app` | `postgres` | `proxy` | load1 |
|---|---|---|---|---|---|---|
| Player | 21:43–21:50 | 117 / 189 / 190% | 50 / 150 / 158% | 17 / 24 / 36% | 8 / 19 / 21% | 3.2 / 5.5 / 6.2 |
| Proxy loopback | 21:50–22:17 | 118 / 196 / 201% | 30 / 101 / 186% | 19 / 35 / 46% | 4 / 14 / 17% | 3.0 / 4.1 / 5.0 |
| Writer loopback | 22:17–22:44 | 1 / 0.5 / 28% | 101 / 186 / 234% | 14 / 25 / 51% | 0 | 1.8 / 2.6 / 3.1 |

`app-read` ran at its `cpus: 2` cap whenever the proxy was in use. This is the same as on 11-12. So the same 2 CPUs now serve fewer player and feed requests than in the 11-12 run. That points to more work per request, but this run does not show whether the code, a larger catalog or larger responses caused it. Postgres stayed under 51%.

## Method

- **Release:** `852ca88` on `main`, read from `/opt/echo`. Alembic was at head. `app` and `app-read` started at 2026-11-21 21:32 UTC, and no container restarted during the run.
- **Stack:** compose project `echo` on the 4-core, 7.7 GB VPS. The containers are `app` (the writer, on `:8000`), `app-read` (2 workers, capped at `cpus: 2`), `proxy` (Caddy, on `:8080`), `postgres` (pool of 15) and `cloudflared`.
- **VPS run:** 2026-11-21 from 21:43 to 22:44 UTC, which was 2026-11-22 in Vietnam, hence the folder name. `run-probe.sh` ran three phases in order, with 20 s between them:
  1. `player_probe.py` through the proxy.
  2. `loopback.py` through the proxy.
  3. `loopback.py` against the writer alone.
- **Loopback probes:** they run on the VPS, with no Cloudflare, tunnel or network trip. Each request sends its own `CF-Connecting-IP`, which keeps the per-IP limits out of the way. Requests send no cookie, so the proxy sends the read paths to `app-read`.
- **Steps:** `loopback.py` used 1, 2, 5, 10, 15, 25 and 50 connections, 20 s each, as on 11-12. `player_probe.py` used 1 to 150 players, 20 s each.
- **Edge, browser and geo:** these ran from the laptop. The geo run started at 22:46 UTC, after the VPS run had finished.

## Health and alerts

- `/api/readyz` returned 200.
- In the 30 minutes before the load test, the access log had 160 × 200 and 2 × 503. Both 503s were `REWARDS_DISABLED` on `POST /api/rewards/reels/claim`. This is expected, because `SX_REEL_REWARDS_ENABLED` is off.
- The watchdog fired during the writer-alone run, as it should under this load:
  - 22:20:27Z: p95 of 3324 ms.
  - 22:22:30Z: `db_pool`, "15 of 15 connections checked out".
  - 22:43:33Z: p95 of 2094 ms.
- `rate_limit_events` grew to 35,787 rows. The probes send a new `CF-Connecting-IP` per request, so each one writes rows.

## Edge, browser and Sentry

- **Edge probe** (`edge_probe.py`, from Vietnam, `raw/edge.log`): 43 of 44 checks pass.
  - All 32 anonymous routes return 200.
  - The CSP is enforced and has no `unsafe-eval`. HSTS is `max-age=15552000`.
  - HTTP redirects to HTTPS.
  - The mp4 Range request returns 206 with ACAO, and the poster returns 200 with ACAO.
  - An unknown API route returns 404 JSON. SPA deep links serve the index.
  - An anonymous rewards claim is refused with a 4xx.
  - The one failure: `sit.echomultiverse.com` is open to the public. It is already tracked in `docs/to-beta.md` (Cloudflare Access for SIT).
- **Browser:** the Reels, Explore, login and 404 pages load with no CSP violations and no failed requests.
- **Sentry:** nothing new from this release. The only steady noise is `REWARDS_DISABLED`, 61 events in 24 h.

## Geo run

`geo_probe.py` runs from the laptop. It used no VPN for Vietnam, and a Surfshark exit for each other location. Every request is an anonymous GET through Cloudflare and the tunnel. For each location it records:

- the Cloudflare colo, from `cdn-cgi/trace`;
- 20 warm samples per route on one keep-alive connection, as TTFB;
- one 4 MB Range read of a reel mp4 from `media.`;
- a cold `/reels` open (the same 18 requests as `player_open`) by 1 and 5 players, 15 s each.

The runs went from 2026-11-21 22:46 UTC (Vietnam) to 2026-11-22 06:49 UTC (Frankfurt). Every route returned 200 in every location.

**Warm TTFB, p50 / p95 (ms)**

| Location | Colo | trace | healthz | spa_index | spa_js | config | reels | tags | feed | player_inline |
|---|---|---|---|---|---|---|---|---|---|---|
| Vietnam, no VPN | SIN | 59 / 119 | 303 / 750 | 255 / 387 | 143 / 205 | 133 / 976 | 314 / 425 | 65 / 450 | 375 / 717 | 402 / 1404 |
| Singapore | SIN | 66 / 873 | 310 / 574 | 326 / 1157 | 147 / 311 | 122 / 566 | 302 / 667 | 68 / 500 | 530 / 841 | 568 / 1269 |
| Tokyo | SJC | 234 / 250 | 273 / 5232 | 503 / 967 | 358 / 806 | 358 / 662 | 419 / 808 | 289 / 1133 | 430 / 1463 | 513 / 999 |
| Sydney | SYD | 173 / 3458 | 360 / 925 | 408 / 551 | 410 / 759 | 375 / 1232 | 507 / 767 | 370 / 3841 | 842 / 3113 | 641 / 1444 |
| Seattle | SEA | 260 / 2191 | 273 / 2662 | 853 / 6783 | 857 / 1557 | 968 / 24781 | 963 / 9127 | 648 / 4719 | 837 / 3472 | 769 / 1494 |
| New York | EWR | 351 / 9319 | 354 / 1191 | 724 / 2206 | 878 / 1241 | 589 / 2218 | 404 / 1613 | 1104 / 4892 | 702 / 1751 | 551 / 1098 |
| London | LHR | 228 / 639 | 394 / 1616 | 388 / 1949 | 494 / 1521 | 242 / 876 | 417 / 762 | 307 / 1087 | 526 / 891 | 720 / 1044 |
| Frankfurt | FRA | 247 / 934 | 393 / 847 | 639 / 2233 | 561 / 870 | 382 / 1346 | 419 / 878 | 252 / 1327 | 532 / 724 | 775 / 1302 |

**Media and player open**

| Location | 4 MB Range read: bytes, speed, TTFB (ms) | Open, 1 player, p50 (ms) | Open, 5 players, p50 / p95 (ms) | Opens, 1 / 5 players |
|---|---|---|---|---|
| Vietnam, no VPN | 2.9 MB (whole file), 1.52 MB/s, 302 | 9927 | 11896 / 14778 | 2 / 10 |
| Singapore | 2.9 MB (whole file), 1.02 MB/s, 408 | 18951 | 10452 / 16419 | 1 / 10 |
| Tokyo | 4 MB, 0.04 MB/s, 685 | 44384 | 15451 / 17110 | 2 / 7 |
| Sydney | 4 MB, 0.04 MB/s, 1095 | 23350 | 16512 / 23184 | 1 / 5 |
| Seattle | 4 MB, 0.53 MB/s, 1299 | 37084 | 31766 / 33089 | 1 / 5 |
| New York | 4 MB, 0.45 MB/s, 1235 | 47486 | 25924 / 34760 | 1 / 5 |
| London | 4 MB, 0.60 MB/s, 1402 | 17848 | 21176 / 25155 | 1 / 5 |
| Frankfurt | 4 MB, 0.64 MB/s, 1621 | 18894 | 18245 / 29936 | 1 / 5 |

Each window was 15 s, and one open took 10 to 47 s. So each cell rests on 1 to 10 opens, and a 1-player cell is usually a single open. The open times are also an upper bound. The probe sends the 18 requests one after another on one connection, and it downloads the full player scripts each time. A browser runs them in parallel on several connections and caches the scripts. Compare the open times between locations only, not with the loopback numbers.

**Compared with the 2026-11-10 baseline:** the baseline gives edge+origin, which is TTFB minus the trace RTT. On this run that subtraction is not reliable. trace p95 reached 0.9 to 9.3 s on several VPN exits, and the derived healthz came out as low as 3 ms from New York, below the trip to Oregon. So only rough statements hold:

- **Asia:** Vietnam and Singapore enter at SIN. Their API p50 is 300 to 570 ms, which is mostly the trip to Oregon. `spa_js` is an edge `HIT` there, at about 145 ms.
- **Tokyo** still enters at SJC, as on 11-10, so it pays a trip to California first. Its trace p50 is 234 ms, and the API p50 is 270 to 510 ms.
- **Europe and US East:** the API p50 is 400 to 780 ms, with a trace p50 of 230 to 350 ms. On 11-10, edge+origin for these exits was 106 to 384 ms. The numbers cannot be split cleanly between the player regression above and the VPN. A rerun from a real network in those regions would separate the two.
- **Media throughput through the VPN is 0.04 to 0.64 MB/s.** This is the VPN cap, as on 11-10, not R2. Without the VPN, Vietnam got 1.52 MB/s.

**Not run:**

- Los Angeles: the VPN leg was dead, so the run failed with `TimeoutError` and `gaierror`. `raw/geo-us-los-angeles.json` is empty. A partial earlier attempt saw colo LAX, with trace at 216 / 622 ms, healthz at 266 / 903 ms, feed at 382 / 681 ms and player_inline at 740 / 1146 ms.
- Hong Kong: excluded on purpose. Claude is not available in Hong Kong or China. `raw/geo-hong-kong.*` is from an early attempt and is not used here.

## Profile of player-inline

`profile_inline.py` runs one anonymous route in-process on a given tree, against a local Postgres. It seeds the prod catalog size: 207 posts from 25 creators, 30 likes per creator, and 291 rows of `post_recommendation_daily_stats` (the prod count for 11-16 to 11-22). Each request has no cookie, like the loopback probe. It times 60 requests after 5 warm-ups, then runs cProfile over 30 more. The rate limiter is real, with a huge limit. `raw/profile.log` has every run.

| Route | `7bf201b` (ms) | `852ca88` (ms) | Change | Prod change in rps |
|---|---|---|---|---|
| `/api/reels/player-inline` | 28.7 | 38.8 | +35% | −28 to −39% |
| `/api/reels/feed` | 24.9 | 32.0 | +29% | −17 to −19% |

The values are medians. The local changes match the prod falls, so the catalog size and the run order do not explain them.

Where the extra time goes, from cProfile (profiled time is about 1.6× wall time):

- **`_pipeline_context` (`server/recommendation/service.py`), about 74% of the gap.** It grew from 8.6 to 23.8 ms per request. Two new queries cause most of it:
  - The 7-day trending read of `PostRecommendationDailyStats`, added in `c00d325`. It loads every row of the last week as ORM objects on every request, about 7.8 ms. The stats are global, not per viewer.
  - The negative `ActorItemAffinity` query, with an `IN` list of about 200 post ids, about 2.8 ms. It runs even for a first-time visitor, who has no affinity rows.
- **The shared rate limiter on the player routes** (`f1fd6b0`), 2.2 ms. It takes an advisory lock and commits on every request. Locally it costs 0 to 1 ms of wall time, but the VPS disk may make the commit dearer. It is a security fix, so keep it.
- **`_fill_player_data`,** 2.2 ms, new and only on the player routes. The template and icons add 1.4 ms more, and the body is 7.6% larger.
- **`_hidden_paths`,** 1.4 ms, plus small gains in rank, rerank and sources.

SQL went from 18 to 23 statements per request on Postgres. With no daily-stats rows, player-inline on `852ca88` takes 36.5 ms, so that read is about 2 ms of wall time at the prod row count. It grows with the number of rows.

**With both fixes** (working tree, not deployed), on the same seed:

| Route | `7bf201b` (ms) | `852ca88` (ms) | With fixes (ms) | Gap recovered |
|---|---|---|---|---|
| `/api/reels/player-inline` | 28.7 | 38.8 | 33.3 | 54% |
| `/api/reels/feed` | 24.9 | 32.0 | 26.5 | 77% |

The fixed tree returns bodies of the same size as `852ca88`. The rest of the player-inline gap is the rate limiter, `_fill_player_data` and the larger body.

Limits: this is one thread on a laptop, with a synthetic seed and macOS fsync. It has no concurrency and no pool contention, so it shows where the time goes, not the prod rates.

### Less waste in `_pipeline_context`

Branch `perf/pipeline-context-waste` against `6c3720e`. Same harness, run on local Postgres 16 (128 MB `shared_buffers`, `pg_stat_statements`), real rate limiter, 291 daily-stats rows. These are local numbers, not prod. The branch skips reads whose answer is already known for a first-time visitor (new cookie, new session), and caches `PostRecommendationStats` for 30 s.

| Measure, per player-inline request | `6c3720e` | Branch |
|---|---|---|
| SQL statements | 21 | 11 |
| `_pipeline_context`, cProfile | 16.05 ms | 0.31 ms |
| `_materialize_reel_page`, cProfile | 48.82 ms | 32.12 ms |
| `get_reel_page`, cProfile | 56.43 ms | 41.02 ms |
| Wall time, p10 / p25, timed requests pooled | 43.7 / 46.9 ms | 38.1 / 41.8 ms |
| Wall time, median of each run | 45.5–74.4 ms | 41.5–67.0 ms |

The ten statements gone are the three actor-affinity reads, two `engagement_events` reads, the event-posts read (it ran with `WHERE false`), the exposures join, the dismissals read, the delivered-ids read, and the `post_recommendation_stats` read. The statements left are the writes (session, request, impressions, rate limit, latency), the advisory lock, the dismissals purge in `_new_session`, and the media-path and session lookups.

cProfile inflates ORM-heavy code, so the ms rows overstate the gain. The wall-time rows come from 5 runs of `6c3720e` and 4 of the branch (60 timed requests each), taken in turns. The laptop had a load average of 11–13 at the time, so run medians swung by 30 ms and do not separate the two trees. The low percentiles, which load disturbs least, are about 5 ms lower on the branch. Treat that as an estimate.

**Deployed in `20bfb10`.** On prod the gain is larger than the local estimate: on the writer alone, the feed is up 40%, the player 29% and player-inline 25% (see "After the pipeline-context fix").

## Not covered

- Signed-in flows and writes: uploads, publish, likes, comments, DMs, billing. Every probe was anonymous and read-only.
- The edge ramp and mixed modes of `2026-11-12/load.py`. The geo run replaced them.
- A real-device check on the Quest.

## Flags

1. **Player routes are 28 to 39% slower than in the 11-12 run,** on both the writer and the reader. The cause is the code between `7bf201b` and `852ca88` (see "Profile of player-inline"). Two fixes are made in the working tree but not deployed:
   - `_recent_stats` reads last week's daily stats for every post as plain columns, once per process every 30 s (`RECENT_STATS_TTL_S`) and again when the day changes.
   - The negative item-affinity query runs only when the viewer has 24 or more affinity rows. With fewer, the top-rows read already holds them all.
   - **Deployed in `7ab15a6`.** The probe after the deploy confirms the gain: on the writer alone, the player is up 20%, player-inline 23% and the feed 19% (see "After deploying 7ab15a6"). They are still below the 11-12 rates.
2. **The feed fell 17 to 19%,** and the session starts fell with it. It shares the `_pipeline_context` cost with the player routes.
3. **The SPA's first reels page never hits the edge cache.**
   - `ReelsPage.jsx` always sends `refresh: refreshKey > 0`. `web/src/api/client.js` drops only `undefined` and `null`, so every request carries `refresh=false`.
   - `EdgeCacheMiddleware` in `server/edge_cache.py` checks `"refresh" not in request.query_params`, which tests whether the key is present, not its value. So it answers `private, no-store`.
   - Checked with `curl`: bare `/api/reels` gets `public, max-age=0, s-maxage=30` and `HIT`. The SPA's URL gets `private, no-store` and `BYPASS`.
   - The result is that every visitor's first reels page goes to Oregon.
   - **Fixed in the working tree, not deployed.** `EdgeCacheMiddleware` now treats `refresh=false` and `refresh=0` as no re-scan. `test_refresh_false_is_cacheable` covers the SPA's URL. After the deploy, check with `curl` that the SPA's URL gets `HIT`. If it stays `BYPASS`, the Cloudflare Cache Rule may also exclude the `refresh` parameter.
   - **Deployed in `7ab15a6` and confirmed.** The SPA's URL gets `public, max-age=0, s-maxage=30`, then `HIT` on a second request.
4. **The DB pool reached 15 of 15** during the writer-alone run at high concurrency.
5. **SIT is open to the public.** This is already tracked in `docs/to-beta.md`.
6. **Sentry noise from `REWARDS_DISABLED`,** 61 events in 24 h. It is expected while rewards are off, but it hides real issues.
7. **Expired recommendation sessions of one-time visitors are never purged.** `_purge_actor_history` runs only when the same actor starts a new session. `recommendation_impressions` is at 2.2M rows and 2179 MB, most of it from probes, and is one candidate for the writer-alone fall after `5c327ce`. A global sweep of expired sessions and their impressions would fix it. Every probe run adds about 400k rows.
   - **Deployed in `6c3720e`.** `sweep_expired_sessions()` in the writer's cleanup loop deletes sessions expired more than 24 h ago, with their requests and impressions. The backlog was drained by hand on 2026-11-24. `recommendation_impressions` now holds 839,674 live rows. The file stays at 2540 MB.

## Online capacity / SX_CAPACITY_ONLINE

The rule in `2026-11-12/README.md` is: the writer feed ceiling × 50, rounded down for headroom. The writer feed ceiling is now 15.1 rps, so 15.1 × 50 ≈ 755 viewers. That is below the current 800. Set `SX_CAPACITY_ONLINE=650`, which keeps the same headroom as 930 → 800 on 11-12. The watchdog then alerts at 70%, which is 455. Raise it again once the feed regression is fixed and a new probe confirms the ceiling. After `7ab15a6` the writer feed ceiling is 18.1 rps, so 18.1 × 50 ≈ 905 viewers. With the same headroom, that allows about 780. After `20bfb10` (r4) the writer feed ceiling is 22.5 rps, so 22.5 × 50 ≈ 1125 viewers. With the same headroom, that allows about 970. This is a single run, and `SX_CAPACITY_ONLINE` was not changed.

## Files

- `edge_probe.py`: the edge check, run from the laptop. Its output is in `raw/edge.log`.
- `player_probe.py`: max concurrent players, on the VPS. `PORT=8080` targets the proxy, and `8000` targets the writer.
- `loopback.py`: the 11-12 loopback probe, unchanged.
- `run-probe.sh`: runs the player probe, then the loopback probe through the proxy, then against the writer, detached on the VPS, with a CPU sampler.
- `geo_probe.py`: the geo probe, run from the laptop at each VPN location.
- `profile_inline.py`: the local profile of one route. Its docstring lists the settings. `raw/profile.log` holds the results.
- `raw/player-proxy.log`, `raw/loopback-proxy.log`, `raw/loopback-writer.log`: one JSON line per step.
- `raw/cpu.log`: container CPU and memory, and load, with phase markers.
- `raw/geo-<location>.json`: one JSON object per location. `raw/geo-<location>.log` holds the progress lines.
- `raw-after-deploy/`: the VPS set after `7ab15a6`.
- `raw-5c327ce/`: the VPS set, the edge probe and the two geo runs that are not comparable, after `5c327ce`. The `-r2` and `-r3` files are the runs before and after the session sweep. The `-r4` files are the run after the pipeline-context fix; each holds both parts of that run. `profile-db/` holds the local seeded and swept profiles.
- `raw-quest/` and `quest.md`: the Quest 3 run.

## How to run

The VPS part takes about 60 minutes. Run it from this folder:

```bash
ssh -n <user>@<vps> mkdir -p /tmp/probe-20261122
```

```bash
scp player_probe.py loopback.py run-probe.sh <user>@<vps>:/tmp/probe-20261122/
```

```bash
ssh -n <user>@<vps> 'setsid nohup sh /tmp/probe-20261122/run-probe.sh > /dev/null 2>&1 < /dev/null &'
```

`/tmp/probe-20261122/done` appears when it finishes. Then copy the logs back:

```bash
for f in player-proxy loopback-proxy loopback-writer cpu; do scp <user>@<vps>:/tmp/probe-20261122/$f.log raw/$f.log; done
```

The geo probe takes about 4 minutes per location. Connect the VPN and check the colo in `cdn-cgi/trace`. Then run:

```bash
python3 -u geo_probe.py <location> > raw/geo-<location>.json 2> raw/geo-<location>.log
```

Do not run the geo probe while the VPS probe is running, because each would slow the other.
