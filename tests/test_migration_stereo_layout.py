"""Migration 20261015_0013 (posts.stereo_layout): upgrade, downgrade, upgrade.

Runs on SQLite always, and on PostgreSQL too when SX_TEST_POSTGRES_URL is set
(that database must be disposable: the test downgrades it to 0012 and back).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

REPO = Path(__file__).resolve().parents[1]
REVISION = "20261015_0013"
PREVIOUS = "20261011_0012"


def _alembic(url: str, monkeypatch) -> Config:
    # migrations/env.py prefers DATABASE_URL over the ini url.
    monkeypatch.setenv("DATABASE_URL", url)
    # No ini file: env.py would otherwise run fileConfig and disable the
    # loggers other tests capture.
    config = Config()
    config.set_main_option("script_location", str(REPO / "migrations"))
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return config


def _urls(tmp_path) -> list[str]:
    urls = ["sqlite:///" + str(tmp_path / "migrate.db")]
    if os.environ.get("SX_TEST_POSTGRES_URL"):
        urls.append(os.environ["SX_TEST_POSTGRES_URL"])
    return urls


def _post_columns(engine) -> set[str]:
    return {column["name"] for column in sa.inspect(engine).get_columns("posts")}


def _reset_postgres(engine) -> None:
    if engine.dialect.name == "postgresql":
        # Other Postgres tests create tables with create_all on the same database.
        with engine.begin() as conn:
            conn.execute(sa.text("DROP SCHEMA public CASCADE; CREATE SCHEMA public"))


def _required_row(connection, table: sa.Table, row: dict) -> dict:
    """Fill every required column of ``row`` generically.

    A required foreign key reuses any row of the referenced table, inserting a
    minimal one first when it is empty (PostgreSQL enforces the constraint).
    """
    for column in table.columns:
        if column.name in row or column.nullable or column.server_default is not None:
            continue
        if column.foreign_keys:
            target = next(iter(column.foreign_keys)).column
            value = connection.execute(sa.select(target).limit(1)).scalar()
            if value is None:
                parent = _required_row(connection, target.table, {})
                connection.execute(target.table.insert().values(**parent))
                value = parent[target.name]
            row[column.name] = value
            continue
        python_type = getattr(column.type, "python_type", str)
        if python_type is int:
            row[column.name] = 0
        elif python_type is bool:
            row[column.name] = False
        elif python_type is datetime:
            row[column.name] = datetime.now(timezone.utc)
        elif python_type is dict:
            row[column.name] = {}
        elif python_type is list:
            row[column.name] = []
        else:
            row[column.name] = str(uuid.uuid4()) if column.name.endswith("id") else "x"
    return row


def _insert_post(engine, media_path: str, width: int, height: int) -> None:
    """Insert a minimal posts row, filling every required column generically."""
    table = sa.Table("posts", sa.MetaData(), autoload_with=engine)
    with engine.begin() as connection:
        row = _required_row(connection, table, {"media_path": media_path, "width": width, "height": height})
        connection.execute(table.insert().values(**row))


@pytest.mark.parametrize("index", [0, 1])
def test_stereo_layout_migration_round_trip(tmp_path, monkeypatch, index):
    urls = _urls(tmp_path)
    if index >= len(urls):
        pytest.skip("SX_TEST_POSTGRES_URL is not set")
    url = urls[index]
    config = _alembic(url, monkeypatch)
    engine = sa.create_engine(url)
    _reset_postgres(engine)
    try:
        command.upgrade(config, PREVIOUS)
        assert "stereo_layout" not in _post_columns(engine)
        tag = uuid.uuid4().hex[:8]
        _insert_post(engine, f"testpipeline-3d/{tag}-sbs.mp4", 3840, 1920)
        _insert_post(engine, f"testpipeline-3d/{tag}-wide.mp4", 1920, 1080)
        _insert_post(engine, f"uploads/{tag}-sbs.mp4", 3840, 1920)

        command.upgrade(config, REVISION)
        assert "stereo_layout" in _post_columns(engine)
        with engine.connect() as connection:
            layouts = dict(
                connection.execute(
                    sa.text("SELECT media_path, stereo_layout FROM posts WHERE media_path LIKE :tag"),
                    {"tag": f"%{tag}%"},
                ).all()
            )
        assert layouts == {
            f"testpipeline-3d/{tag}-sbs.mp4": "sbs",
            f"testpipeline-3d/{tag}-wide.mp4": "mono",
            f"uploads/{tag}-sbs.mp4": "mono",
        }

        command.downgrade(config, PREVIOUS)
        assert "stereo_layout" not in _post_columns(engine)
        command.upgrade(config, REVISION)
        assert "stereo_layout" in _post_columns(engine)
        with engine.begin() as connection:
            connection.execute(sa.text("DELETE FROM posts WHERE media_path LIKE :tag"), {"tag": f"%{tag}%"})
        command.upgrade(config, "head")
    finally:
        engine.dispose()
