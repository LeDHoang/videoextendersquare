"""How far the shared rate limit overshoots when processes check one key at once.

usage (repo root, a throwaway PostgreSQL database):
  RACE_URL=postgresql+psycopg://... PYTHONPATH=. PYTHON_DOTENV_DISABLED=1 python limit_race.py <runs> <processes>

Each run: <processes> processes check one key 40 times each against a limit of
30. Prints the number allowed per run; 30 is exact.
"""
import os, subprocess, sys
from sqlalchemy import create_engine, text
from server.social.database import Base
import server.social.models  # noqa: F401

url = os.environ["RACE_URL"]
e = create_engine(url); Base.metadata.create_all(e)
script = """
from fastapi import HTTPException
from server.social import auth, database
allowed = 0
for _ in range(40):
    with database.SessionLocal() as db:
        try:
            auth.rate_limiter.check(db, 'rec-feed:ip:1.2.3.4', 30, 60, shared=True); allowed += 1
        except HTTPException:
            pass
print(allowed)
"""
env = {**os.environ, "DATABASE_URL": url, "SX_SECURITY_SECRET": "test-only-security-secret", "PYTHON_DOTENV_DISABLED": "1"}
sums = []
for run in range(int(sys.argv[1])):
    with e.begin() as c: c.execute(text("delete from rate_limit_events"))
    ws = [subprocess.Popen([sys.executable, "-c", script], env=env, stdout=subprocess.PIPE, text=True) for _ in range(int(sys.argv[2]))]
    sums.append(sum(int(w.communicate(timeout=120)[0]) for w in ws))
print(sums)
