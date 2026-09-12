"""Recommendation attribution validation and incremental aggregate updates."""

from __future__ import annotations

import math

from sqlalchemy.orm import Session

from server.social.models import (
    ActorCreatorAffinity,
    ActorItemAffinity,
    ActorTagAffinity,
    CoWatchPair,
    EngagementEvent,
    ItemSimilarity,
    Post,
    PostRecommendationStats,
    RecommendationImpression,
    RecommendationSession,
    utcnow,
)

from .config import EVENT_WEIGHTS


class RecommendationAttributionError(ValueError):
    pass


def resolve_attribution(
    db: Session,
    *,
    impression_id: str,
    user_id: str | None,
    anonymous_id: str | None,
    post_id: str | None,
    event_type: str,
    context: dict,
) -> tuple[RecommendationImpression, bool]:
    impression = db.get(RecommendationImpression, impression_id)
    if not impression:
        raise RecommendationAttributionError("Recommendation impression was not found.")
    session = db.get(RecommendationSession, impression.session_id)
    if not session:
        raise RecommendationAttributionError("Recommendation session was not found.")
    if user_id:
        valid_actor = session.user_id == user_id
    else:
        valid_actor = bool(anonymous_id and session.user_id is None and session.anonymous_id == anonymous_id)
    if not valid_actor:
        raise RecommendationAttributionError("Recommendation impression belongs to another viewer.")
    if post_id and impression.post_id != post_id:
        raise RecommendationAttributionError("Recommendation impression does not match this post.")
    target_creator_id = str((context or {}).get("target_user_id") or "")
    if impression.creator_id and target_creator_id and impression.creator_id != target_creator_id:
        raise RecommendationAttributionError("Recommendation impression does not match this creator.")
    if impression.post_id and target_creator_id:
        impression_post = db.get(Post, impression.post_id)
        if not impression_post or impression_post.owner_id != target_creator_id:
            raise RecommendationAttributionError("Recommendation impression does not match this creator.")

    duplicate = False
    if event_type == "impression":
        duplicate = impression.first_visible_at is not None
        if not duplicate:
            impression.first_visible_at = utcnow()
    elif event_type in {"complete", "skip"}:
        duplicate = db.query(EngagementEvent.id).filter(
            EngagementEvent.recommendation_impression_id == impression.id,
            EngagementEvent.event_type.in_(("complete", "skip")),
        ).first() is not None
    return impression, duplicate


def _event_value(event: EngagementEvent) -> float:
    value = float(EVENT_WEIGHTS.get(event.event_type, 0.0))
    if event.event_type == "view":
        if event.watch_ratio is not None:
            quality = max(0.0, min(1.0, float(event.watch_ratio)))
        else:
            quality = max(0.0, min(1.0, float(event.watch_ms or 0) / 10000.0))
        value = 0.5 + 1.5 * quality
    elif event.event_type == "complete" and event.duration_ms and event.duration_ms < 3000:
        value *= 0.5
    elif event.event_type == "skip":
        if event.navigation_reason in {
            "playback_error",
            "background",
            "unload",
            "filter_change",
            "not_interested",
            "hide_creator",
        }:
            return 0.0
        if event.watch_ratio is not None and event.watch_ratio >= 0.5:
            value = -0.25
        elif (event.watch_ms or 0) < 1500:
            value = -2.0
    return value


def _update_post_stats(db: Session, event: EngagementEvent) -> None:
    if not event.post_id:
        return
    stats = db.get(PostRecommendationStats, event.post_id)
    if not stats:
        stats = PostRecommendationStats(post_id=event.post_id)
        db.add(stats)
    if event.event_type == "impression":
        stats.impressions = int(stats.impressions or 0) + 1
    elif event.event_type == "view":
        stats.qualified_views = int(stats.qualified_views or 0) + 1
    elif event.event_type == "complete":
        stats.completions = int(stats.completions or 0) + 1
    elif event.event_type == "skip":
        stats.skips = int(stats.skips or 0) + 1
    elif event.event_type == "like":
        stats.likes = int(stats.likes or 0) + 1
    elif event.event_type == "unlike":
        stats.likes = max(0, int(stats.likes or 0) - 1)
    elif event.event_type == "save":
        stats.saves = int(stats.saves or 0) + 1
    elif event.event_type == "unsave":
        stats.saves = max(0, int(stats.saves or 0) - 1)
    elif event.event_type in {"share", "share_sent"}:
        stats.shares = int(stats.shares or 0) + 1
    elif event.event_type in {"not_interested", "hide_creator"}:
        stats.negative_feedback = int(stats.negative_feedback or 0) + 1
    stats.total_watch_ms = int(stats.total_watch_ms or 0) + max(0, int(event.watch_ms or 0))
    stats.updated_at = utcnow()


def _identity_values(event: EngagementEvent) -> tuple[str | None, str | None, str | None]:
    if event.user_id:
        return f"u:{event.user_id}", event.user_id, None
    if event.anonymous_id:
        return f"a:{event.anonymous_id}", None, event.anonymous_id
    return None, None, None


def _update_affinity_row(row, value: float, event: EngagementEvent) -> None:
    row.score = max(-40.0, min(80.0, float(row.score or 0.0) + value))
    if value > 0:
        row.positive_count = int(row.positive_count or 0) + 1
    elif value < 0:
        row.negative_count = int(row.negative_count or 0) + 1
    row.last_event_at = event.created_at or utcnow()
    row.updated_at = utcnow()


def _update_co_watch(db: Session, actor_key: str, post_id: str) -> None:
    recent = (
        db.query(ActorItemAffinity)
        .filter(
            ActorItemAffinity.actor_key == actor_key,
            ActorItemAffinity.post_id != post_id,
            ActorItemAffinity.qualified_watches > 0,
        )
        .order_by(ActorItemAffinity.last_event_at.desc())
        .limit(20)
        .all()
    )
    for other in recent:
        left_id, right_id = sorted((post_id, other.post_id))
        pair = db.query(CoWatchPair).filter(
            CoWatchPair.actor_key == actor_key,
            CoWatchPair.left_post_id == left_id,
            CoWatchPair.right_post_id == right_id,
        ).first()
        if pair:
            pair.last_seen_at = utcnow()
            continue
        db.add(CoWatchPair(actor_key=actor_key, left_post_id=left_id, right_post_id=right_id))
        db.flush()
        support = db.query(CoWatchPair.id).filter(
            CoWatchPair.left_post_id == left_id,
            CoWatchPair.right_post_id == right_id,
        ).count()
        left_viewers = db.query(ActorItemAffinity.id).filter(
            ActorItemAffinity.post_id == left_id,
            ActorItemAffinity.qualified_watches > 0,
        ).count()
        right_viewers = db.query(ActorItemAffinity.id).filter(
            ActorItemAffinity.post_id == right_id,
            ActorItemAffinity.qualified_watches > 0,
        ).count()
        cosine = support / math.sqrt(max(1, left_viewers) * max(1, right_viewers))
        score = cosine * support / (support + 3.0)
        for source_id, target_id in ((left_id, right_id), (right_id, left_id)):
            similarity = db.query(ItemSimilarity).filter(
                ItemSimilarity.source_post_id == source_id,
                ItemSimilarity.target_post_id == target_id,
                ItemSimilarity.method == "co_watch",
                ItemSimilarity.model_version == "co-watch-v1",
            ).first()
            if not similarity:
                similarity = ItemSimilarity(
                    source_post_id=source_id,
                    target_post_id=target_id,
                    method="co_watch",
                    model_version="co-watch-v1",
                )
                db.add(similarity)
            similarity.support = support
            similarity.score = score
            similarity.updated_at = utcnow()


def update_aggregates(db: Session, event: EngagementEvent) -> None:
    _update_post_stats(db, event)
    actor_key, user_id, anonymous_id = _identity_values(event)
    value = _event_value(event)
    if not actor_key or value == 0:
        return

    post = db.get(Post, event.post_id) if event.post_id else None
    target_creator_id = post.owner_id if post else str((event.context or {}).get("target_user_id") or "") or None
    item_row = None
    if post:
        item_row = db.query(ActorItemAffinity).filter(
            ActorItemAffinity.actor_key == actor_key,
            ActorItemAffinity.post_id == post.id,
        ).first()
        if not item_row:
            item_row = ActorItemAffinity(
                actor_key=actor_key,
                user_id=user_id,
                anonymous_id=anonymous_id,
                post_id=post.id,
            )
            db.add(item_row)
        _update_affinity_row(item_row, value, event)
        item_row.total_watch_ms = int(item_row.total_watch_ms or 0) + max(0, int(event.watch_ms or 0))
        if event.event_type == "view":
            item_row.qualified_watches = int(item_row.qualified_watches or 0) + 1

    if target_creator_id:
        creator_row = db.query(ActorCreatorAffinity).filter(
            ActorCreatorAffinity.actor_key == actor_key,
            ActorCreatorAffinity.creator_id == target_creator_id,
        ).first()
        if not creator_row:
            creator_row = ActorCreatorAffinity(
                actor_key=actor_key,
                user_id=user_id,
                anonymous_id=anonymous_id,
                creator_id=target_creator_id,
            )
            db.add(creator_row)
        _update_affinity_row(creator_row, value, event)

    if post:
        for link in post.tags:
            tag_row = db.query(ActorTagAffinity).filter(
                ActorTagAffinity.actor_key == actor_key,
                ActorTagAffinity.tag_id == link.tag_id,
            ).first()
            if not tag_row:
                tag_row = ActorTagAffinity(
                    actor_key=actor_key,
                    user_id=user_id,
                    anonymous_id=anonymous_id,
                    tag_id=link.tag_id,
                )
                db.add(tag_row)
            _update_affinity_row(tag_row, value, event)
        if event.event_type == "view":
            db.flush()
            _update_co_watch(db, actor_key, post.id)
