"""Record which Terms of Service version a user accepted at signup, and when.

Revision ID: 20261020_0014
Revises: 20261015_0013
Create Date: 2026-10-20
"""

import sqlalchemy as sa
from alembic import op


revision = "20261020_0014"
down_revision = "20261015_0013"
branch_labels = None
depends_on = None


# Nullable with no backfill: accounts created before this revision never
# accepted a recorded version, and inventing one would misstate consent.
def upgrade():
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("terms_version", sa.String(32), nullable=True))
        batch.add_column(sa.Column("terms_accepted_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    with op.batch_alter_table("users") as batch:
        batch.drop_column("terms_accepted_at")
        batch.drop_column("terms_version")
