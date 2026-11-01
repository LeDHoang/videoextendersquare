"""Device id on auth sessions, for limits shared by every account on one browser.

Revision ID: 20261101_0020
Revises: 20261101_0019
Create Date: 2026-11-01
"""

import sqlalchemy as sa
from alembic import op


revision = "20261101_0020"
down_revision = "20261101_0019"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("auth_sessions") as batch:
        batch.add_column(sa.Column("device_hash", sa.String(64), nullable=True))
        batch.create_index("ix_auth_sessions_device_hash", ["device_hash"])


def downgrade():
    with op.batch_alter_table("auth_sessions") as batch:
        batch.drop_index("ix_auth_sessions_device_hash")
        batch.drop_column("device_hash")
