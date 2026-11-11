# What limits latency and capacity, 2026-11-11

An investigation of release `4e05762`. No app code was changed. It answers what holds the server back and which changes buy the most. The load figures it builds on are in `README.md` in this folder.

## Summary

- **The limit is Python CPU on one core.** One process holds the GIL; Postgres sits at 5 to 17% CPU while the app is pinned at 105 to 113% (`raw/loopback-cpu.log`).
- **Every heavy route rebuilds the whole catalog on every request.** `/api/reels`, `/api/reels/tags`, `/api/reels/locations/activity` and `/api/search/suggestions` each load all 203 posts through `reel_records` (`server/social/services.py:198`), as full ORM objects with owners, tags, slides and comments. For an anonymous visitor the result is the same every time.
- **Caching that result removes most of the cost.** Measured locally with byte-identical responses: `/api/reels` 64 → 8 ms, tags 38 → 9 ms, suggestions 46 → 16 ms, activity 49 → 19 ms.
- **Throughput falls as concurrency rises.** With 40 threads fighting for the GIL, `/api/reels` drops from 6.1 rps at one connection to 4.7 at ten on the VPS. A small threadpool held the one-connection rate in a local test.
- **Three more cores are idle.** Four workers served 2.6 times the `/api/reels` rate of one in a local test. In-process state blocks this today; a read-only second service is the practical way in.
- **The SPA's player request was not in the load probes.** `/reels` loads `/api/reels/player-inline` (`web/src/components/ui/ReelsPlayer.jsx:122`), not `/api/reels/player`. It costs about the same locally (53 against 58 ms), so the capacity figures should hold, but its ceiling on the VPS is unmeasured.
- **Distance costs more latency than the server does.** From Asia each API request pays 180 to 200 ms to reach Oregon, against 90 to 145 ms of server time on the heavy routes.

## Method

- **Production evidence:** `README.md` sections 2 to 5 and `raw/loopback*.log` (VPS loopback, today), and Sentry spans for the last 24 hours.
- **Local measurements:** the deployed code (`git archive 4e05762`) run inside the `echo-app:latest` image (Linux, Python 3.12, 3 to 4 CPUs) against a copy of the dev database, which has 203 published posts, 188 comments and 259 slides, close to production's catalog. Requests went through the full ASGI stack with Starlette's `TestClient`; times are the median of 25.
- **What-ifs** are monkeypatches in the measuring script, not app changes. Each kept the response hash unchanged where noted.
- **Local limits:** SQLite instead of Postgres, an Apple-silicon laptop, and a stub media tree. Use local figures as ratios. Production is slower by about 2.3 times on the same request (`/api/reels` 144 ms on VPS loopback against 62 to 64 ms locally), and the "production estimate" columns below apply that ratio.
- The scripts and their output are in the shared notes folder under `bottlenecks-scripts/` (not committed).
- The player timings in sections 1 and 5 were taken without the icon files, which adds about 13 ms to both player routes when present (72 and 69 ms on `dev`).

## 1. Where the time goes, per route

Server time per request at one connection. "VPS" is today's loopback p50 where it was measured, else the Sentry p50 from `README.md` section 4. Query counts are local and match Sentry's db-span count per transaction (reels 6.1, player 25, tags 5.0, `/api/feed` 4.0).

| Route | VPS ms | Local ms | Queries | Body |
|---|---|---|---|---|
| `/api/reels` | 144 | 64 | 6 | 507 KB (37 KB on the wire) |
| `/api/reels/player` | 115 | 58 | 25 | 391 KB (84 KB gzip) |
| `/api/reels/player-inline` | not probed (Sentry p50 135 over 14 days, mixed load) | 53 | 25 | 401 KB JSON, not compressed at the origin |
| `/api/reels/feed` | 87 | 34 | 25 | 32 KB |
| `/api/reels/locations/activity` | not measured alone | 49 | 11 | 4.6 KB |
| `/api/search/suggestions?q=a` | not measured alone | 46 | 9 | 12.8 KB |
| `/api/reels/tags` | not measured alone | 38 | 5 | 3 KB |
| `/api/feed` | not measured alone | 17 | 4 | 44 KB |

### `/api/reels` (`server/routers/reels.py:1999`)

Local 64 ms splits into three parts, measured by memoizing one layer at a time:

| Part | Local ms | Where |
|---|---|---|
| `reel_records`: 5 queries, ORM hydration, per-post dicts | 36 | `server/social/services.py:198` |
| The rest of `_build_payload`: per-item URL and path work | 20 | `server/routers/reels.py:1438` |
| Hidden-paths query, filtering, JSON encoding, middleware | 8 | `reels.py:2024`, FastAPI |

- **The queries are few but wide.** `posts JOIN users` joins `users` twice and loads every user column, including `password_hash` (`joinedload(Post.owner)` plus the filter join, `services.py:212-218`). Comments do the same (`services.py:258-260`). `selectinload` adds one query each for `post_tags`, `tags` and `post_slides`, with all 203 ids in the IN list.
- **Path handling runs hundreds of times per request.** `_image_entry` (`services.py:388`) runs 414 times, once per image and slide, and `has_media_file` → `media_store.rel_path` 730 times. `rel_path` has a fast path for `str` only (`server/media_store.py:93`); callers pass `Path`, so each call does two `os.getcwd()` and a `normpath`. Passing a string saved 4 ms of 64 locally.
- **Cost grows with the catalog.** Half the catalog took 33.5 ms against 64, so about 0.3 ms per post locally and about 0.7 ms on the VPS. At 1,000 posts one request would cost about 0.7 s of CPU and return about 2.5 MB. The route has no limit or cursor, and it embeds every comment of every post.
- **Sentry span durations are inflated.** The 24-hour averages (posts 46 ms, comments 34 ms, tags 28 ms, slides 17 ms, hidden paths 14 ms) come mostly from the saturated ramp, where a span also waits for the GIL. Use them for query shape, not cost.

### `/api/reels/tags`, `/api/reels/locations/activity`, `/api/search/suggestions`

- All three build their catalog from `_metadata_snapshot` → `metadata_for_paths` → `reel_records(include_comments=False)` for every post (`reels.py:380`, `services.py:319`). That is the full ORM load and all 414 image entries, to return 3 to 13 KB.
- `/api/reels/tags` (`reels.py:2136`): `reel_records` is 30 of 38 ms. `_search_key` adds about 3 ms (`reels.py:347`).
- `/api/reels/locations/activity` (`reels.py:2228`): `reel_records` 30 ms, `_recent_activity_by_path` (`reels.py:729`) about 7 ms and 4 more queries.
- `/api/search/suggestions` (`server/routers/social.py:1666`): it calls `tag_suggestions` (`social.py:1716`), so it pays the tags cost on every keystroke, plus `ILIKE '%q%'` scans on users and posts and one `relationship_state` call per user row.

### `/api/reels/player` (`reels.py:2824`), `/api/reels/player-inline` (`reels.py:3064`) and `/api/reels/feed` (`reels.py:2066`)

The SPA uses the inline route; the iframe route is what the probes loaded (Sentry, 14 days: 2,210 inline requests against 6,490 iframe ones, most of the latter from the probes). Both run the same recommendation step and re-parse the same template.

Stage timings for the iframe player, local:

| Stage | Local ms | Note |
|---|---|---|
| `_recommendation_feed_data` | 27 | 20 to 25 queries; the same work is the whole of `/api/reels/feed` |
| 9 `re.sub` passes over the 322 KB template | 9.9 | `reels.py:2898-2904`; same output every request |
| `gzip.compress` level 5, 391 → 84 KB | 6.4 | `reels.py:2914`; level 1 takes 3.2 ms for 104 KB |
| JSON for the page, template read, icons | 2.5 | `reels.py:2889-2907` |
| CSP nonce pass, middleware, response | about 12 | by subtraction, not timed |

- The recommendation step writes on every read: a session row and impression rows. In the profile `_pipeline_context` (`server/social/recommendations/service.py:294`), which rebuilds the candidate catalog, is about 15% of the player request, and ranking (`ranking.py:166`, `:81`) about 17%.
- The inline route replaces the `re.sub` and gzip stages with its own per-request template work: `_scope_css` over 78 KB of CSS (2.4 ms, `reels.py:3214`) and two script regex passes (5.3 ms, `reels.py:3161`, `:3246`). All of it gives the same output every request.
- Memoizing `reel_records` barely moved the player (58 → 51 ms), because it builds only 12 items.

### `/api/feed` (`social.py:1630`)

17 ms and 4 queries locally, 21 rps on the VPS. It is not a bottleneck. It loads one page with a limit, which is the shape `/api/reels` lacks.

## 2. Process model

### Threadpool and GIL

- Handlers are sync `def`, so they run on AnyIO's default pool of 40 threads. Nothing under `server/`, `core/` or `pipeline/` changes that size (no `total_tokens` or `CapacityLimiter`). The SQLAlchemy pool is the default 5 plus 10 overflow (`server/social/database.py:21`), so above 15 busy requests threads also wait for a connection.
- On the VPS, `/api/reels` falls from 6.1 rps at one connection to 4.7 at ten to fifteen (`README.md` section 5). The player falls from 9.6 to 8.1.
- Local test, `/api/reels`, one worker (relative figures; the local drop is steeper than the VPS drop):

| Threads | c=1 | c=4 | c=10 | p95 at c=10 |
|---|---|---|---|---|
| 40 (default) | 13.2 rps | 7.0 | 3.3 | 4363 ms |
| 3 | 13.2 rps | 8.4 | 8.5 | 1760 ms |

### Workers

Local test, `/api/reels`, default threadpool, 4 CPUs:

| Workers | c=1 | c=4 | c=10 |
|---|---|---|---|
| 1 | 13.2 rps | 7.0 | 3.3 |
| 2 | 13.0 | 21.3 | 10.0 |
| 4 | 13.0 | 19.0 | 34.9 |

These two tables were rerun after the fixes below. The first run had loaded the image's own older `server` package under uvicorn instead of the mounted code; the ratios came out the same, the absolute rates did not.

State that lives in the process, and so breaks with `--workers 2` as the app stands:

| State | Where | Effect with two workers |
|---|---|---|
| JobManager pools and job records | `server/jobs.py:119-134` | a job's status and SSE progress are visible in one worker only |
| Staged uploads | `server/routers/image.py:31`, `video.py:40` | an upload staged in one worker is unknown to the other |
| Derived-asset queue and pending set | `server/routers/uploads.py:201-207`, `server/media.py:473` | duplicate or lost encodes |
| Startup and periodic tasks | `server/app.py:213-275` | every worker runs the cleanup loop, the requeue and `sweep_part_files`, which deletes `.part` files on the assumption that no encode is running |
| Rate limiters | `server/social/auth.py:403`, `server/security_headers.py:194`, `server/routers/map_tiles.py:136` | each limit becomes N times looser |
| Metrics, alert state, SSE stream counts | `server/metrics.py:37-42`, `server/routers/messages.py:940` | the Overview and the watchdog see one worker's share |
| Model config | `server/routers/config.py:26` | `PUT /api/config/models` changes one worker |
| TTL caches (`_scan_cache` and others) | `server/routers/reels.py:138` | harmless, but `invalidate_scan_cache` reaches one worker, so a new post can take 10 s to appear on the other |

**What it takes.** Run a second, read-only service from the same image: no lifespan jobs, no uploads, and only the anonymous-safe GET routes (`/api/reels`, `/api/reels/player`, `/api/reels/feed`, tags, locations, `/api/search/suggestions`, `/api/feed`, post and user reads). A proxy that can match on method and path has to sit in front, because cloudflared's ingress rules match on host and path only. The stateful process keeps jobs, uploads and every write. The rate limit on `/api/reels/feed` must then move out of process or be accepted as per-process.

**What it buys.** Two or three reader processes on the 4 vCPU box should give 2 to 3 times the read capacity. The local test gave 2.6 times with four workers on four free CPUs; the VPS also runs Postgres, cloudflared, ffmpeg and caption jobs.

## 3. Stalls

No multi-second pause of the whole process was reproduced locally. With `/api/reels` saturated at ten connections, `/api/healthz` stayed at p95 6 to 41 ms and at most 179 ms.

| Candidate | Evidence | Status |
|---|---|---|
| GIL convoy on the 40-thread pool | measured: p95 doubles at the same load against 3 threads; today's VPS max was 3.3 to 5.2 s at c=10 to 15 | measured; explains slow heavy requests, not slow light ones |
| Connection-pool wait above 15 busy requests | pool is 5 + 10 with a 30 s timeout; VPS p99 jumps at c=25 (player 8.2 s, max 9.9 s) | inferred |
| Garbage collection | measured: generation-2 collections pause up to 53 ms with 210,000 tracked objects, and total 8.5 ms per `/api/reels` request (13% of it) | measured; too short to explain seconds alone |
| In-process caption and encode work | `faster_whisper` runs inside the app process on CPU (`server/media.py:862-864`); ffmpeg encodes run as children at nice 10 | inferred; not measured |
| Periodic tasks | `_cleanup_loop` and `_alert_loop` run every step with `asyncio.to_thread` (`server/app.py:124-163`), so they do not block the event loop but do take the GIL | read, not measured |
| Metrics lock on the event loop | the access middleware calls `metrics.record_request` on the event loop (`server/observability.py:82`), which takes `metrics._lock`; the 60 s watchdog copies up to 50,000 samples under the same lock (`server/metrics.py:85`). Measured with a full deque and no contention: 2.9 ms under the lock, 31 ms for the whole window. A thread that loses the GIL while holding the lock would stretch that | measured without contention; not measured under load |
| Other blocking calls on the event loop | none found in the request path of the routes above; the middlewares are pure ASGI. Other routers were not read | partly read |
| Noisy neighbours on the VPS | steal time was not sampled | not checked |

## 4. Edge and network

- **Session start today:** `/` → JS and CSS → `/api/auth/me` (`web/src/hooks/AuthContext.jsx:12`), `/api/config`, `/api/billing/catalog` → `/api/reels` (`web/src/pages/ReelsPage.jsx:110`) and `/api/reels/player-inline` (`ReelsPlayer.jsx:122`) → first media request. Each stage costs a round trip of 230 to 270 ms from Asia. The request list is from the source; the staging and the list-with-player overlap are from the baseline doc (sections 4 and 9) and were not re-measured in a browser today.
- **Cacheable for anonymous visitors**, since the response does not depend on the viewer: `/api/reels` with default parameters, `/api/reels/tags`, `/api/reels/locations`, `/api/reels/locations/activity`, `/api/config`. A 30 to 60 s edge TTL removes the origin round trip and the server time for those requests. The cache must be bypassed when the session cookie is present. Whether the current Cloudflare plan allows a cookie condition in a Cache Rule was not checked.
- **Not cacheable:** `/api/reels/player`, `/api/reels/player-inline` and `/api/reels/feed`. Each response is a ranked page for one recommendation session, and it writes impressions.
- **ETags** save bytes, not round trips. On `/api/reels` an ETag would turn 37 KB into a 304 for repeat visits; it only pays once the list is cached, because today the server would rebuild the list to compute the tag.
- **Compression:** `/api/reels` (507 KB) and `/api/reels/player-inline` (401 KB) leave the origin uncompressed and are compressed at the edge. That costs no app CPU; only the iframe player gzips in the app.
- **Merging:** `/api/config` and the anonymous `/api/auth/me` answer could be inlined into the HTML, which removes one stage (about 250 ms from Asia). `/api/config` runs one DB query per request today.

## 5. The drop since 2026-10-30

VPS loopback at ten connections: `/api/reels` 5.6 → 4.8 rps, player 10.2 → 8.1, feed 12.1 → 10.7.

Running `09e32f0` (the 2026-10-30 code) and `4e05762` on the same data in the Linux image reproduces part of it:

| Route | `09e32f0` | `73058d7` | `fe34144` | `57057dd` | `78c69ff` | `4e05762` | Change |
|---|---|---|---|---|---|---|---|
| `/api/reels` | 57 ms | 93 | 60 | 59 | 61 | 62 | +8% |
| `/api/reels/tags` | 35 ms | 58 | 38 | 38 | 39 | 38 | +7% |
| `/api/reels/player` | 46 ms | 51 | 51 | 56 | 58 | 58 | +27% |
| `/api/reels/player-inline` | 53 ms | 55 | 51 | 52 | 53 | 54 | none |
| `/api/reels/feed` | 33 ms | 36 | 33 | 33 | 35 | 33 | none |

Every run returned all 203 reels. `09e32f0` and `4e05762` were run twice and agreed within 2 ms.

- `73058d7` (R2 as the only media store, 2026-10-31) added the per-file record lookups through `rel_path`. `fe34144` took most of that back; the `Path` slow path described above is what remains.
- The iframe player gained 5 ms at `73058d7`, 5 ms from origin gzip (`57057dd`) and 2 ms with captions (`78c69ff`).
- This accounts for the player (measured −20% on the VPS) and for about half of the `/api/reels` drop (−15%). The feed's drop (−12%) does not reproduce. The two VPS runs were twelve days apart and the production catalog also changed.

## 6. Fixes, ranked

Session-start capacity is from `README.md` section 5: 0.385 s of server time per session start with a feed page, 136 to 156 per minute.

| # | Fix | Expected gain | How estimated | Effort | Risk |
|---|---|---|---|---|---|
| 1 | Cache the viewer-independent reel records in process (10 s TTL, cleared by `invalidate_scan_cache`), and overlay the signed-in viewer's liked, saved and following sets. Cache the built anonymous `/api/reels` payload on top. | On a cache hit, anonymous `/api/reels` 144 → about 20 ms on the VPS (64 → 8 local); signed-in about 65 ms plus three small viewer queries (28 local, records cached, payload rebuilt). Tags, suggestions and activity fall 60 to 75%. This is a capacity gain: session start 0.385 → about 0.26 s, so about 230 per minute instead of 156. A lone visitor after a quiet 10 s still pays the full build unless the cache refreshes itself in the background. | measured what-ifs C and D, byte-identical bodies, scaled by 2.3 | 1 to 2 days | Medium: a post or comment can be up to 10 s stale; blocked-user and hidden-post filters must stay outside the cache |
| 2 | Cap the request threadpool (start at 4 to 6 threads), or put a limiter around the heavy list routes only. | Holds the one-connection rate under load: up to +30% on `/api/reels` at saturation (4.7 → 6.1 rps), and about half the p95. | measured locally (3.3 → 8.5 rps at c=10); VPS bound from its own c=1 rate | hours | Medium: sync handlers that block for long (uploads, media reads) share the pool, so a per-route limiter is safer than a global cap |
| 3 | Read-only second service behind a method-and-path proxy (section 2). | 2 to 3 times the read capacity; about 450 to 650 session starts per minute after fix 1. | measured locally (2.6 times with four workers); discounted for the other processes on the box | 3 to 5 days | Medium to high: new proxy hop, per-process rate limits, cache invalidation across processes |
| 4 | Cache the player template after its static substitutions, for both player routes; keep only the nonce and the two JSON blocks per request. | Iframe player 115 → about 95 ms on the VPS (11 of 58 ms local); inline player about −18 ms (8 of 53 ms local). Session start −0.02 s. | stage timers | half a day | Low |
| 5 | Edge-cache anonymous `/api/reels`, tags, locations and `/api/config` for 30 to 60 s, bypassed on the session cookie. | Anonymous visitors skip about 200 ms of round trip plus the server time on those requests; the origin sees one request per TTL per colo. | README round-trip figures | half a day, if the plan allows the rule | Medium: a wrong bypass rule would serve one viewer's state to another; only safe for responses with no viewer fields |
| 6 | Give `/api/reels` a limit and cursor, and stop embedding comments in the list. | Keeps the cost flat as the catalog grows: 0.7 ms and 2.5 KB per post on the VPS today. No gain at 203 posts beyond fix 1. | measured with half the catalog | 2 to 3 days, client changes in the SPA and the player | Medium: every consumer of the full list must page |
| 7 | Cache the recommendation candidate catalog for a few seconds. | Player and feed −10 to −15 ms each on the VPS. | profile share (about 15%), not a wall-clock test | 1 day | Low to medium |
| 8 | `gc.freeze()` after startup and a higher generation-0 threshold. | 5 to 10% less CPU on list routes; removes 50 ms pauses. | measured GC time, 13% of an uncached `/api/reels` | hours | Low |
| 9 | Pass strings to `rel_path`, or give it a `Path` fast path. | 6% on `/api/reels` (4 of 64 ms local). Mostly covered by fix 1. | measured what-if A | under an hour | Low |
| 10 | Load plain columns in `reel_records` instead of ORM entities (this also drops the second `users` join and `password_hash`). | About −25 ms on a cache miss for `/api/reels`, tags, suggestions and activity on the VPS (11 of 64 ms local). Only matters for misses once fix 1 is in. | measured: the five loads take 18.7 ms as entities and 7.4 ms as columns | 1 day | Low to medium: `serialize_creator` and the image helpers take ORM objects today |
| 11 | Move the origin to an APAC region. | 150 to 200 ms off every API request from Asia; more than any server fix gives a single uncached request. | baseline section 2 edge→origin table | days, plus a migration window | High: full redeploy; worse for US and Europe |

Order to do them in: 1, 2, 4, 8 and 9 are small and independent, and together take a session start to roughly 0.23 s. Then 5. Then 3 when one core is again the limit. Fix 6 before the catalog passes a few hundred posts.

## 7. Measured, inferred, not checked

**Measured**
- Production: per-route ceilings, the throughput drop with concurrency, app and Postgres CPU (`README.md`, `raw/loopback*.log`); queries per request from Sentry span counts.
- Local, deployed code in the Linux image: per-route times and query counts; the three-way split of `/api/reels`; cost per post; the player's stages; GC pauses; what-ifs for the `rel_path` fast path and for memoized records and payload, with unchanged response hashes; one against two and four workers; 40 against 3 threads; entity against column loads; the metrics lock without contention; six commits between 2026-10-30 and now.

**Inferred**
- Every production figure in the "Expected gain" column: local ratios scaled by 2.3.
- The worker gain on the VPS, the connection-pool wait at c=25, and captions or encodes as a stall source.
- Fix 7's gain, from a cProfile share. cProfile overstates call-heavy code (167 ms profiled against 80 ms real), so no other estimate uses it.

**Not checked**
- Multi-second stalls on the VPS: no py-spy, GC log or steal-time sample was taken there, because production was not to be loaded or touched.
- Postgres query plans and timings. Local runs used SQLite, so the split between query time and Python time on `reel_records` may differ on the VPS.
- `/api/reels/player-inline` under load on the VPS. The probes in `README.md` loaded the iframe route instead.
- Signed-in requests, which add three to four small queries for viewer state and cannot use an anonymous cache as is.
- Sentry SDK overhead (20% trace sampling, logs enabled); local runs had Sentry off.
- Cloudflare plan limits for cookie-based cache bypass.
- The unexplained part of the drop since 2026-10-30.
- A macOS run showed a larger regression (+38% on `/api/reels`) because `os.getcwd()` is slow there; it is not used above.

## 8. Implemented on `perf/bottlenecks`

Fixes 9, 2, 8, 4 and 1, in that order, branched from `dev` (`5437009`). Not deployed and not merged.

| Commit | Fix | Change |
|---|---|---|
| `4e06968` | 9 | `rel_path` answers `Path` arguments on its fast path. |
| `379e959` | 2 | The ten heavy list routes share two slots (`server/read_limit.py`, `SX_HEAVY_READ_CONCURRENCY`). A request waits on the event loop, so it holds no thread and no other route queues behind it. The threadpool itself is unchanged. |
| `cc45b90` | 8 | The startup heap is frozen and the generation-0 threshold raised to 10,000. |
| `81c5d1d`, `5aac76b` | 4 | Both player routes prepare the template once per version of the template, icons and vendored scripts. |
| `12b8dc8`, `652d3d8` | 1 | Viewer-independent reel records and payload entries are kept for up to 10 s; each signed-in viewer's likes, saves, follows, blocks and comment state are laid over a copy. |

**How the downsides were handled**
- **Staleness:** a commit that changes a post, comment, user, tag or slide drops the cache at once, so a new post or like shows on the next request. Only view counts wait for the 10 s TTL. Writes that bypass the ORM session would also wait for the TTL.
- **One viewer seeing another's state:** nothing viewer-specific is cached. Blocks and hidden posts are applied per request, outside the cache.
- **Starving light routes:** the limit covers the list routes only; uploads and light routes keep the full threadpool.

**Verification**
- **Tests:** `pytest tests` passes with 862 passed and 13 skipped, against 842 and 13 on `dev`. The 20 new tests cover each fix.
- **Same responses:** on the 203-post database, `/api/reels` (three parameter sets), a tag page, tag and location suggestions and search suggestions hash identically on `dev` and the branch, for an anonymous visitor and for seven signed-in viewers chosen for their likes, saves, follows and blocks, called in an interleaved order. Location activity could not be compared this way: its scores decay with the clock and differ between two runs of `dev`.
- **Player template:** a test asserts the prepared template plus nonce equals the old per-request build byte for byte.

**Measured, in the app image (Linux, Python 3.12, SQLite), `dev` → branch**

Median of 20 requests through the full stack, one at a time:

| Route | `dev` | Branch |
|---|---|---|
| `/api/reels` | 71 ms | 7 ms |
| `/api/reels/tags` | 44 ms | 8.5 ms |
| `/api/reels/locations/activity` | 55 ms | 19 ms |
| `/api/search/suggestions?q=a` | 51 ms | 15 ms |
| `/api/reels/player-inline` | 69 ms | 35 ms |
| `/api/reels/player` | 72 ms | 44 ms |
| `/api/reels/feed` | 34 ms | 27 ms |

Under one uvicorn worker, requests per second at 1, 4 and 10 connections:

| Route | `dev` | Branch |
|---|---|---|
| `/api/reels` | 13.3, 6.4, 4.0 | 251, 239, 245 |
| `/api/reels/player-inline` | 13.9, 11.8, 7.0 | 29.2, 29.6, 29.9 |
| `/api/reels/tags` | 20.7, 11.7, 7.2 | 175, 177, 178 |

Throughput no longer falls as connections rise. These rates are for a warm cache under steady load; the first request after a quiet 10 s or after a write still pays the full build.

**Not done**
- Fix 10 (plain-column loads): with the records cached it only shortens a cache miss, so the refactor risk no longer pays.
- Fix 7 (recommendation catalog cache): not started. The recommendation step is now most of what is left in the feed and both player routes.
- Fixes 3, 5, 6 and 11 need infrastructure or product decisions.

**Not verified**
- Nothing was run on the VPS or against Postgres. The expected production gain is still the local ratio.
- Signed-in requests were checked for correctness, not timed.
- No browser check of `/reels` on the branch.
