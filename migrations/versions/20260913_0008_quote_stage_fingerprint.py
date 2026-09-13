"""Record the staged upload fingerprint a billing quote was priced from.

Revision ID: 20260913_0008
Revises: 20260913_0007
Create Date: 2026-09-13
"""

import sqlalchemy as sa
from alembic import op


revision = "20260913_0008"
down_revision = "20260913_0007"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("billing_quotes", sa.Column("stage_fingerprint", sa.JSON(), nullable=True))


def downgrade():
    op.drop_column("billing_quotes", "stage_fingerprint")
