"""Searchable index of upload traces (the events themselves live in the R2 log bucket).

Revision ID: 20261109_0021
Revises: 20261101_0020
Create Date: 2026-11-09
"""

import sqlalchemy as sa
from alembic import op


revision = "20261109_0021"
down_revision = "20261101_0020"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "upload_traces",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=True),
        sa.Column("kind", sa.String(8), nullable=True),
        sa.Column("filename", sa.String(255), nullable=True),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("job_id", sa.String(64), nullable=True),
        sa.Column("post_id", sa.String(36), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("process_ms", sa.Integer(), nullable=True),
        sa.Column("cost", sa.Float(), nullable=True),
        sa.Column("error", sa.String(500), nullable=True),
        sa.Column("event_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("file_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_upload_traces_user_id", "upload_traces", ["user_id"])
    op.create_index("ix_upload_traces_job_id", "upload_traces", ["job_id"])
    op.create_index("ix_upload_traces_post_id", "upload_traces", ["post_id"])
    op.create_index("ix_upload_traces_created_at", "upload_traces", ["created_at"])
    op.create_index("ix_upload_traces_status_created", "upload_traces", ["status", "created_at"])


def downgrade():
    op.drop_table("upload_traces")
