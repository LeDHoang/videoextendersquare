"""Comments can reply to a comment (one level: replies attach to the top-level comment).

Revision ID: 20261114_0025
Revises: 20261113_0024
Create Date: 2026-11-14
"""

import sqlalchemy as sa
from alembic import op


revision = "20261114_0025"
down_revision = "20261113_0024"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("comments") as batch:
        batch.add_column(sa.Column("parent_id", sa.String(64), nullable=True))
        batch.create_foreign_key(
            "fk_comments_parent_id_comments", "comments", ["parent_id"], ["id"], ondelete="CASCADE"
        )
        batch.create_index("ix_comments_parent_id", ["parent_id"])


def downgrade():
    with op.batch_alter_table("comments") as batch:
        batch.drop_index("ix_comments_parent_id")
        batch.drop_constraint("fk_comments_parent_id_comments", type_="foreignkey")
        batch.drop_column("parent_id")
