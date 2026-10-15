"""Create the initial account, profile, post, and engagement schema.

Revision ID: 20260910_0001
Revises:
Create Date: 2026-09-10
"""

import sqlalchemy as sa
from alembic import op

revision = "20260910_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email", sa.String(320), nullable=True),
        sa.Column("email_norm", sa.String(320), nullable=True),
        sa.Column("username", sa.String(30), nullable=False),
        sa.Column("username_norm", sa.String(30), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=True),
        sa.Column("display_name", sa.String(60), nullable=False, server_default=""),
        sa.Column("bio", sa.String(150), nullable=False, server_default=""),
        sa.Column("website", sa.String(300), nullable=False, server_default=""),
        sa.Column("avatar_path", sa.String(500), nullable=True),
        sa.Column("avatar_color", sa.String(16), nullable=False, server_default="#FF3B1F"),
        sa.Column("account_type", sa.String(16), nullable=False, server_default="real"),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("post_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("follower_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("following_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_users_email_norm", "users", ["email_norm"], unique=True)
    op.create_index("ix_users_username_norm", "users", ["username_norm"], unique=True)
    op.create_index("ix_users_account_type", "users", ["account_type"])
    op.create_index("ix_users_status", "users", ["status"])

    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("csrf_hash", sa.String(64), nullable=False),
        sa.Column("user_agent", sa.String(300), nullable=False, server_default=""),
        sa.Column("ip_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_index("ix_auth_sessions_token_hash", "auth_sessions", ["token_hash"], unique=True)
    op.create_index("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"])

    op.create_table(
        "posts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("media_path", sa.String(1000), nullable=False),
        sa.Column("media_type", sa.String(16), nullable=False),
        sa.Column("title", sa.String(100), nullable=False, server_default=""),
        sa.Column("caption", sa.Text(), nullable=False, server_default=""),
        sa.Column("location", sa.JSON(), nullable=False),
        sa.Column("source", sa.String(32), nullable=False, server_default="upload"),
        sa.Column("status", sa.String(16), nullable=False, server_default="published"),
        sa.Column("legacy_like_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("legacy_view_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("like_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("comment_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("save_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("view_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_posts_owner_id", "posts", ["owner_id"])
    op.create_index("ix_posts_media_path", "posts", ["media_path"], unique=True)
    op.create_index("ix_posts_media_type", "posts", ["media_type"])
    op.create_index("ix_posts_status", "posts", ["status"])
    op.create_index("ix_posts_created_at", "posts", ["created_at"])
    op.create_index("ix_posts_deleted_at", "posts", ["deleted_at"])
    op.create_index("ix_posts_owner_created", "posts", ["owner_id", "created_at", "id"])
    op.create_index("ix_posts_status_created", "posts", ["status", "created_at", "id"])

    op.create_table(
        "tags",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(60), nullable=False),
        sa.Column("slug", sa.String(60), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_tags_slug", "tags", ["slug"], unique=True)

    op.create_table(
        "post_tags",
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag_id", sa.String(36), sa.ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "post_likes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "post_id", name="uq_post_like_user_post"),
    )
    op.create_index("ix_post_likes_post", "post_likes", ["post_id", "created_at"])

    op.create_table(
        "post_saves",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "post_id", name="uq_post_save_user_post"),
    )
    op.create_index("ix_post_saves_user", "post_saves", ["user_id", "created_at"])

    op.create_table(
        "follows",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("follower_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("followee_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("follower_id", "followee_id", name="uq_follow_pair"),
    )
    op.create_index("ix_follows_followee", "follows", ["followee_id", "created_at"])
    op.create_index("ix_follows_follower", "follows", ["follower_id", "created_at"])

    op.create_table(
        "comments",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("author_id", sa.String(36), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("text", sa.String(500), nullable=False),
        sa.Column("timestamp_ms", sa.Integer(), nullable=True),
        sa.Column("legacy_like_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("like_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_comments_post_id", "comments", ["post_id"])
    op.create_index("ix_comments_author_id", "comments", ["author_id"])
    op.create_index("ix_comments_created_at", "comments", ["created_at"])
    op.create_index("ix_comments_post_created", "comments", ["post_id", "created_at", "id"])

    op.create_table(
        "comment_likes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("comment_id", sa.String(64), sa.ForeignKey("comments.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "comment_id", name="uq_comment_like_user_comment"),
    )

    op.create_table(
        "view_dedup",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("viewer_key", sa.String(80), nullable=False),
        sa.Column("window_date", sa.String(10), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("post_id", "viewer_key", "window_date", name="uq_view_window"),
    )
    op.create_index("ix_view_dedup_created", "view_dedup", ["created_at"])

    op.create_table(
        "engagement_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("client_event_id", sa.String(64), nullable=True, unique=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("anonymous_id", sa.String(64), nullable=True),
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("event_type", sa.String(40), nullable=False),
        sa.Column("source", sa.String(40), nullable=False, server_default="unknown"),
        sa.Column("watch_ms", sa.Integer(), nullable=True),
        sa.Column("position_ms", sa.Integer(), nullable=True),
        sa.Column("completed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("context", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    for name in ("user_id", "anonymous_id", "post_id", "event_type", "source", "created_at"):
        op.create_index(f"ix_engagement_events_{name}", "engagement_events", [name])

    op.create_table(
        "data_migrations",
        sa.Column("key", sa.String(100), primary_key=True),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    for table in (
        "data_migrations",
        "engagement_events",
        "view_dedup",
        "comment_likes",
        "comments",
        "follows",
        "post_saves",
        "post_likes",
        "post_tags",
        "tags",
        "posts",
        "auth_sessions",
        "users",
    ):
        op.drop_table(table)
