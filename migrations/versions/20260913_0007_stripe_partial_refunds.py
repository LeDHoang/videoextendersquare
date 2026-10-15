"""Track cumulative Stripe refund/dispute amounts for pro-rated reversals.

Revision ID: 20260913_0007
Revises: 20260913_0006
Create Date: 2026-09-13
"""

import sqlalchemy as sa
from alembic import op


revision = "20260913_0007"
down_revision = "20260913_0006"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "stripe_purchases",
        sa.Column("amount_refunded_cents", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "stripe_purchases",
        sa.Column("credits_revoked", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade():
    op.drop_column("stripe_purchases", "credits_revoked")
    op.drop_column("stripe_purchases", "amount_refunded_cents")
