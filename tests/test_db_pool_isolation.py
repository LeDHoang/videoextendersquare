"""One request, one pooled connection: no hold-and-wait between sessions.

Regression for the pool deadlock seen in WebXR Earth QA: get_optional_auth
kept the request session's connection checked out (it only committed when
last_used_at was stale), then the reels helpers opened a second SessionLocal()
for every lookup. ~15 concurrent signed-in requests each held one connection
of the 5+10 QueuePool while waiting for another, every AnyIO worker blocked,
and even /api/health stalled until a restart.

Both session factories (get_db and the module-level SessionLocal the helpers
fall back to) are pointed at one instrumented engine, so a helper that still
opens its own session shows up as a second concurrent checkout.

SQLite by default; set SX_TEST_POSTGRES_URL (e.g.
postgresql+psycopg://localhost:55432/pool_test, a throwaway database whose
tables are dropped and recreated per test) to run the same checks on
PostgreSQL.
"""

from __future__ import annotations

import os
import threading

from argon2 import PasswordHasher
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from sqlalchemy.orm import sessionmaker
from starlette.requests import Request

from verified_signup import register_verified
from server.routers import reels, social
from server.social import auth, database, safety
from server.social.database import Base, get_db
from server.social.models import Comment, User
from server.social.services import create_or_update_post


PASSWORD = "correct-horse-battery-pool"
POSTGRES_URL = os.environ.get("SX_TEST_POSTGRES_URL", "")
LOCATION_KEY = "tokyo--japan"
SCAN_ROWS = [
    {
        "rel_path": f"uploads/pool-{index}.png",
        "path": f"output/uploads/pool-{index}.png",
        "filename": f"pool-{index}.png",
        "folder": "uploads",
        "size_human": "1 KB",
        "mtime": 100 - index,
        "media_type": "image",
    }
    for index in range(3)
]


class PoolProbe:
    """Counts checked-out connections and remembers the peak since reset()."""

    def __init__(self, engine):
        self._lock = threading.Lock()
        self.current = 0
        self.peak = 0
        event.listen(engine, "checkout", self._checkout)
        event.listen(engine, "checkin", self._checkin)

    def _checkout(self, *_args):
        with self._lock:
            self.current += 1
            self.peak = max(self.peak, self.current)

    def _checkin(self, *_args):
        with self._lock:
            self.current -= 1

    def reset(self):
        with self._lock:
            self.peak = self.current


def build_app(tmp_path, monkeypatch, **pool_options) -> FastAPI:
    monkeypatch.setattr(
        auth,
        "PASSWORD_HASHER",
        PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1),
    )
    if POSTGRES_URL:
        engine = create_engine(POSTGRES_URL, **pool_options)
        Base.metadata.drop_all(engine)
    else:
        engine = create_engine(
            "sqlite:///" + str(tmp_path / "pool.db"),
            connect_args={"check_same_thread": False},
            **pool_options,
        )
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    # Close the isolation gap: helpers that open their own session must hit
    # the same (small, instrumented) pool as the request session, not the
    # developer database behind the global SessionLocal.
    monkeypatch.setattr(database, "SessionLocal", testing_session)
    monkeypatch.setattr(safety, "SessionLocal", testing_session)

    application = FastAPI()
    application.include_router(social.router)
    application.include_router(reels.router)

    def override_get_db():
        db = testing_session()
        try:
            yield db
        finally:
            db.close()

    application.dependency_overrides[get_db] = override_get_db
    application.state.engine = engine
    application.state.testing_session = testing_session
    application.state.probe = PoolProbe(engine)

    monkeypatch.setattr(reels.SM, "scan_output_media", lambda _root: [dict(row) for row in SCAN_ROWS])
    monkeypatch.setitem(reels._scan_cache, "at", 0.0)
    monkeypatch.setitem(reels._scan_cache, "data", [])
    monkeypatch.setattr(reels, "COMMENTS_FILE", tmp_path / "reels_comments.json")
    monkeypatch.setattr(reels, "META_FILE", tmp_path / "reels_meta.json")
    return application


def register_and_seed(app: FastAPI, client: TestClient) -> dict:
    response = register_verified(client,
        json={
            "email": "pool@example.com",
            "username": "pooluser",
            "password": PASSWORD,
            "accept_terms": True,
            "display_name": "Pool",
        },
    )
    assert response.status_code == 200, response.text
    with app.state.testing_session() as db:
        owner = db.query(User).filter(User.username == "pooluser").one()
        posts = [
            create_or_update_post(
                db,
                media_path=row["rel_path"],
                media_type="image",
                owner=owner,
                title=f"Pool {index}",
                tags=["night-city"],
                location={"city": "Tokyo", "country": "Japan", "lat": 35.68, "lon": 139.69},
            )
            for index, row in enumerate(SCAN_ROWS)
        ]
        db.add(Comment(post_id=posts[0].id, author_id=owner.id, text="first"))
        db.commit()
        return {"post_id": posts[0].id, "media_path": posts[0].media_path}


AUTHENTICATED_CASES = [
    ("location", lambda seed: ("/api/reels/locations/" + LOCATION_KEY, {})),
    ("location-recent", lambda seed: ("/api/reels/locations/" + LOCATION_KEY, {"sort": "recent_trending"})),
    ("tag", lambda seed: ("/api/reels/tags/night-city", {})),
    ("list", lambda seed: ("/api/reels", {})),
    ("list-search", lambda seed: ("/api/reels", {"search": "tokyo"})),
    ("location-activity", lambda seed: ("/api/reels/locations/activity", {})),
    ("comments", lambda seed: ("/api/reels/comments", {"video_path": seed["media_path"]})),
    ("feed-post-author", lambda seed: ("/api/reels/feed", {"post": seed["post_id"], "author": "pooluser"})),
    ("feed-post-following", lambda seed: ("/api/reels/feed", {"post": seed["post_id"], "feed": "following"})),
    ("search-suggestions", lambda seed: ("/api/search/suggestions", {"q": "night"})),
    ("search-suggestions-empty-query", lambda seed: ("/api/search/suggestions", {})),
]


@pytest.mark.parametrize("case", [name for name, _ in AUTHENTICATED_CASES])
def test_authenticated_reels_request_checks_out_at_most_one_connection(tmp_path, monkeypatch, case):
    app = build_app(tmp_path, monkeypatch, pool_size=5, max_overflow=0, pool_timeout=2)
    probe = app.state.probe
    with TestClient(app) as client:
        seed = register_and_seed(app, client)
        path, params = dict(AUTHENTICATED_CASES)[case](seed)
        probe.reset()
        response = client.get(path, params=params)
        assert response.status_code == 200, response.text
        assert probe.peak <= 1, f"{case}: {probe.peak} connections checked out by one request"
        assert probe.current == 0
    app.state.engine.dispose()


def test_anonymous_recent_trending_request_checks_out_at_most_one_connection(tmp_path, monkeypatch):
    app = build_app(tmp_path, monkeypatch, pool_size=5, max_overflow=0, pool_timeout=2)
    probe = app.state.probe
    with TestClient(app) as client:
        register_and_seed(app, client)
        client.cookies.clear()
        probe.reset()
        response = client.get("/api/reels", params={"sort": "recent_trending"})
        assert response.status_code == 200, response.text
        assert len(response.json()["videos"]) == len(SCAN_ROWS)
        assert probe.peak <= 1
    app.state.engine.dispose()


def test_concurrent_signed_in_location_requests_share_a_single_connection_pool(tmp_path, monkeypatch):
    app = build_app(tmp_path, monkeypatch, pool_size=1, max_overflow=0, pool_timeout=1)
    with TestClient(app) as client:
        register_and_seed(app, client)
        cookies = dict(client.cookies)
    workers = 6
    barrier = threading.Barrier(workers)
    statuses: list[int] = []
    errors: list[BaseException] = []

    def worker():
        try:
            worker_client = TestClient(app, cookies=cookies)
            barrier.wait(timeout=10)
            statuses.append(worker_client.get("/api/reels/locations/" + LOCATION_KEY).status_code)
        except BaseException as exc:  # noqa: BLE001 - surface any pool timeout to the test thread
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    assert not any(thread.is_alive() for thread in threads)
    assert not [error for error in errors if isinstance(error, PoolTimeoutError)], errors
    assert not errors, errors
    assert statuses == [200] * workers
    assert app.state.probe.current == 0
    app.state.engine.dispose()


def _cookie_request(token: str) -> Request:
    return Request({"type": "http", "headers": [(b"cookie", f"{auth.SESSION_COOKIE}={token}".encode())]})


def test_optional_auth_returns_its_connection_to_the_pool(tmp_path, monkeypatch):
    app = build_app(tmp_path, monkeypatch, pool_size=1, max_overflow=0, pool_timeout=1)
    probe = app.state.probe
    with TestClient(app) as client:
        register_and_seed(app, client)
        token = client.cookies.get(auth.SESSION_COOKIE)
    assert token

    db = app.state.testing_session()
    try:
        context = auth.get_optional_auth(_cookie_request(token), db)
        assert context is not None
        # The read transaction is over and the pooled connection is back...
        assert not db.in_transaction()
        assert probe.current == 0
        # ...while the loaded rows stay usable without another round trip.
        assert context.user.username == "pooluser"
        assert context.session.user_id == context.user.id
        assert probe.current == 0

        assert auth.get_optional_auth(_cookie_request("not-a-session"), db) is None
        assert not db.in_transaction()
        assert probe.current == 0
    finally:
        db.close()
    app.state.engine.dispose()


def test_payload_fallbacks_do_not_requery_after_a_failed_batch_lookup(tmp_path, monkeypatch):
    monkeypatch.setattr(reels, "COMMENTS_FILE", tmp_path / "reels_comments.json")
    monkeypatch.setattr(reels, "META_FILE", tmp_path / "reels_meta.json")
    calls = {"reel_records": 0, "metadata_for_paths": 0}

    def starved_reel_records(*_args, **_kwargs):
        calls["reel_records"] += 1
        raise PoolTimeoutError("QueuePool limit reached")

    def counting_metadata_for_paths(*_args, **_kwargs):
        calls["metadata_for_paths"] += 1
        raise PoolTimeoutError("QueuePool limit reached")

    monkeypatch.setattr(reels, "reel_records", starved_reel_records)
    monkeypatch.setattr(reels, "metadata_for_paths", counting_metadata_for_paths)

    # A failed batch is a retryable 503 (never fabricated fallback metadata;
    # see tests/test_reels_metadata_failures.py).
    with pytest.raises(HTTPException) as raised:
        reels._build_payload([dict(row) for row in SCAN_ROWS], "hevc")

    assert raised.value.status_code == 503
    # One batched lookup; a failure must not fan out into per-item retries
    # that each wait out another pool timeout.
    assert calls == {"reel_records": 1, "metadata_for_paths": 0}


def test_search_suggestions_reuse_the_request_session_for_tags(tmp_path, monkeypatch):
    # The route queried its request db, then called the reels tag helpers
    # without it: each opened a second SessionLocal() while the first
    # connection was still checked out (peak 2 -> deadlock under load).
    app = build_app(tmp_path, monkeypatch, pool_size=1, max_overflow=0, pool_timeout=1)
    probe = app.state.probe
    with TestClient(app) as client:
        register_and_seed(app, client)
        probe.reset()
        response = client.get("/api/search/suggestions", params={"q": "night"})
        assert response.status_code == 200, response.text
        assert probe.peak <= 1, f"{probe.peak} connections checked out by one request"
        assert [tag["slug"] for tag in response.json()["tags"]] == ["night-city"]
        assert probe.current == 0

        # Anonymous callers take the same path.
        client.cookies.clear()
        probe.reset()
        response = client.get("/api/search/suggestions", params={"q": "night"})
        assert response.status_code == 200, response.text
        assert probe.peak <= 1
        assert [tag["slug"] for tag in response.json()["tags"]] == ["night-city"]
    app.state.engine.dispose()


def test_concurrent_search_suggestions_share_a_single_connection_pool(tmp_path, monkeypatch):
    app = build_app(tmp_path, monkeypatch, pool_size=1, max_overflow=0, pool_timeout=1)
    with TestClient(app) as client:
        register_and_seed(app, client)
        cookies = dict(client.cookies)
    workers = 6
    barrier = threading.Barrier(workers)
    statuses: list[int] = []
    errors: list[BaseException] = []

    def worker():
        try:
            worker_client = TestClient(app, cookies=cookies)
            barrier.wait(timeout=10)
            statuses.append(worker_client.get("/api/search/suggestions", params={"q": "night"}).status_code)
        except BaseException as exc:  # noqa: BLE001 - surface any pool timeout to the test thread
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    assert not any(thread.is_alive() for thread in threads)
    assert not errors, errors
    assert statuses == [200] * workers
    assert app.state.probe.current == 0
    app.state.engine.dispose()


def _failing_lookup(*_args, **_kwargs):
    raise OperationalError("SELECT posts", {}, Exception("server closed the connection unexpectedly"))


@pytest.mark.parametrize("lookup", ["metadata_for_paths", "slide_media_paths"])
def test_search_suggestions_surface_a_failed_reels_lookup_as_503(tmp_path, monkeypatch, lookup):
    # A failed reels lookup must stay a retryable 503 (never an empty tag
    # list that looks like "no matches") and must still release its connection.
    app = build_app(tmp_path, monkeypatch, pool_size=1, max_overflow=0, pool_timeout=1)
    probe = app.state.probe
    with TestClient(app) as client:
        register_and_seed(app, client)
        monkeypatch.setattr(reels, lookup, _failing_lookup)
        probe.reset()
        response = client.get("/api/search/suggestions", params={"q": "night"})
        assert response.status_code == 503, response.text
        assert response.headers["retry-after"] == str(reels.REEL_DATA_RETRY_AFTER_SECONDS)
        assert set(response.json()) == {"detail"}
        assert probe.peak <= 1
        assert probe.current == 0
    app.state.engine.dispose()
