# Recommendation Coverage and Lean Relatedness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the signal gaps in `reels-heuristic-v1`, add text, location and same-creator relatedness without a model, and route Following, filtered For You, the grids, VR tile taps and the long tail through personalized ranking.

**Architecture:** Everything stays inside the in-process heuristic pipeline in `server/social/recommendations/`: catalog → `PipelineContext` → candidate sources → RRF + linear rank → `rerank_page`. New sources read precomputed per-item text tokens and locations from the cached catalog base. New surfaces reuse the pipeline: a pool mode for filtered sets and grids, a recency blend for Following, and catalog "extra ids" for the long tail and VR scopes.

**Tech Stack:** Python 3 / FastAPI / SQLAlchemy, pytest with SQLite fixtures, plain JS in `ui/assets/reels.html` and `ui/assets/vr_shell.js`.

**Spec:** `docs/superpowers/specs/2026-11-13-recommendation-coverage-design.md`

## Global Constraints

- All work goes on the branch `recommendation-engine-update`, cut from `dev`. Merge back only when the user says so.
- Commit messages carry no `Co-Authored-By` or "Generated with" trailer.
- Commit at the end of each workstream (A, B, C) or when asked, not after every task. The "Commit" steps below mark the points where committing is allowed.
- Run tests with: `PYTHON_DOTENV_DISABLED=1 .venv/bin/python -m pytest <target> -v`.
- No ML or embedding model. No file reads or model calls on the ranking hot path.
- Filtered and Following feeds must return the same *set* of reels as today. Only the order changes.
- In Following, recency still leads. New reels from followed creators must not be buried under old ones.
- Algorithm version becomes `reels-heuristic-v2`, bumped once at the end of workstream B.

## Spec deviations (decided while planning; tell the user)

Where the spec and this list disagree, this list wins. Amend the spec to match once the user approves the plan.

1. **C3 grid paging is keyset, not offset.** `/api/reels` pages with a cursor carrying the last item's key. The `for_you` key is `(rank_index, -mtime, rel_path)`. The cursor carries the 10-minute `seed` bucket, as `shuffle` already does, so pages after the first use the same cached ranking.
2. **C3 anonymous grid is not cookie-personalized.** Anonymous `/api/reels` responses are edge-cached by URL (`server/edge_cache.py`) and must not vary by cookie. Anonymous viewers get one shared, non-personal ranking (quality, freshness, exploration) from a fixed actor key `grid:anonymous`. Signed-in viewers get personal ranking; their responses are already `private, no-store`.
3. **C5: no age cutoff (user's decision, 2026-11-13).** Old reels are penalized by age in tiers instead of being cut off: small within 3 months, more within 6 months, more within a year, most after that. The per-request pool is no longer "newest 1000": it is the newest half plus the best-performing older posts of any age. Personal long-tail picks add older posts from creators and tags the viewer likes. It all runs on the cached in-memory catalog; the only new queries are the unrestricted top-20 creator and tag affinities and the seeds' `ItemSimilarity` rows.
4. **B3: the opened reel's creator has no hard cap on related pages (user's decision, 2026-11-13).** The 3-per-creator cap is lifted for that one creator on the related surface only. The soft penalties still apply: −0.45 per reel already on the page and −2.5 for back-to-back. So more of that creator can show when they score well, spread out rather than stacked. Other creators keep the hard cap. Reels from related creators are welcome as before.
5. **C1 scales the following score by 4.0 before the rerank.** This keeps the existing 0.45-per-creator and 2.5 back-to-back penalties in proportion. Watched reels are a separate partition after all unwatched ones, not a score offset.
6. **C4: the client rotates the list.** The client sends `scope_ids` already starting at the tapped reel. The server keeps that order and does not rotate.

## Review Focus

1. **Replay of a materialized page.** The same cursor requested twice (refresh, retry) when the page holds long-tail, past-cap or `scope_ids` posts should return identical ids. Today `_replay_reel_page` re-checks eligibility through the capped catalog and would drop them. Test: Task 8.
2. **Seeds missing from the catalog.** On page 2 and later the opened reel was already delivered, so it is excluded from `context.items`. A seed can also sit past the cap. Text and location relatedness should still work. Test: Task 5.
3. **Anonymous grid with different cookies.** `/api/reels?sort=for_you&limit=24` should return a byte-identical body with `public` cache headers for two different anonymous cookies. Test: Task 12.
4. **Degenerate text.** Empty title and caption, all-stopword captions, and one caption shared by every post should give no division by zero and no spurious `text_related` hits. Test: Task 5.
5. **Junk `scope_ids`.** Unknown, hidden or duplicate ids, more than 200 ids, or a list without the tapped id should be dropped or capped silently, with no 500. Test: Task 13.

---

## File structure

| File | Responsibility |
|---|---|
| `server/social/geo.py` (create) | `CITY_COORDS`, `location_key`, `location_coords`, `haversine_km`, moved from `server/routers/reels.py`. The router imports them under its old private names. |
| `server/social/recommendations/relatedness.py` (create) | Pure functions: `tokenize`, `build_idf`, `tfidf_vector`, `cosine`, `location_score`, `text_scores`, `location_scores`, `block_diverse`. No DB access. |
| `server/social/recommendations/types.py` | `PostLocation`, new `CatalogItem` and `PipelineContext` fields. |
| `server/social/recommendations/config.py` | New source weights, `FOLLOWING_*` constants, version bump, grid and long-tail constants. |
| `server/social/recommendations/sources.py` | `TextRelatedSource`, `LocationRelatedSource`, `CreatorOtherReelsSource`, `ScopePoolSource`, and the source selection in `gather_source_hits`. |
| `server/social/recommendations/ranking.py` | Following blend, `rerank_page(explore, preselected)`, reason keys. |
| `server/social/recommendations/service.py` | Catalog fields and extras, A3 session events, watched ids, long tail, sessionless `rank_pool`, `rank_grid` with cache, `pool_only` in `get_reel_page`. |
| `server/routers/reels.py` | C2 pool mode, C3 `sort=for_you` grid, C4 `scope_ids`. |
| `server/routers/social.py`, `server/routers/messages.py` | A2 allowlist, A1 event rename. |
| `ui/assets/reels.html`, `ui/assets/vr_shell.js` | A2 replay emit, C4 tile tap through the recommender, C3 VR sort switch. |
| `tests/test_recommendations.py` | All new server tests unless noted. |
| `tests/test_recommendation_relatedness.py` (create) | Pure-function tests for `relatedness.py`. |

---

## Workstream A — Signal fixes

### Task 1: A1 — DM share records `share_sent`

**Files:**
- Modify: `server/routers/messages.py:573-581`
- Test: `tests/test_recommendations.py`

**Interfaces:**
- Produces: DM reel shares stored as `EngagementEvent(event_type="share_sent", client_event_id=f"share:{row.id}", source="messages")`.

- [ ] **Step 1: Write the failing test** `test_dm_share_records_share_sent_and_moves_affinity`
  - Register a sender and a recipient. Seed one post with `seed_catalog(app, creators=1, posts_per_creator=1)`.
  - POST `/api/messages/share-content` with `{"kind": "reel", "target_id": post.id, "usernames": [recipient], "note": "", "client_id": "t1"}` and CSRF headers. Copy an existing share test in `tests/test_messaging.py` for the body shape the route accepts.
  - Assert exactly one `EngagementEvent` with `event_type == "share_sent"` and `post_id == post.id`.
  - Assert no `reel_share_message` row exists.
  - Assert `ActorItemAffinity` for `(f"u:{sender_id}", post.id)` and `ActorCreatorAffinity` for the post's owner are both `> 0`. Use the actor key format from `actor_identity`.

- [ ] **Step 2: Run it.** `PYTHON_DOTENV_DISABLED=1 .venv/bin/python -m pytest tests/test_recommendations.py::test_dm_share_records_share_sent_and_moves_affinity -v`. Expected: FAIL; the event type is `reel_share_message`.

- [ ] **Step 3: Change `event_type="reel_share_message"` to `event_type="share_sent"`.** Keep every other argument. Leave `pack_share_message` alone.
  - Nothing else should be needed. `contribution_allowed` (`events.py:290`) lets an event with no impression count up to `SX_EVENT_DAILY_CAP` (default 5) times per actor, post and day. `events.py:168` already handles `share_sent`.

- [ ] **Step 4: Run it and `tests/test_messaging.py`.** Expected: PASS.

### Task 2: A2 — `replay` event

**Files:**
- Modify: `server/routers/social.py:1470` (allowlist), `ui/assets/reels.html` (the `'ended'` handler, ~line 6926)
- Test: `tests/test_recommendations.py`, `tests/test_player_template.py`

**Interfaces:**
- Produces: `/api/events` accepts `event_type="replay"`.

- [ ] **Step 1: Write the failing server test** `test_replay_event_counts_once_per_impression`
  - Get a for_you page as a signed-in user and take the first item's `recommendation.impression_id`.
  - POST `/api/events` twice with `event_type="replay"`, that `post_id` and `recommendation_impression_id`, using different `client_event_id`s.
  - Assert both return 2xx.
  - Assert the `ActorItemAffinity` score after both posts equals the score after the first post.
  - Assert the score after the first post is greater than before.

- [ ] **Step 2: Run it.** Expected: FAIL with 422 `INVALID_EVENT`.

- [ ] **Step 3: Add `"replay"` to `allowed` in `create_event`.** The once-per-impression dedupe already exists: `contribution_allowed` (`events.py:290`) lets an event type count once per (actor, post, impression). `EVENT_WEIGHTS["replay"] = 2.0` is already set.

- [ ] **Step 4: Emit it from the player.** In the `'ended'` handler's `else` branch (loop, not auto-next), before `startViewTracking`, call the same `requestJson('/api/events', …)` shape the share event uses (~line 5009):
  - `event_type: 'replay'`, `post_id`, `pack_id`, `source: analyticsSource`, `client_event_id: eventId()`, `recommendation_impression_id: recommendationImpressionId(item)`, `client_occurred_at`.
  - Send it at most once per item per impression. Keep a `Set` of `impressionId || post_id` keys already sent. Skip items without a `post_id`. Swallow errors with `.catch(() => {})`.

- [ ] **Step 5: Add a template assertion** to `tests/test_player_template.py`, in the style of its existing string checks: the served `reels.html` contains `event_type: 'replay'`.

- [ ] **Step 6: Run** `tests/test_recommendations.py::test_replay_event_counts_once_per_impression` and `tests/test_player_template.py`. Expected: PASS.

### Task 3: A3 — session context includes unattributed events

**Files:**
- Modify: `server/social/recommendations/service.py:419-460` (`_pipeline_context` session events)
- Test: `tests/test_recommendations.py`

**Interfaces:**
- Produces: `session_creator_affinity` and `session_tag_affinity` also count the actor's events that have `recommendation_session_id IS NULL` and `created_at >= session.created_at`.

- [ ] **Step 1: Write the failing test** `test_session_context_counts_unattributed_likes`
  - Seed 4 creators × 3 posts.
  - Sign in and fetch for_you page 0 (`limit=2`).
  - Like a post by `creator_3` through the normal like endpoint without an impression header, so the event has no session id.
  - Call `service._pipeline_context` for the same session: look up the session by actor and surface, then build the context.
  - Assert `context.session_creator_affinity[creator_3.id] == 2.0`.
  - Then add an `EngagementEvent(event_type="like", recommendation_session_id=<another session id>, …)` for a post of `creator_2` and rebuild. Assert `creator_2.id` is not in `session_creator_affinity`.

- [ ] **Step 2: Run it.** Expected: FAIL with `KeyError` or 0.

- [ ] **Step 3: Extend the query.**
  - Keep the session-id filter OR (`recommendation_session_id IS NULL` AND the actor's column matches AND `created_at >= session.created_at`).
  - The actor's column is `user_id == actor.user_id` when signed in, else `anonymous_id == actor.anonymous_id`.
  - Keep `post_id IS NOT NULL`, the `created_at desc` order, `limit(100)` and the same `event_values`.

- [ ] **Step 4: Run** the test and the whole `tests/test_recommendations.py`. Expected: PASS.

- [ ] **Step 5: Commit workstream A.**
```bash
git add server/routers/messages.py server/routers/social.py server/social/recommendations/service.py ui/assets/reels.html tests/test_recommendations.py tests/test_player_template.py
git commit -m "feat(recs): emit share_sent and replay, count unattributed session events"
```

---

## Workstream B — Relatedness sources

### Task 4: Catalog text tokens and locations, shared geo helpers

**Files:**
- Create: `server/social/geo.py`, `server/social/recommendations/relatedness.py`, `tests/test_recommendation_relatedness.py`
- Modify: `server/routers/reels.py:515-598` (move the helpers, re-import them), `server/social/recommendations/types.py`, `server/social/recommendations/service.py:251-283` (`_catalog_base`), `tests/test_recommendation_catalog_cache.py:83-91`

**Interfaces:**
- Produces, in `server/social/geo.py`:
  - `CITY_COORDS`
  - `location_key(city: str, country: str) -> str`
  - `location_coords(city, country, lat=None, lon=None) -> tuple[float, float] | None`
  - `haversine_km(a, b) -> float`
  - Bodies move verbatim. `reels.py` does `from server.social.geo import CITY_COORDS, location_key as _location_key, location_coords as _location_coords, haversine_km as _haversine_km`, so no call site changes.
- Produces, in `types.py`:
  - `class PostLocation(NamedTuple): slug: str; city: str; country: str; coords: tuple[float, float] | None`
  - `CatalogItem` gains `text_tokens: tuple[str, ...] = ()` and `location: PostLocation | None = None`. These go last, with defaults.
- Produces, in `relatedness.py`: `tokenize(text: str) -> tuple[str, ...]`.
  - Lowercase.
  - Strip URLs (`https?://\S+`).
  - Split on `[^\w#]+` with Unicode `\w`, then strip a leading `#`, so hashtags become plain tokens.
  - Drop tokens shorter than 3 characters and stopwords.
  - Stopwords: a module-level `frozenset` of common English and Vietnamese function words. The builder picks the list.

- [ ] **Step 1: Write failing tests** in `tests/test_recommendation_relatedness.py`:
  - `test_tokenize_keeps_unicode_and_hashtags`: `tokenize("Phố cổ Hà Nội #streetfood https://x.io/a the")` contains `"phố"`, `"nội"` and `"streetfood"`; does not contain `"the"`, `"https"` or `"x.io"`; and drops tokens under 3 characters (`"cổ"`, `"hà"`).
  - `test_tokenize_empty`: `tokenize("") == ()`.

- [ ] **Step 2: Write the failing catalog test** `test_catalog_base_carries_text_and_location` in `tests/test_recommendations.py`:
  - Seed one post with `title="Sunset ride"`, `caption="#motorbike over Hanoi"` and `location={"city": "Hanoi", "country": "Vietnam"}`.
  - Assert the catalog item has `{"sunset", "ride", "motorbike", "hanoi"} <= set(text_tokens)`.
  - Assert `location.slug == "hanoi--vietnam"` and `location.coords` is not `None`, since Hanoi is in `CITY_COORDS`.
  - Assert a post with `location={}` has `location is None`.

- [ ] **Step 3: Run both.** Expected: FAIL with an import error.

- [ ] **Step 4: Implement.**
  - Move the geo helpers.
  - Add the types.
  - Add `tokenize`.
  - In `_catalog_base`, also select `Post.title`, `Post.caption`, `Post.location`.
  - Fill `text_tokens=tokenize(f"{title} {caption}")`.
  - Fill `location`: a `PostLocation` when `location_key(city, country)` is non-empty, with `coords=location_coords(city, country, lat, lon)`; otherwise `None`.

- [ ] **Step 5: Update the reference builder** in `tests/test_recommendation_catalog_cache.py` so it fills the two new fields the same way: import `tokenize`, `location_key` and `location_coords`. Its equality assertions then still hold.

- [ ] **Step 6: Run** `tests/test_recommendation_relatedness.py`, `tests/test_recommendation_catalog_cache.py`, `tests/test_recommendations.py`, `tests/test_reel_location_coords.py` and `tests/test_reels_discovery.py`. Expected: PASS.

### Task 5: B1 — `text_related` source

**Files:**
- Modify: `relatedness.py`, `types.py` (`PipelineContext`), `service.py` (`_pipeline_context`, IDF cache, base index), `sources.py`, `ranking.py` (`REASON_BY_SOURCE`), `config.py`
- Test: `tests/test_recommendation_relatedness.py`, `tests/test_recommendations.py`

**Interfaces:**
- Produces, in `relatedness.py`:
  - `build_idf(items: Iterable[CatalogItem]) -> dict[str, float]`: **unsmoothed** `log(N / df)`. A token present in every item gets 0.
  - `tfidf_vector(tokens, idf) -> dict[str, float]`: L2-normalized; `{}` when the norm is 0.
  - `cosine(a, b) -> float`
  - `text_scores(seeds: list[tuple[CatalogItem, float]], items: Mapping[str, CatalogItem], idf, threshold=0.1) -> dict[str, tuple[float, tuple[str, ...]]]`:
    - A candidate's score is the max over seeds of `cosine × seed_weight`, capped at 1.0.
    - The tuple holds the matching seed ids.
    - Seeds never score themselves.
    - Pairs under `threshold` are dropped, judged on the cosine before weighting.
- Produces, in `service.py`:
  - `_catalog_index(db) -> dict[str, CatalogItem]`: built from and cached alongside `_catalog_base`, keyed on the same store.
  - `_catalog_idf(db) -> dict[str, float]`: cached on the same store.
- Produces, in `PipelineContext` (new fields go last, with defaults):
  - `seed_items: tuple[tuple[CatalogItem, float], ...] = ()`. Seeds resolved from `_catalog_index`, **not** from `items`, so a delivered or past-cap seed still works. Weight 1.0 for `seed_post_id`; 0.5 for affinity seeds on the related surface; 1.0 for affinity seeds elsewhere.
  - `text_scores: dict[str, tuple[float, tuple[str, ...]]] = field(default_factory=dict)`.
- Produces: `TextRelatedSource` (`name = "text_related"`), which emits `_ranked_hits` over `context.text_scores`. It is added to `DEFAULT_SOURCES`.
- Produces: `SOURCE_WEIGHTS["text_related"] = 0.9`, `REASON_BY_SOURCE["text_related"] = "similar_caption"`.
- `related_scores` merge: in `_pipeline_context`, each candidate's score becomes the max of the existing value and its text score, keeping the seeds of the larger.

- [ ] **Step 1: Write failing pure tests:**
  - `test_text_scores_prefers_shared_distinctive_words`:
    - Items: A "saigon night market neon", B "night market neon lights", C "mountain hiking sunrise", plus 3 filler items with unrelated words, so IDF is meaningful.
    - Seed A with weight 1.0.
    - Assert `scores[B][0] > scores.get(C, (0,))[0]`, and that A is not in scores.
  - `test_text_scores_degenerate_inputs`:
    - Every item has the same caption → `text_scores == {}`.
    - A seed with empty tokens → `{}`.
    - All-stopword captions → `{}`.
    - Nothing raises.

- [ ] **Step 2: Write the failing pipeline test** `test_text_related_works_on_page_two_when_seed_was_delivered`:
  - Seed posts whose captions share distinctive words with the opened reel.
  - Fetch related page 0 with `post=<seed>` and `limit=2`, then page 1 with the cursor.
  - Build the page-1 context through `service._pipeline_context` for that session, or assert on page 1's impression provenance.
  - Assert a `text_related` hit exists for a matching post, and that the seed id is absent from `context.items`.

- [ ] **Step 3: Run them.** Expected: FAIL.

- [ ] **Step 4: Implement** the functions, fields and source above.
  - Compute `text_scores` in `_pipeline_context` from `seed_items` over `items`.
  - Existing tests that pin order may shift. `seed_catalog` uses one caption for every post, so unsmoothed IDF gives it 0 weight and no hits. If an order test still moves, fix the cause, not the test.

- [ ] **Step 5: Run** `tests/test_recommendation_relatedness.py` and `tests/test_recommendations.py`. Expected: PASS.

### Task 6: B2 — `location_related` source

**Files:**
- Modify: `relatedness.py`, `types.py`, `service.py`, `sources.py`, `ranking.py`, `config.py`
- Test: `tests/test_recommendation_relatedness.py`, `tests/test_recommendations.py`

**Interfaces:**
- Produces: `location_score(a: PostLocation | None, b: PostLocation | None) -> float`:
  - 0.0 if either is `None`.
  - 1.0 if the slugs are equal.
  - If both have coords: `exp(-haversine_km / 50)`, or 0.0 when that is under 0.05.
  - Else 0.6 for the same city and country (casefolded).
  - Else 0.15 for the same country.
  - Else 0.0.
- Produces: `location_scores(seeds, items) -> dict[str, tuple[float, tuple[str, ...]]]`. Same max-over-weighted-seeds shape as `text_scores`, skipping 0.
- Produces: `PipelineContext.location_scores` (default empty), and `LocationRelatedSource` (`name = "location_related"`) in `DEFAULT_SOURCES`.
- Produces: `SOURCE_WEIGHTS["location_related"] = 0.7`, `REASON_BY_SOURCE["location_related"] = "same_place"`. The score joins the `related_scores` max.

- [ ] **Step 1: Write the failing pure test** `test_location_scores_order`:
  - Seed Hanoi (21.03, 105.85).
  - Candidates: another Hanoi post with a different slug spelling but coordinates 2 km away; Hai Phong (20.86, 106.68, ~100 km); Ho Chi Minh City (10.82, 106.63); no location.
  - Assert Hanoi > Hai Phong > HCMC, where HCMC is either missing or scores 0.15 through the same-country rule.
  - Assert the no-location post is not in the result.
  - Assert the same slug scores exactly 1.0.

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement**, mirroring Task 5.

- [ ] **Step 4: Run** `tests/test_recommendation_relatedness.py` and `tests/test_recommendations.py`. Expected: PASS.

### Task 7: B3 + B5 — `creator_other_reels`, seed-aware rerank, version bump

**Files:**
- Modify: `sources.py`, `ranking.py` (`rerank_page`), `service.py` (`_materialize_reel_page` pin), `config.py`
- Test: `tests/test_recommendations.py`

**Interfaces:**
- Produces: `CreatorOtherReelsSource` (`name = "creator_other_reels"`) in `DEFAULT_SOURCES`.
  - Owner: `seed_post_id`'s owner, from `_catalog_index` through `context.seed_items`.
  - It does nothing when there is no `seed_post_id`.
  - Candidates: the owner's other items in `context.items`, newest first, scored `1 / (1 + rank)`, capped at 20.
  - It does **not** feed `related_scores`.
- Produces: `SOURCE_WEIGHTS["creator_other_reels"] = 0.8`, `REASON_BY_SOURCE["creator_other_reels"] = "more_from_creator"`.
- Produces: `rerank_page(candidates, limit, *, explore: bool = True, preselected: Sequence[Candidate] = (), uncapped_owner: str | None = None) -> list[Candidate]`.
  - `preselected` seeds the creator, tag and source counters and the back-to-back check.
  - It is not included in the returned list.
  - `uncapped_owner` skips the hard 3-per-creator cap for that one owner. Its −0.45 × count and −2.5 back-to-back penalties still apply.
  - `_materialize_reel_page` passes `preselected=[pinned]` when it pins the seed. On the related surface it also passes `uncapped_owner=<seed's owner_id>`.
- Produces: `REELS_ALGORITHM_VERSION = "reels-heuristic-v2"`.

- [ ] **Step 1: Write the failing test** `test_related_page_spreads_creator_other_reels`:
  - Seed creator X with 7 reels and 3 other creators with 2 reels each.
  - Open X's newest reel with `post=<id>&limit=8`.
  - Page 0: `ids[0]` is the seed.
  - Give the viewer a strong `ActorCreatorAffinity` for X, so X's reels outscore the others.
  - More than 3 items in `ids` are by X, counting the seed. This shows the hard cap is gone for X (spec deviation 4).
  - At least one item is by another creator, and X-X back-to-back pairs number fewer than `count(X) - 1`. This shows the penalties still spread X out.
  - Guard: in the same fixture, with no `post` seed on for_you, no creator exceeds 3 per page.
  - At least one X item has `creator_other_reels` in its provenance sources.

- [ ] **Step 2: Write the failing test** `test_algorithm_version_bump_restarts_session`:
  - Get page 0, then set the session's `algorithm_version` to `"reels-heuristic-v1"` in the DB.
  - Request page 1 with the cursor.
  - Assert the response reports a restart. Use the field the existing expired-cursor test checks, e.g. `restart_reason == "algorithm_version_changed"`.

- [ ] **Step 3: Run them.** Expected: FAIL.

- [ ] **Step 4: Implement** the source, the `preselected` parameter, the pin change and the version bump.

- [ ] **Step 5: Run** all of `tests/test_recommendations.py` and `tests/test_recommendation_relatedness.py`. Expected: PASS.

- [ ] **Step 6: Commit workstream B.**
```bash
git add server/social/geo.py server/social/recommendations/ server/routers/reels.py tests/test_recommendation_relatedness.py tests/test_recommendations.py tests/test_recommendation_catalog_cache.py
git commit -m "feat(recs): text, location and same-creator relatedness; reels-heuristic-v2"
```

---

## Workstream C — Surface coverage

### Task 8: Catalog extras, uncapped pools, stable replay

**Files:**
- Modify: `service.py` (`_catalog`, `_replay_reel_page`, `get_reel_page`, `_materialize_reel_page`, `_pipeline_context`)
- Test: `tests/test_recommendations.py`

**Interfaces:**
- Produces: `_catalog(db, *, actor, allowed_post_ids, excluded_post_ids, surface, extra_post_ids: frozenset[str] = frozenset(), capped: bool = True)`.
  - Once `MAX_CATALOG_SIZE` is reached, it keeps scanning the base but accepts only ids in `extra_post_ids`.
  - All the other filters still apply: hidden, dismissed, allowed, followed, excluded.
  - `capped=False` drops the cap entirely.
- Produces the full new signature, used by Tasks 9 to 13:
  ```python
  def _pipeline_context(db, *, actor, session: RecommendationSession | None, surface, seed_post_id,
                        allowed_post_ids, manual_order, scope_order=None,
                        pool_only: bool = False, capped: bool = True,
                        extra_post_ids: frozenset[str] = frozenset()) -> PipelineContext
  ```
  - `session=None` means no delivered exclusions, no session events and no exposures. Task 12 uses it.
  - `pool_only` and `capped` are independent. `pool_only=True` sets `PipelineContext.pool_only = True` (new field, default `False`). `capped` is passed through to `_catalog`.
- Produces: `get_reel_page(..., pool_only: bool = False, extra_post_ids: frozenset[str] = frozenset())`. With `pool_only=True` it calls `_pipeline_context(..., pool_only=True, capped=False)`, so a filtered set keeps matches past the cap (C2 anti-goal).
- Produces: `_replay_reel_page` passes `extra_post_ids={row.post_id for row in rows}` to `_catalog`, so posts it already delivered are never dropped by the cap.

- [ ] **Step 1: Write the failing test** `test_catalog_extras_survive_cap_and_replay`:
  - Monkeypatch `service.MAX_CATALOG_SIZE = 3`.
  - Seed 6 posts.
  - Assert `_catalog(..., extra_post_ids={oldest_id})` contains the first 3 items `_catalog` keeps (the newest 3 until Task 11 changes the order) plus `oldest_id`, and `capped=False` contains all 6.
  - Then page through `get_reel_page(..., extra_post_ids={oldest_id}, limit=1)` until `has_more` is false, recording each cursor and its ids. `oldest_id` should land after page 0, since it is the oldest with no engagement; assert that as a precondition.
  - Re-request every recorded cursor **without** `extra_post_ids`, so these calls replay. Assert each returns the same ids as the first time, including the page that held `oldest_id`.

- [ ] **Step 2: Run it.** Expected: FAIL with an unexpected keyword.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** `tests/test_recommendations.py` and `tests/test_recommendation_catalog_cache.py`. Expected: PASS.

### Task 9: C2 — filtered For You ranks within the filtered set

**Files:**
- Modify: `sources.py`, `ranking.py`, `server/routers/reels.py:1962-1969`
- Test: `tests/test_recommendations.py`

**Interfaces:**
- Consumes: Task 8's `pool_only`.
- Produces: `ScopePoolSource` (`name = "scope_pool"`): every item in `context.items` gets a hit, newest first, `raw_score = 1.0`.
  - In `gather_source_hits`, `context.pool_only` selects `(ScopePoolSource(),)` only.
  - `SOURCE_WEIGHTS["scope_pool"] = 1.0`, `REASON_BY_SOURCE["scope_pool"] = "matches_your_filter"`.
- Produces: when `context.pool_only` is set, `_materialize_reel_page` calls `rerank_page(..., explore=False)`.
- Router:
  - When `requested_surface == "for_you"`, `sort in {"for_you", "personalized"}`, and (`search` or `tag` or `location`) and not `author`: set `manual_order = None` and call `get_reel_page(..., pool_only=True)` with `allowed_post_ids` = the filtered ids, as today.
  - Author scope and explicit sorts keep `manual_order`.

- [ ] **Step 1: Write the failing test** `test_tag_feed_keeps_set_and_orders_by_affinity`:
  - Monkeypatch `service.MAX_CATALOG_SIZE = 3`.
  - Seed 4 creators × 3 posts, all tagged `cinematic`, plus 2 untagged posts.
  - Give the viewer a large `ActorCreatorAffinity` for `creator_0`, whose posts are the oldest.
  - Page through `/api/reels/feed?tag=cinematic&sort=for_you&limit=4` until there is no cursor.
  - Assert the set of returned ids == the 12 tagged ids, with each exactly once.
  - Assert page 0's first item is by `creator_0`.
  - Assert no item's provenance has `fresh_exploration` or `global_quality_trending`.

- [ ] **Step 2: Write the guard test** `test_author_feed_keeps_newest_order`: `author=creator_1` returns that creator's posts newest first, as today.

- [ ] **Step 3: Run them.** Expected: the first FAILS on order; the second PASSES.

- [ ] **Step 4: Implement.**

- [ ] **Step 5: Run** `tests/test_recommendations.py` and `tests/test_reels_discovery.py`. Expected: PASS.

### Task 10: C1 — Following blends recency with the personalized score

**Files:**
- Modify: `ranking.py` (`_ranked_candidates` following branch, `rerank_page` prefix), `service.py` (`watched_post_ids`), `types.py`, `config.py`
- Test: `tests/test_recommendations.py`

**Interfaces:**
- Produces, in `config.py`: `FOLLOWING_PERSONAL_WEIGHT = 0.5`, `FOLLOWING_RECENCY_DECAY_HOURS = 48.0`, the e-folding time in `exp(-age_hours / 48)` (not a half-life); `FOLLOWING_SCORE_SCALE = 4.0`; `FOLLOWING_WATCHED_DAYS = 7`; `FOLLOWING_WATCHED_MS = 3000`.
- Produces: `PipelineContext.watched_post_ids: frozenset[str] = frozenset()`. Filled only on the following surface.
  - It holds the actor's events from the last 7 days with `event_type == "complete"`, or `event_type == "view"` and `watch_ms >= 3000`, restricted to `items`.
- Produces, in the following branch:
  - Compute the same features and linear score as the for_you path. Extract the shared body into `_features(context, post_id, item, retrieval_norm) -> tuple[dict[str, float], float]`, used by both paths.
  - `personalized_norm` = min–max of the linear score over the request, or 0.0 when max equals min.
  - `final_score = FOLLOWING_SCORE_SCALE × (0.5 × personalized_norm + 0.5 × exp(-age_hours / 48))`.
  - `features` gains `recency` and `personalized_norm`.
  - Sort: unwatched by `-final_score` first, then watched by `-final_score`.
- Produces: `rerank_page` passes only a `manual_order` prefix straight through, no longer `following_recent`.
  - On the following surface, `_materialize_reel_page` reranks the unwatched partition with `explore=False` first.
  - It fills the rest of the page from the watched partition, with `preselected` = the unwatched picks.

- [ ] **Step 1: Write the failing test** `test_following_blends_recency_and_affinity`. The viewer follows creators A, B, C and D.
  - A has one 3-day-old reel, and the viewer has a large `ActorCreatorAffinity` for A.
  - B has one 1-hour-old reel, with zero affinity.
  - C and D have equal affinity; C has a 2-hour-old reel and D a 10-hour-old reel.
  - D also has a 30-minute-old reel the viewer completed: insert an `EngagementEvent(event_type="complete")` from 1 day ago.
  - Fetch `feed=following&limit=2` until there is no cursor.
  - Affinity: A ≫ C = D > 0 = B. B must hold the lowest linear score, so its `personalized_norm` is about 0.
    - Arithmetic: A ≈ 0.5 × 1.0 + 0.5 × exp(−72/48) ≈ 0.61. B ≈ 0.5 × pn_B + 0.5 × 0.98 ≈ 0.49 + 0.5 × pn_B. A wins only while pn_B < 0.24.
    - If a freshness feature lifts pn_B above that, raise C and D's affinity. Don't change the weights.
  - Assert A's reel comes before B's.
  - Assert C's reel comes before D's 10-hour reel.
  - Assert D's watched reel comes last.
  - Assert every followed post appears exactly once.

- [ ] **Step 2: Write the failing test** `test_following_new_reel_not_buried_by_diversity`:
  - The viewer follows A, B and C with equal affinity.
  - A has a 1-hour-old and a 2-hour-old reel; B has a 5-day-old reel; C has a 6-day-old reel.
  - With `limit=4`, assert `ids[0]` is A(1h), and A(2h) comes before C(6d). The back-to-back penalty may put B between A's two reels; the creator penalty must not push A(2h) below an older reel from a creator not yet on the page.

- [ ] **Step 3: Run them.** Expected: FAIL; today's order is pure `created_at`.

- [ ] **Step 4: Implement.**

- [ ] **Step 5: Run** all of `tests/test_recommendations.py`. Update the existing Following newest-first tests only where the spec changed the order, and say which ones in the commit body. Expected: PASS.

### Task 11: C5 — no age cutoff: tiered age penalty, catalog pool by score, personal long tail

**User's decision (2026-11-13):** old reels are not cut off; they are penalized by age in tiers, so an old banger can still win. The penalty is small within 3 months, larger within 6 months, larger within a year, and largest after that.

**Files:**
- Modify: `ranking.py` (`_features` freshness), `service.py` (`_catalog_base` pool order, `_catalog`, `_pipeline_context`, new `_long_tail_ids`), `relatedness.py` (`age_factor`), `config.py`
- Test: `tests/test_recommendation_relatedness.py`, `tests/test_recommendations.py`

**Interfaces:**
- Consumes: Task 8's `extra_post_ids`; Task 4's `CatalogItem.location`.
- Produces, in `config.py`:
  - `AGE_FACTOR_POINTS = ((0, 1.0), (90, 0.85), (180, 0.70), (365, 0.55), (730, 0.40))`, as (age in days, factor). These values are my call; tune if the tests below still pass.
  - `CATALOG_NEWEST_SHARE = 0.5`, the part of the pool kept for the newest posts.
  - `LONG_TAIL_MAX = 150`.
- Produces, in `relatedness.py`: `age_factor(age_days: float) -> float`. Linear between the points, 1.0 at day 0, flat 0.40 after 730 days. Never increases with age.
- Ranking: the `freshness` feature becomes `age_factor(age_days)`, replacing `exp(-age_days / 30)`. `RANK_WEIGHTS["freshness"]` stays 0.50.
  - So the largest gap between a new reel and a 2-year-old one is 0.5 × 0.6 = 0.30 of linear score. Today it is 0.50, reached after about 3 months.
  - Following (Task 10) keeps its own `recency`; it does not use this.
- Catalog pool, so the per-request cap no longer means "newest 1000":
  - `_catalog_pool_order(db) -> tuple[CatalogItem, ...]`, cached with `_catalog_base` on the same store.
  - It is the newest `int(MAX_CATALOG_SIZE × CATALOG_NEWEST_SHARE)` posts, then every other post sorted by `legacy_prior(like_count, view_count) × age_factor(age)` descending, ties newest first.
  - `legacy_prior` is the `tanh(log1p(views + 5 × likes) / 8)` term from `_quality`; extract it as a shared function.
  - `_catalog` iterates `_catalog_pool_order` instead of `_catalog_base`. The cap of `MAX_CATALOG_SIZE` per request stays, for speed, but it now keeps the newest posts plus the best-performing older ones, of any age.
- Personal long tail: `_long_tail_ids(db, *, actor, outside: Sequence[CatalogItem], seed_ids: list[str]) -> frozenset[str]`.
  - `outside` is `_catalog_pool_order(db)[MAX_CATALOG_SIZE:]`, the posts that did not make the pool.
  - Taken in this priority order until there are `LONG_TAIL_MAX`:
    1. ≤ 5 newest per creator among the actor's top 20 positive `ActorCreatorAffinity` rows. This is an **unrestricted** query, ordered by score desc.
    2. ≤ 50 in total, newest first, carrying any of the actor's top 20 positive `ActorTagAffinity` tags. Also an unrestricted query.
    3. `ItemSimilarity.target_post_id` for `source_post_id in seed_ids`, by score desc.
    4. ≤ 20 sharing the first seed's `location.slug`.
- `_pipeline_context`:
  - On for_you and related, and only when not `pool_only`, it resolves the seeds first: move the `item_rows` query above `_catalog`.
  - It calls `_long_tail_ids`, merges the result with any caller `extra_post_ids`, then calls `_catalog`.
  - Following and pool mode skip it.

- [ ] **Step 1: Write the failing pure test** `test_age_factor_tiers` in `tests/test_recommendation_relatedness.py`:
  - `age_factor(0) == 1.0`, `age_factor(90) == 0.85`, `age_factor(180) == 0.70`, `age_factor(365) == 0.55`, `age_factor(2000) == 0.40`.
  - Never increases across 0..3000 days in steps of 1.

- [ ] **Step 2: Write the failing test** `test_old_banger_enters_pool_and_can_win`:
  - Monkeypatch `service.MAX_CATALOG_SIZE = 4`.
  - Seed 10 new posts with 0 likes, plus one post created 2 years ago with `like_count=300`, `view_count=5000`, and `PostStats` showing strong engagement (impressions 1000, qualified views 800, completions 600, likes 300, saves 50).
  - Assert the old post is in `_catalog_pool_order(db)[:4]` and in `_catalog(...)`.
  - Assert an anonymous for_you page with `limit=4` contains it.

- [ ] **Step 3: Write the failing test** `test_long_tail_post_can_be_recommended`:
  - Monkeypatch `service.MAX_CATALOG_SIZE = 10`. This stands in for the spec's 1,005-post check and runs much faster.
  - Seed 15 posts across 3 creators with 0 likes, so the oldest post belongs to creator Z and falls outside the pool.
  - Give the viewer a strong affinity for Z only.
  - Assert the oldest post's id is in `service._pipeline_context(...).items`, and the for_you page with `limit=15` contains it.
  - With a monkeypatched `LONG_TAIL_MAX = 2` and three eligible posts, `_long_tail_ids` returns 2.

- [ ] **Step 4: Run them.** Expected: FAIL.

- [ ] **Step 5: Implement.** Existing tests that relied on `exp(-age/30)` or on the newest-1000 order may move; fix the cause, and name any test you change in the commit body.

- [ ] **Step 6: Run** `tests/test_recommendations.py`, `tests/test_recommendation_relatedness.py` and `tests/test_recommendation_catalog_cache.py`. Expected: PASS.

### Task 12: C3 — `/api/reels?sort=for_you` grid

**Files:**
- Modify: `service.py` (new `rank_pool`, `rank_grid`, grid cache), `relatedness.py` (`block_diverse`), `server/social/recommendations/__init__.py` (export `rank_grid`), `server/routers/reels.py` (`_list_page_key`, `list_reels`), `config.py`
- Test: `tests/test_recommendations.py`, `tests/test_reels_paging.py`, `tests/test_edge_cache.py`

**Interfaces:**
- Consumes: Task 8's `pool_only`; Task 9's `ScopePoolSource`.
- Produces: `GRID_CACHE_TTL_S = 600`, `GRID_CACHE_MAX = 256`, `GRID_BLOCK = 24`, `GRID_CREATOR_CAP = 3`.
- Produces: `block_diverse(post_ids: list[str], owner_of: Mapping[str, str], block: int, cap: int) -> list[str]`.
  - It fills each block of `block` items in input order, skipping creators already at `cap` in that block.
  - Skipped ids stay queued for later blocks.
  - If only capped creators remain, it fills in input order.
  - Output is a permutation of the input.
- Produces: `rank_pool(db, *, actor, allowed_post_ids: set[str]) -> list[Candidate]`.
  - Calls `_pipeline_context(..., session=None, pool_only=True, capped=True)`; capped keeps the grid bounded. Then `rank_candidates`, no rerank.
- Produces: `rank_grid(db, *, actor, allowed_post_ids: set[str], filters_key: str, seed: int) -> list[str]`.
  - Returns `block_diverse` of the `rank_pool` ids.
  - Cached in a module dict keyed `(actor.actor_key, filters_key, seed)`. Each entry holds `(store, created_monotonic, ids)`, where `store = reel_records_version(False)`.
  - A hit needs `entry.store is store`, the same identity check `_catalog_base` uses, and an age under 600 s. Don't put `id(store)` in the key; ids are reused after garbage collection.
  - When the cache is over `GRID_CACHE_MAX` entries, the oldest is dropped.
- Router:
  - In `list_reels`, when `sort == "for_you"`, `scoped_paths is None` and `post` is not set. `scoped_paths` comes from `scoped_media_paths` (feed or author scope). Search, tag and location do not set it, so VR Search is covered.
    - `seed = cursor seed or int(time.time()) // 600`, carried in the cursor as `shuffle` does.
    - Actor: `actor_identity(viewer_id, None)` when signed in, else the fixed `ActorIdentity(actor_key="grid:anonymous", user_id=None, anonymous_id=None)`. This is spec deviation 2. **Never** read or set the anonymous cookie here.
    - `ranks = {post_id: i}` from `rank_grid`.
    - `_list_page_key` gains `ranks: dict[str, int] | None = None` and a `path_to_post_id` lookup.
    - The key is `(ranks.get(post_id, len(ranks)), -mtime, rel_path)`, so no-post and past-cap items sort after the ranked ones, newest first.
  - The unpaged form uses the same ordering.
  - Other sorts are unchanged.
  - `ui/assets/vr_shell.js:150-151`: `sort: 'shuffle'` becomes `sort: 'for_you'` in the explore and search sources.

- [ ] **Step 1: Write the failing pure test** `test_block_diverse_caps_creators_per_block` in `tests/test_recommendation_relatedness.py`:
  - 10 ids by A followed by 10 by B, with `block=6, cap=3`.
  - Each block of 6 has ≤ 3 per creator while both creators remain.
  - Output is a permutation of the input.

- [ ] **Step 2: Write the failing test** `test_grid_for_you_puts_affine_creator_first`:
  - Sign in a viewer with a strong affinity for `creator_0`.
  - `GET /api/reels?sort=for_you&limit=24`.
  - The first 3 items are by `creator_0`.
  - Paging with `limit=5` through `next_cursor` returns every post exactly once.
  - `GET /api/reels?sort=for_you&search=cinematic&limit=24` also puts `creator_0` first, which is the VR Search route.

- [ ] **Step 3: Write the failing test** `test_anonymous_grid_for_you_is_shared_and_cacheable` in `tests/test_edge_cache.py`:
  - Two anonymous clients with different `ANON_COOKIE` values each call `/api/reels?sort=for_you&limit=24`.
  - Byte-identical `content`.
  - `cache-control == PUBLIC`.
  - No `set-cookie`.

- [ ] **Step 4: Guard tests.** The existing `tests/test_reels_paging.py` newest and shuffle cases stay green without change.

- [ ] **Step 5: Run them.** Expected: the new tests FAIL.

- [ ] **Step 6: Implement.**

- [ ] **Step 7: Run** `tests/test_recommendations.py`, `tests/test_recommendation_relatedness.py`, `tests/test_reels_paging.py`, `tests/test_edge_cache.py` and `tests/test_payload_cache.py`. Expected: PASS.

### Task 13: C4 server — `scope_ids` on `/api/reels/feed`

**Files:**
- Modify: `server/routers/reels.py` (`reels_feed`, `_recommendation_feed_data`)
- Test: `tests/test_recommendations.py`

**Interfaces:**
- Consumes: Task 8's `extra_post_ids`.
- Produces: the `scope_ids: str = ""` query parameter on `/api/reels/feed`. It is comma-separated post ids, used only with `post`.
  - Split, strip, dedupe keeping the first, keep the first 200.
  - The client already ordered it from the tapped reel on. The server inserts `post` first when it is missing, and does not rotate.
  - Resolve the ids to videos from `raw`, **not** from the related-surface `videos`, which ignore search and tag.
  - Ids that are unknown, hidden, unpublished or not in `raw` are dropped silently.
  - The scoped videos are added to `videos`. `scope_order` = the surviving ids. `allowed_post_ids` includes them.
  - `get_reel_page(..., extra_post_ids=frozenset(scope_order))`.
  - `feed_filters["scope"] = blake2b(",".join(scope_order), digest_size=8).hexdigest()`, or `""` when there are no `scope_ids`.
  - When `scope_ids` is given, it takes precedence over the existing search/tag/location `scope_first` build.

- [ ] **Step 1: Write the failing test** `test_feed_scope_ids_plays_given_order_then_related`:
  - Seed 4 × 3 posts.
  - Send `post=<p5>` with `scope_ids` = `[p5, p9, p1, p11]` in that shuffled order, plus `limit=6`.
  - Page 0 ids start with `[p5, p9, p1, p11]`.
  - The remaining items are not in the scope.
  - Every item has a `recommendation.impression_id`.
  - Paging to the end returns each post once.

- [ ] **Step 2: Write the failing test** `test_feed_scope_ids_drops_junk`:
  - `scope_ids` = `"nope,<hidden post id>,<p2>,<p2>,"` plus 250 random uuid strings.
  - The status is 200.
  - Page 0 starts with `[post, p2]`.
  - The hidden and unknown ids never appear.

- [ ] **Step 3: Run them.** Expected: FAIL.

- [ ] **Step 4: Implement.**

- [ ] **Step 5: Run** `tests/test_recommendations.py`. Expected: PASS.

### Task 14: C4 client — VR tile tap plays through the recommender

**Files:**
- Modify: `ui/assets/reels.html` (new `playVrShellFeed`, the `onShellPlayFeed` wiring at ~line 7475)
- Test: `tests/test_player_template.py`

**Interfaces:**
- Consumes: Task 13's `scope_ids`.
- Produces: `async function playVrShellFeed(feed)`, wired as `onShellPlayFeed`. `webxr_vr.js:8224` ignores the return value.
  - When `feed.videoData[feed.startIndex].post_id` is set, it builds `ids` from `items.slice(start).concat(items.slice(0, start))`, keeping those with a `post_id` and the first 200.
  - `params` = `{ codec: feedParams.codec, folder: feedParams.folder, post: <tapped id>, scope_ids: ids.join(',') }`.
  - It follows `switchToLocationFeed`:
    - `captureOriginalFeed`, `abortFeedWork`, the generation check.
    - `requestJson(feedRequestUrl(null, params))`, then `FeedState.fromPage(page, params, { slug: '', name: feed.label || 'EXPLORE' })`.
    - It swaps state and calls `loadVideo(0, { autoplay: true })`.
  - On a missing `post_id`, an empty page or a request error that is not `AbortError`, it calls `replaceFeedForVr(feed)`.
  - `feedParams` keeps `scope_ids`, so later pages re-send it. At most 200 × 37 chars, about 7.4 KB, which is within the URL limits of the edge and uvicorn.

- [ ] **Step 1: Write the failing template test** in `tests/test_player_template.py`:
  - The served `reels.html` contains `onShellPlayFeed: playVrShellFeed`.
  - It contains `scope_ids`.
  - `replaceFeedForVr(` is still present as the fallback.

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** `tests/test_player_template.py` and `tests/test_player_inline_template.py`. Expected: PASS.

- [ ] **Step 5: Manual Quest check.**
  - Use USB debug and drive the headset through adb/CDP yourself.
  - Open VR Explore and tap a tile. Scroll past the grid's last item and confirm more reels load.
  - Like one. Confirm the `/api/events` like request carries `recommendation_impression_id`.
  - Loop a reel. Confirm one `replay` request per impression (Task 2).
  - URL size: against the deployed edge (SIT or staging), request `/api/reels/feed` with `post` and 200 real `scope_ids` and confirm a 200 response. If it fails, lower the cap to what passes and update Task 13's cap and test.

- [ ] **Step 6: Full suite.** Run `PYTHON_DOTENV_DISABLED=1 .venv/bin/python -m pytest tests -q`. Expected: all pass.

- [ ] **Step 7: Commit workstream C.**
```bash
git add server/ ui/assets/reels.html ui/assets/vr_shell.js tests/
git commit -m "feat(recs): personalize following, filtered feeds, grids, VR taps and the long tail"
```
