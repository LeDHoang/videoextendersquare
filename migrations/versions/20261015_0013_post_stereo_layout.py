"""Stereoscopic posts: per-post stereo layout (mono | sbs | tb).

Revision ID: 20261015_0013
Revises: 20261011_0012
Create Date: 2026-10-15
"""

import sqlalchemy as sa
from alembic import op


revision = "20261015_0013"
down_revision = "20261011_0012"
branch_labels = None
depends_on = None


# Loose files in these folders were imported before stereo metadata existed
# and are full SBS (admin spatialize output); mirrors
# server.media.LEGACY_SBS_FOLDERS. Only exact 2:1 rows are marked.
LEGACY_SBS_FOLDERS = ("testpipeline-3d",)


def upgrade():
    with op.batch_alter_table("posts") as batch:
        batch.add_column(
            sa.Column("stereo_layout", sa.String(16), nullable=False, server_default="mono")
        )

    posts = sa.table(
        "posts",
        sa.column("media_path", sa.String),
        sa.column("width", sa.Integer),
        sa.column("height", sa.Integer),
        sa.column("stereo_layout", sa.String),
    )
    for folder in LEGACY_SBS_FOLDERS:
        op.execute(
            posts.update()
            .where(posts.c.media_path.like(f"{folder}/%"))
            .where(posts.c.width == posts.c.height * 2)
            .values(stereo_layout="sbs")
        )


def downgrade():
    with op.batch_alter_table("posts") as batch:
        batch.drop_column("stereo_layout")
