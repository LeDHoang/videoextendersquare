"""The read-only processes (SX_ROLE=reader): which requests reach them, what
they refuse, what they never start, and how stale they can be."""

from __future__ import annotations

import asyncio
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, update
from sqlalchemy.orm import sessionmaker

from server import read_routes
from server.routers import reels, social
from server.social import auth, services
from server.social.database import Base, get_db
from server.social.models import Post, User

# server.app calls load_dotenv() at import; keep the developer's .env out of
# the test process (see test_production_boot.py).
with patch("dotenv.load_dotenv"):
    from server import app as app_module

CADDYFILE = Path(__file__).resolve().parents[1] / "deploy" / "Caddyfile"
STALENESS_BOUND_S = 10


# ── The proxy rule ──────────────────────────────────────────────────────────

def _read_matcher() -> str:
    return re.search(r"@read \{(.*?)\n\t\}", CADDYFILE.read_text(encoding="utf-8"), re.S).group(1)


def test_proxy_sends_exactly_the_read_paths_to_the_readers():
    lines = [line.split() for line in _read_matcher().splitlines() if line.strip()]
    rules = {words[0]: words[1:] for words in lines}
    assert set(rules) == {"method", "path", "not"}
    assert rules["method"] == ["GET"]
    assert sorted(rules["path"]) == sorted(read_routes.READ_PATHS)
    # A request with a session cookie stays on the writer.
    assert rules["not"] == ["header_regexp", "Cookie", rf"(^|;\s*){auth.SESSION_COOKIE}="]


def test_everything_else_goes_to_the_writer_alone():
    text = CADDYFILE.read_text(encoding="utf-8")
    blocks = re.findall(r"\n\thandle( @read)? \{(.*?)\n\t\}", text, re.S)
    assert [matcher.strip() for matcher, _ in blocks] == ["@read", ""]
    upstreams = [re.search(r"reverse_proxy ([^{\n]*)", body).group(1).split() for _, body in blocks]
    # Readers first, the writer as their fallback; the writer alone otherwise.
    assert upstreams == [["app-read:8000", "app:8000"], ["app:8000"]]


def test_read_paths_have_no_method_but_get():
    routers = [module.router for name, module in sys.modules.items() if name.startswith("server.routers.") and hasattr(module, "router")]
    methods: dict[str, set] = {}
    for route in (route for router in routers for route in router.routes):
        if getattr(route, "path", None) in read_routes.READ_PATHS:
            methods.setdefault(route.path, set()).update(route.methods)
    assert methods == {path: {"GET"} for path in read_routes.READ_PATHS}


# ── The reader's own guard ──────────────────────────────────────────────────

@pytest.fixture
def session_factory(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    # Production lists posts from their rows only, never from output/ on disk.
    monkeypatch.setenv("SX_ENV", "production")
    engine = create_engine("sqlite:///" + str(tmp_path / "reader.db"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with Session() as db:
        db.add(User(id="ann", username="ann", username_norm="ann"))
        for name in ("a", "b"):
            rel = f"uploads/{name}.mp4"
            db.add(Post(
                id=f"p{name}", owner_id="ann", media_path=rel, media_type="video", caption=f"first {name}",
                media_files={rel: {"bytes": 1000}},
            ))
        db.commit()
    reels.invalidate_scan_cache()
    yield Session
    reels.invalidate_scan_cache()
    engine.dispose()


def _with_db(app: FastAPI, Session) -> FastAPI:
    def override_get_db():
        with Session() as db:
            yield db

    app.dependency_overrides[get_db] = override_get_db
    return app


def test_reader_serves_the_read_routes_and_refuses_the_rest(session_factory, monkeypatch):
    monkeypatch.setenv("SX_ROLE", "reader")
    client = TestClient(_with_db(app_module.create_app(), session_factory))

    for path in read_routes.READ_PATHS:
        assert client.get(path).status_code == 200, path
    assert client.get("/api/healthz").status_code == 200

    refused = [
        client.post("/api/reels/like", json={}),
        client.post("/api/reels"),
        client.post("/api/events", json={}),
        client.post("/api/image/upload"),
        client.get("/api/auth/me"),
        client.get("/api/reels/tags/sunset"),
        client.get("/api/jobs/x/events"),
        client.get("/api/admin/overview"),
        client.get("/api/readyz"),
        client.get("/"),
    ]
    assert [response.status_code for response in refused] == [404] * len(refused)
    assert {response.json()["detail"]["code"] for response in refused} == {"NOT_ON_READER"}
    assert refused[0].headers["x-request-id"]


def test_writer_has_no_such_guard(session_factory):
    client = TestClient(_with_db(app_module.create_app(), session_factory))
    assert client.get("/api/auth/me").status_code == 200


# ── Startup and periodic tasks ──────────────────────────────────────────────

def test_reader_starts_no_jobs_and_no_periodic_tasks(monkeypatch):
    from server import jobs, media
    from server.billing import runtime
    from server.routers import uploads
    from server.social import legacy
    import server.social as social_package

    started = []

    def record(name):
        return lambda *args, **kwargs: started.append(name)

    async def loop():
        started.append("loop")

    monkeypatch.setattr(social_package, "init_database", lambda: None)
    monkeypatch.setattr(jobs.job_manager, "start", record("jobs"))
    monkeypatch.setattr(jobs.job_manager, "shutdown", record("jobs drain"))
    monkeypatch.setattr(uploads, "start_derived_pool", record("encodes"))
    monkeypatch.setattr(uploads, "shutdown_derived_pool", record("encodes drain"))
    monkeypatch.setattr(uploads, "requeue_missing_derived", record("requeue"))
    monkeypatch.setattr(media, "sweep_part_files", record("part sweep"))
    monkeypatch.setattr(runtime, "reconcile_pending_requests", record("billing reconcile"))
    monkeypatch.setattr(runtime, "reap_stale_reservations", record("billing reap"))
    monkeypatch.setattr(legacy, "import_legacy_social", record("legacy import"))
    monkeypatch.setattr(app_module, "_backfill_media_info", record("backfill"))
    monkeypatch.setattr(app_module, "_cleanup_loop", loop)
    monkeypatch.setattr(app_module, "_alert_loop", loop)

    async def run_lifespan():
        async with app_module.lifespan(FastAPI()):
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.05)

    monkeypatch.setenv("SX_ROLE", "reader")
    asyncio.run(run_lifespan())
    assert started == []

    # The same patches do record the writer's startup, so the check above is real.
    monkeypatch.delenv("SX_ROLE")
    with patch("core.tooling.pick_encoder"):
        asyncio.run(run_lifespan())
    assert set(started) == {
        "legacy import", "billing reconcile", "billing reap", "part sweep", "jobs", "encodes",
        "loop", "backfill", "requeue", "jobs drain", "encodes drain",
    }


# ── Staleness on a reader ───────────────────────────────────────────────────

@pytest.fixture
def reader(session_factory, monkeypatch):
    monkeypatch.setenv("SX_ROLE", "reader")
    return TestClient(_with_db(app_module.create_app(), session_factory))


def _write_as_another_process(Session, statement) -> None:
    """A Core statement: no ORM flush, so this process's caches hear nothing,
    as when the writer process commits."""
    with Session() as db:
        db.connection().execute(statement)
        db.commit()


def _captions(response) -> set:
    body = response.json()
    return {item["caption"] for item in body.get("videos", body.get("items"))}


def test_an_edit_made_by_the_writer_shows_on_a_reader_within_the_bound(reader, session_factory, monkeypatch):
    assert services._REEL_RECORDS_TTL <= STALENESS_BOUND_S and reels._SCAN_TTL <= STALENESS_BOUND_S
    assert _captions(reader.get("/api/reels")) == {"first a", "first b"}

    _write_as_another_process(session_factory, update(Post).where(Post.id == "pa").values(caption="edited a"))
    assert _captions(reader.get("/api/reels")) == {"first a", "first b"}

    now = services.time.monotonic()
    monkeypatch.setattr(services.time, "monotonic", lambda: now + STALENESS_BOUND_S + 0.1)
    assert _captions(reader.get("/api/reels")) == {"edited a", "first b"}
    assert _captions(reader.get("/api/reels/feed")) == {"edited a", "first b"}


def test_a_takedown_made_by_the_writer_applies_on_a_reader_at_once(reader, session_factory):
    warm = [reader.get(path) for path in ("/api/reels", "/api/reels/feed", "/api/reels/player-inline", "/api/reels/player")]
    assert all("uploads/a.mp4" in response.text for response in warm)
    assert len(reader.get("/api/recommendations/creators").json()["items"]) == 1

    _write_as_another_process(
        session_factory, update(Post).where(Post.id == "pa").values(deleted_at=datetime.now(timezone.utc))
    )
    for path in ("/api/reels", "/api/reels/feed", "/api/reels/player-inline", "/api/reels/player"):
        text = reader.get(path).text
        assert "uploads/a.mp4" not in text and "uploads/b.mp4" in text, path

    _write_as_another_process(session_factory, update(User).where(User.id == "ann").values(status="suspended"))
    assert reader.get("/api/reels").json()["videos"] == []
    assert reader.get("/api/reels/feed").json()["items"] == []
    assert reader.get("/api/recommendations/creators").json()["items"] == []


# ── The rate limit over reader and writer together ──────────────────────────

@pytest.mark.parametrize("path", ["/api/reels/feed", "/api/recommendations/creators"])
def test_reader_and_writer_share_one_per_ip_limit(path, session_factory, monkeypatch):
    from server.social.models import RateLimitEvent

    writer = TestClient(_with_db(app_module.create_app(), session_factory))
    monkeypatch.setenv("SX_ROLE", "reader")
    reader = TestClient(_with_db(app_module.create_app(), session_factory))

    statuses = [client.get(path).status_code for _ in range(30) for client in (reader, writer)]
    assert statuses == [200] * 60
    assert (reader.get(path).status_code, writer.get(path).status_code) == (429, 429)
    # Counted in the database, which is all the two processes share.
    with session_factory() as db:
        assert db.query(RateLimitEvent).count() == 60
    assert auth.rate_limiter._hits == {}
