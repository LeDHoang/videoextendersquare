# Load profile on release 7bf201b, 2026-11-12

The loopback probes from `docs/perf-probes/2026-11-11-after-fixes/` were run again on release `7bf201b`. This release adds the separate reader service behind a proxy, the edge cache headers, `/api/reels` paging, the recommendation catalog cache and the `reel_records` column load.

**Status:** loopback and edge both done. The first edge run was stopped because the laptop's connection was too slow; it was run again from another network on 2026-11-12. See "Edge run" below.

## Summary

- **Session starts: about 770 per minute through the proxy.** That is about 2 times the 375 per minute on `69d86cd` and about 5 times the 136 to 156 before the fixes.
- **Through the proxy, the read routes about doubled.** Anonymous GETs of the 6 read paths go to `app-read`, which runs 2 workers. The feed went from 15 to 16 rps to 33.6 rps, and the player from 14 to 14.6 rps to 29.3 rps.
- **On the writer alone, the feed and the player gained about 20%.** Feed 18.6 rps, player 17.7 rps, session 443 per minute. These gains come from the per-request savings (`d99d813`, `73e835e`). Part of the difference may be run-to-run noise.
- **Creators did not gain on the writer alone.** It reached 22.2 rps, against 22 to 26 before. Its p95 at 10 connections went from 543 to 636 ms. Through the proxy it reached 41 rps.
- **`locations/activity` and `search/suggestions` are the same either way,** at about 21 and 33 rps. They are not in `READ_PATHS`, so they stay on the writer.
- **No errors.** Every step, up to 50 connections, returned only 200.

## Results

The ceiling is the highest rate across the steps. Earlier numbers are from `docs/perf-probes/2026-11-11-after-fixes/README.md`.

| Route | `69d86cd` ceiling (rps) | Writer alone (rps) | Through proxy (rps) | p95 at c=10, writer / proxy (ms) |
|---|---|---|---|---|
| `/api/reels/feed` | 15–16 | 18.6 | 33.6 | 594 / 468 |
| `/api/recommendations/creators` | 22–26 | 22.2 | 41.3 | 636 / 365 |
| `/api/reels` | 86–90 | 89.2 | 142.2 | 129 / 133 |
| `/api/reels/player` | 14–14.6 | 17.7 | 29.3 | 656 / 412 |
| `/api/reels/player-inline` | about 14 | 17.5 | 30.8 | 629 / 434 |
| `/api/reels/tags` | n/a | 81.2 | 132.9 | 147 / 109 |
| `/api/reels/locations/activity` | n/a | 21.4 | 20.7 | 552 / 556 |
| `/api/search/suggestions?q=a` | n/a | 33.2 | 32.1 | 336 / 365 |
| session, sessions per minute | about 375 | 443 | 770 | 608 / 455 |
| session_spa, sessions per minute | n/a | 430 | 772 | 586 / 501 |

The session rows' p95 is per request. The session rows are the same sequences as in the earlier runs: `/`, `/api/config`, `/api/auth/me`, `/api/reels`, the player route and one feed page.

## CPU

`docker stats` was sampled every 8 to 10 s (`raw/loopback-cpu.log`). The proxy run is the samples before 17:58 UTC and the writer run is the samples after. The "proxy done" marker the runner wrote is missing from this file. The sampler had the file open without append, so it wrote over the marker. `run-loopback.sh` here appends instead, which fixes this for the next run.

| Run | `app-read` p50 / p90 | `app` p50 / p90 | `postgres` p50 / p90 | `proxy` p90 |
|---|---|---|---|---|
| Through proxy | 164% / 190% | 1% / 102% | 16% / 28% | 9% |
| Writer alone | 0% / 37% | 101% / 123% | 15% / 22% | 0% |

`app-read` is capped at `cpus: 2` in `compose.yaml` and ran close to that cap. `app` was busy during the proxy run only for the routes outside `READ_PATHS`. Postgres and the proxy had room to spare. On this 4-core VPS, read throughput is now bound by the 2 reader workers.

## Method

- **Tool:** `loopback.py`, run on the VPS, with no Cloudflare, tunnel or network round trip. Each request sends its own `CF-Connecting-IP`, which keeps the feed and creators routes under their 60 per minute per-IP limit. Requests send no cookie, so they are anonymous and the proxy sends the read paths to `app-read`.
- **Targets:** first `127.0.0.1:8080`, the proxy, which visitors get. Then `127.0.0.1:8000`, the writer alone, which is comparable with the earlier runs.
- **Steps:** 1, 2, 5, 10, 15, 25 and 50 connections, 20 s each.
- **When:** 2026-11-11, from 17:31 to 18:24 UTC (2026-11-12 in Taiwan, hence the folder name). The proxy run went until about 17:58 and the writer run after that.
- **Release:** `7bf201b`, read from `/opt/echo`. The containers were `app`, `app-read` (2 workers), `proxy`, `postgres` and `cloudflared`.

## Edge run

`load.py` from a laptop in Taiwan, through Cloudflare (colo `SJC`) and the tunnel, on 2026-11-12 from 03:28 to 05:13 UTC. Release `7bf201b`. Compared with the "before" run in `docs/perf-probes/2026-11-11/raw/` (release `4e05762`). Before the run, with a warm connection, `cdn-cgi/trace` answered in 159 ms and `/healthz` in 311 to 643 ms. No step of any mode returned an error.

**Summary**

- **The edge cache works.** `/api/reels`, tags, locations and config are now answered by Cloudflare. At one connection their time to first byte is about the round trip to the edge, 127 to 243 ms at p50, against 268 to 411 ms before. Under load they no longer stop: `/api/reels` went from a ceiling of 4.4 rps to more than 172 rps, and tags from 8.3 to more than 262 rps, with p95 near 300 ms at 50 connections.
- **Session starts: about 1,530 per minute at 50 connections, against about 160 at most before.** The before run stopped at 15 connections, with a session p95 of 6.8 s. At 15 connections it is now 560 per minute with a session p95 of 1.9 s.
- **The player routes reach about 28 rps,** against 7.8 rps before, and flatten from 25 connections. This matches the loopback ceiling through the proxy (29 to 31 rps), so the 2 reader workers are the limit.
- **`search/suggestions` and `locations/activity` gained 4 to 5 times,** to 32 and 20 rps. They stay on the writer, so this is from the per-request fixes.
- **`/api/users/{user}/posts` fell from 70 to 20 rps.** This is probably not a like-for-like comparison. `load.py` picks the user from the first reel of `/api/reels`, and the response is now 4,035 bytes against 994 before, so the run likely hit a different user with more posts. Not checked further.
- **The light routes (`/healthz`, `/`, `/api/auth/me`) were 5 to 15% lower.** They do almost no work on the server, so this is likely the network. It is not known whether the before run used the same network.

**Ramp: ceiling (highest rps across steps), p95 time to first byte at 10 connections**

| Route | Before ceiling (rps) | Now ceiling (rps) | p95 at c=10, before / now (ms) |
|---|---|---|---|
| `/api/config` | 158 | 268 | 287 / 261 |
| `/api/reels` | 4.4 | 172 (not reached) | 2364 / 507 |
| `/api/reels/tags` | 8.3 | 262 (not reached) | 1466 / 271 |
| `/api/reels/player` | 7.8 | 28.8 | 1465 / 536 |
| `/api/reels/player-inline` | n/a | 28.2 | n/a / 462 |
| `/api/reels/locations/activity` | 5.8 | 20.0 | 2012 / 582 |
| `/api/search/suggestions?q=a` | 6.8 | 31.9 | 1719 / 418 |
| `/api/feed` | 21.4 | 23.5 | 639 / 518 |
| `/api/packs` | 37.2 | 39.4 | 427 / 430 |
| `/api/users/{user}/posts` | 70.4 | 20.0 | 332 / 661 |
| `/api/posts/{post}/comments` | 90.1 | 89.0 | 317 / 359 |

"Not reached" means the route was still scaling at 50 connections, the last step.

**Latency: one connection, time to first byte p50 / p95 (ms)**

| Route | Before | Now |
|---|---|---|
| `/api/reels` | 411 / 578 | 153 / 179 |
| `/api/reels/locations` | 372 / 513 | 127 / 146 |
| `/api/config` | 268 / 291 | 145 / 166 |
| `/api/reels/tags` | 373 / 510 | 243 / 291 |
| `/api/reels/feed` | 386 / 524 | 435 / 526 |
| `/api/reels/player` | 440 / 533 | 397 / 506 |
| `/api/recommendations/creators` | 328 / 465 | 387 / 910 |
| `/healthz` | 268 / 397 | 287 / 304 |

At one connection the uncached routes are bound by the round trip from Taiwan to Oregon, so they changed little. The full set is in `raw/latency.log`.

**Mixed: session starts**

| Connections | Before, sessions per minute (session p95) | Now, sessions per minute (session p95) |
|---|---|---|
| 1 | 25.9 (2.6 s) | 42.1 (1.8 s) |
| 5 | 111.2 (3.3 s) | 193.4 (1.8 s) |
| 10 | 146.6 (5.2 s) | 407.6 (1.8 s) |
| 15 | 159.6 (6.8 s) | 560.5 (1.9 s) |
| 25 | stopped | 978.1 (1.9 s) |
| 50 | stopped | 1526.6 (2.7 s) |

## Files

- `loopback.py`: the loopback probe. `PORT=8080` targets the proxy, and the default `8000` targets the writer.
- `run-loopback.sh`: runs both loopback passes detached on the VPS, with a CPU sampler.
- `load.py`: the edge probe, unchanged from the earlier runs.
- `raw/loopback-proxy.log`, `raw/loopback-writer.log`: one JSON line per step.
- `raw/loopback-cpu.log`: container CPU and memory samples.
- `raw/{latency,ramp,mixed}.{log,json}`: the edge run, one JSON line per step in the logs.

## How to run the loopback probe

From this folder. It takes about 50 minutes, and the laptop's connection does not affect the numbers.

```bash
scp loopback.py run-loopback.sh <user>@<vps>:/tmp/
```

```bash
ssh -n <user>@<vps> 'setsid nohup sh /tmp/run-loopback.sh > /dev/null 2>&1 < /dev/null &'
```

Check progress, then copy the logs back once `/tmp/probe.done` exists:

```bash
ssh -n <user>@<vps> 'ls /tmp/probe.done; tail -2 /tmp/probe-proxy.log /tmp/probe-writer.log'
```

```bash
for f in proxy writer cpu; do scp <user>@<vps>:/tmp/probe-$f.log raw/loopback-$f.log; done
```

To run a single route, pass its name. The names are the keys of `PATHS` in `loopback.py`:

```bash
ssh <user>@<vps> PORT=8080 python3 - reels_feed player < loopback.py
```

## How to run the edge probe

`load.py` runs from a laptop through Cloudflare and the tunnel, so it measures the edge cache and the real round trip. It needs a steady connection. Check the connection first: `cdn-cgi/trace` is answered by Cloudflare without reaching the server, so it should come back in well under 0.5 s every time.

```bash
for i in $(seq 10); do curl -s -o /dev/null -w "%{time_starttransfer}\n" https://echomultiverse.com/cdn-cgi/trace; done
```

If the times jump around or pass 1 s, wait for a better connection. Otherwise the run measures the connection, not the site.

Then run the three modes in order, from this folder. They take about 95 minutes in all, and each writes `raw/<mode>.json` plus the log:

```bash
for m in latency ramp mixed; do python3 -u load.py $m > raw/$m.log 2>&1; done
```

- `latency`: one connection on every anonymous GET path, up to 250 samples or 120 s each (300 s for the rate-limited routes).
- `ramp`: steps of 1 to 50 connections per path, 25 s each. A path stops at p95 time to first byte over 3 s or over 2% errors.
- `mixed`: steps of a session-start sequence, 50 s each.

Do not run the edge probe while the loopback probe is running, because each would slow the other.

What to compare against:

- the "before" edge run in `docs/perf-probes/2026-11-11/raw/{latency,ramp,mixed}.json` (release `4e05762`)
- `/api/reels`, tags and config, which should now be edge cache hits for anonymous visitors (`cf-cache-status: HIT`, `cache-control: public, max-age=0, s-maxage=30`), so they should be about as fast as `cdn-cgi/trace`
