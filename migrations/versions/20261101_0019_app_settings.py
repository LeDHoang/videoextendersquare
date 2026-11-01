"""Runtime settings that staff change without a deploy (the processing kill switches).

Revision ID: 20261101_0019
Revises: 20261031_0018
Create Date: 2026-11-01
"""

import sqlalchemy as sa
from alembic import op


revision = "20261101_0019"
down_revision = "20261031_0018"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(100), primary_key=True),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("updated_by", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    op.drop_table("app_settings")
