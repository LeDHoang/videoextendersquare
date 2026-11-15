"""Reel reward claims survive recommendation session purges.

The claim's impression FK cascaded, so purging an expired session deleted
today's claims with it: the daily count dropped and the next milestone reused
an already-paid ledger key, silently earning nothing. SET NULL keeps the claim.

Revision ID: 20261113_0024
Revises: 20261113_0023
Create Date: 2026-11-13
"""

import sqlalchemy as sa
from alembic import op


revision = "20261113_0024"
down_revision = "20261113_0023"
branch_labels = None
depends_on = None

FK_NAME = "fk_reel_reward_claims_impression_id_recommendation_impressions"
# 0006 left this FK unnamed: SQLite reflects it nameless, so batch mode names
# it by this convention; PostgreSQL reports its generated name.
NAMING = {"fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"}


def _impression_fk_name():
    for fk in sa.inspect(op.get_bind()).get_foreign_keys("reel_reward_claims"):
        if fk["constrained_columns"] == ["impression_id"]:
            return fk["name"] or FK_NAME
    return FK_NAME


def _replace_impression_fk(*, nullable, ondelete):
    existing = _impression_fk_name()
    with op.batch_alter_table("reel_reward_claims", naming_convention=NAMING) as batch:
        batch.drop_constraint(existing, type_="foreignkey")
        batch.alter_column("impression_id", existing_type=sa.String(36), nullable=nullable)
        batch.create_foreign_key(
            FK_NAME, "recommendation_impressions", ["impression_id"], ["id"], ondelete=ondelete
        )


def upgrade():
    _replace_impression_fk(nullable=True, ondelete="SET NULL")


def downgrade():
    # The old schema cannot hold an orphaned claim; it would have cascaded away.
    op.execute("DELETE FROM reel_reward_claims WHERE impression_id IS NULL")
    _replace_impression_fk(nullable=False, ondelete="CASCADE")
