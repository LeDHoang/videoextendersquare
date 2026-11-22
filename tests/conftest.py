"""Shared pytest fixtures.

Routes take their session from ``get_db`` (which tests override), but helpers
called without a ``db`` fall back to the module-level ``SessionLocal``. Point
that fallback at an empty throwaway database so no test reads or writes the
developer's ``data/echo.db``. A test that needs the fallback on its own
database still monkeypatches ``SessionLocal`` itself (the later patch wins).
"""

from __future__ import annotations

import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor, wait

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from core import models
from server.social import database, safety, turnstile


@event.listens_for(Engine, "connect")
def _no_fsync_for_test_sqlite(dbapi_connection, _connection_record):
    """Test databases are throwaway: skip the disk syncs on each commit.

    Most fixtures build a fresh file database with ``create_all``, one commit
    per table and index; with the syncs that took about 0.14 s a database and
    118 s of a 287 s run. A rollback journal in memory keeps the same locking
    as the default journal; a database a test put in WAL mode stays in WAL.
    """
    if not isinstance(dbapi_connection, sqlite3.Connection):
        return
    dbapi_connection.execute("PRAGMA synchronous=OFF")
    mode = dbapi_connection.execute("PRAGMA journal_mode").fetchone()[0]
    if mode == "delete":
        dbapi_connection.execute("PRAGMA journal_mode=MEMORY")


@pytest.fixture(scope="session")
def _fallback_session_factory(tmp_path_factory):
    engine = create_engine(
        "sqlite:///" + str(tmp_path_factory.mktemp("fallback-db") / "fallback.db"),
        connect_args={"check_same_thread": False},
    )
    database.Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    engine.dispose()


@pytest.fixture(autouse=True)
def _no_live_fal_prices(monkeypatch):
    """No test calls fal's pricing API, and each one starts on the code prices."""
    monkeypatch.setenv("SX_FAL_PRICE_SYNC_S", "0")
    yield
    models.apply_synced_prices({})
    models.apply_fal_schemas({})


@pytest.fixture(autouse=True)
def _isolate_global_session_local(monkeypatch, _fallback_session_factory):
    monkeypatch.setattr(database, "SessionLocal", _fallback_session_factory)
    monkeypatch.setattr(safety, "SessionLocal", _fallback_session_factory)


@pytest.fixture(autouse=True)
def _own_background_workers(monkeypatch):
    """Each test gets its own derived-asset and captions workers.

    A test that publishes leaves encodes and captions on these one-thread
    pools; shared across tests, a later test's job queued behind them and
    ran under that test's patches (with pytest-xdist the order changes per
    run, so this failed now and then). At teardown, while this test's
    patches still apply, queued jobs are dropped and the running one gets
    up to 30 s to finish.
    """
    from server.routers import uploads

    monkeypatch.setattr(uploads, "_derived_pool", ThreadPoolExecutor(max_workers=1, thread_name_prefix="derived-assets"))
    monkeypatch.setattr(uploads, "_captions_pool", ThreadPoolExecutor(max_workers=1, thread_name_prefix="captions"))
    yield
    # Read the globals again: start_derived_pool may have replaced them.
    for pool in (uploads._derived_pool, uploads._captions_pool):
        pool.shutdown(wait=False, cancel_futures=True)
    with uploads._derived_lock:
        pending = list(uploads._derived_futures)
    wait(pending, timeout=30)


@pytest.fixture(autouse=True)
def _no_real_speech_model(monkeypatch):
    """Keep tests off the real faster-whisper model, as on CI (no captions extra).

    Where requirements-captions.txt is installed, a publish in a test that
    does not stub captions loaded the model and fetched its weights from
    Hugging Face; offline that read could hang the captions worker, and the
    test with it. tests/test_captions.py puts its own fake module here.
    """
    monkeypatch.setitem(sys.modules, "faster_whisper", None)


@pytest.fixture(autouse=True)
def _expose_email_tokens(monkeypatch):
    """Let tests read verification/reset tokens from API responses (dev switch)."""
    monkeypatch.setenv("SX_PASSWORD_RESET_EXPOSE_TOKEN", "1")


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    """Rate-limit counts live in process memory; each test starts with none,
    as each test used to start with an empty rate-limit table."""
    from server.social.auth import rate_limiter

    rate_limiter.reset()


@pytest.fixture(autouse=True)
def _fresh_reel_records():
    """Cached reel records live in process memory, keyed by media path; each
    test has its own database, so each starts with none."""
    from server.social.services import invalidate_reel_records

    invalidate_reel_records()


@pytest.fixture(autouse=True)
def _fresh_grid_cache():
    """The for_you grid order is cached in process memory by actor, filters and seed."""
    from server.social.recommendations import service

    service._grid_cache.clear()


@pytest.fixture(autouse=True)
def _fresh_recent_stats():
    """Last week's daily stats are cached in process memory for every post."""
    from server.social.recommendations import service

    service._recent_stats_cache["entry"] = (None, 0.0, {})


@pytest.fixture(autouse=True)
def _roomy_device_limits(monkeypatch):
    """Tests sign up several users from one TestClient cookie jar, which is one
    device; tests/test_device_limits.py lowers these again."""
    monkeypatch.setenv("SX_REGISTER_DEVICE_HOURLY", "1000")
    monkeypatch.setenv("SX_REGISTER_DEVICE_DAILY", "1000")


@pytest.fixture(autouse=True)
def _no_new_account_tier(monkeypatch):
    """Test accounts are seconds old; without this every one would get the
    lower ``new`` tier limits. tests/test_trust_tiers.py sets these again."""
    monkeypatch.setenv("SX_TRUST_NEW_HOURS", "0")
    monkeypatch.setenv("SX_REEL_REWARD_MIN_ACCOUNT_AGE_HOURS", "0")


@pytest.fixture(autouse=True)
def _no_reel_jackpots(monkeypatch):
    """Reel milestones rarely roll a jackpot; pin them to +1 so credit
    balances are deterministic. Jackpot tests patch the roll again."""
    from server.billing import service

    monkeypatch.setattr(service, "roll_reel_reward", lambda: (1, None))


# Turns the bot check on with a fake siteverify: "good-<action>" passes for that action
# on echomultiverse.com; anything else fails.
class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


@pytest.fixture
def turnstile_on(monkeypatch):
    monkeypatch.setenv("SX_TURNSTILE_SECRET", "test-secret")
    monkeypatch.delenv("SX_TURNSTILE_DISABLED", raising=False)
    monkeypatch.setenv("SX_PUBLIC_URL", "https://echomultiverse.com")
    calls: list[dict] = []

    def fake_post(url, data=None, timeout=None):
        calls.append({"url": url, "data": dict(data), "timeout": timeout})
        good = data["response"].startswith("good-")
        return _FakeResponse({
            "success": good,
            "hostname": "echomultiverse.com",
            "action": data["response"][len("good-"):] if good else None,
        })

    monkeypatch.setattr(turnstile.httpx, "post", fake_post)
    return calls
