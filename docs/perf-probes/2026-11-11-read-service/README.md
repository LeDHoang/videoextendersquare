# Read service: one writer vs. the proxy with two reader processes (2026-11-11)

Fix 3 of `../2026-11-11/bottlenecks.md` (section 2, "Workers"): anonymous GETs
of the read routes go to `app-read` (SX_ROLE=reader, 2 uvicorn processes),
everything else to the one writer `app`. Design and limits:
`server/read_routes.py`, `docs/deploy-runbook.md` section 6.

## Result

Ceiling = best `good_rps` over the steps 1–50 connections, 20 s per step, every
request 200.

| Route | Writer alone (127.0.0.1:8011) | Through the proxy (127.0.0.1:8012) | Gain | p95 at 10 conns, alone → proxy |
|---|---|---|---|---|
| `/api/reels/feed` | 30.5 rps | 63.6 rps (64.4 with the advisory lock) | 2.1× | 460 → 325 ms (203 ms with the lock) |
| `/api/reels/player` | 25.2 rps | 40.2 rps | 1.6× | 693 → 357 ms |
| `/api/reels/player-inline` | 25.4 rps | 48.5 rps | 1.9× | 552 → 318 ms |

What saturates (`raw/cpu.log`, `docker stats` every 8 s):

- Writer alone: `app` at 100–114 % CPU, one core, the rest of the machine idle.
- Through the proxy: `app-read` at 200–218 %, its `cpus: 2` cap; the writer
  idle; Postgres up to ~90 % at the feed's peak. The gain is bounded by the
  readers' cap, so `SX_READ_WORKERS` and `cpus` are the knobs.
- The player gains less than the feed. Not measured why; one guess is that its
  larger response gives the proxy and the load generator, on the same laptop,
  a larger share of the CPU.

The writer-alone baseline is this branch's writer, so it already pays the
shared rate-limit insert and commit on the feed. Both runs used one stack and
one database, back to back, with a 65 s pause between.

## Method

- Laptop: Apple Silicon, Docker Desktop with 8 CPUs and 8 GB. Not the VPS: the
  numbers compare the two setups; they are not production capacity.
- Stack: `compose.yaml` of this branch as project `echo-readsvc` (app, app-read
  with `SX_READ_WORKERS=2`, proxy, postgres), production mode, image = this
  branch's code over the local `echo-app:latest` dependency layers.
- Data: the dev SQLite catalog (203 reels) migrated to head and copied into the
  stack's Postgres.
- Probe: `loopback.py`, a copy of `docs/perf-probes/2026-11-11-after-fixes/loopback.py`
  (not yet committed on `dev` when this ran); only `ORIGIN`'s port differs per
  run (8011 writer, 8012 proxy). It sends a new CF-Connecting-IP per request, so
  the 60/min limit does not cap the run.
- Raw: `raw/writer-alone.log`, `raw/through-proxy.log`,
  `raw/through-proxy-feed-with-lock.log` (feed only, rerun after the change
  below), `raw/cpu.log`.

## Routing and the shared limit, live

`live_check.py` against the same stack: 32 of 32 checks pass
(`raw/live_check.log`). Each request carries an X-Request-ID, and the checks
find it in the access log of the service that should have served it:

- Anonymous GETs of the six read routes go to app-read, also with other cookies.
- The same GETs with an `echo_session` cookie go to the writer.
- POSTs, `/api/reels/tags/{name}`, `/api/auth/me`, `/api/config`, SSE, admin,
  `/` and HEAD go to the writer.
- `/api/reels` returns the same body from the writer and from a reader.
- 70 feed requests from one IP through the proxy: 60 pass, 10 get 429. The
  writer refuses that IP too, and another IP is not affected.
- Six feed pages over the reader processes return 72 distinct items with no
  restart.

## Shared limit under concurrency

`limit_race.py` checks one key from N processes at once against a limit of 30,
on PostgreSQL:

| | 3 processes, 20 runs | 8 processes, 10 runs |
|---|---|---|
| Conditional insert alone | 30 in 19 runs, 32 once | 31–34 |
| With `pg_advisory_xact_lock` on the key (committed) | 30 every run | 30 every run |

Under READ COMMITTED every check in flight at `limit - 1` sees the same count.
The per-key advisory lock makes the checks take turns until the commit. It made
no measurable difference to the feed's ceiling (63.6 → 64.4 rps), but that run
sends a new IP per request, so no two checks ever waited on one lock. Requests
from one IP queue behind each other for one insert and commit each; a single IP
is held to 60 per minute anyway.
`tests/test_rate_limiter.py -k shared` runs the cross-process check on
PostgreSQL in CI.
