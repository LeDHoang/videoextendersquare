"""Per-day recommendation stats for trending, and a fast-skip count per post.

Revision ID: 20261113_0023
Revises: 20261111_0022
Create Date: 2026-11-13
"""

import sqlalchemy as sa
from alembic import op


revision = "20261113_0023"
down_revision = "20261111_0022"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "post_recommendation_daily_stats",
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("impressions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("qualified_views", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("likes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("saves", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("shares", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index(
        "ix_post_recommendation_daily_stats_day", "post_recommendation_daily_stats", ["day"]
    )
    with op.batch_alter_table("post_recommendation_stats") as batch:
        batch.add_column(sa.Column("fast_skips", sa.Integer(), nullable=False, server_default="0"))


def downgrade():
    with op.batch_alter_table("post_recommendation_stats") as batch:
        batch.drop_column("fast_skips")
    op.drop_index("ix_post_recommendation_daily_stats_day", table_name="post_recommendation_daily_stats")
    op.drop_table("post_recommendation_daily_stats")
