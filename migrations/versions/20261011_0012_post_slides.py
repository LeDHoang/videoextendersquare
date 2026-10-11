"""Multi-image posts: extra slides per image post and a per-post dwell time.

Revision ID: 20261011_0012
Revises: 20261005_0011
Create Date: 2026-10-11
"""

import sqlalchemy as sa
from alembic import op


revision = "20261011_0012"
down_revision = "20261005_0011"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("posts") as batch:
        batch.add_column(sa.Column("dwell_ms", sa.Integer(), nullable=True))

    op.create_table(
        "post_slides",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("media_path", sa.String(1000), nullable=False),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("post_id", "position", name="uq_post_slide_position"),
        sa.CheckConstraint("position >= 1", name="ck_post_slide_position_positive"),
    )
    op.create_index("ix_post_slides_post_id", "post_slides", ["post_id"])
    op.create_index("ix_post_slides_media_path", "post_slides", ["media_path"], unique=True)


def downgrade():
    op.drop_index("ix_post_slides_media_path", table_name="post_slides")
    op.drop_index("ix_post_slides_post_id", table_name="post_slides")
    op.drop_table("post_slides")
    with op.batch_alter_table("posts") as batch:
        batch.drop_column("dwell_ms")
