# Recommendation coverage and relatedness — design

Date: 2026-11-13
Status: draft, awaiting approval

## Intent

The `reels-heuristic-v1` recommender works where it runs, but large parts of the product never reach it. Some user signals are defined but never sent. "Related" is decided only by co-watch and tag overlap. This work does three things:

- extends personalized ordering to the surfaces that skip the recommender today;
- closes the signal gaps;
- adds lean relatedness signals: text, location and same creator. No ML model.

**Why:** we don't yet know which surfaces get the most traffic. Every gap found in the review counts as worth fixing.

## Workstreams

The work splits into three independent workstreams. Each can be planned, built and verified on its own.

- **A. Signal fixes**: small, server and player.
- **B. Relatedness sources**: new candidate sources in the pipeline.
- **C. Surface coverage**: routes more surfaces through ranking.

C uses B's sources once they exist, but it does not depend on them.

---

## A. Signal fixes

### A1. Emit `share_sent` on DM shares
- **Today:** `server/routers/messages.py:573` records `reel_share_message`. That event has no weight. `EVENT_WEIGHTS["share_sent"] = 5` is never hit.
- **Change:** record the DM share as `event_type="share_sent"` with the same `client_event_id=f"share:{row.id}"`, so idempotency holds. A grep on 2026-11-13 found no other reader of `reel_share_message` in `server/`, `ui/` or `web/src/`, so it is safe to rename. Events already stored under the old name stay as they are.
- **Double count:** the player's share sheet fires `share` (weight 2) when the sheet opens. A DM send then fires `share_sent` (5). Both count. Opening the sheet and sending are different strengths of intent. *(My call.)*
- **Check:** a test sends a reel in a DM, then asserts one `share_sent` event and the matching `ActorItemAffinity` and `ActorCreatorAffinity` deltas.

### A2. Emit `replay`
- **Today:** `replay` (weight 2) is in `EVENT_WEIGHTS`, but no client sends it. `/api/events` (`server/routers/social.py:1460`) does not allow it.
- **Change:**
  - Add `replay` to the `/api/events` allowlist.
  - In `ui/assets/reels.html`, the `'ended'` handler's loop branch (`!isAutoNext`) sends one `replay` event before `startViewTracking`. It carries the item's `recommendation_impression_id`.
  - Limit it to once per item per impression on the client. The server's contribution cap (once per impression, or `SX_EVENT_DAILY_CAP` per day) is the backstop.
- **Check:** a server test posts `replay` twice for one impression; affinity moves once. A manual player check on loop playback shows one `/api/events` replay request per impression.

### A3. Session context uses unattributed events
- **Today:** `_pipeline_context` builds session signals only from events that carry `recommendation_session_id`. Likes, saves and follows made from other places in the same visit (profile page, grid, DM) are ignored for in-session steering.
- **Change:** session signals also include the actor's events since `session.created_at` that have no session id. They use the same per-type values (view 0.8, complete 1, like 2, save 2.5, share 2.5, skip −1, not_interested −4) and are bounded by the same query limit.
  - An event already attributed to *another* session is not counted.
- **Check:** a test likes a post with no session id after a session starts. The next page's `session_creator_affinity` includes that creator.

---

## B. Relatedness sources (no model)

**Today, "related" means:** ItemSimilarity co-watch (cosine × support/(support+3)) plus tag overlap with seed reels. The seeds are the opened reel and the top 8 positive item affinities.

**Adds:** three new candidate sources. Each one:
- returns `SourceHit`s scored 0..1;
- adds to `related_scores` so the `related` ranking feature sees it;
- gets a `SOURCE_WEIGHTS` entry and a reason key for the UI's "why am I seeing this".

All three run on every surface that runs `DEFAULT_SOURCES` (for_you, related). Seeds are the same as for tag overlap. On the related surface, the opened reel's seed weight is 2× the affinity seeds. *(My call.)*

### B1. `text_related`: title and caption overlap
- **Text:** `Post.title` and `Post.caption`. Lowercase, strip URLs, split on non-word characters, drop stopwords and tokens shorter than 3 characters. Hashtags count as tokens. Unicode word characters are kept, so Vietnamese and other non-ASCII captions work.
- **Score:** TF-IDF cosine between the seed and the candidate. IDF comes from the catalog and is cached with the catalog against `reel_records_version`. Pairs scoring below 0.1 are dropped.
- **Whisper transcripts** (`.vtt`, `server/media.py:625`): **deferred.** Caption files may live in object storage rather than on local disk (`has_media_file(..., files)`), and transcribing is optional. A later step may add transcript tokens, but only if the transcript text is first stored in the database, for example a `Post` text column filled when `make_captions` finishes. No file reads happen at ranking time. *(My call.)*
- **Check:** a unit test with three posts. A and B share distinctive caption words; C does not. Seeded with A, B scores above C.

### B2. `location_related`
- **Location data:** `Post.location` JSON (`slug`, `city`, `country`, `lat`, `lon`). Reuse `_location_coords` and `_haversine_km` from `server/routers/reels.py`. Move them to a shared module if importing them from the router would be awkward.
- **Score:**
  - same `slug` = 1.0;
  - both have coordinates: `exp(-km / 50)`, dropped when under 0.05 (about 150 km);
  - same city, no coordinates = 0.6;
  - same country only = 0.15.
- Posts without a location get no hit.
- **Check:** a unit test with Hanoi, Hai Phong (~100 km), Ho Chi Minh City and no-location posts. The order is Hanoi > Hai Phong > HCMC, and the no-location post gets no hit.

### B3. `creator_other_reels`
- **Candidates:** other published reels from the same `owner_id` as the opened reel on the related surface, or as the session seed. Newest first, scored by `1 / (1 + rank)`, capped at 20 candidates.
- **Conflict with diversity rules:** the 3-per-creator page cap and the 2.5 back-to-back penalty stay as they are.
  - **Intended outcome:** on a related page, the creator's other reels can fill up to the cap (3 per page), spread out, not stacked.
  - The source gets more of the creator's reels into the candidate pool. The rerank still decides how many show.
  - No special case for this source. *(My call.)*
- Hidden or dismissed creators stay excluded, through the existing dismissal filter.
- **Check:** a test opens a reel by a creator with 6 other reels. The related page 0 contains 3 of them, with no two adjacent.

### B4. Visuals: not in scope
Visual similarity needs an embedding model. The user chose no model for now. The design doesn't block adding a `visual_related` source later through the same interface.

### B5. Weights and version
- **Starting `SOURCE_WEIGHTS`:**
  - `text_related` 0.9
  - `location_related` 0.7
  - `creator_other_reels` 0.8
- **`related_scores`:** combined as `max(co_watch, tag, text, location)` per candidate, so one strong signal is enough. Same-creator does not feed `related`, because creator affinity already covers it.
  - These numbers are *my call*. The builder can tune them against the test fixtures.
- **Algorithm version:** bump it to `reels-heuristic-v2`.
  - Already handled: `service.py:215` restarts a session whose `algorithm_version` differs, with `restart_reason="algorithm_version_changed"`. This is the same path an expired cursor takes. No new cursor logic is needed.

---

## C. Surface coverage

| Surface | Today | Change |
|---|---|---|
| Following feed | Pure `created_at` order | C1 |
| For You with search, tag or location, default sort | Manual order (newest) | C2 |
| For You with author scope | Manual order | No change: a profile reads newest-first |
| For You with an explicit admin sort | Manual order | No change: the admin asked for that order |
| `/api/reels` web grid, `sort=for_you` (the web default) | Falls through to newest | C3 |
| VR shell: tapping a grid tile | Static queue, no impressions or paging | C4 |
| VR Explore and Search grids | `sort: 'shuffle'` | C3 (user's decision: personalize) |
| Packs | Curated order | Non-goal: order is the creator's intent |
| Creator suggestions | Endpoint exists, no UI | Out of scope for now (my call; the user did not pick a place for it) |
| Posts older than the newest 1000 | Never candidates | C5 |

### C1. Following: recency-led, not strictly newest first
- **What the user asked for:** new reels lean toward the top, but it does not have to be strictly newest first. An older reel the user is likely to like can come before a newer one.
- **Candidates:** unchanged. Posts from followed creators plus the user's own posts. Signed in only. Dismissals are excluded.
- **Score:** blend recency with the personalized score the for_you ranker already computes (creator, topic, negative, related, quality).
  - `following_score = 0.5 × personalized_norm + 0.5 × recency`
  - `recency = exp(−age_hours / 48)`, a decay time of about two days.
  - `personalized_norm` is the linear rank score scaled to 0..1 within the request.
  - Result: a reel from a favourite creator a few days old can beat a reel from a low-affinity creator posted an hour ago. A reel a week old needs very strong affinity to reach the top.
  - The following branch of `_ranked_candidates` computes the full feature set instead of returning early with `created_at` order.
  - The weights and the 48h decay time are *my call*. The builder may tune them, as long as the checks below hold.
- **Already watched sinks:** a reel the user completed, or saw for 3s or more in the last 7 days, goes below every unwatched reel. Without this, liked older reels would keep coming back to the top. *(My call.)*
- **Rerank:** the normal diversity rerank applies: 3 per creator per page and the back-to-back penalty. There is no exploration slot, because every candidate is already from a followed creator.
- **Paging:** session impressions already stop repeats within a session. Every following post still appears exactly once while paging through.
- **Check:** one test covers all of these:
  - a 3-day-old reel from a high-affinity creator ranks above a 1-hour-old reel from a zero-affinity creator;
  - with equal affinity, the newer reel ranks first;
  - a watched reel ranks below unwatched ones;
  - paging returns every post exactly once.

### C2. Filtered For You (search, tag, location)
- **Today:** any explicit scope makes `personalized = False` (`server/routers/reels.py:1964`), so the filtered list plays in newest order.
- **Change:** with search, tag or location and the default sort (`for_you` or `personalized`), the recommender ranks **within the filtered set**.
  - Pass the filtered post ids as an allowlist.
  - The only source is a new `scope_pool` source: every in-scope post gets a hit.
  - No exploration slot, no trending or fresh injection.
- **Anti-goal:** the *set* of reels must be identical to today; only the order changes. That includes matches older than the newest 1000. They come from the filter, not the catalog, so they are loaded on demand as in C5.
- **Check:** a test runs a tag query. The ids returned across all pages equal today's set exactly, and their order follows affinity.

### C3. Grids: web `sort=for_you`, VR Explore and Search
- **Today:** the `/api/reels` grid sort (~`server/routers/reels.py:2109`) has no `for_you` branch, so the web Reels page's default grid shows newest first.
- **Change:** `sort=for_you` on `/api/reels` orders the grid by the personalized score through a ranking-only call.
  - It creates no session and no impressions.
  - No diversity rerank across the whole grid; the 3-per-creator rule applies per 24-item block.
  - Other sorts are unchanged.
  - Anonymous viewers are ranked by their cookie actor key (`a:<hash>`), the same way the player ranks them.
  - The VR shell's Explore and Search routes (`ui/assets/vr_shell.js:150-151`) switch from `sort: 'shuffle'` to `sort: 'for_you'`. This is the user's decision.
  - **Paging stays stable:** these grids page by offset, so the ranked id list is cached per actor, filters and `reel_records_version` for 10 minutes, and each page is a slice of it. Without the cache, affinities that change between pages would duplicate or skip reels. *(My call.)*
- **Check:** a test signs in a viewer with a strong creator affinity. `/api/reels?sort=for_you` puts that creator's reels in the first block. A test with `sort=newest` gives the same output as today.

### C4. VR shell tile tap goes through the recommender
- **Today:** `play()` in `ui/assets/vr_shell.js` (~line 569) hands any route's `items` (Explore, Search, profile, saved, DM-shared) to `replaceFeedForVr` (`ui/assets/reels.html:6550`). That function plays a fixed queue: `feedCursor = null`, `feedHasMore = false`, no impressions, no attribution.
- **Change:** when the tapped item has a `post_id`, request a related-surface page seeded by that post. The route's items are the scope:
  - The scope ids reach `/api/reels/feed` (with `post=<tapped id>`) as an explicit, ordered `scope_ids` list of post ids, capped at 200, because a shuffled list can't be rebuilt server-side from filter params.
  - The server uses them like today's `scope_order`: the tapped reel, the rest of the list from there, then the items before it, then related reels with paging.
  - A `post_id` not in the catalog is fetched by id. A missing, unpublished or hidden id is dropped silently.
- **Fallback:** if the tapped item has no `post_id` (unpublished or local media), or the request fails, keep today's static queue.
- **Check:**
  - A server test sends `scope_ids` in shuffled order, then asserts the returned order and that impressions exist.
  - A manual Quest check: tap an Explore tile, scroll past the grid's last item, and more reels load. A like during that run has `recommendation_impression_id` set.

### C5. Long tail beyond the newest 1000
- **Today:** `MAX_CATALOG_SIZE = 1000` newest posts. Older posts can never be recommended.
- **Change:** a `long_tail` retrieval step adds older published posts. It runs per request on for_you and related only. It takes, by indexed query:
  - posts by the actor's top 20 positive-affinity creators (≤ 5 each);
  - posts carrying the top 20 positive-affinity tags (≤ 50 total);
  - posts with `ItemSimilarity` rows to the seeds;
  - posts sharing the seed's location slug (≤ 20).

  These join the catalog for that request only, capped at 150 extra items. They are not cached.
- **Check:** a test with 1,005 posts. One of the 5 oldest belongs to the actor's top creator, and that post can appear in for_you.

---

## Constraints
- All work happens on the branch `recommendation-engine-update`, cut from `dev`. It is merged back only when the user says so.

## Non-goals
- Visual similarity or any ML or embedding model.
- Reordering Packs.
- A UI for creator suggestions.
- Changing explicit admin sorts or author-profile order.
- Online weight tuning or A/B infrastructure.

## Anti-goals
- A filtered or following feed that shows a different *set* of reels than today. Ordering only.
- A Following feed where new reels from followed creators get buried under old ones. Recency must still lead.
- New file reads, or model calls, on the ranking hot path.

## Left to the builder
- Exact module layout for the new sources, and where the shared location helpers live.
- Stopword list and tokenizer details for B1.
- Index additions needed for C5's queries, checked with `EXPLAIN` on the dev DB.
- Tuning the B5 weights against fixtures, as long as the checks above still pass.

## Calls I made (for review)
- `share` + `share_sent` both count on a DM share.
- Following blend: 50/50 personalized and recency, 48h decay; watched reels sink.
- Transcripts deferred until their text is stored in the database.
- Starting weights in B5, and `max()` to combine related scores.
- `creator_other_reels` follows the existing diversity cap; no special case.
- Author scope and admin sorts keep their current order.
- Version bump to v2. Old sessions restart, through the existing `algorithm_version_changed` path.
- Builder check was a self-review against the doc, not a separate agent.
