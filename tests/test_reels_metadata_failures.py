"""A failed social-database lookup must never fabricate reel metadata.

Regression for pool starvation (see tests/test_db_pool_isolation.py):
_metadata_snapshot and _build_payload swallowed any exception from the
batched metadata_for_paths / reel_records lookup and fell back to
_seed_meta, so published posts were served with invented tags, location,
likes and views. A failed lookup now raises a 503 with Retry-After; the
legacy JSON / seed fallback is kept only for paths the database answered
have no published post (local, unpublished output/ files).
"""

from __future__ import annotations

import json

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from sqlalchemy.orm import sessionmaker

from server.routers import reels
from server.social import database, safety, services
from server.social.database import Base, get_db
from server.social.models import User
from server.social.services import create_or_update_post


PUBLISHED = "uploads/published.png"
LEGACY = "uploads/legacy-local.png"
UNSEEDED = "uploads/unseeded-local.png"
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
    for index, rel_path in enumerate((PUBLISHED, LEGACY, UNSEEDED))
]
LEGACY_META = {
    LEGACY: {
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
    # every helper lookup with a real sqlalchemy TimeoutError.
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "meta.db"),
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
            media_path=PUBLISHED,
            media_type="image",
            owner=owner,
            title="Published",
            tags=["night-city"],
            location={"city": "Tokyo", "country": "Japan", "lat": 35.68, "lon": 139.69},
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


def _fail_lookups(monkeypatch, error: Exception) -> None:
    """Make every batched social lookup (both import sites) raise ``error``."""

    def failing(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(reels, "reel_records", failing)
    monkeypatch.setattr(reels, "metadata_for_paths", failing)
    monkeypatch.setattr(services, "reel_records", failing)


def _assert_retryable_503(raised: pytest.ExceptionInfo) -> None:
    assert raised.value.status_code == 503
    assert raised.value.headers == {"Retry-After": str(reels.REEL_DATA_RETRY_AFTER_SECONDS)}
    assert isinstance(raised.value.__cause__, PoolTimeoutError)


def test_metadata_snapshot_raises_503_instead_of_seeding_when_the_pool_is_starved(env):
    with env["engine"].connect():  # hold the only pooled connection
        with pytest.raises(HTTPException) as raised:
            reels._metadata_snapshot([dict(row) for row in SCAN_ROWS])
    _assert_retryable_503(raised)
    assert env["seeded"] == []


def test_build_payload_raises_503_instead_of_seeding_when_the_pool_is_starved(env, monkeypatch):
    fallbacks: list[str] = []
    monkeypatch.setattr(reels, "_get_meta_for_video", lambda path, *_a: fallbacks.append(path) or {})
    monkeypatch.setattr(reels, "_get_comments_for_video", lambda path, *_a: fallbacks.append(path) or [])

    with env["engine"].connect():  # hold the only pooled connection
        with pytest.raises(HTTPException) as raised:
            reels._build_payload([dict(row) for row in SCAN_ROWS], "hevc")
    _assert_retryable_503(raised)
    assert fallbacks == []
    assert env["seeded"] == []


def test_non_database_errors_are_not_swallowed_into_fallback_metadata(env, monkeypatch):
    _fail_lookups(monkeypatch, RuntimeError("bug in reel_records"))

    with pytest.raises(RuntimeError, match="bug in reel_records"):
        reels._metadata_snapshot([dict(row) for row in SCAN_ROWS])
    with pytest.raises(RuntimeError, match="bug in reel_records"):
        reels._build_payload([dict(row) for row in SCAN_ROWS], "hevc")
    assert env["seeded"] == []


FAILING_ROUTES = [
    ("/api/reels", {}),
    ("/api/reels", {"search": "tokyo"}),
    ("/api/reels", {"sort": "trending"}),
    ("/api/reels/tags", {"q": "night"}),
    ("/api/reels/tags/night-city", {}),
    ("/api/reels/locations", {"q": "tokyo"}),
    ("/api/reels/locations/tokyo--japan", {}),
    ("/api/reels/locations/activity", {}),
]


@pytest.mark.parametrize(("path", "params"), FAILING_ROUTES)
def test_routes_return_503_without_fabricated_engagement_when_lookup_fails(env, monkeypatch, path, params):
    _fail_lookups(
        monkeypatch,
        OperationalError("SELECT posts", {}, Exception("server closed the connection unexpectedly")),
    )

    response = TestClient(env["app"]).get(path, params=params)

    assert response.status_code == 503, response.text
    assert response.headers["retry-after"] == str(reels.REEL_DATA_RETRY_AFTER_SECONDS)
    body = response.json()
    assert set(body) == {"detail"}
    assert env["seeded"] == []


def test_successful_lookup_keeps_database_rows_and_legacy_fallback_for_local_files(env):
    truth = services.reel_records([PUBLISHED])[PUBLISHED]

    snapshot = reels._metadata_snapshot([dict(row) for row in SCAN_ROWS])
    assert snapshot[PUBLISHED]["post_id"] == env["post_id"]
    assert (snapshot[PUBLISHED]["likes"], snapshot[PUBLISHED]["views"]) == (truth["likes"], truth["views"])
    assert snapshot[LEGACY]["title"] == "Local legacy"
    assert (snapshot[LEGACY]["likes"], snapshot[LEGACY]["views"]) == (3, 30)
    # Only the local file with neither a post nor a legacy entry is seeded.
    assert env["seeded"] == [UNSEEDED]

    env["seeded"].clear()
    response = TestClient(env["app"]).get("/api/reels")
    assert response.status_code == 200, response.text
    by_path = {item["path"]: item for item in response.json()["videos"]}
    published = by_path[PUBLISHED]
    assert published["post_id"] == env["post_id"]
    assert (published["likes"], published["views"]) == (truth["likes"], truth["views"])
    assert published["tags"] == ["night-city"]
    legacy = by_path[LEGACY]
    assert legacy["post_id"] is None
    assert (legacy["title"], legacy["likes"], legacy["views"]) == ("Local legacy", 3, 30)
    assert set(env["seeded"]) == {UNSEEDED}
