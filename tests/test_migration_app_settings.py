"""Migration 20261101_0019 (app_settings): upgrade, downgrade, upgrade.

Runs on SQLite always, and on PostgreSQL too when SX_TEST_POSTGRES_URL is set
(that database must be disposable: the test downgrades it to 0018 and back).
"""
from __future__ import annotations

import pytest
import sqlalchemy as sa
from alembic import command

from test_migration_stereo_layout import _alembic, _reset_postgres, _urls

REVISION = "20261101_0019"
PREVIOUS = "20261031_0018"


@pytest.mark.parametrize("index", [0, 1])
def test_app_settings_migration_round_trips(tmp_path, monkeypatch, index):
    urls = _urls(tmp_path)
    if index >= len(urls):
        pytest.skip("SX_TEST_POSTGRES_URL is not set")
    url = urls[index]
    config = _alembic(url, monkeypatch)
    engine = sa.create_engine(url)
    _reset_postgres(engine)
    try:
        command.upgrade(config, REVISION)
        assert "app_settings" in sa.inspect(engine).get_table_names()
        command.downgrade(config, PREVIOUS)
        assert "app_settings" not in sa.inspect(engine).get_table_names()
        command.upgrade(config, REVISION)
        assert "app_settings" in sa.inspect(engine).get_table_names()
    finally:
        command.upgrade(config, "head")
        engine.dispose()
