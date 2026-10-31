"""Migration 20261031_0018 (posts.media_files): backfill from output/, downgrade, upgrade.

Runs on SQLite always, and on PostgreSQL too when SX_TEST_POSTGRES_URL is set
(that database must be disposable: the test downgrades it to 0017 and back).
"""
from __future__ import annotations

import json
import uuid

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.script import ScriptDirectory
from PIL import Image

from server.social.database import EXPECTED_SCHEMA_REVISION

from test_migration_stereo_layout import _alembic, _insert_post, _post_columns, _urls

REVISION = "20261031_0018"
PREVIOUS = "20261022_0017"


def test_app_expects_the_migration_head(tmp_path, monkeypatch):
    # The app refuses to boot unless the database is at EXPECTED_SCHEMA_REVISION.
    head = ScriptDirectory.from_config(_alembic(_urls(tmp_path)[0], monkeypatch)).get_current_head()
    assert EXPECTED_SCHEMA_REVISION == head == REVISION


@pytest.mark.parametrize("index", [0, 1])
def test_media_files_migration_backfills_local_files(tmp_path, monkeypatch, index):
    urls = _urls(tmp_path)
    if index >= len(urls):
        pytest.skip("SX_TEST_POSTGRES_URL is not set")
    url = urls[index]
    config = _alembic(url, monkeypatch)
    engine = sa.create_engine(url)
    monkeypatch.chdir(tmp_path)
    uploads = tmp_path / "output" / "uploads"
    uploads.mkdir(parents=True)
    tag = uuid.uuid4().hex[:8]
    Image.new("RGB", (8, 8)).save(uploads / f"{tag}-here.png")
    Image.new("RGB", (8, 8)).save(uploads / f"{tag}-here-poster.jpg")
    try:
        command.upgrade(config, PREVIOUS)
        _insert_post(engine, f"uploads/{tag}-here.png", 8, 8)
        _insert_post(engine, f"uploads/{tag}-gone.png", 8, 8)

        command.upgrade(config, REVISION)
        with engine.connect() as connection:
            rows = dict(
                connection.execute(
                    sa.text("SELECT media_path, media_files FROM posts WHERE media_path LIKE :tag"),
                    {"tag": f"%{tag}%"},
                ).all()
            )
        recorded = rows[f"uploads/{tag}-here.png"]
        recorded = json.loads(recorded) if isinstance(recorded, str) else recorded
        assert set(recorded) == {f"uploads/{tag}-here.png", f"uploads/{tag}-here-poster.jpg"}
        assert recorded[f"uploads/{tag}-here.png"]["bytes"] == (uploads / f"{tag}-here.png").stat().st_size
        # No original on this machine: left unrecorded, readers probe the disk.
        assert rows[f"uploads/{tag}-gone.png"] is None

        command.downgrade(config, PREVIOUS)
        assert "media_files" not in _post_columns(engine)
        command.upgrade(config, REVISION)
        assert "media_files" in _post_columns(engine)
        with engine.begin() as connection:
            connection.execute(sa.text("DELETE FROM posts WHERE media_path LIKE :tag"), {"tag": f"%{tag}%"})
        command.upgrade(config, "head")
    finally:
        engine.dispose()
