"""Store reel duration and pixel size on posts.

Revision ID: 20261005_0011
Revises: 20260913_0010
Create Date: 2026-10-05
"""

import sqlalchemy as sa
from alembic import op


revision = "20261005_0011"
down_revision = "20260913_0010"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("posts") as batch:
        batch.add_column(sa.Column("duration_ms", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("width", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("height", sa.Integer(), nullable=True))
    _backfill_from_media_files()


def _backfill_from_media_files():
    """Best effort: probe media that is on this machine's output/ folder.

    Rows whose file is missing (a production database migrated away from the
    media volume) or whose probe fails stay NULL, which the API reports as
    "unknown". New and re-uploaded posts are probed when they are created.
    """
    from pathlib import Path

    from server import media as media_service

    bind = op.get_bind()
    posts = sa.table(
        "posts",
        sa.column("id", sa.String),
        sa.column("media_path", sa.String),
        sa.column("media_type", sa.String),
        sa.column("duration_ms", sa.Integer),
        sa.column("width", sa.Integer),
        sa.column("height", sa.Integer),
    )
    root = Path("output")
    for row in bind.execute(sa.select(posts.c.id, posts.c.media_path, posts.c.media_type)).fetchall():
        path = root / row.media_path
        try:
            if not path.is_file():
                continue
        except OSError:
            continue
        info = media_service.probe_media_info(str(path))
        if not info:
            continue
        bind.execute(
            posts.update()
            .where(posts.c.id == row.id)
            .values(
                duration_ms=info["duration_ms"] if row.media_type == "video" else None,
                width=info["width"],
                height=info["height"],
            )
        )


def downgrade():
    with op.batch_alter_table("posts") as batch:
        batch.drop_column("height")
        batch.drop_column("width")
        batch.drop_column("duration_ms")
