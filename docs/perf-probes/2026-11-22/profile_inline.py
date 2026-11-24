"""Time and profile one anonymous route on whichever tree is on PYTHONPATH, run locally.

Seeds 207 posts from 25 creators (the prod catalog size), then times 60 requests and
profiles 30 more. Each request has no cookie, like the loopback probe.

usage: PYTHONPATH=<tree> PYTHON_DOTENV_DISABLED=1 .venv/bin/python profile_inline.py <label> [n_posts]
env:   DB_URL      a throwaway Postgres URL (default: SQLite in a temp dir). The schema is dropped.
       ROUTE       default /api/reels/player-inline
       REAL_LIMITER=1   keep the rate-limit check (with a huge limit), instead of stubbing it
       DAILY_ROWS  how many post_recommendation_daily_stats rows to seed (default: 7 per post)
       NO_DAILY=1  seed none
       SEED_SESSIONS  Postgres only: seed this many expired sessions, each with one request and 11 impressions
       SWEEP=1     with SEED_SESSIONS: delete the seeded sessions again before timing (plain VACUUM only)
"""
import cProfile
import io
import os
import pstats
import random
import statistics
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

label = sys.argv[1]
N_POSTS = int(sys.argv[2]) if len(sys.argv) > 2 else 207
random.seed(7)
launch_dir = os.getcwd()  # the .prof file is saved here
tmp = tempfile.mkdtemp()
os.chdir(tmp)
mp = pytest.MonkeyPatch()
mp.delenv("SX_ENV", raising=False)
mp.setenv("SX_SECURITY_SECRET", "test-only-security-secret")

with patch("dotenv.load_dotenv"):
    from server import app as app_module
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.routers import reels
from server.social import database, safety
from server.social.database import Base, get_db
from server.social.models import Post, PostLike, User
from server.social.services import create_or_update_post

TAGS = [f"tag{i}" for i in range(40)]
CITIES = [("Tokyo", "Japan"), ("Hanoi", "Vietnam"), ("Paris", "France"), ("Seattle", "United States"), ("Sydney", "Australia")]
ITEMS = []
DB_URL = os.environ.get("DB_URL")
ROUTE = os.environ.get("ROUTE", "/api/reels/player-inline")
if DB_URL:
    engine = create_engine(DB_URL)
    Base.metadata.drop_all(engine)
else:
    engine = create_engine("sqlite:///" + os.path.join(tmp, "p.db"), connect_args={"check_same_thread": False})
Base.metadata.create_all(engine)
Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
mp.setattr(database, "SessionLocal", Session)
mp.setattr(safety, "SessionLocal", Session)
start = datetime(2026, 9, 1, tzinfo=timezone.utc)
with Session() as db:
    users = []
    for i in range(25):
        u = User(id=f"u{i}", username=f"u{i}", username_norm=f"u{i}", display_name=f"User {i}", status="active")
        db.add(u)
        users.append(u)
    db.flush()
    for n in range(N_POSTS):
        rel = f"uploads/u{n % 25}/reel{n}.mp4"
        city, country = random.choice(CITIES)
        create_or_update_post(
            db,
            media_path=rel,
            media_type="video",
            owner=users[n % 25],
            title=f"Reel {n} {city}",
            caption=f"A walk around {city} #{random.choice(TAGS)}",
            tags=random.sample(TAGS, 3),
            location={"city": city, "country": country},
            created_at=start + timedelta(hours=7 * n),
        )
        ITEMS.append({
            "rel_path": rel, "path": f"output/{rel}", "filename": f"reel{n}.mp4", "folder": "uploads",
            "size_human": "20 MB", "mtime": 1_700_000_000 + n, "media_type": "video",
        })
    db.flush()
    posts = db.query(Post).all()
    for u in users:
        for p in random.sample(posts, 30):
            db.add(PostLike(user_id=u.id, post_id=p.id))
    from server.social import models as M
    if hasattr(M, "PostRecommendationDailyStats") and not os.environ.get("NO_DAILY"):
        today = datetime.now(timezone.utc).date()
        pairs = [(p, d) for p in posts for d in range(7)]
        if os.environ.get("DAILY_ROWS"):
            pairs = random.sample(pairs, int(os.environ["DAILY_ROWS"]))
        for p, d in pairs:
                db.add(M.PostRecommendationDailyStats(post_id=p.id, day=today - timedelta(days=d), impressions=random.randint(5, 200),
                       qualified_views=random.randint(1, 50), completions=random.randint(0, 20), likes=random.randint(0, 10), saves=0, shares=0))
    db.commit()
if os.environ.get("SEED_SESSIONS") and engine.dialect.name == "postgresql":
    # Expired one-time-visitor sessions, as the probes leave them: one request and
    # 11 impressions each, random UUID keys, a provenance of about 300 bytes.
    from sqlalchemy import text
    t0 = time.perf_counter()
    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO recommendation_sessions (id, actor_key, anonymous_id, surface, filter_hash, filters,
                algorithm_version, status, created_at, last_accessed_at, expires_at)
            SELECT gen_random_uuid()::text, 'a:' || md5(g::text), md5(g::text), 'reels', md5('f'), '{}',
                'v', 'active', now() - interval '3 days', now() - interval '3 days', now() - interval '2 days'
            FROM generate_series(1, :n) g"""), {"n": int(os.environ["SEED_SESSIONS"])})
        conn.execute(text("""
            INSERT INTO recommendation_requests (id, session_id, page_index, requested_count, returned_count,
                candidate_count, latency_ms, diagnostics, created_at)
            SELECT gen_random_uuid()::text, id, 0, 12, 11, 200, 30, '{}', created_at FROM recommendation_sessions"""))
        conn.execute(text("""
            INSERT INTO recommendation_impressions (id, request_id, session_id, post_id, position, primary_source,
                retrieval_score, final_score, reason_key, provenance, delivered_at)
            SELECT gen_random_uuid()::text, r.id, r.session_id,
                (p.ids)[((abs(hashtext(r.id)) + pos) % array_length(p.ids, 1)) + 1], pos, 'trending', 0.5, 0.5,
                'popular_now', json_build_object('sources', json_build_array('trending', 'fresh'), 'pad', repeat('x', 250)),
                r.created_at
            FROM recommendation_requests r CROSS JOIN generate_series(0, 10) pos
            CROSS JOIN (SELECT array_agg(id) AS ids FROM posts) p"""))
    if os.environ.get("SWEEP"):
        # Then delete them again, as the expired-session sweep would, and leave the
        # files to a plain VACUUM (no REINDEX, no VACUUM FULL).
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM recommendation_sessions WHERE expires_at < now() - interval '1 day'"))
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.execute(text("VACUUM ANALYZE"))
        conn.execute(text("CHECKPOINT"))  # the timed requests should not pay for the bulk load's WAL
        size = conn.execute(text("SELECT pg_size_pretty(pg_total_relation_size('recommendation_impressions'))")).scalar()
    print(f"seeded {os.environ['SEED_SESSIONS']} sessions, impressions {size}, in {time.perf_counter() - t0:.0f}s", flush=True)

mp.setattr(app_module, "mount_spa", lambda *_: None)
mp.setattr(reels.SM, "scan_output_media", lambda _root: [])
mp.setattr(reels, "post_media_items", lambda _db=None: [dict(i) for i in ITEMS])
mp.setattr(reels, "slide_media_paths", lambda _db=None: set())
mp.setattr(reels, "META_FILE", os.path.join(tmp, "m.json"))
mp.setattr(reels, "COMMENTS_FILE", os.path.join(tmp, "c.json"))
if os.environ.get("REAL_LIMITER"):
    real_check = reels.rate_limiter.check
    mp.setattr(reels.rate_limiter, "check", lambda db, key, limit, window, **k: real_check(db, key, 10**9, window, **k))
else:
    mp.setattr(reels.rate_limiter, "check", lambda *a, **k: None)


def override_get_db():
    with Session() as db:
        yield db


app = app_module.create_app()
app.dependency_overrides[get_db] = override_get_db
client = TestClient(app)


def hit():
    client.cookies.clear()  # each probe request is a first-time visitor
    r = client.get(ROUTE)
    assert r.status_code == 200, r.text[:300]
    return len(r.content)


for _ in range(5):
    size = hit()
times = []
for _ in range(60):
    t = time.perf_counter()
    hit()
    times.append((time.perf_counter() - t) * 1000)
times.sort()
print(f"{label} {ROUTE} db={engine.dialect.name} limiter={bool(os.environ.get('REAL_LIMITER'))}: posts={N_POSTS} bytes={size} median={statistics.median(times):.1f}ms p95={times[56]:.1f}ms mean={statistics.mean(times):.1f}ms")

prof = cProfile.Profile()
prof.enable()
for _ in range(30):
    hit()
prof.disable()
out = io.StringIO()
st = pstats.Stats(prof, stream=out)
st.sort_stats("cumulative").print_stats(r"server/", 45)
print(out.getvalue())
st.dump_stats(os.path.join(launch_dir, f"inline-{label}.prof"))
