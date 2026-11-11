"""Migration 20261111_0022 (tags.blocked_at): upgrade, downgrade, upgrade.

Runs on SQLite always, and on PostgreSQL too when SX_TEST_POSTGRES_URL is set
(that database must be disposable: the test downgrades it to 0021 and back).
"""
from __future__ import annotations

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.script import ScriptDirectory

from server.social.database import EXPECTED_SCHEMA_REVISION

from test_migration_stereo_layout import _alembic, _reset_postgres, _urls

REVISION = "20261111_0022"
PREVIOUS = "20261109_0021"


def _columns(engine) -> set[str]:
    return {column["name"] for column in sa.inspect(engine).get_columns("tags")}


def test_app_expects_the_migration_head(tmp_path, monkeypatch):
    # The app refuses to boot unless the database is at EXPECTED_SCHEMA_REVISION.
    head = ScriptDirectory.from_config(_alembic(_urls(tmp_path)[0], monkeypatch)).get_current_head()
    assert EXPECTED_SCHEMA_REVISION == head == REVISION


@pytest.mark.parametrize("index", [0, 1])
def test_tag_block_migration_round_trips(tmp_path, monkeypatch, index):
    urls = _urls(tmp_path)
    if index >= len(urls):
        pytest.skip("SX_TEST_POSTGRES_URL is not set")
    url = urls[index]
    config = _alembic(url, monkeypatch)
    engine = sa.create_engine(url)
    _reset_postgres(engine)
    try:
        command.upgrade(config, REVISION)
        assert "blocked_at" in _columns(engine)
        command.downgrade(config, PREVIOUS)
        assert "blocked_at" not in _columns(engine)
        command.upgrade(config, REVISION)
        assert "blocked_at" in _columns(engine)
    finally:
        command.upgrade(config, "head")
        engine.dispose()
