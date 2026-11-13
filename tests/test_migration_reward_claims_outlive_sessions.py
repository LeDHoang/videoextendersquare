"""Migration 20261113_0024 (reward claims survive session purges): upgrade, downgrade, upgrade.

Runs on SQLite always, and on PostgreSQL too when SX_TEST_POSTGRES_URL is set
(that database must be disposable: the test downgrades it to 0023 and back).
"""
from __future__ import annotations

import uuid

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.script import ScriptDirectory

from server.social.database import EXPECTED_SCHEMA_REVISION

from test_migration_stereo_layout import _alembic, _required_row, _reset_postgres, _urls

REVISION = "20261113_0024"
PREVIOUS = "20261113_0023"


def test_app_expects_the_migration_head(tmp_path, monkeypatch):
    # The app refuses to boot unless the database is at EXPECTED_SCHEMA_REVISION.
    head = ScriptDirectory.from_config(_alembic(_urls(tmp_path)[0], monkeypatch)).get_current_head()
    assert EXPECTED_SCHEMA_REVISION == head == REVISION


def _engine(url):
    engine = sa.create_engine(url)
    if engine.dialect.name == "sqlite":
        @sa.event.listens_for(engine, "connect")
        def _foreign_keys(dbapi_connection, _record):
            dbapi_connection.execute("PRAGMA foreign_keys=ON")
    return engine


def _claim_left_after_impression_delete(engine):
    """Insert a claim, delete its impression, and return the surviving claim's impression_id."""
    metadata = sa.MetaData()
    claims = sa.Table("reel_reward_claims", metadata, autoload_with=engine)
    impressions = sa.Table("recommendation_impressions", metadata, autoload_with=engine)
    posts = sa.Table("posts", metadata, autoload_with=engine)
    with engine.begin() as connection:
        post = _required_row(connection, posts, {"media_path": f"claim-{uuid.uuid4()}.jpg"})
        connection.execute(posts.insert().values(**post))
        # An impression must target a post (ck_recommendation_impression_one_target).
        impression = _required_row(connection, impressions, {"post_id": post["id"]})
        connection.execute(impressions.insert().values(**impression))
        row = _required_row(connection, claims, {"post_id": post["id"], "impression_id": impression["id"]})
        connection.execute(claims.insert().values(**row))
        connection.execute(impressions.delete().where(impressions.c.id == row["impression_id"]))
        left = connection.execute(sa.select(claims.c.impression_id).where(claims.c.id == row["id"])).all()
        connection.execute(claims.delete())
    return left


@pytest.mark.parametrize("index", [0, 1])
def test_reward_claims_outlive_sessions_migration_round_trips(tmp_path, monkeypatch, index):
    urls = _urls(tmp_path)
    if index >= len(urls):
        pytest.skip("SX_TEST_POSTGRES_URL is not set")
    url = urls[index]
    config = _alembic(url, monkeypatch)
    engine = _engine(url)
    _reset_postgres(engine)
    try:
        command.upgrade(config, PREVIOUS)
        assert _claim_left_after_impression_delete(engine) == []
        command.upgrade(config, REVISION)
        assert _claim_left_after_impression_delete(engine) == [(None,)]
        command.downgrade(config, PREVIOUS)
        assert _claim_left_after_impression_delete(engine) == []
        command.upgrade(config, REVISION)
        assert _claim_left_after_impression_delete(engine) == [(None,)]
    finally:
        command.upgrade(config, "head")
        engine.dispose()
