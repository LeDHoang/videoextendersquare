"""A failed slide lookup must never cache or seed slide tiles.

_scan_cached hides the extra images of multi-image posts behind their post.
It swallowed any slide_media_paths failure, fell back to ``set()`` and
cached that unfiltered scan for _SCAN_TTL, so every request in that window
(even with the database healthy again) served the slides as standalone
tiles. A slide is not any post's media_path, so _build_payload sent it
through _get_meta_for_video into _seed_meta: fabricated tags, location,
likes and views. A failed slide lookup now raises the same 503 +
Retry-After as the batched metadata lookups (see
tests/test_reels_metadata_failures.py) and leaves the cache stale.
"""

from __future__ import annotations

import json
import time

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from sqlalchemy.orm import sessionmaker

from server.routers import reels
from server.social import database, safety
from server.social.database import Base, get_db
from server.social.models import User
from server.social.services import create_or_update_post


COVER = "uploads/cover.png"
SLIDE = "uploads/cover-slide-2.png"
LOCAL = "uploads/legacy-local.png"
SCAN_ROWS = [
    {
        "rel_path": rel_path,
        "path": f"output/{rel_path}",
        "filename": rel_path.split("/")[-1],
        "folder": "uploads",
        "size_human": "1 KB",
        "mtime": 100 - index,
        "media_type": "image",
    }
    for index, rel_path in enumerate((COVER, SLIDE, LOCAL))
]
FILTERED = [COVER, LOCAL]
LEGACY_META = {
    LOCAL: {
        "title": "Local legacy",
        "tags": ["night-city"],
        "location": {"city": "Tokyo", "country": "Japan"},
        "likes": 3,
        "views": 30,
    },
}


@pytest.fixture
def env(tmp_path, monkeypatch):
    # One-connection pool with a short timeout so a held connection starves
    # the slide lookup with a real sqlalchemy TimeoutError.
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "slides.db"),
        connect_args={"check_same_thread": False},
        pool_size=1,
        max_overflow=0,
        pool_timeout=0.2,
    )
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", testing_session)
    monkeypatch.setattr(safety, "SessionLocal", testing_session)

    meta_file = tmp_path / "reels_meta.json"
    meta_file.write_text(json.dumps(LEGACY_META), encoding="utf-8")
    monkeypatch.setattr(reels, "META_FILE", meta_file)
    monkeypatch.setattr(reels, "COMMENTS_FILE", tmp_path / "reels_comments.json")
    monkeypatch.setattr(reels.SM, "scan_output_media", lambda _root: [dict(row) for row in SCAN_ROWS])
    monkeypatch.setitem(reels._scan_cache, "at", 0.0)
    monkeypatch.setitem(reels._scan_cache, "data", [])

    with testing_session() as db:
        owner = User(username="owner", username_norm="owner", display_name="Owner", status="active")
        db.add(owner)
        db.flush()
        post = create_or_update_post(
            db,
            media_path=COVER,
            media_type="image",
            owner=owner,
            title="Two-image post",
            tags=["night-city"],
            location={"city": "Tokyo", "country": "Japan", "lat": 35.68, "lon": 139.69},
            slide_paths=[SLIDE],
        )
        db.commit()
        post_id = post.id

    seeded: list[str] = []
    real_seed_meta = reels._seed_meta

    def recording_seed_meta(rel_path, filename, rng):
        seeded.append(rel_path)
        return real_seed_meta(rel_path, filename, rng)

    monkeypatch.setattr(reels, "_seed_meta", recording_seed_meta)

    application = FastAPI()
    application.include_router(reels.router)

    def override_get_db():
        db = testing_session()
        try:
            yield db
        finally:
            db.close()

    application.dependency_overrides[get_db] = override_get_db
    yield {"engine": engine, "app": application, "post_id": post_id, "seeded": seeded}
    engine.dispose()


def _flaky_slide_lookup(monkeypatch) -> dict:
    """Fail only the slide lookup until ``state["fail"]`` is cleared."""
    real = reels.slide_media_paths
    state = {"fail": True, "calls": 0}

    def flaky(db=None):
        state["calls"] += 1
        if state["fail"]:
            raise OperationalError(
                "SELECT post_slides.media_path", {}, Exception("server closed the connection unexpectedly")
            )
        return real(db)

    monkeypatch.setattr(reels, "slide_media_paths", flaky)
    return state


def _rel_paths(rows: list[dict]) -> list[str]:
    return [row["rel_path"] for row in rows]


def _assert_retryable_503(raised: pytest.ExceptionInfo, cause: type[Exception]) -> None:
    assert raised.value.status_code == 503
    assert raised.value.headers == {"Retry-After": str(reels.REEL_DATA_RETRY_AFTER_SECONDS)}
    assert isinstance(raised.value.__cause__, cause)


def test_failed_slide_lookup_neither_caches_nor_seeds_slide_tiles(env, monkeypatch):
    lookup = _flaky_slide_lookup(monkeypatch)
    client = TestClient(env["app"])

    failed = client.get("/api/reels")
    assert failed.status_code == 503, failed.text
    assert failed.headers["retry-after"] == str(reels.REEL_DATA_RETRY_AFTER_SECONDS)
    assert set(failed.json()) == {"detail"}
    # Nothing cached: no unfiltered scan, and no fresh timestamp either.
    assert reels._scan_cache == {"at": 0.0, "data": []}

    # Database healthy again well inside _SCAN_TTL: the next request must
    # rescan with the slide filter instead of serving a cached slide tile.
    lookup["fail"] = False
    healthy = client.get("/api/reels")
    assert healthy.status_code == 200, healthy.text
    by_path = {item["path"]: item for item in healthy.json()["videos"]}
    assert sorted(by_path) == sorted(FILTERED)
    assert by_path[COVER]["post_id"] == env["post_id"]
    assert _rel_paths(reels._scan_cache["data"]) == FILTERED
    assert lookup["calls"] == 2
    # The slide was never seeded; neither was anything else (the cover is a
    # published post, the local file has legacy metadata).
    assert env["seeded"] == []


def test_scan_raises_503_and_caches_nothing_when_the_pool_is_starved(env):
    with env["engine"].connect():  # hold the only pooled connection
        with pytest.raises(HTTPException) as raised:
            reels._scan_cached()
    _assert_retryable_503(raised, PoolTimeoutError)
    assert reels._scan_cache == {"at": 0.0, "data": []}

    assert _rel_paths(reels._scan_cached()) == FILTERED
    assert env["seeded"] == []


def test_failed_refresh_keeps_the_filtered_scan_and_retries_on_the_next_request(env, monkeypatch):
    previous = reels._scan_cached()
    assert _rel_paths(previous) == FILTERED
    monkeypatch.setitem(reels._scan_cache, "at", time.monotonic() - reels._SCAN_TTL - 1)
    lookup = _flaky_slide_lookup(monkeypatch)

    with pytest.raises(HTTPException) as raised:
        reels._scan_cached()
    _assert_retryable_503(raised, OperationalError)
    # The previous filtered scan is never replaced by an unfiltered one, and
    # the cache stays stale so the lookup is retried instead of skipped.
    assert reels._scan_cache["data"] is previous
    assert reels._scan_cache["at"] == 0.0

    lookup["fail"] = False
    assert _rel_paths(reels._scan_cached()) == FILTERED
    assert lookup["calls"] == 2


def test_non_database_slide_lookup_errors_propagate(env, monkeypatch):
    def broken(db=None):
        raise RuntimeError("bug in slide_media_paths")

    monkeypatch.setattr(reels, "slide_media_paths", broken)

    with pytest.raises(RuntimeError, match="bug in slide_media_paths"):
        reels._scan_cached()
    assert reels._scan_cache["data"] == []
    with pytest.raises(RuntimeError, match="bug in slide_media_paths"):
        TestClient(env["app"]).get("/api/reels")
    assert env["seeded"] == []


SCAN_ROUTES = [
    ("/api/reels", {}),
    ("/api/reels", {"sort": "trending"}),
    ("/api/reels/tags", {"q": "night"}),
    ("/api/reels/tags/night-city", {}),
    ("/api/reels/locations", {"q": "tokyo"}),
    ("/api/reels/locations/tokyo--japan", {}),
    ("/api/reels/locations/activity", {}),
]


@pytest.mark.parametrize(("path", "params"), SCAN_ROUTES)
def test_scan_routes_return_503_when_only_the_slide_lookup_fails(env, monkeypatch, path, params):
    _flaky_slide_lookup(monkeypatch)

    response = TestClient(env["app"]).get(path, params=params)

    assert response.status_code == 503, response.text
    assert response.headers["retry-after"] == str(reels.REEL_DATA_RETRY_AFTER_SECONDS)
    assert set(response.json()) == {"detail"}
    assert reels._scan_cache == {"at": 0.0, "data": []}
    assert env["seeded"] == []
