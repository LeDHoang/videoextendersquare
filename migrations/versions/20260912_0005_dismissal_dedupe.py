"""Deduplicate recommendation dismissals with partial unique indexes.

Revision ID: 20260912_0005
Revises: 20260912_0004
Create Date: 2026-09-12
"""

import sqlalchemy as sa
from alembic import op


revision = "20260912_0005"
down_revision = "20260912_0004"
branch_labels = None
depends_on = None


def upgrade():
    # Plain UNIQUE would ignore NULLs, so concurrent double feedback could
    # still duplicate rows (and double-count negative stats). Partial indexes
    # are supported by both SQLite and PostgreSQL.
    op.create_index(
        "uq_recommendation_dismissal_actor_post",
        "recommendation_dismissals",
        ["actor_key", "post_id"],
        unique=True,
        sqlite_where=sa.text("target_type = 'post'"),
        postgresql_where=sa.text("target_type = 'post'"),
    )
    op.create_index(
        "uq_recommendation_dismissal_actor_creator",
        "recommendation_dismissals",
        ["actor_key", "creator_id"],
        unique=True,
        sqlite_where=sa.text("target_type = 'creator'"),
        postgresql_where=sa.text("target_type = 'creator'"),
    )


def downgrade():
    op.drop_index("uq_recommendation_dismissal_actor_creator", table_name="recommendation_dismissals")
    op.drop_index("uq_recommendation_dismissal_actor_post", table_name="recommendation_dismissals")
