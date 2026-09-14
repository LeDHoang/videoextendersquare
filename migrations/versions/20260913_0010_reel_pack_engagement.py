"""Add Reel Pack likes and de-duplicated view counting.

Revision ID: 20260913_0010
Revises: 20260913_0009
Create Date: 2026-09-13
"""

import sqlalchemy as sa
from alembic import op


revision = "20260913_0010"
down_revision = "20260913_0009"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("reel_packs") as batch:
        batch.add_column(sa.Column("like_count", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("view_count", sa.Integer(), nullable=False, server_default="0"))

    op.create_table(
        "reel_pack_likes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("pack_id", sa.String(36), sa.ForeignKey("reel_packs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "pack_id", name="uq_reel_pack_like_user_pack"),
    )
    op.create_index("ix_reel_pack_likes_pack", "reel_pack_likes", ["pack_id", "created_at"])

    op.create_table(
        "reel_pack_views",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("pack_id", sa.String(36), sa.ForeignKey("reel_packs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("viewer_key", sa.String(80), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_reel_pack_views_created_at", "reel_pack_views", ["created_at"])
    op.create_index("ix_reel_pack_views_pack_viewer", "reel_pack_views", ["pack_id", "viewer_key", "created_at"])


def downgrade():
    op.drop_index("ix_reel_pack_views_pack_viewer", table_name="reel_pack_views")
    op.drop_index("ix_reel_pack_views_created_at", table_name="reel_pack_views")
    op.drop_table("reel_pack_views")

    op.drop_index("ix_reel_pack_likes_pack", table_name="reel_pack_likes")
    op.drop_table("reel_pack_likes")

    with op.batch_alter_table("reel_packs") as batch:
        batch.drop_column("view_count")
        batch.drop_column("like_count")
