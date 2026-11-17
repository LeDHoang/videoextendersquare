# Private Posts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator can publish a post as private or switch a published post between public and private; a private post is listed nowhere and opens for its creator and for anyone with its direct link.

**Architecture:** A new `posts.visibility` column (`public` | `private`) beside the unchanged `status`. Private posts are hidden at the three places every listing already passes through: `unavailable_media_paths_for_viewer` (all `/api/reels*` routes), `post_query` (profile, saved, `/api/feed`, search) and the recommender's `_catalog`. Two narrow exceptions reveal a private post for one request: the `?post=<id>` link, and the creator looking at their own profile scope. Packs decide through `active_item`.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic (SQLite in tests, PostgreSQL in production), pytest; React, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-private-posts-design.md`

## Global Constraints

- Visibility values are exactly `public` and `private`. Default `public`. Existing rows become `public`.
- `status` keeps its meaning (`published`, `deleted`, moderation states). Do not add a status value.
- Private means unlisted, not locked: the media files stay at their public URLs, and a signed-out visitor with `/reels?post=<id>` can open the post.
- Hiding is fail-closed: a listing shows a private post only when the code names the exception. The only exceptions are the `?post=<id>` link, the creator's own profile scope, the creator's own `play=<path>` lookup and explore-preview request, and the pack owner's private posts in their own UNLISTED pack.
- A pack never changes a post's visibility.
- Likes, comments, saves, reports and DM shares need no visibility check: they resolve the post by id through `get_post_by_reference`, which stays visibility-blind.
- A post turned private may stay in anonymous lists for up to 30 s (`EDGE_TTL_S` in `server/edge_cache.py`). Do not add purge code.
- UI copy, verbatim: toggle label `PRIVATE POST`; help line `Only you and anyone with the link can see it.`; tile badge `PRIVATE`.
- Branch from `upload-redesign` (it holds migrations `0023`–`0026`, which `main` lacks). Run `.venv/bin/python -m alembic heads` first and confirm the single head is `20261115_0026`; if it differs, use the real head as `down_revision`.
- In a worktree, prefix pytest, alembic and uvicorn with `PYTHON_DOTENV_DISABLED=1`.
- Commits: no `Co-Authored-By` or "Generated with" lines.
- Follow `CLAUDE.md`: touch only what the task names; match the surrounding style.
- Backend tests: `.venv/bin/python -m pytest -q tests/<file>`. Frontend tests: `cd web && npx vitest run <file>`. Whole suite: `make test`.

## Review Focus

1. A post turned private while its id sits in the cached `for_you` grid order: the next `/api/reels` request must not return it. (Task 3)
2. The creator opens their private post, then a signed-out visitor loads Explore: the reveal must not have reached a shared cache. (Task 4)
3. A stranger sends `scope_ids` holding another creator's private post id, or `play=<private media path>`: the feed answers normally without that post, with no error. (Task 4)
4. The link to a private post whose creator is suspended, or who blocks the viewer: still 404. (Task 4)
5. An UNLISTED pack with the owner's private posts is switched to public: those members stop counting and show as unavailable; with fewer than 3 playable reels the pack reports `needs_repair`. (Task 5)

## File Structure

| File | Change |
|---|---|
| `migrations/versions/20261116_0027_post_visibility.py` | Create: add `posts.visibility`. |
| `server/social/models.py` | `Post.visibility` column. |
| `server/social/database.py` | `EXPECTED_SCHEMA_REVISION`. |
| `server/social/services.py` | `POST_VISIBILITIES`; `create_or_update_post(visibility=)`; `post_card` field; `scoped_media_paths` filter. |
| `server/social/safety.py` | `unavailable_media_paths_for_viewer` hides private, with two reveal arguments. |
| `server/social/recommendations/types.py`, `service.py` | `CatalogItem.private`; `_catalog` rule; creator-page filter. |
| `server/routers/social.py` | `post_query(include_private_of=)`; `PostUpdateRequest.visibility`; `update_post`; `profile_stats`. |
| `server/routers/uploads.py` | `PublishRequest.visibility`. |
| `server/routers/reels.py` | `_hidden_paths` helper and its four call sites. |
| `server/routers/packs.py` | `active_item`, `validate_posts`. |
| `web/src/components/upload/mediaItems.js`, `PostForm.jsx` | Draft field, publish body, toggle. |
| `web/src/pages/ProfilePage.jsx`, `web/src/components/explore/ExploreTile.jsx` | Edit toggle, badge. |
| `tests/test_migration_post_visibility.py`, `tests/test_private_posts.py` | Create. |
| `tests/test_reel_packs.py`, `tests/test_image_posts.py`, `tests/test_comment_replies.py` | Extend. |

---

### Task 1: Column, migration, card field

**Files:**
- Create: `migrations/versions/20261116_0027_post_visibility.py`
- Create: `tests/test_migration_post_visibility.py`
- Modify: `server/social/models.py` (class `Post`, after `status`)
- Modify: `server/social/database.py:14`
- Modify: `server/social/services.py` (`post_card`, near line 1030)
- Modify: `tests/test_comment_replies.py:121`

**Interfaces:**
- Produces: `Post.visibility` (`String(16)`, not null, default and server default `"public"`, no index: two values, small table); `POST_VISIBILITIES = ("public", "private")` in `server/social/services.py`; `post_card(...)["visibility"]`.

- [ ] **Step 1: Write the failing migration test.** Copy the structure of `tests/test_migration_stereo_layout.py` (its `_alembic`, `_urls`, `_reset_postgres`, `_required_row` helpers) with `REVISION = "20261116_0027"`, `PREVIOUS = "20261115_0026"`. One test, `test_upgrade_downgrade_upgrade`, per URL:

```python
command.upgrade(config, PREVIOUS)
# insert one posts row through _required_row
command.upgrade(config, REVISION)
assert "visibility" in _post_columns(engine)
assert connection.execute(sa.text("SELECT visibility FROM posts")).scalar_one() == "public"
command.downgrade(config, PREVIOUS)
assert "visibility" not in _post_columns(engine)
command.upgrade(config, REVISION)
assert "visibility" in _post_columns(engine)
```

- [ ] **Step 2: Run it.** `.venv/bin/python -m pytest -q tests/test_migration_post_visibility.py` → FAIL, revision `20261116_0027` not found.

- [ ] **Step 3: Write the migration.** `revision = "20261116_0027"`, `down_revision = "20261115_0026"`. `upgrade`: `op.batch_alter_table("posts")` adds `sa.Column("visibility", sa.String(16), nullable=False, server_default="public")`. `downgrade`: drop the column.

- [ ] **Step 4: Model and constants.** Add the column to `Post` with `default="public", server_default="public"`. Add `POST_VISIBILITIES = ("public", "private")` at module level in `server/social/services.py`. Add `"visibility": post.visibility or "public"` to the dict `post_card` returns. Set `EXPECTED_SCHEMA_REVISION = "20261116_0027"` and change the literal in `tests/test_comment_replies.py:121` to match.

- [ ] **Step 5: Run.** `.venv/bin/python -m pytest -q tests/test_migration_post_visibility.py tests/test_comment_replies.py tests/test_profile_beta.py` → PASS.

- [ ] **Step 6: Commit.** `git commit -m "feat(posts): visibility column, public by default"`

---

### Task 2: Set visibility at publish and on edit

**Files:**
- Modify: `server/social/services.py` (`create_or_update_post`)
- Modify: `server/routers/uploads.py` (`PublishRequest`, the `create_or_update_post` call near line 900)
- Modify: `server/routers/social.py` (`PostUpdateRequest`, `update_post`)
- Create: `tests/test_private_posts.py`
- Modify: `tests/test_image_posts.py`

**Interfaces:**
- Consumes: `Post.visibility`, `POST_VISIBILITIES`.
- Produces: `create_or_update_post(..., visibility: str | None = None)`; `POST /api/uploads/publish` body field `visibility: "public" | "private"` (default `"public"`); `PATCH /api/posts/{id}` body field `visibility`, same values, optional.

- [ ] **Step 1: Create `tests/test_private_posts.py`.** Build its `app` fixture as `tests/test_reel_packs.py` does (routers `account_safety`, `social`, `packs`, `messages`, `reels`; `register`, `csrf_headers` helpers copied). Add a helper `make_post(app, owner_id, name, *, visibility="public", tags=()) -> Post` that calls `create_or_update_post` on `app.state.testing_session()` with `media_path=f"uploads/{name}.mp4"`, `media_type="video"`, commits and returns the row. Tests:

```python
def test_patch_switches_visibility_both_ways(client_alice, post):
    r = client_alice.patch(f"/api/posts/{post.id}", json={"visibility": "private"}, headers=csrf)
    assert r.status_code == 200 and r.json()["post"]["visibility"] == "private"
    r = client_alice.patch(f"/api/posts/{post.id}", json={"visibility": "public"}, headers=csrf)
    assert r.json()["post"]["visibility"] == "public"

def test_patch_without_visibility_keeps_it(...):       # PATCH {"title": "x"} on a private post -> still "private"
def test_only_the_owner_changes_visibility(...):       # bob PATCH -> 403 FORBIDDEN, row unchanged
def test_unknown_visibility_is_refused(...):           # {"visibility": "friends"} -> 422
def test_reimport_keeps_a_private_post_private(...):   # create_or_update_post again on the same media_path, no visibility argument -> row still "private"
```

- [ ] **Step 2: Add to `tests/test_image_posts.py`** a test beside `test_publish_multi_image_post`, using its `_publish` helper: body with `"visibility": "private"` → the created `Post` row has `visibility == "private"`; the same body without the field → `"public"`.

- [ ] **Step 3: Run both files** → the new tests FAIL (field ignored).

- [ ] **Step 4: Implement.**
  - `create_or_update_post`: new keyword `visibility: str | None = None`. Set `post.visibility` only when the argument is not `None`; a value outside `POST_VISIBILITIES` raises `ValueError`. A new row with no argument gets the column default.
  - `PublishRequest.visibility: Literal["public", "private"] = "public"`, passed to `create_or_update_post`.
  - `PostUpdateRequest.visibility: Literal["public", "private"] | None = None`. In `update_post`, when it is set and differs from the stored value: assign it and, after `db.commit()`, call `invalidate_reel_records()` from `server.social.services` so this process rebuilds the recommender catalog at once.

- [ ] **Step 5: Run** `.venv/bin/python -m pytest -q tests/test_private_posts.py tests/test_image_posts.py` → PASS.

- [ ] **Step 6: Commit.** `git commit -m "feat(posts): choose visibility at publish and on edit"`

---

### Task 3: Private posts leave every listing

After this task a private post is hidden everywhere, including its own link. Task 4 opens the link.

**Files:**
- Modify: `server/social/safety.py` (`unavailable_media_paths_for_viewer`)
- Modify: `server/routers/social.py` (`post_query`, `profile_stats`)
- Modify: `server/social/services.py` (`scoped_media_paths`)
- Modify: `server/social/recommendations/types.py` (`CatalogItem`), `server/social/recommendations/service.py` (`_catalog_base`, `_catalog`, `_materialize_creator_page`)
- Test: `tests/test_private_posts.py`

**Interfaces:**
- Produces:
  - `unavailable_media_paths_for_viewer(viewer_id, db=None, *, reveal_post_id: str | None = None, reveal_owner_id: str | None = None) -> set[str]`. Adds the media path of every `visibility == "private"` post, except the post whose id is `reveal_post_id` and the posts owned by `reveal_owner_id`. Both default to no exception. The existing reasons (not published, deleted, inactive owner, blocks) are never lifted by the reveal arguments.
  - `post_query(db, *, include_private_of: str | None = None)`. Filters to `visibility == "public"`, or also the private posts owned by `include_private_of`.
  - `CatalogItem.private: bool = False`.

- [ ] **Step 1: Write the leak sweep.** In `tests/test_private_posts.py`, a fixture `world` gives: alice with public post `pub` and private post `priv`, both tagged `sweep` with location `{"city": "Hanoi", "country": "Vietnam"}` and titles `sweep public` / `sweep private`; bob, who follows alice; a signed-out client. Make both posts visible to the reels routes the way `tests/test_reels_paging.py` does (its `scan` fixture patches the scan to return items for given `rel_path`s). Parametrize over the three viewers (`anon`, `bob`, `alice`) and assert `priv.id` and `priv.media_path` appear in none of:

```python
GET /api/reels?limit=50
GET /api/reels?limit=50&sort=newest
GET /api/reels?limit=50&search=sweep
GET /api/reels?limit=50&feed=following            # bob and alice only
GET /api/reels/feed?limit=50
GET /api/reels/tags/sweep
GET /api/reels/locations/<server.social.geo.location_key("Hanoi", "Vietnam")>
GET /api/reels/locations                           # Hanoi's entry counts 1 reel
GET /api/reels/locations/activity
GET /api/reels/tags?q=sweep                        # the "sweep" entry in "tags" counts 1 reel
GET /api/feed
GET /api/search/suggestions?q=sweep
GET /api/users/alice/posts                         # anon and bob only
GET /api/recommendations/creators                  # bob: alice's preview posts exclude priv
```

  Each response must still contain `pub`. For the two count lines, read the count field's name from the response of the same request made before `priv` exists; the response must be equal with and without `priv`. Add:

```python
def test_owner_sees_private_post_on_own_profile(...):   # alice GET /api/users/alice/posts -> has priv, card visibility == "private"
def test_profile_like_total_counts_public_only(...):    # one like on each post -> GET /api/users/alice "like_count" == 1
def test_saved_list_hides_a_post_turned_private(...):   # bob saves pub; alice PATCHes it private; bob GET /api/users/me/saved lacks it; PATCH public -> it returns
def test_a_post_turned_private_leaves_the_grid_at_once(...):  # Review Focus 1: GET /api/reels?limit=50 (for_you) has pub; PATCH private; same request again lacks it
```

- [ ] **Step 2: Run** → the sweep FAILS on every route.

- [ ] **Step 3: Implement the three chokepoints.**
  - `safety.py`: as in Interfaces. One more `union` branch on the existing query.
  - `post_query`: as in Interfaces. The `GET /api/users/{username}/posts` handler (`get_profile_posts`, line 883) passes `include_private_of=viewer_id if viewer_id == user.id else None`. The saved list, `/api/feed` and search suggestions keep the default.
  - `profile_stats`: add `Post.visibility == "public"` to `published`.
  - `scoped_media_paths`: keep a private row only when `author` is set and the row's `owner_id == viewer_id`; otherwise require `visibility == "public"`.

- [ ] **Step 4: Implement the recommender rule.**
  - `_catalog_base`: select `Post.visibility` and build `CatalogItem(..., private=post.visibility == "private")`. Private posts stay in the base so a private seed can be ranked and pinned.
  - `_catalog`: skip an item when `item.private and (allowed_post_ids is None or item.post_id not in allowed_post_ids)`. The route's allowlist comes from the viewer-filtered scan, so a private id is in it only when the route revealed it.
  - `_materialize_creator_page`: add `Post.visibility == "public"` to the `eligible_post_rows` filter.

- [ ] **Step 5: Run** `.venv/bin/python -m pytest -q tests/test_private_posts.py tests/test_recommendations.py tests/test_recommendation_catalog_cache.py tests/test_reels_paging.py tests/test_reels_discovery.py` → PASS.

- [ ] **Step 6: Commit.** `git commit -m "feat(posts): private posts leave every listing"`

---

### Task 4: The link opens it; the creator sees it in their own scope

**Files:**
- Modify: `server/routers/reels.py` (new `_hidden_paths`; call sites in `_recommendation_feed_data` ~line 1854 and `list_reels` ~2221; direct reveal calls in explore-preview ~2773 and `reels_player_inline` ~3471)
- Test: `tests/test_private_posts.py`

**Interfaces:**
- Consumes: `unavailable_media_paths_for_viewer(..., reveal_post_id=, reveal_owner_id=)`.
- Produces: `_hidden_paths(db: Session, viewer: AuthContext | None, *, post: str | None = None, author: str | None = None) -> set[str]` in `server/routers/reels.py`, used by the two list builders. It passes `reveal_post_id=post`, and `reveal_owner_id=viewer.user.id` only when `author` is set and equals the viewer's username (compare case-folded, as `scoped_media_paths` does).

- [ ] **Step 1: Write the failing tests.**

```python
def test_anyone_opens_a_private_post_by_link(world):
    for client in (anon, bob, alice):
        assert client.get(f"/api/posts/{priv.id}").json()["post"]["visibility"] == "private"
        r = client.get(f"/api/reels?post={priv.id}")
        assert r.status_code == 200 and r.json()["count"] == 1 and len(r.json()["videos"]) == 1
        feed = client.get(f"/api/reels/feed?surface=related&post={priv.id}&limit=5").json()
        assert feed["items"][0]["post_id"] == priv.id
        # what the SPA requests for /reels?post=<id> (ReelsPlayer.jsx), and what the DM card links to (MessagingPanel.jsx:50)
        assert priv.media_path in client.get(f"/api/reels/player-inline?post={priv.id}").text
        assert client.get(f"/api/posts/{priv.id}/share").json()["canonical_url"].endswith(f"/reels?post={priv.id}")

def test_interactions_stay_available_on_a_private_post(world):
    # bob: PUT like 200, POST comment 201/200, PUT save 200, POST /api/posts/{id}/view 200,
    # POST /api/reports {"target_type": "post", "target_id": priv.id, "reason": "spam"} -> success

def test_link_with_an_author_scope_matches_a_public_post(world):
    # anon GET /api/reels/feed?surface=related&post=<id>&author=alice&limit=5 for pub, then for priv:
    # same status, and the seed is first in both. A profile-scoped link must not break because the post is private.

def test_a_private_post_shared_in_a_dm_opens(world):
    # alice shares priv to bob (share-reel); bob lists the conversation: shared_post.id == priv.id, attachment_unavailable false
    # alice shares pub to bob, then PATCHes pub private: bob's message still carries shared_post

def test_owner_plays_own_private_post_from_profile(world):
    # alice GET /api/reels?author=alice&limit=50 -> has priv; bob and anon with author=alice -> lack it
    # alice GET /api/reels/feed?author=alice&limit=50 -> has priv
    # alice GET /api/reels/player-inline?play=<priv.media_path>&author=alice -> body has priv.media_path (profile tile link)
    # alice GET /api/reels/player-inline?folder=uploads&codec=all&sort=newest&play=<priv.media_path> -> body has it
    #   (the PLAY IN REELS button after publishing, MediaDialog.jsx:191: no author in the link)

def test_the_reveal_does_not_reach_other_viewers(world):          # Review Focus 2
    # alice opens ?post=priv and author=alice; then anon and bob GET /api/reels?limit=50 and /api/reels/feed -> lack priv

def test_scope_ids_and_play_cannot_reveal(world):                 # Review Focus 3
    # bob GET /api/reels/feed?surface=related&post=<pub.id>&scope_ids=<pub.id>,<priv.id> -> 200, no priv
    # bob and anon GET /api/reels/player-inline?play=<priv.media_path> -> 200, body lacks priv.media_path
    # the same with &author=alice -> 200, body lacks it

def test_the_link_still_404s_for_blocked_and_suspended(world):    # Review Focus 4
    # alice blocks bob -> bob GET /api/posts/{priv.id} 404 and /api/reels?post= 404
    # alice suspended -> anon GET /api/reels?post={priv.id} 404
```

- [ ] **Step 2: Run** → the link, owner-scope and DM-open tests FAIL (Task 3 hid the post everywhere); the cannot-reveal tests already pass.

- [ ] **Step 3: Implement `_hidden_paths`** and use it in `_recommendation_feed_data` (`post=post, author=author`) and `list_reels` (`post=post, author=author`), and, with a direct call to `unavailable_media_paths_for_viewer(..., reveal_owner_id=<the viewer's id>)`, the two places that look up one named item for the signed-in viewer: `reels_player_inline`'s `play` lookup (it matches only the path in `play`, so a creator's own private path opens and nobody else's does) and explore-preview (the creator's own private tiles get previews). `/api/reels/player` and `/api/reels/player-inline` need no other change: both build their list through `_recommendation_feed_data`. Leave the tag, location, activity and suggestion routes on the plain call.

- [ ] **Step 4: Run** `.venv/bin/python -m pytest -q tests/test_private_posts.py tests/test_reels_paging.py tests/test_messaging.py tests/test_edge_cache.py` → PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(posts): a private post opens by link and in its creator's own scope"`

---

### Task 5: Reel Packs

**Files:**
- Modify: `server/routers/packs.py` (`active_item` line 97, `validate_posts` line 204)
- Test: `tests/test_reel_packs.py`

**Interfaces:**
- Produces: `active_item(item)` also requires that the post is public, or that `item.pack.visibility == "unlisted"` and `item.post.owner_id == item.pack.owner_id`. `member_available_for_viewer`, `playable_items`, `cover_cards`, `serialize_pack` and the pack player feed inherit it unchanged.

- [ ] **Step 1: Write the failing tests** in `tests/test_reel_packs.py`, with the file's own helpers:

```python
def test_private_member_is_unavailable_in_a_public_pack(...):
    # alice's public pack of 4 own posts; one PATCHed private.
    # anon and bob GET /api/packs/{id}: that item has available False and post None; it is not in cover_items; playable_count == 3

def test_unlisted_pack_link_shows_its_owners_private_posts(...):
    # alice's UNLISTED pack, 3 own posts, all private. anon GET /api/packs/{id}: every item available, playable_count == 3
    # GET /api/reels/player-inline?pack_id={id} as anon -> 200 and the body holds all three media paths

def test_other_creators_private_post_stays_hidden_in_an_unlisted_pack(...):
    # bob's unlisted pack holds alice's post; alice PATCHes it private -> anon and bob see that item unavailable

def test_only_the_owner_adds_a_private_post_to_a_pack(...):
    # bob POST /api/packs/{bob pack}/items with alice's private post -> 422 INVALID_PACK_ITEM
    # alice adds her own private post to her own pack -> 200

def test_unlisted_pack_made_public_drops_private_members(...):     # Review Focus 5
    # alice's published unlisted pack: 2 public + 2 private own posts. PATCH {"visibility": "public"} -> 200
    # (the handler at packs.py:712 keeps the pack live below the minimum), then
    # playable_count == 2, needs_repair True, and GET /api/packs (discovery) omits the pack
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `active_item`: the rule in Interfaces. `validate_posts`: a post is also invalid when `visibility == "private"` and `owner_id` differs from the pack owner's id (same `INVALID_PACK_ITEM` error).

- [ ] **Step 4: Run** `.venv/bin/python -m pytest -q tests/test_reel_packs.py tests/test_private_posts.py` → PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(packs): private members hide, except the owner's in an unlisted pack"`

---

### Task 6: Publish form toggle

**Files:**
- Modify: `web/src/components/upload/mediaItems.js` (`emptyDraft` line 36, `publishBody` line 100)
- Modify: `web/src/components/upload/PostForm.jsx`
- Test: `web/src/components/upload/mediaItems.test.js`; create `web/src/components/upload/PostForm.test.jsx`

**Interfaces:**
- Consumes: publish body field `visibility`.
- Produces: `draft.visibility` (`'public'` | `'private'`), default `'public'`.

- [ ] **Step 1: Write the failing tests.**

```js
// mediaItems.test.js, in describe('publishBody')
expect(publishBody([a], draft, null).visibility).toBe('public');
expect(publishBody([a], { ...draft, visibility: 'private' }, null).visibility).toBe('private');
expect(emptyDraft('t').visibility).toBe('public');

// PostForm.test.jsx
render(<PostForm draft={emptyDraft('t')} onChange={onChange} />);
await user.click(screen.getByLabelText('PRIVATE POST'));
expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'private' }));
// with draft.visibility === 'private': the text 'Only you and anyone with the link can see it.' is shown
```

- [ ] **Step 2: Run** `cd web && npx vitest run src/components/upload` → FAIL.

- [ ] **Step 3: Implement.** `emptyDraft` returns `visibility: 'public'`. `publishBody` adds `visibility: draft.visibility || 'public'`. `PostForm`: after the LOCATION field, a `sx-studio-field` holding `ToggleRow` (from `../ui/controls.jsx`) with `label="PRIVATE POST"`, `checked={draft.visibility === 'private'}`, `onChange={(on) => set({ visibility: on ? 'private' : 'public' })}`, and under it, only while checked, `<Mono>Only you and anyone with the link can see it.</Mono>`.

- [ ] **Step 4: Run** `cd web && npx vitest run src/components/upload src/pages/UploadPage.test.jsx` → PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(upload): PRIVATE POST toggle on the post form"`

---

### Task 7: Profile edit toggle and PRIVATE badge

**Files:**
- Modify: `web/src/pages/ProfilePage.jsx` (`beginEditPost`, `saveEditedPost`, the EDIT POST dialog)
- Modify: `web/src/components/explore/ExploreTile.jsx` (the `badge` line, ~171)
- Test: `web/src/pages/ProfilePage.test.jsx`, `web/src/components/explore/ExploreTile.test.jsx`

**Interfaces:**
- Consumes: card field `visibility`; `PATCH /api/posts/{id}` field `visibility`.

- [ ] **Step 1: Write the failing tests.**

```js
// ExploreTile.test.jsx
// a video with visibility: 'private' renders the text 'PRIVATE' in its badge; one with 'public' does not

// ProfilePage.test.jsx, new describe('ProfilePage private posts')
// own profile with one public post: open EDIT, tick 'PRIVATE POST', SAVE POST ->
//   api.patch called with '/api/posts/<id>' and a body containing { visibility: 'private' }
//   after the mocked response ({ post: { ...post, visibility: 'private' } }) the tile shows 'PRIVATE'
// EDIT on a private post opens with the toggle ticked and the help line shown
```

- [ ] **Step 2: Run** `cd web && npx vitest run src/pages/ProfilePage.test.jsx src/components/explore/ExploreTile.test.jsx` → FAIL.

- [ ] **Step 3: Implement.** `ExploreTile`: prepend `'PRIVATE'` to the `badge` parts when `video.visibility === 'private'`. `ProfilePage`: `editForm.visibility` set from `post.visibility || 'public'` in `beginEditPost`; `saveEditedPost` sends it; the dialog gets the same `ToggleRow` and help line as Task 6, after the TAGS field.

- [ ] **Step 4: Run** the two files, then `cd web && npx vitest run` and `npx vite build` → all PASS, build clean.

- [ ] **Step 5: Commit.** `git commit -m "feat(profile): switch a post private or public, PRIVATE badge on tiles"`

---

### Task 8: Whole-suite run, live check, docs

**Files:**
- Modify: `docs/todolist.md` (tick the private posts item; add it to "Done" with the date and test files)
- Modify: `docs/to-beta.md` ("Open items by priority" group 1 line; line 502 "confirm the final revision is `20261101_0020`" and line 745 "Current schema head: `20261101_0020`" → `20261116_0027`; leave the dated 2026-11-01 records as they are)

`web/src/pages/PrivacyPage.jsx` has no list of who can see a post, so it does not change.

- [ ] **Step 1:** `make test` → backend and frontend all PASS. Record the two counts.
- [ ] **Step 2:** `.venv/bin/python -m alembic upgrade head` on a copy of the dev database, then `alembic current` → `20261116_0027 (head)`.
- [ ] **Step 3: Live check on local staging** (`docs/local-staging.md`), two browsers, accounts A and B:
  1. A publishes a video with PRIVATE POST ticked. A's profile shows it with the PRIVATE badge.
  2. A copies the link with SHARE. A private window (signed out) opens it and the reel plays.
  3. B's Explore, search for its title, its tag page and A's profile do not show it. B opens the link: it plays; B likes and comments.
  4. A shares the private post to B in a DM. B opens it from the message and it plays.
  5. Right after publishing a second private post, A clicks PLAY IN REELS in the upload dialog: the player starts on that post.
  6. A edits a public post to private: within about 30 s it is gone from the signed-out Explore.
  7. A makes an UNLISTED pack of three private posts; the signed-out window opens the pack link and all three play.
- [ ] **Step 4:** Update the docs listed above with what was run and what was not.
- [ ] **Step 5: Commit.** `git commit -m "docs: private posts done, schema 20261116_0027"`

Not covered by this plan: a PRIVATE indicator inside the player, a way to switch visibility from the player's More menu, and purging the edge cache when a post turns private.
