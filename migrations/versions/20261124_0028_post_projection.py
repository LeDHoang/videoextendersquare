"""VR 180/360 posts: per-post projection (flat | equirect180 | equirect360).

Revision ID: 20261124_0028
Revises: 20261116_0027
Create Date: 2026-11-24
"""

import sqlalchemy as sa
from alembic import op


revision = "20261124_0028"
down_revision = "20261116_0027"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("posts") as batch:
        batch.add_column(sa.Column("projection", sa.String(16), nullable=False, server_default="flat"))


def downgrade():
    with op.batch_alter_table("posts") as batch:
        batch.drop_column("projection")
