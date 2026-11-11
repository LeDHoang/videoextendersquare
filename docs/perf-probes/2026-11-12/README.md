# Load profile on release 7bf201b, 2026-11-12

The loopback probes from `docs/perf-probes/2026-11-11-after-fixes/` were run again on release `7bf201b`. This release adds the separate reader service behind a proxy, the edge cache headers, `/api/reels` paging, the recommendation catalog cache and the `reel_records` column load.

**Status:** loopback only. The edge run (`load.py`) was stopped because the laptop's connection was too slow to give useful numbers. At the time, even `www.cloudflare.com/cdn-cgi/trace` took 0.4 to 4.3 s to first byte, while the server answered `/healthz` in 3 to 6 ms on the VPS. So the edge cache is not measured yet. See "How to run the edge probe" below.

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

## Files

- `loopback.py`: the loopback probe. `PORT=8080` targets the proxy, and the default `8000` targets the writer.
- `run-loopback.sh`: runs both loopback passes detached on the VPS, with a CPU sampler.
- `load.py`: the edge probe, unchanged from the earlier runs.
- `raw/loopback-proxy.log`, `raw/loopback-writer.log`: one JSON line per step.
- `raw/loopback-cpu.log`: container CPU and memory samples.

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
