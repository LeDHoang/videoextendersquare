"""Record each post's stored files (derived siblings, sizes, codecs) on the post.

Revision ID: 20261031_0018
Revises: 20261022_0017
Create Date: 2026-10-31
"""

import sqlalchemy as sa
from alembic import op


revision = "20261031_0018"
down_revision = "20261022_0017"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("posts") as batch:
        batch.add_column(sa.Column("media_files", sa.JSON(), nullable=True))
    _backfill_from_media_files()


def _backfill_from_media_files():
    """Best effort: record the files that are on this machine's output/ folder.

    Rows whose original is missing here stay NULL, and readers keep probing
    the disk for them. New posts are recorded when they are created.
    """
    from pathlib import Path

    from server import media as media_service

    bind = op.get_bind()
    posts = sa.table(
        "posts",
        sa.column("id", sa.String),
        sa.column("media_path", sa.String),
        sa.column("media_files", sa.JSON),
    )
    slides = sa.table(
        "post_slides",
        sa.column("post_id", sa.String),
        sa.column("media_path", sa.String),
    )
    slide_paths: dict[str, list[str]] = {}
    for row in bind.execute(sa.select(slides.c.post_id, slides.c.media_path)).fetchall():
        slide_paths.setdefault(row.post_id, []).append(row.media_path)
    root = Path("output")
    for row in bind.execute(sa.select(posts.c.id, posts.c.media_path)).fetchall():
        files = media_service.local_media_files(root / row.media_path)
        if row.media_path not in files:
            continue
        for rel in slide_paths.get(row.id, []):
            files.update(media_service.local_media_files(root / rel))
        bind.execute(posts.update().where(posts.c.id == row.id).values(media_files=files))


def downgrade():
    with op.batch_alter_table("posts") as batch:
        batch.drop_column("media_files")
