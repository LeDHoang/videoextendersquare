# Less waste in `_pipeline_context`

Short design. Small change.

## Intent

`_pipeline_context` (server/social/recommendations/service.py) gathers every
input the ranker needs. It runs about 11 queries on every request. The local
profile of HEAD `6c3720e` puts it at 16 ms of a 47.5 ms player-inline request.
Postgres spends 0.01–0.1 ms on each statement; the rest is round trips and ORM
work on the app side. Many of those queries have a result we already know.

Goal: stop asking the database questions whose answer is known. Rankings stay
the same.

## Goals

- First-time visitor (anonymous cookie minted in this request, session created
  in this request): about 11 queries drop to about 2.
- Every viewer: no round trip for an `IN` over an empty list.
- `PostRecommendationStats` (global per-post counters) is read once per 30 s,
  not on every request.

## Non-goals

- Restoring the 11-12 throughput figures.
- Merging queries or rewriting reads as Core rows (approach 2).
- Changing the flush/commit of requests and impressions.

## Anti-goals

- Any difference in what a viewer is shown, beyond stats up to 30 s old.
- Caching pages or rankings across viewers (approach 3).

## Approaches

1. **Skip what is known to be empty. Picked.** Flags for a fresh session and a
   fresh actor skip the queries they make certain to be empty. Skip any query
   whose `IN` list is empty. Cache `PostRecommendationStats` next to
   `_recent_stats`. About 30 lines. Est. 7–8 ms off a cold open (~15%),
   2–3 ms off a returning viewer. Estimates, not measured.
2. Approach 1 plus merged reads: delivered and exposures in one impressions
   read, the three affinity tables in one `UNION ALL` of Core rows. About
   2 ms more for returning viewers. More code touched. Not now.
3. Cache the whole first page for fresh anonymous visitors, like `_grid_cache`.
   Largest win, but every new visitor sees the same first page for the TTL.
   That is a behavior change, not less waste. Rejected.

## Design

**Fresh session.** `get_reel_page` knows whether `_resolve_session` created the
session in this request (no cursor, or a restart). It passes
`fresh_session=True` to `_materialize_reel_page`, which passes it on to
`_pipeline_context`. A session created this request has no impressions and no
events, so these are skipped and set empty:

- delivered post ids (impressions by session)
- exposures by creator (impressions joined to posts)
- session events, and the event-posts read that follows them

The session-events query also matches actor events since `session.created_at`.
For a session created in this request that window is milliseconds long. An
event landing in it is missed for this one page only. Accepted.

**Fresh actor.** The route learns whether `ensure_anonymous_cookie` minted the
cookie in this request (a small helper or return flag in server/social/auth.py;
builder's call which). Signed-in viewers are never fresh. A fresh actor's key
is new and random, so it has no rows anywhere. Skipped and set empty:

- item affinity and the negative item-affinity read
- creator affinity, tag affinity
- watched post ids
- follows (already skipped for anonymous viewers)

Only a fresh *actor* may skip affinity. Empty item affinity is not enough:
follows write creator-affinity rows without item rows (events.py).

**Empty `IN`.** Where code now does `X.in_(ids) if ids else False` and still
runs the query, skip the query and use the empty result.

**Stats cache.** `PostRecommendationStats` rows for the catalog are cached for
`RECENT_STATS_TTL_S` (30 s), the same way `_recent_stats` is. Cached as plain
values, not ORM objects. Effect: popularity and quality scores can lag by up to
30 s. Trending already lags the same way.

`rank_pool` passes neither flag and behaves as today.

## Tests

- For a fresh session and fresh actor, the context built with the flags equals
  the context built without them (stats cache cleared), field by field.
- A returning actor with only creator affinity (from a follow) keeps it.
- Query count for a fresh player-inline request drops to the expected number.
- Existing recommendation tests pass.

## Verify

Rerun `pgss_run.sh` (local Postgres 16, the profile_inline.py harness) and
compare against the HEAD profile: median wall, `_pipeline_context` cumulative
ms, statement calls per request.

## Left to the builder

- The exact shape of the "cookie minted" signal.
- Where the stats cache lives and how it is keyed (catalog store or post ids).
