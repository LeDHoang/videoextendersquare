import os

import pytest
from fastapi import HTTPException

from server.social import auth


@pytest.fixture
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(auth.time, "monotonic", lambda: now[0])
    return now


def test_limit_holds_within_the_window_and_frees_as_it_slides(clock):
    limiter = auth.RateLimiter()
    for _ in range(3):
        limiter.check(None, "ip:a", 3, 60)
    with pytest.raises(HTTPException) as refused:
        limiter.check(None, "ip:a", 3, 60)
    assert refused.value.status_code == 429
    # A refused request is not counted, and other keys are unaffected.
    limiter.check(None, "ip:b", 3, 60)
    clock[0] += 60
    limiter.check(None, "ip:a", 3, 60)


def test_idle_keys_are_swept(clock):
    limiter = auth.RateLimiter()
    limiter.check(None, "ip:a", 3, 10)
    limiter.check(None, "ip:b", 3, 600)
    clock[0] += auth.RateLimiter._SWEEP_SECONDS
    limiter.check(None, "ip:c", 3, 10)
    assert set(limiter._hits) == {"ip:b", "ip:c"}


# ── shared=True: counted in the database, for limits the readers check too ──

@pytest.fixture
def sessions(tmp_path, monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from server.social import database

    # SQLite by default; SX_TEST_POSTGRES_URL (a throwaway database, as in
    # test_db_pool_isolation.py) runs the same checks on PostgreSQL.
    postgres_url = os.environ.get("SX_TEST_POSTGRES_URL", "")
    engine = create_engine(postgres_url or f"sqlite:///{tmp_path / 'limits.db'}")
    if postgres_url:
        database.Base.metadata.drop_all(engine)
    database.Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", factory)
    yield factory
    engine.dispose()


def _refused(limiter, db, key, limit=3, window=60) -> bool:
    try:
        limiter.check(db, key, limit, window, shared=True)
    except HTTPException as refused:
        assert refused.status_code == 429
        return True
    return False


def test_shared_limit_is_one_limit_for_every_process(sessions, monkeypatch):
    from server.social.models import RateLimitEvent

    now = [auth.utcnow()]
    monkeypatch.setattr(auth, "utcnow", lambda: now[0])
    # Each process has its own limiter object and its own connections.
    one, two = auth.RateLimiter(), auth.RateLimiter()
    with sessions() as db_one, sessions() as db_two:
        assert [_refused(limiter, db, "rec-feed:ip:1.2.3.4") for limiter, db in
                ((one, db_one), (two, db_two), (one, db_one), (two, db_two), (one, db_one))] == [False, False, False, True, True]
        # A refused request is not counted, and other keys are unaffected.
        assert db_one.query(RateLimitEvent).count() == 3
        assert not _refused(two, db_two, "rec-feed:ip:5.6.7.8")
        # The key is stored hashed.
        assert all(len(row.key_hash) == 64 and "1.2.3.4" not in row.key_hash for row in db_one.query(RateLimitEvent))
        now[0] += auth.timedelta(seconds=60)
        assert not _refused(two, db_two, "rec-feed:ip:1.2.3.4")
    # In-memory limits never touch the table.
    assert one._hits == {} and two._hits == {}


def test_shared_limit_holds_across_real_processes(tmp_path):
    import subprocess
    import sys

    from sqlalchemy import create_engine

    from server.social.database import Base

    # PostgreSQL is where checks really run at the same moment.
    url = os.environ.get("SX_TEST_POSTGRES_URL", "") or f"sqlite:///{tmp_path / 'processes.db'}"
    engine = create_engine(url)
    if url.startswith("postgresql"):
        Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    engine.dispose()
    script = (
        "from fastapi import HTTPException\n"
        "from server.social import auth, database\n"
        "allowed = 0\n"
        "for _ in range(40):\n"
        "    with database.SessionLocal() as db:\n"
        "        try:\n"
        "            auth.rate_limiter.check(db, 'rec-feed:ip:1.2.3.4', 30, 60, shared=True)\n"
        "            allowed += 1\n"
        "        except HTTPException:\n"
        "            pass\n"
        "print(allowed)\n"
    )
    env = {**os.environ, "DATABASE_URL": url, "SX_SECURITY_SECRET": "test-only-security-secret", "PYTHON_DOTENV_DISABLED": "1"}
    workers = [
        subprocess.Popen([sys.executable, "-c", script], env=env, stdout=subprocess.PIPE, text=True)
        for _ in range(3)
    ]
    allowed = [int(worker.communicate(timeout=60)[0]) for worker in workers]
    assert all(worker.returncode == 0 for worker in workers)
    # 120 checks from three processes: 30 pass in all, not 30 per process.
    assert sum(allowed) == 30


def test_old_shared_hits_are_pruned(sessions, monkeypatch):
    from server.social.models import RateLimitEvent

    limiter = auth.RateLimiter()
    with sessions() as db:
        limiter.check(db, "rec-feed:ip:old", 3, 60, shared=True)
        real_now = auth.utcnow()
        monkeypatch.setattr(auth, "utcnow", lambda: real_now + auth.timedelta(seconds=auth.RateLimiter.SHARED_KEEP_SECONDS + 1))
        limiter.check(db, "rec-feed:ip:new", 3, 60, shared=True)
        assert auth.prune_shared_rate_limits() == 1
        assert db.query(RateLimitEvent).count() == 1
