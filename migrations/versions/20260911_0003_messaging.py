"""Add encrypted direct messaging and reel sharing.

Revision ID: 20260911_0003
Revises: 20260911_0002
"""

from alembic import op
import sqlalchemy as sa


revision = "20260911_0003"
down_revision = "20260911_0002"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("reports", sa.Column("evidence_ciphertext", sa.Text(), nullable=True))

    op.create_table(
        "conversations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False, server_default="direct"),
        sa.Column("direct_key", sa.String(80), nullable=False),
        sa.Column("requester_id", sa.String(36), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("state", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("latest_message_id", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("declined_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_conversations_kind", "conversations", ["kind"])
    op.create_index("ix_conversations_direct_key", "conversations", ["direct_key"], unique=True)
    op.create_index("ix_conversations_requester_id", "conversations", ["requester_id"])
    op.create_index("ix_conversations_state", "conversations", ["state"])
    op.create_index("ix_conversations_updated_at", "conversations", ["updated_at"])

    op.create_table(
        "conversation_members",
        sa.Column("conversation_id", sa.String(36), sa.ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_read_message_id", sa.String(36), nullable=True),
    )
    op.create_index("ix_conversation_members_user", "conversation_members", ["user_id", "conversation_id"])

    op.create_table(
        "direct_messages",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("conversation_id", sa.String(36), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sender_id", sa.String(36), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False, server_default="text"),
        sa.Column("payload_ciphertext", sa.Text(), nullable=False, server_default=""),
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("client_id", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("sender_id", "client_id", name="uq_direct_message_sender_client"),
    )
    op.create_index("ix_direct_messages_conversation_id", "direct_messages", ["conversation_id"])
    op.create_index("ix_direct_messages_sender_id", "direct_messages", ["sender_id"])
    op.create_index("ix_direct_messages_kind", "direct_messages", ["kind"])
    op.create_index("ix_direct_messages_post_id", "direct_messages", ["post_id"])
    op.create_index("ix_direct_messages_created_at", "direct_messages", ["created_at"])
    op.create_index("ix_direct_messages_deleted_at", "direct_messages", ["deleted_at"])
    op.create_index("ix_direct_messages_conversation_created", "direct_messages", ["conversation_id", "created_at", "id"])

    op.create_table(
        "message_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("recipient_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("conversation_id", sa.String(36), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("message_id", sa.String(36), sa.ForeignKey("direct_messages.id", ondelete="SET NULL"), nullable=True),
        sa.Column("event_type", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_message_events_recipient_id", "message_events", ["recipient_id"])
    op.create_index("ix_message_events_conversation_id", "message_events", ["conversation_id"])
    op.create_index("ix_message_events_event_type", "message_events", ["event_type"])
    op.create_index("ix_message_events_created_at", "message_events", ["created_at"])
    op.create_index("ix_message_events_recipient_id_id", "message_events", ["recipient_id", "id"])


def downgrade():
    op.drop_table("message_events")
    op.drop_table("direct_messages")
    op.drop_table("conversation_members")
    op.drop_table("conversations")
    op.drop_column("reports", "evidence_ciphertext")
