# Less Waste in `_pipeline_context` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `_pipeline_context` from querying for answers already known, so a first-time visitor's reel page runs about 2 context queries instead of about 11, with the same ranking.

**Architecture:** Two flags, `fresh_session` and `fresh_actor`, flow from the route through `get_reel_page` and `_materialize_reel_page` into `_pipeline_context`. They skip queries that are certainly empty. Queries over an empty `IN` list are skipped. `PostRecommendationStats` moves to a 30 s process cache shaped like `_recent_stats`.

**Tech Stack:** Python, FastAPI, SQLAlchemy ORM, pytest (SQLite), local Postgres 16 for the profile.

**Spec:** `docs/superpowers/specs/2026-11-24-pipeline-context-waste-design.md`

## Global Constraints

- Rankings unchanged. The only allowed difference is post stats up to `RECENT_STATS_TTL_S` (30 s) old.
- Only a fresh *actor* (anonymous cookie minted in this request) skips affinity. Empty item affinity alone never does: follows write creator-affinity rows without item rows.
- Signed-in viewers are never fresh actors.
- `rank_pool` and every other caller pass no flags and behave as today. Both flags default to `False`.
- No page or ranking cache across viewers.
- Run python with `PYTHON_DOTENV_DISABLED=1`. Test command prefix: `PYTHON_DOTENV_DISABLED=1 .venv/bin/python -m pytest`.
- Commits carry no Co-Authored-By or "Generated with" trailer. Never commit `.claude/launch.json`.

## Review Focus

1. A signed-in viewer whose browser has no anonymous cookie: not fresh, affinity and follows still read. Test in Task 3.
2. A forged or badly signed anonymous cookie: treated as absent, so a new cookie is minted and the actor is fresh (its key is new). Test in Task 3.
3. A restarted session (filters changed, expired cursor): the new session is fresh. Its first page must not repeat the old session's last page any more than today (delivered was always per session). Test in Task 2.
4. A post created inside the 30 s stats window: absent from the cache, so `stats.get` gives `None` and `stats_quality` uses its defaults. That is the same as a post with no stats row today. Test in Task 1.
5. A returning anonymous viewer with dismissals: dismissals still apply. Only a fresh actor skips the dismissal read. Test in Task 3.

---

### Task 1: Cache `PostRecommendationStats` for 30 s

**Files:**
- Modify: `server/social/recommendations/service.py` (next to `_recent_stats`, ~line 524; the `stats = {...}` block in `_pipeline_context`, ~line 702)
- Modify: `tests/conftest.py` (`_fresh_recent_stats`, ~line 136)
- Create: `tests/test_recommendation_context_waste.py`

**Interfaces:**
- Produces: `class PostStats(NamedTuple)` with fields `impressions, qualified_views, completions, skips, fast_skips, likes, saves, shares, negative_feedback, total_watch_ms` (all `int`), in service.py.
- Produces: `_post_stats_cache: dict = {"entry": (0.0, {})}` and `_post_stats(db: Session) -> dict[str, PostStats]`. It reads every row's plain columns (no entities, no `IN`), keeps them for `RECENT_STATS_TTL_S` by `time.monotonic()`, then rereads.
- `_pipeline_context` builds `stats = {pid: all_stats[pid] for pid in post_ids if pid in all_stats}` from `_post_stats(db)` when `post_ids` is non-empty, else `{}`. `PipelineContext.stats` is already typed `dict[str, object]`. Readers use `getattr` and `.get` (ranking.py:47, 117; sources.py:192, 227), so they need no change.
- `_catalog_pool_order` keeps its own read. It is out of scope.

- [ ] **Step 1: Write the failing tests** in `tests/test_recommendation_context_waste.py`. Copy the `db` fixture from `tests/test_recommendation_catalog_cache.py:24-50` (SQLite, users, posts p0–p7, query listener on `session.queries`). Add `PostRecommendationStats(post_id="p1", impressions=40, qualified_views=12, likes=3)` to it.

```python
def stats_queries(db):
    return [sql for sql in db.queries if "FROM post_recommendation_stats" in sql]

def context(db, **flags):
    actor = actor_identity(None, "anon")
    return service._pipeline_context(
        db, actor=actor, session=None, surface="for_you", seed_post_id=None,
        allowed_post_ids=None, manual_order=None, **flags,
    )

def test_post_stats_are_read_once_per_ttl(db, monkeypatch):
    first = context(db)
    assert first.stats["p1"].impressions == 40 and first.stats["p1"].likes == 3
    assert len(stats_queries(db)) == 1
    context(db)
    assert len(stats_queries(db)) == 1
    clock = time.monotonic() + service.RECENT_STATS_TTL_S + 1
    monkeypatch.setattr(service.time, "monotonic", lambda: clock)
    context(db)
    assert len(stats_queries(db)) == 2

def test_post_without_stats_row_scores_like_today(db):
    ctx = context(db)
    assert "p2" not in ctx.stats
    assert stats_quality(ctx.stats.get("p2"), 0, 0) == stats_quality(None, 0, 0)
```

(`stats_quality` is from `server.social.recommendations.ranking`.)

- [ ] **Step 2: Run the tests and see them fail**

Run: `PYTHON_DOTENV_DISABLED=1 .venv/bin/python -m pytest tests/test_recommendation_context_waste.py -q`
Expected: `test_post_stats_are_read_once_per_ttl` fails on the second count (2 stats queries, expected 1).

- [ ] **Step 3: Implement `PostStats`, `_post_stats` and its use in `_pipeline_context`.** Add `service._post_stats_cache["entry"] = (0.0, {})` to the conftest `_fresh_recent_stats` fixture and widen its docstring to cover post stats.

- [ ] **Step 4: Run the new tests and the recommendation suites**

Run: `PYTHON_DOTENV_DISABLED=1 .venv/bin/python -m pytest tests/test_recommendation_context_waste.py tests/test_recommendations.py tests/test_recommendation_catalog_cache.py tests/test_recommendation_rerank.py tests/test_recommendation_relatedness.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/social/recommendations/service.py tests/conftest.py tests/test_recommendation_context_waste.py
git commit -m "perf(recs): cache post recommendation stats for 30 s"
```

---

### Task 2: Skip empty `IN` reads and session reads for a fresh session

**Files:**
- Modify: `server/social/recommendations/service.py`: `_pipeline_context` (~550), `_materialize_reel_page` (~1058), `get_reel_page` (~937)
- Test: `tests/test_recommendation_context_waste.py`

**Interfaces:**
- Consumes: Task 1's `context(db, **flags)` test helper.
- Produces: `_pipeline_context(..., fresh_session: bool = False)` and `_materialize_reel_page(..., fresh_session: bool = False)`.
- `get_reel_page` computes `fresh_session = not cursor or restarted` after `_resolve_session`. No cursor, or a restart, always means `_new_session` built this session. It passes the flag to `_materialize_reel_page`, which passes it on. The replay paths do not take it.
- With `fresh_session=True` and a session given, skip and set empty: `delivered`, `session_events` (and so `event_posts`), `exposures`. `session_id` in the context stays `session.id`.
- Empty-`IN` skips, independent of the flags:
  - the negative item-affinity read when `post_ids` is empty;
  - creator affinity when `owner_ids` is empty;
  - tag affinity when `tag_ids` is empty;
  - `event_posts` when `event_post_ids` is empty.

  Each becomes the empty result with no query. Drop the `... if x else False` filter arms they replace.

- [ ] **Step 1: Write the failing tests**

```python
def new_session(db, actor):
    return service._new_session(db, actor=actor, surface="for_you", seed_post_id=None,
                                filters={}, algorithm_version=service.REELS_ALGORITHM_VERSION)

def tables(db):
    return " ".join(db.queries)

def test_fresh_session_reads_no_impressions_or_events_and_matches_full(db):
    actor = actor_identity(None, "anon")
    session = new_session(db, actor); db.flush()
    full = service._pipeline_context(db, actor=actor, session=session, surface="for_you",
        seed_post_id=None, allowed_post_ids=None, manual_order=None)
    db.queries.clear()
    lean = service._pipeline_context(db, actor=actor, session=session, surface="for_you",
        seed_post_id=None, allowed_post_ids=None, manual_order=None, fresh_session=True)
    assert dataclasses.replace(lean, now=full.now) == full
    assert "FROM recommendation_impressions" not in tables(db)
    # Only the watched read remains: the actor is not fresh in this task.
    assert len([sql for sql in db.queries if "FROM engagement_events" in sql]) == 1
    assert "FROM posts" not in tables(db)  # event_posts skipped

def test_restarted_session_is_fresh(db, monkeypatch):
    # get_reel_page passes fresh_session=True for no cursor and for a restart, False for a resumed cursor.
    seen = []
    real = service._materialize_reel_page
    monkeypatch.setattr(service, "_materialize_reel_page",
                        lambda *a, **k: seen.append(k["fresh_session"]) or real(*a, **k))
    actor = actor_identity(None, "anon")
    page = service.get_reel_page(db, actor=actor, filters={"a": 1}, limit=2)
    service.get_reel_page(db, actor=actor, filters={"a": 1}, limit=2, cursor=page.next_cursor)
    service.get_reel_page(db, actor=actor, filters={"a": 2}, limit=2, cursor=page.next_cursor)
    assert seen == [True, False, True]
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `PYTHON_DOTENV_DISABLED=1 .venv/bin/python -m pytest tests/test_recommendation_context_waste.py -q`
Expected: FAIL, because `fresh_session` is an unexpected keyword.

- [ ] **Step 3: Implement the flag plumbing and the skips described in Interfaces.**

- [ ] **Step 4: Run the new tests and the recommendation suites** (same command as Task 1 Step 4). Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/social/recommendations/service.py tests/test_recommendation_context_waste.py
git commit -m "perf(recs): skip session and empty-IN reads that are known empty"
```

---

### Task 3: Skip actor reads for a fresh actor

**Files:**
- Modify: `server/social/auth.py` (next to `ensure_anonymous_cookie`, ~line 338)
- Modify: `server/routers/reels.py` (~1984 and the `get_reel_page` call ~2003)
- Modify: `server/social/recommendations/service.py`: `get_reel_page`, `_materialize_reel_page`, `_pipeline_context`, `_catalog` (~480), `_long_tail_ids` (~388)
- Test: `tests/test_recommendation_context_waste.py`, `tests/test_recommendations.py`

**Interfaces:**
- Consumes: Task 2's flag plumbing pattern.
- Produces: `has_anonymous_cookie(request: Request) -> bool` in auth.py: `_verify_anon_cookie(request.cookies.get(ANON_COOKIE)) is not None`.
- Route: before `ensure_anonymous_cookie`, `fresh_actor = not viewer_id and not has_anonymous_cookie(request)`, passed as `get_reel_page(..., fresh_actor=fresh_actor)`.
- `get_reel_page(..., fresh_actor: bool = False)` → `_materialize_reel_page(..., fresh_actor: bool = False)` → `_pipeline_context(..., fresh_actor: bool = False)`.
- With `fresh_actor=True`, skip and set empty:
  - item affinity (`item_rows = []`; `seed_ids` then holds only `seed_post_id`, if any);
  - creator affinity, tag affinity;
  - `watched_post_ids`;
  - follows (already skipped for anonymous viewers).
- Two more skips are an implementation call, not in the spec's list. They follow its rule that a fresh actor has no rows anywhere:
  - `_catalog(..., fresh_actor: bool = False)` skips `_active_dismissals` and uses `(set(), set())`;
  - `_long_tail_ids(..., fresh_actor: bool = False)` skips the `top_creators` read and uses `[]`.

- [ ] **Step 1: Write the failing tests**

In `tests/test_recommendation_context_waste.py`:

```python
AFFINITY = ("FROM actor_item_affinity", "FROM actor_creator_affinity", "FROM actor_tag_affinity",
            "FROM engagement_events", "FROM recommendation_dismissals", "FROM follows")

def test_fresh_actor_reads_no_actor_rows_and_matches_full(db):
    actor = actor_identity(None, "brand-new")
    full = context_for(db, actor)
    db.queries.clear()
    lean = context_for(db, actor, fresh_actor=True)
    assert dataclasses.replace(lean, now=full.now) == full
    assert not [t for t in AFFINITY if t in tables(db)]

def test_creator_affinity_from_a_follow_survives_without_the_flag(db):
    actor = actor_identity(None, "follower")
    db.add(ActorCreatorAffinity(actor_key=actor.actor_key, creator_id="bob", score=5.0,
                                last_event_at=START)); db.flush()
    assert context_for(db, actor).creator_affinity["bob"] > 0

def test_dismissals_still_apply_to_a_returning_actor(db):
    actor = actor_identity(None, "returning")
    db.add(RecommendationDismissal(actor_key=actor.actor_key, post_id="p3", ...)); db.flush()
    assert "p3" not in context_for(db, actor).items
```

`context_for(db, actor, **flags)` is the Task 1 `context` helper with the actor as a parameter. Fill the `RecommendationDismissal` fields from its model; `test_recommendation_catalog_cache.py` already builds one.

In `tests/test_recommendations.py`, using the `app` fixture and the route used by `test_inline_player_bootstraps_only_first_page_and_preserves_anonymous_cookie`:

```python
def test_only_a_cookieless_anonymous_request_is_a_fresh_actor(app, monkeypatch):
    seen = []
    real = reels.get_reel_page
    monkeypatch.setattr(reels, "get_reel_page", lambda *a, **k: seen.append(k["fresh_actor"]) or real(*a, **k))
    client = TestClient(app)
    client.get(ROUTE)                                   # no cookie: fresh
    client.get(ROUTE)                                   # cookie set by the first: not fresh
    client.cookies.set(ANON_COOKIE, "forged.value")
    client.get(ROUTE)                                   # bad signature: fresh
    register(client, "sam"); client.get(ROUTE)          # signed in: never fresh
    assert seen == [True, False, True, False]
```

Adjust `ROUTE` and the forged-cookie step to the names used there. If `register` leaves the anonymous cookie in place, the last call still must be `False` because `viewer_id` is set.

- [ ] **Step 2: Run the tests and see them fail**

Run: `PYTHON_DOTENV_DISABLED=1 .venv/bin/python -m pytest tests/test_recommendation_context_waste.py tests/test_recommendations.py -k "fresh or follow or dismissals" -q`
Expected: FAIL, because `fresh_actor` is an unexpected keyword.

- [ ] **Step 3: Implement `has_anonymous_cookie`, the route change, and the flag plumbing and skips described in Interfaces.**

- [ ] **Step 4: Run the full test suite**

Run: `PYTHON_DOTENV_DISABLED=1 .venv/bin/python -m pytest -q`
Expected: all pass. Any failure that also happens on `format-all` without these changes is pre-existing. Note it and do not fix it.

- [ ] **Step 5: Commit**

```bash
git add server/social/auth.py server/routers/reels.py server/social/recommendations/service.py tests/test_recommendation_context_waste.py tests/test_recommendations.py
git commit -m "perf(recs): skip actor reads for a first-time anonymous visitor"
```

---

### Task 4: Re-profile and record

**Files:**
- Modify: `docs/perf-probes/2026-11-22/README.md` (profile section)

**Interfaces:**
- Consumes: the scratchpad script `pgss_run.sh <label>`. It starts a fresh `pi-pg` Postgres 16 container (128MB shared_buffers, pg_stat_statements), runs `profile_inline.py` against the working tree, and writes `<label>.txt`, `<label>.pgss` and `inline-<label>.prof`. Baseline: `head6c3.txt`, `head6c3.pgss`, `inline-head6c3.prof` in the same folder (HEAD `6c3720e`, median 47.5 ms, `_pipeline_context` 16.05 ms).

- [ ] **Step 1: Run the profile**

Run: `bash <scratchpad>/prof/pgss_run.sh lean`
Expected: a `median=` line for `/api/reels/player-inline`, lower than 47.5 ms.

- [ ] **Step 2: Compare.** Use `pstats` on `inline-lean.prof` against `inline-head6c3.prof`: `_pipeline_context` cumulative ms per request, and statement calls per request from `lean.pgss` against `head6c3.pgss`. Pass: `_pipeline_context` is clearly below 16 ms. No `actor_*_affinity`, `recommendation_impressions` (SELECT), `engagement_events` or `recommendation_dismissals` SELECTs appear at about 1 call per request. Each request is cookieless, so all of them are fresh.

- [ ] **Step 3: Record** a short "Less waste in `_pipeline_context`" subsection in the README profile section: before and after median and p95, `_pipeline_context` ms, and the query count per request. Say the numbers come from a local Postgres 16 profile, not prod.

- [ ] **Step 4: Clean up** with `docker rm -f pi-pg`.

- [ ] **Step 5: Commit**

```bash
git add docs/perf-probes/2026-11-22/README.md
git commit -m "docs(perf): profile after cutting _pipeline_context waste"
```

Deploying to prod and re-probing is a separate request. It is not part of this plan.
