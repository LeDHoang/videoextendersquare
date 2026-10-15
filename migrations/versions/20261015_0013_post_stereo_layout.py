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


def upgrade():
    with op.batch_alter_table("posts") as batch:
        batch.add_column(
            sa.Column("stereo_layout", sa.String(16), nullable=False, server_default="mono")
        )


def downgrade():
    with op.batch_alter_table("posts") as batch:
        batch.drop_column("stereo_layout")
