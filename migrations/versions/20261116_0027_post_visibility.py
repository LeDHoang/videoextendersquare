"""Private posts: per-post visibility (public | private).

Revision ID: 20261116_0027
Revises: 20261115_0026
Create Date: 2026-11-16
"""

import sqlalchemy as sa
from alembic import op


revision = "20261116_0027"
down_revision = "20261115_0026"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("posts") as batch:
        batch.add_column(
            sa.Column("visibility", sa.String(16), nullable=False, server_default="public")
        )


def downgrade():
    with op.batch_alter_table("posts") as batch:
        batch.drop_column("visibility")
