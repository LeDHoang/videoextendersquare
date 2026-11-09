"""Migration 20261109_0021 (upload_traces): upgrade, downgrade, upgrade.

Runs on SQLite always, and on PostgreSQL too when SX_TEST_POSTGRES_URL is set
(that database must be disposable: the test downgrades it to 0020 and back).
"""
from __future__ import annotations

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.script import ScriptDirectory

from server.social.database import EXPECTED_SCHEMA_REVISION

from test_migration_stereo_layout import _alembic, _reset_postgres, _urls

REVISION = "20261109_0021"
PREVIOUS = "20261101_0020"


def test_app_expects_the_migration_head(tmp_path, monkeypatch):
    # The app refuses to boot unless the database is at EXPECTED_SCHEMA_REVISION.
    head = ScriptDirectory.from_config(_alembic(_urls(tmp_path)[0], monkeypatch)).get_current_head()
    assert EXPECTED_SCHEMA_REVISION == head == REVISION


@pytest.mark.parametrize("index", [0, 1])
def test_upload_traces_migration_round_trips(tmp_path, monkeypatch, index):
    urls = _urls(tmp_path)
    if index >= len(urls):
        pytest.skip("SX_TEST_POSTGRES_URL is not set")
    url = urls[index]
    config = _alembic(url, monkeypatch)
    engine = sa.create_engine(url)
    _reset_postgres(engine)
    try:
        command.upgrade(config, REVISION)
        assert "upload_traces" in sa.inspect(engine).get_table_names()
        command.downgrade(config, PREVIOUS)
        assert "upload_traces" not in sa.inspect(engine).get_table_names()
        command.upgrade(config, REVISION)
        assert "upload_traces" in sa.inspect(engine).get_table_names()
    finally:
        command.upgrade(config, "head")
        engine.dispose()
