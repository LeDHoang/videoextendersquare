"""Create user profiles and social interaction tables.

Revision ID: 20260910_0001
Revises:
Create Date: 2026-09-10
"""

from alembic import op

from server.social.models import Base

revision = "20260910_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    Base.metadata.create_all(bind=op.get_bind())


def downgrade():
    bind = op.get_bind()
    for table in reversed(Base.metadata.sorted_tables):
        table.drop(bind=bind, checkfirst=True)
