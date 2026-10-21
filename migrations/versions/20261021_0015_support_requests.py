"""Support inbox: requests fileable signed out, optionally linked to a report.

Revision ID: 20261021_0015
Revises: 20261020_0014
Create Date: 2026-10-21
"""

import sqlalchemy as sa
from alembic import op


revision = "20261021_0015"
down_revision = "20261020_0014"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "support_requests",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("category", sa.String(24), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="open"),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("email", sa.String(320), nullable=True),
        sa.Column("subject", sa.String(120), nullable=False, server_default=""),
        sa.Column("body", sa.String(4000), nullable=False, server_default=""),
        sa.Column("link", sa.String(500), nullable=False, server_default=""),
        sa.Column("report_id", sa.String(36), sa.ForeignKey("reports.id", ondelete="SET NULL"), nullable=True),
        sa.Column("ip_hash", sa.String(64), nullable=True),
        sa.Column("moderator_note", sa.String(1000), nullable=False, server_default=""),
        sa.Column("handled_by_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_support_requests_category", "support_requests", ["category"])
    op.create_index("ix_support_requests_status", "support_requests", ["status"])
    op.create_index("ix_support_requests_user_id", "support_requests", ["user_id"])
    op.create_index("ix_support_requests_ip_hash", "support_requests", ["ip_hash"])
    op.create_index("ix_support_requests_created_at", "support_requests", ["created_at"])
    op.create_index("ix_support_requests_status_created", "support_requests", ["status", "created_at"])


def downgrade():
    op.drop_index("ix_support_requests_status_created", table_name="support_requests")
    op.drop_index("ix_support_requests_created_at", table_name="support_requests")
    op.drop_index("ix_support_requests_ip_hash", table_name="support_requests")
    op.drop_index("ix_support_requests_user_id", table_name="support_requests")
    op.drop_index("ix_support_requests_status", table_name="support_requests")
    op.drop_index("ix_support_requests_category", table_name="support_requests")
    op.drop_table("support_requests")
