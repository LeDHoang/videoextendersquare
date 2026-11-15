"""Per-user index of job results (the Upload page's "my media" list).

Revision ID: 20261115_0026
Revises: 20261114_0025
Create Date: 2026-11-15
"""

import sqlalchemy as sa
from alembic import op


revision = "20261115_0026"
down_revision = "20261114_0025"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "user_renders",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("role", sa.String(8), nullable=False, server_default="square"),
        sa.Column("source_stage_id", sa.String(64), nullable=True),
        sa.Column("source_job_id", sa.String(64), nullable=True),
        sa.Column("filename", sa.String(255), nullable=True),
        sa.Column("status", sa.String(12), nullable=False, server_default="working"),
        sa.Column("kept", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("file_name", sa.String(80), nullable=True),
        sa.Column("preview_name", sa.String(80), nullable=True),
        sa.Column("thumb_name", sa.String(80), nullable=True),
        sa.Column("post_id", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_user_renders_user_id", "user_renders", ["user_id"])
    op.create_index("ix_user_renders_user_created", "user_renders", ["user_id", "created_at"])


def downgrade():
    op.drop_table("user_renders")
