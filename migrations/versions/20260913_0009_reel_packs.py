"""Add first-class Reel Packs, saves, progress, and message attachments.

Revision ID: 20260913_0009
Revises: 20260913_0008
Create Date: 2026-09-13
"""

import sqlalchemy as sa
from alembic import op


revision = "20260913_0009"
down_revision = "20260913_0008"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "reel_packs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("title", sa.String(80), nullable=False),
        sa.Column("description", sa.String(500), nullable=False, server_default=""),
        sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
        sa.Column("visibility", sa.String(16), nullable=False, server_default="public"),
        sa.Column("cover_post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("location", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("save_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_reel_packs_owner_id", "reel_packs", ["owner_id"])
    op.create_index("ix_reel_packs_status", "reel_packs", ["status"])
    op.create_index("ix_reel_packs_visibility", "reel_packs", ["visibility"])
    op.create_index("ix_reel_packs_created_at", "reel_packs", ["created_at"])
    op.create_index("ix_reel_packs_deleted_at", "reel_packs", ["deleted_at"])
    op.create_index("ix_reel_packs_owner_updated", "reel_packs", ["owner_id", "updated_at", "id"])
    op.create_index("ix_reel_packs_discovery", "reel_packs", ["status", "visibility", "updated_at", "id"])

    op.create_table(
        "reel_pack_items",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("pack_id", sa.String(36), sa.ForeignKey("reel_packs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("pack_id", "post_id", name="uq_reel_pack_item_post"),
        sa.UniqueConstraint("pack_id", "position", name="uq_reel_pack_item_position"),
        sa.CheckConstraint("position >= 0", name="ck_reel_pack_item_position_nonnegative"),
    )
    op.create_index("ix_reel_pack_items_pack_id", "reel_pack_items", ["pack_id"])
    op.create_index("ix_reel_pack_items_post_id", "reel_pack_items", ["post_id"])

    op.create_table(
        "reel_pack_tags",
        sa.Column("pack_id", sa.String(36), sa.ForeignKey("reel_packs.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag_id", sa.String(36), sa.ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "reel_pack_saves",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("pack_id", sa.String(36), sa.ForeignKey("reel_packs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "pack_id", name="uq_reel_pack_save_user_pack"),
    )
    op.create_index("ix_reel_pack_saves_user", "reel_pack_saves", ["user_id", "created_at"])

    op.create_table(
        "reel_pack_progress",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("pack_id", sa.String(36), sa.ForeignKey("reel_packs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("current_item_id", sa.String(36), sa.ForeignKey("reel_pack_items.id", ondelete="SET NULL"), nullable=True),
        sa.Column("position_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("phase", sa.String(16), nullable=False, server_default="intro"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "pack_id", name="uq_reel_pack_progress_user_pack"),
        sa.CheckConstraint("position_ms >= 0", name="ck_reel_pack_progress_position_nonnegative"),
    )
    op.create_index("ix_reel_pack_progress_user_updated", "reel_pack_progress", ["user_id", "updated_at"])

    with op.batch_alter_table("direct_messages") as batch:
        batch.add_column(sa.Column("pack_id", sa.String(36), nullable=True))
        batch.create_foreign_key(
            "fk_direct_messages_pack_id_reel_packs",
            "reel_packs",
            ["pack_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index("ix_direct_messages_pack_id", ["pack_id"])
        batch.create_check_constraint(
            "ck_direct_message_single_attachment",
            "NOT (post_id IS NOT NULL AND pack_id IS NOT NULL)",
        )

    with op.batch_alter_table("engagement_events") as batch:
        batch.add_column(sa.Column("pack_id", sa.String(36), nullable=True))
        batch.create_foreign_key(
            "fk_engagement_events_pack_id_reel_packs",
            "reel_packs",
            ["pack_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index("ix_engagement_events_pack_id", ["pack_id"])
        batch.create_index("ix_engagement_pack_type_created", ["pack_id", "event_type", "created_at"])


def downgrade():
    with op.batch_alter_table("engagement_events") as batch:
        batch.drop_index("ix_engagement_pack_type_created")
        batch.drop_index("ix_engagement_events_pack_id")
        batch.drop_constraint("fk_engagement_events_pack_id_reel_packs", type_="foreignkey")
        batch.drop_column("pack_id")

    with op.batch_alter_table("direct_messages") as batch:
        batch.drop_constraint("ck_direct_message_single_attachment", type_="check")
        batch.drop_index("ix_direct_messages_pack_id")
        batch.drop_constraint("fk_direct_messages_pack_id_reel_packs", type_="foreignkey")
        batch.drop_column("pack_id")

    op.drop_table("reel_pack_progress")
    op.drop_table("reel_pack_saves")
    op.drop_table("reel_pack_tags")
    op.drop_table("reel_pack_items")
    op.drop_table("reel_packs")
