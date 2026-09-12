"""Add recommendation sessions, attribution, feedback, and aggregates.

Revision ID: 20260912_0004
Revises: 20260911_0003
Create Date: 2026-09-12
"""

import sqlalchemy as sa
from alembic import op


revision = "20260912_0004"
down_revision = "20260911_0003"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "recommendation_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("actor_key", sa.String(80), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("anonymous_id", sa.String(64), nullable=True),
        sa.Column("surface", sa.String(32), nullable=False),
        sa.Column("seed_post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("filter_hash", sa.String(64), nullable=False),
        sa.Column("filters", sa.JSON(), nullable=False),
        sa.Column("algorithm_version", sa.String(64), nullable=False),
        sa.Column("experiment_id", sa.String(64), nullable=True),
        sa.Column("variant", sa.String(32), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("restart_reason", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_accessed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    for name in ("actor_key", "user_id", "anonymous_id", "surface", "filter_hash", "status", "last_accessed_at", "expires_at"):
        op.create_index(f"ix_recommendation_sessions_{name}", "recommendation_sessions", [name])
    op.create_index(
        "ix_recommendation_sessions_actor_surface",
        "recommendation_sessions",
        ["actor_key", "surface", "last_accessed_at"],
    )

    op.create_table(
        "recommendation_requests",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("recommendation_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("page_index", sa.Integer(), nullable=False),
        sa.Column("requested_count", sa.Integer(), nullable=False),
        sa.Column("returned_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("candidate_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("latency_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("fallback_reason", sa.String(64), nullable=True),
        sa.Column("diagnostics", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("session_id", "page_index", name="uq_recommendation_request_session_page"),
    )
    op.create_index("ix_recommendation_requests_session_id", "recommendation_requests", ["session_id"])

    op.create_table(
        "recommendation_impressions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("request_id", sa.String(36), sa.ForeignKey("recommendation_requests.id", ondelete="CASCADE"), nullable=False),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("recommendation_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("creator_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("primary_source", sa.String(40), nullable=False),
        sa.Column("source_rank", sa.Integer(), nullable=True),
        sa.Column("retrieval_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("final_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("reason_key", sa.String(64), nullable=False, server_default="popular_now"),
        sa.Column("provenance", sa.JSON(), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("first_visible_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "(post_id IS NOT NULL AND creator_id IS NULL) OR "
            "(post_id IS NULL AND creator_id IS NOT NULL)",
            name="ck_recommendation_impression_one_target",
        ),
        sa.UniqueConstraint("session_id", "position", name="uq_recommendation_impression_session_position"),
        sa.UniqueConstraint("session_id", "post_id", name="uq_recommendation_impression_session_post"),
        sa.UniqueConstraint("session_id", "creator_id", name="uq_recommendation_impression_session_creator"),
    )
    for name in ("request_id", "session_id", "post_id", "creator_id", "first_visible_at"):
        op.create_index(f"ix_recommendation_impressions_{name}", "recommendation_impressions", [name])

    op.create_table(
        "recommendation_dismissals",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("actor_key", sa.String(80), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("anonymous_id", sa.String(64), nullable=True),
        sa.Column("target_type", sa.String(16), nullable=False),
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=True),
        sa.Column("creator_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("reason", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "(target_type = 'post' AND post_id IS NOT NULL AND creator_id IS NULL) OR "
            "(target_type = 'creator' AND post_id IS NULL AND creator_id IS NOT NULL)",
            name="ck_recommendation_dismissal_target",
        ),
    )
    for name in ("actor_key", "user_id", "anonymous_id", "target_type", "post_id", "creator_id", "expires_at"):
        op.create_index(f"ix_recommendation_dismissals_{name}", "recommendation_dismissals", [name])
    op.create_index(
        "ix_recommendation_dismissal_actor_target",
        "recommendation_dismissals",
        ["actor_key", "target_type", "post_id", "creator_id"],
    )

    op.create_table(
        "actor_item_affinities",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("actor_key", sa.String(80), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("anonymous_id", sa.String(64), nullable=True),
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("positive_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("negative_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("qualified_watches", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_watch_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_event_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("actor_key", "post_id", name="uq_actor_item_affinity"),
    )
    for name in ("user_id", "anonymous_id", "post_id", "last_event_at"):
        op.create_index(f"ix_actor_item_affinities_{name}", "actor_item_affinities", [name])
    op.create_index("ix_actor_item_affinity_actor_score", "actor_item_affinities", ["actor_key", "score"])

    op.create_table(
        "actor_creator_affinities",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("actor_key", sa.String(80), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("anonymous_id", sa.String(64), nullable=True),
        sa.Column("creator_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("positive_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("negative_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_event_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("actor_key", "creator_id", name="uq_actor_creator_affinity"),
    )
    for name in ("user_id", "anonymous_id", "creator_id", "last_event_at"):
        op.create_index(f"ix_actor_creator_affinities_{name}", "actor_creator_affinities", [name])
    op.create_index("ix_actor_creator_affinity_actor_score", "actor_creator_affinities", ["actor_key", "score"])

    op.create_table(
        "actor_tag_affinities",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("actor_key", sa.String(80), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("anonymous_id", sa.String(64), nullable=True),
        sa.Column("tag_id", sa.String(36), sa.ForeignKey("tags.id", ondelete="CASCADE"), nullable=False),
        sa.Column("score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("positive_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("negative_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_event_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("actor_key", "tag_id", name="uq_actor_tag_affinity"),
    )
    for name in ("user_id", "anonymous_id", "tag_id", "last_event_at"):
        op.create_index(f"ix_actor_tag_affinities_{name}", "actor_tag_affinities", [name])
    op.create_index("ix_actor_tag_affinity_actor_score", "actor_tag_affinities", ["actor_key", "score"])

    op.create_table(
        "post_recommendation_stats",
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("impressions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("qualified_views", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("skips", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("likes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("saves", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("shares", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("negative_feedback", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_watch_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_post_recommendation_stats_updated_at", "post_recommendation_stats", ["updated_at"])

    op.create_table(
        "co_watch_pairs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("actor_key", sa.String(80), nullable=False),
        sa.Column("left_post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("right_post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("left_post_id < right_post_id", name="ck_co_watch_pair_order"),
        sa.UniqueConstraint("actor_key", "left_post_id", "right_post_id", name="uq_co_watch_actor_pair"),
    )
    for name in ("actor_key", "left_post_id", "right_post_id"):
        op.create_index(f"ix_co_watch_pairs_{name}", "co_watch_pairs", [name])

    op.create_table(
        "item_similarities",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("source_post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("target_post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("method", sa.String(24), nullable=False, server_default="co_watch"),
        sa.Column("model_version", sa.String(32), nullable=False, server_default="co-watch-v1"),
        sa.Column("score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("support", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("source_post_id != target_post_id", name="ck_item_similarity_distinct"),
        sa.UniqueConstraint(
            "source_post_id",
            "target_post_id",
            "method",
            "model_version",
            name="uq_item_similarity_version",
        ),
    )
    for name in ("source_post_id", "target_post_id", "updated_at"):
        op.create_index(f"ix_item_similarities_{name}", "item_similarities", [name])
    op.create_index("ix_item_similarity_source_score", "item_similarities", ["source_post_id", "score"])

    event_columns = (
        sa.Column(
            "recommendation_impression_id",
            sa.String(36),
            sa.ForeignKey(
                "recommendation_impressions.id",
                ondelete="SET NULL",
                name="fk_engagement_events_recommendation_impression_id",
            ),
            nullable=True,
        ),
        sa.Column(
            "recommendation_request_id",
            sa.String(36),
            sa.ForeignKey(
                "recommendation_requests.id",
                ondelete="SET NULL",
                name="fk_engagement_events_recommendation_request_id",
            ),
            nullable=True,
        ),
        sa.Column(
            "recommendation_session_id",
            sa.String(36),
            sa.ForeignKey(
                "recommendation_sessions.id",
                ondelete="SET NULL",
                name="fk_engagement_events_recommendation_session_id",
            ),
            nullable=True,
        ),
        sa.Column("foreground_ms", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("watch_ratio", sa.Float(), nullable=True),
        sa.Column("navigation_reason", sa.String(32), nullable=True),
        sa.Column("playback_quality", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("client_occurred_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("schema_version", sa.Integer(), nullable=False, server_default="2"),
    )
    with op.batch_alter_table("engagement_events") as batch_op:
        for column in event_columns:
            batch_op.add_column(column)
        for name in ("recommendation_impression_id", "recommendation_request_id", "recommendation_session_id"):
            batch_op.create_index(f"ix_engagement_events_{name}", [name])
        batch_op.create_index(
            "ix_engagement_actor_created",
            ["user_id", "anonymous_id", "created_at"],
        )
        batch_op.create_index(
            "ix_engagement_post_type_created",
            ["post_id", "event_type", "created_at"],
        )


def downgrade():
    with op.batch_alter_table("engagement_events") as batch_op:
        batch_op.drop_index("ix_engagement_post_type_created")
        batch_op.drop_index("ix_engagement_actor_created")
        for name in ("recommendation_session_id", "recommendation_request_id", "recommendation_impression_id"):
            batch_op.drop_index(f"ix_engagement_events_{name}")
        for name in (
            "schema_version",
            "client_occurred_at",
            "playback_quality",
            "navigation_reason",
            "watch_ratio",
            "duration_ms",
            "foreground_ms",
            "recommendation_session_id",
            "recommendation_request_id",
            "recommendation_impression_id",
        ):
            batch_op.drop_column(name)
    for table in (
        "item_similarities",
        "co_watch_pairs",
        "post_recommendation_stats",
        "actor_tag_affinities",
        "actor_creator_affinities",
        "actor_item_affinities",
        "recommendation_dismissals",
        "recommendation_impressions",
        "recommendation_requests",
        "recommendation_sessions",
    ):
        op.drop_table(table)
