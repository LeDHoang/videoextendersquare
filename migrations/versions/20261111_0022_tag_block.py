"""Staff can block a tag: hidden everywhere and refused on new posts until unblocked.

Revision ID: 20261111_0022
Revises: 20261109_0021
Create Date: 2026-11-11
"""

import sqlalchemy as sa
from alembic import op


revision = "20261111_0022"
down_revision = "20261109_0021"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("tags") as batch:
        batch.add_column(sa.Column("blocked_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    with op.batch_alter_table("tags") as batch:
        batch.drop_column("blocked_at")
