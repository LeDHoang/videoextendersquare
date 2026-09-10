# Tag Explore and Discovery Search Plan

## Product goal

Give every reel tag a durable explore destination. A route such as
/explore/tag/cyberpunk should explain the tag, show all reels that carry it,
surface adjacent tags, and let a viewer continue into the Reels player without
losing the tag context.

Turn the header field into the first version of content discovery. A person can
type a tag, a reel title, a creator, a location, or a recognizable name from a
filename and receive relevant tag destinations. The response contract should
remain useful when heuristic scoring is replaced by a recommendation service.

## Primary journeys

1. Direct tag visit
   - A shared URL opens the exact tag page.
   - The page reports reel, view, like, and related-tag counts.
   - The default order is Top, with Newest, Most Viewed, and Most Liked options.
   - Selecting a tile opens the Reels player at that item with the tag filter
     retained for next/previous playback.

2. Header discovery
   - Command/Ctrl+K focuses the search field.
   - An empty focused field shows popular tags.
   - Typing #cyberpunk or cyberpunk prioritizes the exact tag.
   - Typing a reel name such as Night Runner recommends tags attached to reels
     whose title, filename, creator, or location matches that name.
   - Arrow keys move through results, Enter opens a tag, and Escape closes the
     list.
   - Search All Reels remains available for queries that should be treated as
     broad text filters.

3. Related exploration
   - The tag page lists tags that co-occur on the same matching reels.
   - Each related tag links to its own durable explore route.
   - Shared-reel counts make the relationship understandable rather than
     presenting an unexplained recommendation.

## Page structure

The tag detail page uses the existing ECHO visual system and this hierarchy:

- Breadcrumb: Explore / #tag
- Hero: tag name and aggregate counts
- Discovery signal card: explains exact matching and the current relationship
  signal
- Primary action: play the tag feed from its highest-ranked reel
- Related tags: horizontally scrollable links with shared-reel counts
- Controls: ranking and playback codec
- Reel grid: the shared Explore tile, preview loading, engagement, title, and
  location behavior
- Empty/error states: keep the requested tag visible and offer recovery through
  header search or the main Explore route

## Search and ranking baseline

The API builds a tag catalog from current reel metadata. Every tag record
contains:

- stable slug and display name
- reel count
- aggregate views and likes
- image and video counts
- co-occurring tags and shared-reel counts

Header suggestions use additive, deterministic signals:

1. Exact normalized tag match
2. Tag prefix match
3. Tag substring match
4. Existing filename-hint aliases
5. Tags attached to reels whose title, filename, creator, location, or caption
   matches the query
6. Popularity ordering when the query is empty

Normalization is case-insensitive, removes a leading hash, and ignores
punctuation for lookup. Exact tag feeds still require an exact normalized tag,
which prevents a cyber query from silently mixing cyberpunk with unrelated
results.

## API contract

GET /api/reels/tags?q=cyberpunk&limit=6

Returns ranked tag rows with counts, score reason, and a small related-tag set.
The UI displays the reason but does not depend on its numeric score.

GET /api/reels/tags/{tag}?codec=hevc&sort=trending

Returns the canonical tag summary, related tags, folders represented in the
feed, and playable reel payloads.

GET /api/reels?...&tag=cyberpunk

Applies the same exact tag filter to existing gallery and player requests. The
embedded player endpoints accept the same tag parameter so playback does not
fall back to the full library.

## Recommendation evolution

The heuristic endpoint is intentionally shaped like a ranking service. A later
version can preserve the response while adding:

- Search impression, tag selection, reel open, watch duration, completion,
  replay, like, comment, and skip events
- Session and user affinity vectors for tags, creators, locations, and media
  type
- Recency decay and diversity constraints
- Query embeddings for semantic matches beyond literal names
- Exploration slots so new tags and low-volume creators can receive traffic
- Offline evaluation for click-through, watch completion, and repeated skips
- Explainable reason labels derived from the winning ranking feature

The first instrumentation milestone should store a request ID with every search
impression and carry it through tag selection and reel playback. That makes
future ranking changes measurable without changing page navigation.

## Acceptance criteria

- /explore/tag/cyberpunk is directly addressable and survives refresh.
- Only reels carrying the normalized cyberpunk tag appear in its feed.
- Top, Newest, Most Viewed, and Most Liked produce deterministic ordering.
- Related tags reflect real co-occurrence in current reel metadata.
- Header search returns exact, partial, and name-derived tag suggestions.
- Keyboard and pointer selection both work.
- A broad query can open the existing Explore gallery as a metadata-aware text
  search.
- Opening a tag tile starts the Reels player on that item and retains tag scope.
- Existing page shortcuts continue to work as a fallback when no tag result is
  available.
