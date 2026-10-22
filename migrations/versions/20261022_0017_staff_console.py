"""Staff console: an append-only audit log of staff actions, and report claims.

Revision ID: 20261022_0017
Revises: 20261022_0016
Create Date: 2026-10-22
"""

import sqlalchemy as sa
from alembic import op


revision = "20261022_0017"
down_revision = "20261022_0016"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "staff_actions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("action", sa.String(40), nullable=False),
        sa.Column("target_type", sa.String(16), nullable=False),
        sa.Column("target_id", sa.String(64), nullable=False),
        sa.Column("report_id", sa.String(36), sa.ForeignKey("reports.id", ondelete="SET NULL"), nullable=True),
        sa.Column("reason", sa.String(500), nullable=False, server_default=""),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_staff_actions_actor_id", "staff_actions", ["actor_id"])
    op.create_index("ix_staff_actions_action", "staff_actions", ["action"])
    op.create_index("ix_staff_actions_target", "staff_actions", ["target_type", "target_id"])
    op.create_index("ix_staff_actions_report_id", "staff_actions", ["report_id"])
    op.create_index("ix_staff_actions_created_at", "staff_actions", ["created_at"])
    with op.batch_alter_table("reports") as batch:
        batch.add_column(sa.Column("claimed_by_id", sa.String(36), nullable=True))
        batch.add_column(sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True))
        batch.create_foreign_key(
            "fk_reports_claimed_by_id_users", "users", ["claimed_by_id"], ["id"], ondelete="SET NULL"
        )


def downgrade():
    with op.batch_alter_table("reports") as batch:
        batch.drop_constraint("fk_reports_claimed_by_id_users", type_="foreignkey")
        batch.drop_column("claimed_at")
        batch.drop_column("claimed_by_id")
    op.drop_index("ix_staff_actions_created_at", table_name="staff_actions")
    op.drop_index("ix_staff_actions_report_id", table_name="staff_actions")
    op.drop_index("ix_staff_actions_target", table_name="staff_actions")
    op.drop_index("ix_staff_actions_action", table_name="staff_actions")
    op.drop_index("ix_staff_actions_actor_id", table_name="staff_actions")
    op.drop_table("staff_actions")
