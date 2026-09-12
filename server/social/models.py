"""Relational model for ECHO accounts, media posts, and engagement."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def uuid4_string() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    email = Column(String(320), nullable=True)
    email_norm = Column(String(320), nullable=True, unique=True, index=True)
    username = Column(String(30), nullable=False)
    username_norm = Column(String(30), nullable=False, unique=True, index=True)
    password_hash = Column(String(255), nullable=True)
    display_name = Column(String(60), nullable=False, default="")
    bio = Column(String(150), nullable=False, default="")
    website = Column(String(300), nullable=False, default="")
    avatar_path = Column(String(500), nullable=True)
    avatar_color = Column(String(16), nullable=False, default="#FF3B1F")
    account_type = Column(String(16), nullable=False, default="real", index=True)
    role = Column(String(16), nullable=False, default="user", index=True)
    status = Column(String(16), nullable=False, default="active", index=True)
    post_count = Column(Integer, nullable=False, default=0)
    follower_count = Column(Integer, nullable=False, default=0)
    following_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)
    last_seen_at = Column(DateTime(timezone=True), nullable=True)


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    csrf_hash = Column(String(64), nullable=False)
    user_agent = Column(String(300), nullable=False, default="")
    ip_hash = Column(String(64), nullable=False, default="")
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_used_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)

    user = relationship("User")


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)
    used_at = Column(DateTime(timezone=True), nullable=True)


class RateLimitEvent(Base):
    __tablename__ = "rate_limit_events"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    key_hash = Column(String(64), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)

    __table_args__ = (Index("ix_rate_limit_key_created", "key_hash", "created_at"),)


class Post(Base):
    __tablename__ = "posts"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    owner_id = Column(String(36), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    media_path = Column(String(1000), nullable=False, unique=True, index=True)
    media_type = Column(String(16), nullable=False, index=True)
    title = Column(String(100), nullable=False, default="")
    caption = Column(Text, nullable=False, default="")
    location = Column(JSON, nullable=False, default=dict)
    source = Column(String(32), nullable=False, default="upload")
    status = Column(String(16), nullable=False, default="published", index=True)
    legacy_like_count = Column(Integer, nullable=False, default=0)
    legacy_view_count = Column(Integer, nullable=False, default=0)
    like_count = Column(Integer, nullable=False, default=0)
    comment_count = Column(Integer, nullable=False, default=0)
    save_count = Column(Integer, nullable=False, default=0)
    view_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)
    deleted_at = Column(DateTime(timezone=True), nullable=True, index=True)

    owner = relationship("User")
    tags = relationship("PostTag", cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_posts_owner_created", "owner_id", "created_at", "id"),
        Index("ix_posts_status_created", "status", "created_at", "id"),
    )


class Tag(Base):
    __tablename__ = "tags"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    name = Column(String(60), nullable=False)
    slug = Column(String(60), nullable=False, unique=True, index=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)


class PostTag(Base):
    __tablename__ = "post_tags"

    post_id = Column(String(36), ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True)
    tag_id = Column(String(36), ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    tag = relationship("Tag")


class PostLike(Base):
    __tablename__ = "post_likes"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    post_id = Column(String(36), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("user_id", "post_id", name="uq_post_like_user_post"),
        Index("ix_post_likes_post", "post_id", "created_at"),
    )


class PostSave(Base):
    __tablename__ = "post_saves"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    post_id = Column(String(36), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("user_id", "post_id", name="uq_post_save_user_post"),
        Index("ix_post_saves_user", "user_id", "created_at"),
    )


class Follow(Base):
    __tablename__ = "follows"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    follower_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    followee_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("follower_id", "followee_id", name="uq_follow_pair"),
        Index("ix_follows_followee", "followee_id", "created_at"),
        Index("ix_follows_follower", "follower_id", "created_at"),
    )


class UserBlock(Base):
    __tablename__ = "user_blocks"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    blocker_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    blocked_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("blocker_id", "blocked_id", name="uq_user_block_pair"),
        Index("ix_user_blocks_blocker", "blocker_id", "created_at"),
        Index("ix_user_blocks_blocked", "blocked_id", "created_at"),
    )


class Comment(Base):
    __tablename__ = "comments"

    id = Column(String(64), primary_key=True, default=uuid4_string)
    post_id = Column(String(36), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    author_id = Column(String(36), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    text = Column(String(500), nullable=False)
    timestamp_ms = Column(Integer, nullable=True)
    legacy_like_count = Column(Integer, nullable=False, default=0)
    like_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    author = relationship("User")
    post = relationship("Post")

    __table_args__ = (Index("ix_comments_post_created", "post_id", "created_at", "id"),)


class CommentLike(Base):
    __tablename__ = "comment_likes"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    comment_id = Column(String(64), ForeignKey("comments.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (UniqueConstraint("user_id", "comment_id", name="uq_comment_like_user_comment"),)


class ViewDedup(Base):
    __tablename__ = "view_dedup"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    post_id = Column(String(36), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False)
    viewer_key = Column(String(80), nullable=False)
    window_date = Column(String(10), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("post_id", "viewer_key", "window_date", name="uq_view_window"),
        Index("ix_view_dedup_created", "created_at"),
    )


class EngagementEvent(Base):
    __tablename__ = "engagement_events"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    client_event_id = Column(String(64), nullable=True, unique=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    anonymous_id = Column(String(64), nullable=True, index=True)
    post_id = Column(String(36), ForeignKey("posts.id", ondelete="SET NULL"), nullable=True, index=True)
    recommendation_impression_id = Column(
        String(36),
        ForeignKey("recommendation_impressions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    recommendation_request_id = Column(
        String(36),
        ForeignKey("recommendation_requests.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    recommendation_session_id = Column(
        String(36),
        ForeignKey("recommendation_sessions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    event_type = Column(String(40), nullable=False, index=True)
    source = Column(String(40), nullable=False, default="unknown", index=True)
    watch_ms = Column(Integer, nullable=True)
    foreground_ms = Column(Integer, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    watch_ratio = Column(Float, nullable=True)
    position_ms = Column(Integer, nullable=True)
    completed = Column(Boolean, nullable=False, default=False)
    navigation_reason = Column(String(32), nullable=True)
    playback_quality = Column(JSON, nullable=False, default=dict)
    client_occurred_at = Column(DateTime(timezone=True), nullable=True)
    schema_version = Column(Integer, nullable=False, default=2)
    context = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)

    __table_args__ = (
        Index("ix_engagement_actor_created", "user_id", "anonymous_id", "created_at"),
        Index("ix_engagement_post_type_created", "post_id", "event_type", "created_at"),
    )


class RecommendationSession(Base):
    __tablename__ = "recommendation_sessions"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    actor_key = Column(String(80), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    anonymous_id = Column(String(64), nullable=True, index=True)
    surface = Column(String(32), nullable=False, index=True)
    seed_post_id = Column(String(36), ForeignKey("posts.id", ondelete="SET NULL"), nullable=True)
    filter_hash = Column(String(64), nullable=False, index=True)
    filters = Column(JSON, nullable=False, default=dict)
    algorithm_version = Column(String(64), nullable=False)
    experiment_id = Column(String(64), nullable=True)
    variant = Column(String(32), nullable=True)
    status = Column(String(16), nullable=False, default="active", index=True)
    restart_reason = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_accessed_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)

    __table_args__ = (
        Index("ix_recommendation_sessions_actor_surface", "actor_key", "surface", "last_accessed_at"),
    )


class RecommendationRequest(Base):
    __tablename__ = "recommendation_requests"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    session_id = Column(
        String(36),
        ForeignKey("recommendation_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    page_index = Column(Integer, nullable=False)
    requested_count = Column(Integer, nullable=False)
    returned_count = Column(Integer, nullable=False, default=0)
    candidate_count = Column(Integer, nullable=False, default=0)
    latency_ms = Column(Integer, nullable=False, default=0)
    fallback_reason = Column(String(64), nullable=True)
    diagnostics = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("session_id", "page_index", name="uq_recommendation_request_session_page"),
    )


class RecommendationImpression(Base):
    __tablename__ = "recommendation_impressions"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    request_id = Column(
        String(36),
        ForeignKey("recommendation_requests.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    session_id = Column(
        String(36),
        ForeignKey("recommendation_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    post_id = Column(String(36), ForeignKey("posts.id", ondelete="SET NULL"), nullable=True, index=True)
    creator_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    position = Column(Integer, nullable=False)
    primary_source = Column(String(40), nullable=False)
    source_rank = Column(Integer, nullable=True)
    retrieval_score = Column(Float, nullable=False, default=0.0)
    final_score = Column(Float, nullable=False, default=0.0)
    reason_key = Column(String(64), nullable=False, default="popular_now")
    provenance = Column(JSON, nullable=False, default=dict)
    delivered_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    first_visible_at = Column(DateTime(timezone=True), nullable=True, index=True)

    __table_args__ = (
        CheckConstraint(
            "(post_id IS NOT NULL AND creator_id IS NULL) OR "
            "(post_id IS NULL AND creator_id IS NOT NULL)",
            name="ck_recommendation_impression_one_target",
        ),
        UniqueConstraint("session_id", "position", name="uq_recommendation_impression_session_position"),
        UniqueConstraint("session_id", "post_id", name="uq_recommendation_impression_session_post"),
        UniqueConstraint("session_id", "creator_id", name="uq_recommendation_impression_session_creator"),
    )


class RecommendationDismissal(Base):
    __tablename__ = "recommendation_dismissals"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    actor_key = Column(String(80), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    anonymous_id = Column(String(64), nullable=True, index=True)
    target_type = Column(String(16), nullable=False, index=True)
    post_id = Column(String(36), ForeignKey("posts.id", ondelete="CASCADE"), nullable=True, index=True)
    creator_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    reason = Column(String(32), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    expires_at = Column(DateTime(timezone=True), nullable=True, index=True)

    __table_args__ = (
        CheckConstraint(
            "(target_type = 'post' AND post_id IS NOT NULL AND creator_id IS NULL) OR "
            "(target_type = 'creator' AND post_id IS NULL AND creator_id IS NOT NULL)",
            name="ck_recommendation_dismissal_target",
        ),
        Index("ix_recommendation_dismissal_actor_target", "actor_key", "target_type", "post_id", "creator_id"),
    )


class ActorItemAffinity(Base):
    __tablename__ = "actor_item_affinities"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    actor_key = Column(String(80), nullable=False)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    anonymous_id = Column(String(64), nullable=True, index=True)
    post_id = Column(String(36), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    score = Column(Float, nullable=False, default=0.0)
    positive_count = Column(Integer, nullable=False, default=0)
    negative_count = Column(Integer, nullable=False, default=0)
    qualified_watches = Column(Integer, nullable=False, default=0)
    total_watch_ms = Column(Integer, nullable=False, default=0)
    last_event_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("actor_key", "post_id", name="uq_actor_item_affinity"),
        Index("ix_actor_item_affinity_actor_score", "actor_key", "score"),
    )


class ActorCreatorAffinity(Base):
    __tablename__ = "actor_creator_affinities"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    actor_key = Column(String(80), nullable=False)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    anonymous_id = Column(String(64), nullable=True, index=True)
    creator_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    score = Column(Float, nullable=False, default=0.0)
    positive_count = Column(Integer, nullable=False, default=0)
    negative_count = Column(Integer, nullable=False, default=0)
    last_event_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("actor_key", "creator_id", name="uq_actor_creator_affinity"),
        Index("ix_actor_creator_affinity_actor_score", "actor_key", "score"),
    )


class ActorTagAffinity(Base):
    __tablename__ = "actor_tag_affinities"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    actor_key = Column(String(80), nullable=False)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    anonymous_id = Column(String(64), nullable=True, index=True)
    tag_id = Column(String(36), ForeignKey("tags.id", ondelete="CASCADE"), nullable=False, index=True)
    score = Column(Float, nullable=False, default=0.0)
    positive_count = Column(Integer, nullable=False, default=0)
    negative_count = Column(Integer, nullable=False, default=0)
    last_event_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("actor_key", "tag_id", name="uq_actor_tag_affinity"),
        Index("ix_actor_tag_affinity_actor_score", "actor_key", "score"),
    )


class PostRecommendationStats(Base):
    __tablename__ = "post_recommendation_stats"

    post_id = Column(String(36), ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True)
    impressions = Column(Integer, nullable=False, default=0)
    qualified_views = Column(Integer, nullable=False, default=0)
    completions = Column(Integer, nullable=False, default=0)
    skips = Column(Integer, nullable=False, default=0)
    likes = Column(Integer, nullable=False, default=0)
    saves = Column(Integer, nullable=False, default=0)
    shares = Column(Integer, nullable=False, default=0)
    negative_feedback = Column(Integer, nullable=False, default=0)
    total_watch_ms = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)


class CoWatchPair(Base):
    __tablename__ = "co_watch_pairs"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    actor_key = Column(String(80), nullable=False, index=True)
    left_post_id = Column(String(36), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    right_post_id = Column(String(36), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_seen_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (
        CheckConstraint("left_post_id < right_post_id", name="ck_co_watch_pair_order"),
        UniqueConstraint("actor_key", "left_post_id", "right_post_id", name="uq_co_watch_actor_pair"),
    )


class ItemSimilarity(Base):
    __tablename__ = "item_similarities"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    source_post_id = Column(String(36), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    target_post_id = Column(String(36), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    method = Column(String(24), nullable=False, default="co_watch")
    model_version = Column(String(32), nullable=False, default="co-watch-v1")
    score = Column(Float, nullable=False, default=0.0)
    support = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)

    __table_args__ = (
        CheckConstraint("source_post_id != target_post_id", name="ck_item_similarity_distinct"),
        UniqueConstraint(
            "source_post_id",
            "target_post_id",
            "method",
            "model_version",
            name="uq_item_similarity_version",
        ),
        Index("ix_item_similarity_source_score", "source_post_id", "score"),
    )


class Report(Base):
    __tablename__ = "reports"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    reporter_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    target_type = Column(String(16), nullable=False, index=True)
    target_id = Column(String(64), nullable=False, index=True)
    reason = Column(String(32), nullable=False, index=True)
    details = Column(String(500), nullable=False, default="")
    status = Column(String(16), nullable=False, default="open", index=True)
    moderator_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    resolution = Column(String(500), nullable=False, default="")
    evidence_ciphertext = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    reviewed_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (Index("ix_reports_status_created", "status", "created_at"),)


class DataMigration(Base):
    __tablename__ = "data_migrations"

    key = Column(String(100), primary_key=True)
    details = Column(JSON, nullable=False, default=dict)
    completed_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    kind = Column(String(16), nullable=False, default="direct", index=True)
    direct_key = Column(String(80), nullable=False, unique=True, index=True)
    requester_id = Column(String(36), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    state = Column(String(16), nullable=False, default="pending", index=True)
    latest_message_id = Column(String(36), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    accepted_at = Column(DateTime(timezone=True), nullable=True)
    declined_at = Column(DateTime(timezone=True), nullable=True)

    members = relationship("ConversationMember", cascade="all, delete-orphan", back_populates="conversation")
    messages = relationship("DirectMessage", cascade="all, delete-orphan", back_populates="conversation")
    requester = relationship("User")


class ConversationMember(Base):
    __tablename__ = "conversation_members"

    conversation_id = Column(
        String(36),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    joined_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_read_at = Column(DateTime(timezone=True), nullable=True)
    last_read_message_id = Column(String(36), nullable=True)

    conversation = relationship("Conversation", back_populates="members")
    user = relationship("User")

    __table_args__ = (Index("ix_conversation_members_user", "user_id", "conversation_id"),)


class DirectMessage(Base):
    __tablename__ = "direct_messages"

    id = Column(String(36), primary_key=True, default=uuid4_string)
    conversation_id = Column(
        String(36),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    sender_id = Column(String(36), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    kind = Column(String(16), nullable=False, default="text", index=True)
    payload_ciphertext = Column(Text, nullable=False, default="")
    post_id = Column(String(36), ForeignKey("posts.id", ondelete="SET NULL"), nullable=True, index=True)
    client_id = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    deleted_at = Column(DateTime(timezone=True), nullable=True, index=True)

    conversation = relationship("Conversation", back_populates="messages")
    sender = relationship("User")
    post = relationship("Post")

    __table_args__ = (
        UniqueConstraint("sender_id", "client_id", name="uq_direct_message_sender_client"),
        Index("ix_direct_messages_conversation_created", "conversation_id", "created_at", "id"),
    )


class MessageEvent(Base):
    __tablename__ = "message_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    recipient_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    conversation_id = Column(
        String(36),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    message_id = Column(String(36), ForeignKey("direct_messages.id", ondelete="SET NULL"), nullable=True)
    event_type = Column(String(32), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)

    __table_args__ = (Index("ix_message_events_recipient_id_id", "recipient_id", "id"),)
