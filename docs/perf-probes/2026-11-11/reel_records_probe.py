"""Response hashes, cache-miss timings and query counts of the routes built on reel_records.

Run it on two trees against the same copy of a database; the hash lines must match:

    cp data/echo.db /tmp/probe.db
    PYTHON_DOTENV_DISABLED=1 DATABASE_URL=sqlite:////tmp/probe.db \
        python docs/perf-probes/2026-11-11/reel_records_probe.py

Run it from a folder whose ``output/`` holds the media tree. Bodies are hashed byte for byte through
the full ASGI stack, for the anonymous viewer and for a few signed-in ones. The activity route's
clock is pinned, since its scores decay with time. Every timed request starts with the reel records
dropped, so it pays a cache miss. The records themselves are hashed too, in key order, since the routes
show only part of them.

Set ``PROBE_PREPARE=1`` on the first run against a fresh copy: it blocks one tag and deactivates one
post owner and one comment author, so the filters on them reach the hashes.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
logging.disable(logging.CRITICAL)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import event, text  # noqa: E402

from server.app import app  # noqa: E402
from server.routers import reels  # noqa: E402
from server.social import services  # noqa: E402
from server.social.auth import AuthContext, get_optional_auth, rate_limiter  # noqa: E402
from server.social.database import SessionLocal, engine  # noqa: E402
from server.social.models import User  # noqa: E402

ROUTES = (
    "/api/reels",
    "/api/reels/tags",
    "/api/search/suggestions?q=a",
    "/api/reels/locations/activity",
)
RUNS = int(os.environ.get("PROBE_RUNS", "25"))
PINNED_NOW = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)

_recent_activity_by_path = reels._recent_activity_by_path
reels._recent_activity_by_path = lambda db, raw, window_days=reels.RECENT_ACTIVITY_DEFAULT_DAYS, now=None: (
    _recent_activity_by_path(db, raw, window_days, now=PINNED_NOW)
)

queries = [0]
statements: list[str] = []


@event.listens_for(engine, "before_cursor_execute")
def _count(conn, cursor, statement, parameters, context, executemany):
    queries[0] += 1
    statements.append(statement)


def prepare() -> None:
    with SessionLocal() as db:
        db.execute(text("update tags set blocked_at = current_timestamp where id = (select tag_id from post_tags group by 1 order by count(*) desc limit 1)"))
        db.execute(text("update users set status = 'suspended' where id = (select owner_id from posts where status='published' group by 1 order by count(*) asc limit 1)"))
        db.execute(text("update users set status = 'suspended' where id = (select author_id from comments group by 1 order by count(*) asc limit 1)"))
        db.commit()


def viewer_ids() -> list[str]:
    picks = (
        "select user_id from post_likes group by 1 order by count(*) desc limit 2",
        "select follower_id from follows group by 1 order by count(*) desc limit 1",
        "select blocker_id from user_blocks limit 1",
        "select user_id from comment_likes group by 1 order by count(*) desc limit 1",
        "select owner_id from posts where status='published' group by 1 order by count(*) desc limit 1",
    )
    ids: list[str] = []
    with SessionLocal() as db:
        for sql in picks:
            ids += [row[0] for row in db.execute(text(sql)).all()]
    return list(dict.fromkeys(ids))


def as_viewer(viewer_id: str | None) -> None:
    app.dependency_overrides.pop(get_optional_auth, None)
    if viewer_id:
        with SessionLocal() as db:
            user = db.get(User, viewer_id)
            db.expunge(user)
        app.dependency_overrides[get_optional_auth] = lambda: AuthContext(user=user, session=None)


def get(client: TestClient, path: str) -> bytes:
    rate_limiter.reset()
    response = client.get(path)
    assert response.status_code == 200, (path, response.status_code)
    return response.content


def main() -> None:
    if os.environ.get("PROBE_PREPARE"):
        prepare()
    client = TestClient(app)
    for path in ROUTES:
        get(client, path)  # warm everything but the reel records

    for viewer_id in [None, *viewer_ids()]:
        as_viewer(viewer_id)
        for path in ROUTES:
            services.invalidate_reel_records()
            body = get(client, path)
            print(f"hash {viewer_id or 'anon':36s} {path:32s} {hashlib.sha256(body).hexdigest()[:16]} {len(body)}")
    as_viewer(None)

    for path in ROUTES:
        times, counts = [], []
        for _ in range(RUNS):
            services.invalidate_reel_records()
            queries[0] = 0
            start = time.perf_counter()
            get(client, path)
            times.append((time.perf_counter() - start) * 1000)
            counts.append(queries[0])
        print(f"miss {path:32s} median {statistics.median(times):6.1f} ms  queries {statistics.median(counts):.0f}")

    with SessionLocal() as db:
        paths = [row[0] for row in db.execute(text("select media_path from posts order by media_path")).all()]
    for include_comments in (True, False):
        times, counts = [], []
        for _ in range(RUNS):
            with SessionLocal() as db:
                queries[0] = 0
                statements.clear()
                start = time.perf_counter()
                records = services._load_reel_records(db, paths, include_comments)
                times.append((time.perf_counter() - start) * 1000)
                counts.append(queries[0])
        digest = hashlib.sha256(json.dumps(records, default=str).encode()).hexdigest()[:16]
        sql = " ".join(statements)
        print(
            f"load comments={include_comments!s:5s} {len(records)} of {len(paths)} paths  records {digest}"
            f"  median {statistics.median(times):6.1f} ms  queries {statistics.median(counts):.0f}"
            f"  'JOIN users' {sql.count('JOIN users')}  password_hash {sql.count('password_hash')}"
        )

if __name__ == "__main__":
    main()
