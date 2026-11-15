# P0 Public Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five abuse paths that a stranger can use on the public site today.

**Architecture:** Five independent server-side fixes, one per task, each with its own tests. No schema change, no new environment variable, no frontend change. A last task records the result in the beta checklist.

**Tech Stack:** Python, FastAPI, SQLAlchemy, pytest.

**Spec:** `docs/to-beta.md`, the five items marked "New (2026-10-30)": `?refresh=true` (Processing API section), player routes (Recommendation section), `/docs` (Network section), model-info cache (Network section), map-tile proxy (Network section).

## Global Constraints

- Base branch: `dev` (owner's decision 2026-11-14: production is not public yet). Work on a new branch `fix/p0-public-hardening`. Production deploys `main` (`deploy/deploy.sh`).
- In a worktree, run pytest with `PYTHON_DOTENV_DISABLED=1`, or the main checkout's `.env` is loaded.
- Find code by function name. Line numbers differ between `main`, `dev` and feature branches.
- Change only the lines each task names. Do not reformat or refactor neighbouring code.
- No new environment variables. The new limits are module constants.
- Commit messages follow the repository style (`fix(scope): …`) and carry no `Co-Authored-By` or "Generated with" line.
- Existing error codes stay: `RATE_LIMITED` (shared limiter), `MAP_TILE_RATE_LIMITED` (tile proxy).
- Test runner: `.venv/bin/python -m pytest -q <file>`.

## Review Focus

1. A reader process (`SX_ROLE=reader`) serves `/api/reels/player`. The limit must be counted in the database (`shared=True`), under the same `rec-feed:` key as the feed, or each process gets its own budget. Test in Task 3.
2. A player opened with `pack_id` writes no recommendation rows. It must keep working after the `rec-feed` budget is used up. Test in Task 3.
3. In production, `/docs` and `/openapi.json` fall through to the SPA catch-all and answer 200 with the HTML shell. The answer must not contain the schema. Test in Task 1.
4. The tile cache directory can hold leftover `.tmp-*` files, or not exist yet. Pruning must not count the first or fail on the second. Test in Task 5.
5. A user pastes a fal playground URL with a query string instead of a bare model id. It must still resolve to the normalized id. Test in Task 4.

---

### Task 1: No API docs in production

**Files:**
- Modify: `server/app.py` (`create_app`)
- Test: `tests/test_production_boot.py`, `tests/test_route_access.py`

- [ ] **Step 1: Write the failing tests**

In `tests/test_production_boot.py`, next to `test_production_app_drops_media_mount_and_compare`:

```python
DOCS_PATHS = {"/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"}


def test_production_app_serves_no_api_docs(monkeypatch):
    monkeypatch.setenv("SX_ENV", "production")
    assert DOCS_PATHS.isdisjoint(_paths(app_module.create_app()))


def test_dev_app_keeps_api_docs(monkeypatch):
    monkeypatch.delenv("SX_ENV", raising=False)
    assert DOCS_PATHS <= _paths(app_module.create_app())
```

In `tests/test_route_access.py`:
- In `test_only_known_routes_are_left_out_of_the_schema`, delete the four `("Route", "GET", …)` entries for `/docs`, `/docs/oauth2-redirect`, `/openapi.json` and `/redoc`. Drop "and FastAPI's own docs pages" from the comment above.
- Add:

```python
def test_production_serves_no_openapi_schema(production_app):
    response = TestClient(production_app).get("/openapi.json")
    assert response.headers["content-type"].startswith("text/html")
    assert '"paths"' not in response.text
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `.venv/bin/python -m pytest -q tests/test_production_boot.py tests/test_route_access.py`
Expected: `test_production_app_serves_no_api_docs`, `test_only_known_routes_are_left_out_of_the_schema` and `test_production_serves_no_openapi_schema` fail.

- [ ] **Step 3: Turn the docs off in production**

In `create_app`, pass `docs_url=None, redoc_url=None, openapi_url=None` to `FastAPI(...)` when `is_production()` is true (already imported in `server/app.py`). Dev keeps the defaults. `application.openapi()` still builds the schema in tests, so `_operations()` in `tests/test_route_access.py` needs no change. Leave `_CSP_EXEMPT` in `server/security_headers.py` as it is; dev still serves the pages.

- [ ] **Step 4: Run the tests and see them pass**

Run: `.venv/bin/python -m pytest -q tests/test_production_boot.py tests/test_route_access.py tests/test_security_headers.py`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/app.py tests/test_production_boot.py tests/test_route_access.py
git commit -m "fix(app): serve no API docs or OpenAPI schema in production"
```

---

### Task 2: `?refresh=true` re-scans for admins only

**Files:**
- Modify: `server/routers/reels.py` (`_recommendation_feed_data`, `list_reels`, `get_reel_tag`, `get_reel_location`)
- Test: `tests/test_reels_prod_gates.py`

**Interfaces:**
- Produces: `_admin_refresh(refresh: bool, viewer: AuthContext | None) -> bool` in `server/routers/reels.py`.

- [ ] **Step 1: Write the failing test**

In `tests/test_reels_prod_gates.py`. The test counts calls to `reels.post_media_items`, which `_scan_cached` calls once per re-scan. One post must exist, because an empty scan is never cached.

```python
REFRESH_URLS = [
    "/api/reels?refresh=true",
    "/api/reels/feed?refresh=true",
    "/api/reels/tags/any?refresh=true",
    "/api/reels/locations/any?refresh=true",
]


@pytest.mark.parametrize("url", REFRESH_URLS)
def test_refresh_rescans_for_admins_only(app, monkeypatch, url):
    monkeypatch.setenv("SX_ADMIN_USERS", "scan_admin")
    monkeypatch.setitem(reels._scan_cache, "at", 0.0)
    monkeypatch.setitem(reels._scan_cache, "data", [])
    scans = []
    real = reels.post_media_items
    monkeypatch.setattr(reels, "post_media_items", lambda db: scans.append(1) or real(db))
    with TestClient(app) as anonymous, TestClient(app) as member, TestClient(app) as admin:
        user = register(member, "scan_member")
        register(admin, "scan_admin")
        add_post(app, user["id"], "uploads/scan.mp4")
        anonymous.get("/api/reels")          # warms the cache
        assert len(scans) == 1
        anonymous.get(url)
        member.get(url)
        assert len(scans) == 1               # ignored for both
        admin.get(url)
        assert len(scans) == 2
```

All four URLs answer 200 in this fixture (checked 2026-11-14). `SX_ADMIN_USERS` gives the registering account `role == "admin"` through `bootstrap_role` in `server/routers/social.py`.

- [ ] **Step 2: Run the test and see it fail**

Run: `.venv/bin/python -m pytest -q tests/test_reels_prod_gates.py -k refresh`
Expected: 4 failures, each `assert 3 == 1` (checked 2026-11-14).

- [ ] **Step 3: Gate the reset**

Add `_admin_refresh(refresh: bool, viewer: AuthContext | None) -> bool` next to `invalidate_scan_cache`: true only when `refresh` is set and `viewer` is an `AuthContext` whose `user.role == "admin"`. Replace each of the four `if refresh:` lines that set `_scan_cache["at"] = 0.0` with `if _admin_refresh(refresh, viewer):`. Keep the `refresh` query parameters; other callers are refused silently, as `/api/health` does. Do not touch `server/edge_cache.py`. The two other resets in `reels.py` (`generate_proxies`, which needs `require_admin_csrf`, and the spatialize job) already sit behind sign-in; leave them.

- [ ] **Step 4: Run the tests and see them pass**

Run: `.venv/bin/python -m pytest -q tests/test_reels_prod_gates.py tests/test_edge_cache.py tests/test_read_service.py`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/routers/reels.py tests/test_reels_prod_gates.py
git commit -m "fix(reels): honour ?refresh=true for admins only"
```

---

### Task 3: Player routes share the feed's rate limit

**Files:**
- Modify: `server/routers/reels.py` (`reels_feed`, `_recommendation_feed_data`)
- Test: `tests/test_reels_prod_gates.py`

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.parametrize("player", ["/api/reels/player", "/api/reels/player-inline"])
def test_player_routes_share_the_feed_limit(app, player):
    with TestClient(app) as client:
        for _ in range(60):
            assert client.get(player).status_code == 200
        for url in (player, "/api/reels/feed"):
            refused = client.get(url)
            assert refused.status_code == 429
            assert refused.json()["detail"]["code"] == "RATE_LIMITED"


def test_pack_player_is_outside_the_feed_limit(app):
    with TestClient(app) as client:
        for _ in range(60):
            client.get("/api/reels/feed")
        assert client.get("/api/reels/feed").status_code == 429
        # An unknown pack answers as it did before; it is never a 429.
        assert client.get("/api/reels/player?pack_id=missing").status_code != 429
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `.venv/bin/python -m pytest -q tests/test_reels_prod_gates.py -k "player"`
Expected: the two parametrized cases fail with `assert 200 == 429` (checked 2026-11-14). The pack test passes already; it guards Step 3.

- [ ] **Step 3: Move the limit into the shared function**

Move these two lines from `reels_feed` to the top of `_recommendation_feed_data`, before the refresh check:

```python
limiter_key = viewer.user.id if isinstance(viewer, AuthContext) else f"ip:{request_identity(request)}"
rate_limiter.check(db, f"rec-feed:{limiter_key}", 60, 60, shared=True)
```

`reels_feed`, `reels_player` and `reels_player_inline` are its only callers, so all three now share one budget of 60 a minute per user or IP. `shared=True` must stay: the player routes are in `READ_PATHS` (`server/read_routes.py`). The `pack_id` branch calls `_pack_feed_data` and stays unlimited.

**Deploy gate.** `docs/to-beta.md` still lists "confirm from two different networks that rate limits give each visitor a separate bucket" as open. If every anonymous visitor shares one identity behind the Tunnel, this change makes the player page answer 429 for all of them after 60 loads a minute. Before this task ships, load `/api/reels/player` from two networks (for example home Wi-Fi and a phone on cellular) and check that each gets its own 60.

- [ ] **Step 4: Run the tests and see them pass**

Run: `.venv/bin/python -m pytest -q tests/test_reels_prod_gates.py tests/test_recommendations.py tests/test_player_template.py tests/test_read_service.py tests/test_rate_limiter.py`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/routers/reels.py tests/test_reels_prod_gates.py
git commit -m "fix(reels): player routes count against the rec-feed rate limit"
```

---

### Task 4: Bounded model-info cache

**Files:**
- Modify: `server/routers/model_info.py`
- Test: `tests/test_model_info_auth.py`

- [ ] **Step 1: Write the failing tests**

Use the file's existing sign-in helper for `client`.

```python
def test_model_info_cache_is_bounded(app, monkeypatch):
    monkeypatch.setattr(model_info, "_CACHE_MAX_ENTRIES", 3)
    monkeypatch.setattr(model_info, "MODEL_INFO_FETCHES_PER_MINUTE", 100)
    with TestClient(app) as client:
        register(client, "cache_cap")
        for index in range(5):
            assert client.get("/api/config/model-info", params={"model": f"fal-ai/m{index}"}).status_code == 200
        assert sorted(model_info._cache) == ["fal-ai/m2|upscale", "fal-ai/m3|upscale", "fal-ai/m4|upscale"]


def test_model_info_refuses_unknown_kinds_and_long_ids(app):
    with TestClient(app) as client:
        register(client, "cache_inputs")
        assert client.get("/api/config/model-info", params={"model": "fal-ai/a", "kind": "bogus"}).status_code == 422
        assert client.get("/api/config/model-info", params={"model": "a" * 301}).status_code == 422
        assert app.state.fetched == []


def test_model_info_accepts_a_pasted_playground_url(app):
    with TestClient(app) as client:
        register(client, "cache_url")
        url = "https://fal.ai/models/fal-ai/foo/bar/playground?share=abc#x"
        assert client.get("/api/config/model-info", params={"model": url, "kind": "outpaint"}).status_code == 200
        assert app.state.fetched == [("fal-ai/foo/bar/playground", "outpaint")]


def test_model_info_caches_each_casing_on_its_own(app):
    with TestClient(app) as client:
        register(client, "cache_case")
        client.get("/api/config/model-info", params={"model": "fal-ai/Foo"})
        client.get("/api/config/model-info", params={"model": "fal-ai/foo"})
        assert app.state.fetched == [("fal-ai/Foo", "upscale"), ("fal-ai/foo", "upscale")]
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `.venv/bin/python -m pytest -q tests/test_model_info_auth.py`
Expected: three new tests fail: `_CACHE_MAX_ENTRIES` missing; 200 instead of 422; the casing test sees only `[("fal-ai/Foo", "upscale")]`. The playground-URL test passes already.

- [ ] **Step 3: Bound the cache and the inputs**

- Add `_CACHE_MAX_ENTRIES = 256` next to `_CACHE_TTL_S`.
- Key the cache on the id as sent to fal: `key = f"{norm}|{kind}"` (drop `.lower()` at `:281`). Today the first caller's casing decides what every caller sees for an hour; `docs/to-beta.md` asks for this fix.
- `model`: `Query(..., max_length=300, …)`.
- `kind`: type it `Literal["outpaint", "upscale", "image_upscale", "image_outpaint"]`, default `"upscale"`. These are the four values the SPA sends (`CustomModelPanel` callers).
- Before the insert in `get_model_info`, inside `_cache_lock`: while the cache holds `_CACHE_MAX_ENTRIES` or more, first drop every entry older than `_CACHE_TTL_S`; if it is still full, drop the entry with the oldest timestamp. Read `_CACHE_MAX_ENTRIES` at call time so the test's monkeypatch applies.

- [ ] **Step 4: Run the tests and see them pass**

Run: `.venv/bin/python -m pytest -q tests/test_model_info_auth.py`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/routers/model_info.py tests/test_model_info_auth.py
git commit -m "fix(config): cap the model-info cache, key it as sent, validate model and kind"
```

---

### Task 5: Map-tile proxy: global budget, pruned cache, swept limiter

**Files:**
- Modify: `server/routers/map_tiles.py`
- Test: `tests/test_map_tiles.py`

**Interfaces:**
- Produces, all in `server/routers/map_tiles.py`:
  - `GLOBAL_RATE_LIMIT_COUNT = 6000`, `GLOBAL_RATE_LIMIT_WINDOW_S = 3600.0`
  - `_global_hits: collections.deque[float]`, `_check_global_rate() -> bool`
  - `_next_rate_sweep: float` (monotonic time of the next sweep of `_rate_hits`)
  - `MAX_CACHE_BYTES = 2 << 30`, `CACHE_PRUNE_TARGET = 0.8`
  - `_cache_bytes: int | None` (`None` means not measured yet), `_prune_cache() -> None`

- [ ] **Step 1: Extend the fixture and write the failing tests**

Add `import os` and `import time` to the test file. In the `client` fixture, next to `_rate_hits.clear()`: clear `map_tiles._global_hits`, and set `map_tiles._cache_bytes = None` and `map_tiles._next_rate_sweep = 0.0` with `monkeypatch.setattr`.

```python
def test_global_fetch_budget_counts_misses_from_every_client(client, monkeypatch):
    monkeypatch.setattr(map_tiles, "_fetch_upstream", _stub_upstream(client))
    monkeypatch.setattr(map_tiles, "GLOBAL_RATE_LIMIT_COUNT", 2)
    assert client.get("/api/reels/map-tiles/3/0/0.png").status_code == 200
    assert client.get("/api/reels/map-tiles/3/1/0.png").status_code == 200
    blocked = client.get("/api/reels/map-tiles/3/2/0.png")
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["code"] == "MAP_TILE_RATE_LIMITED"
    assert blocked.headers["retry-after"] == "60"
    assert client.get("/api/reels/map-tiles/3/0/0.png").status_code == 200  # cached tiles still serve
    assert len(client.fetch_calls) == 2


def test_a_client_over_its_own_limit_spends_no_global_budget(client, monkeypatch):
    monkeypatch.setattr(map_tiles, "_fetch_upstream", _stub_upstream(client))
    monkeypatch.setattr(map_tiles, "RATE_LIMIT_COUNT", 1)
    client.get("/api/reels/map-tiles/3/0/0.png")
    assert client.get("/api/reels/map-tiles/3/1/0.png").status_code == 429
    assert len(map_tiles._global_hits) == 1


def test_idle_clients_are_dropped_from_the_rate_table(client):
    with map_tiles._rate_lock:
        map_tiles._rate_hits["idle"] = [time.monotonic() - map_tiles.RATE_LIMIT_WINDOW_S - 1]
    assert map_tiles._check_fetch_rate("busy")
    assert set(map_tiles._rate_hits) == {"busy"}


def test_cache_is_pruned_oldest_first_when_over_the_cap(client, monkeypatch):
    monkeypatch.setattr(map_tiles, "_fetch_upstream", _stub_upstream(client))
    monkeypatch.setattr(map_tiles, "MAX_CACHE_BYTES", 3 * len(FAKE_TILE_PNG))
    for x in range(4):
        assert client.get(f"/api/reels/map-tiles/3/{x}/0.png").status_code == 200
        os.utime(map_tiles._tile_cache_path(3, x, 0), (1000 + x, 1000 + x))
    # The 4th store passes the cap; pruning to 80% (2.4 tiles) keeps the newest two.
    assert [map_tiles._tile_cache_path(3, x, 0).is_file() for x in range(4)] == [False, False, True, True]
    assert client.get("/api/reels/map-tiles/3/0/0.png").status_code == 200  # fetched again
    assert len(client.fetch_calls) == 5


def test_prune_ignores_temp_files_and_a_missing_directory(client, monkeypatch):
    map_tiles._prune_cache()  # the cache directory does not exist yet
    monkeypatch.setattr(map_tiles, "_fetch_upstream", _stub_upstream(client))
    client.get("/api/reels/map-tiles/3/0/0.png")
    leftover = map_tiles._tile_cache_path(3, 0, 0).with_name("0.png.tmp-123")
    leftover.write_bytes(b"x" * (4 << 20))
    monkeypatch.setattr(map_tiles, "MAX_CACHE_BYTES", 2 * len(FAKE_TILE_PNG))
    map_tiles._prune_cache()
    assert map_tiles._tile_cache_path(3, 0, 0).is_file()
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `.venv/bin/python -m pytest -q tests/test_map_tiles.py`
Expected: the five new tests fail on missing names.

- [ ] **Step 3: Add the global budget**

`_check_global_rate() -> bool`: under `_rate_lock`, drop entries of `_global_hits` older than `GLOBAL_RATE_LIMIT_WINDOW_S`, return False when `GLOBAL_RATE_LIMIT_COUNT` remain, otherwise append now and return True. In `_serve_tile`, call it after `_check_fetch_rate(identity)` passes, and raise the same 429 (`MAP_TILE_RATE_LIMITED`, `Retry-After: 60`) when it refuses. Update the comment above `RATE_LIMIT_COUNT` to say there is also a budget for all clients together.

- [ ] **Step 4: Sweep the per-IP table**

In `_check_fetch_rate`, when `time.monotonic() >= _next_rate_sweep`: delete every key of `_rate_hits` whose newest hit is at or before the cutoff, and set `_next_rate_sweep` to now plus `RATE_LIMIT_WINDOW_S`.

- [ ] **Step 5: Cap the disk cache**

- `_prune_cache() -> None`: list `*.png` files under `_cache_dir()` with size and mtime. Skip anything that is not a regular file ending in `.png`, and any file that vanishes while listing. When the total is over `MAX_CACHE_BYTES`, delete oldest first (`unlink(missing_ok=True)`) until the total is at or under `MAX_CACHE_BYTES * CACHE_PRUNE_TARGET`. Store the resulting total in `_cache_bytes`. A missing directory gives a total of 0.
- In `_store_tile`, after a successful `os.replace`: under a new module lock, if `_cache_bytes` is `None` call `_prune_cache()` (which measures), else add `len(data)`; then call `_prune_cache()` if `_cache_bytes > MAX_CACHE_BYTES`.
- Eviction is by fetch time, not last use. A pruned tile is fetched again on the next request.

- [ ] **Step 6: Run the tests and see them pass**

Run: `.venv/bin/python -m pytest -q tests/test_map_tiles.py`
Expected: all pass, including the existing `test_fetch_rate_limit_counts_misses_only`.

- [ ] **Step 7: Commit**

```bash
git add server/routers/map_tiles.py tests/test_map_tiles.py
git commit -m "fix(map-tiles): global fetch budget, capped disk cache, swept rate table"
```

---

### Task 6: Full suite and checklist record

**Files:**
- Modify: `docs/to-beta.md`, `docs/todolist.md`

- [ ] **Step 1: Run the whole backend suite**

Run: `.venv/bin/python -m pytest -q tests`
Expected: all pass. Record the count.

- [ ] **Step 2: Exercise the changes on a local production-mode server**

Start the local staging stack (`docs/local-staging.md`), then:

```bash
curl -s -o /dev/null -w '%{content_type}\n' http://localhost:<port>/openapi.json
for i in $(seq 1 61); do curl -s -o /dev/null -w '%{http_code}\n' http://localhost:<port>/api/reels/player; done | sort | uniq -c
```

Expected: `text/html…` for the first; sixty `200` and one `429` for the second.

- [ ] **Step 3: Update the checklists**

In `docs/to-beta.md`:
- Tick the five "New (2026-10-30)" items with the date and a one-line result. On the map-tile item, add "**Remaining:** the provider decision (stay on OSM or set `SX_MAP_TILES_URL`)".
- Tick the suspended-comment-authors item (`GET /api/posts/{post_id}/comments`), fixed in `5b3e518`, once that commit is on the same branch.
- Add the test count under "Latest recorded automated verification", and the date to "Last updated".

In `docs/todolist.md`: add one Done line for this batch.

- [ ] **Step 4: Commit**

```bash
git add docs/to-beta.md docs/todolist.md
git commit -m "docs(beta): record the public hardening batch"
```

---

## Open decisions for the owner

1. **Base branch.** Decided 2026-11-14: `dev`, because production is not public yet.
2. **Tile provider.** The plan keeps OpenStreetMap and limits the proxy to 6,000 upstream fetches an hour for all clients together. The alternative is a keyed provider whose plan allows proxying, set through `SX_MAP_TILES_URL`. The code is the same either way.
3. **Limits.** `GLOBAL_RATE_LIMIT_COUNT = 6000` an hour, `MAX_CACHE_BYTES` = 2 GB, `_CACHE_MAX_ENTRIES = 256`. These are estimates for an invite beta, not measured values. Trade-off: one client at its own cap of 720 a minute empties the shared hour budget in about 8 minutes, and new tiles then stop for everyone until hits age out. Cached tiles still serve. `Retry-After: 60` under an hour window also sends clients back before the budget has room.
4. **Rate-limit buckets (gate for Task 3).** Confirmed 2026-11-14 on `https://echomultiverse.com/api/reels/feed`: with the home IP's bucket full (429), a request from a Surfshark exit in Singapore got 200, and the home IP still got 429 right after.
