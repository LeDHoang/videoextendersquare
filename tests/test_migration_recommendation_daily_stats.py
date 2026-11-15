"""Migration 20261113_0023 (daily recommendation stats, fast skips): upgrade, downgrade, upgrade.

Runs on SQLite always, and on PostgreSQL too when SX_TEST_POSTGRES_URL is set
(that database must be disposable: the test downgrades it to 0022 and back).
"""
from __future__ import annotations

import pytest
import sqlalchemy as sa
from alembic import command

from test_migration_stereo_layout import _alembic, _reset_postgres, _urls

REVISION = "20261113_0023"
PREVIOUS = "20261111_0022"


def _state(engine):
    inspector = sa.inspect(engine)
    columns = {column["name"] for column in inspector.get_columns("post_recommendation_stats")}
    return "post_recommendation_daily_stats" in inspector.get_table_names(), "fast_skips" in columns


@pytest.mark.parametrize("index", [0, 1])
def test_recommendation_daily_stats_migration_round_trips(tmp_path, monkeypatch, index):
    urls = _urls(tmp_path)
    if index >= len(urls):
        pytest.skip("SX_TEST_POSTGRES_URL is not set")
    url = urls[index]
    config = _alembic(url, monkeypatch)
    engine = sa.create_engine(url)
    _reset_postgres(engine)
    try:
        command.upgrade(config, REVISION)
        assert _state(engine) == (True, True)
        command.downgrade(config, PREVIOUS)
        assert _state(engine) == (False, False)
        command.upgrade(config, REVISION)
        assert _state(engine) == (True, True)
    finally:
        command.upgrade(config, "head")
        engine.dispose()
