"""Candidate sources for the in-process Reels recommendation pipeline."""

from __future__ import annotations

import math
from typing import Protocol

from .config import MAX_SOURCE_RESULTS
from .types import PipelineContext, SourceHit


class CandidateSource(Protocol):
    name: str

    def generate(self, context: PipelineContext) -> list[tuple[str, SourceHit]]:
        ...


def _ranked_hits(name: str, scored: list[tuple[str, float, tuple[str, ...]]]) -> list[tuple[str, SourceHit]]:
    scored.sort(key=lambda row: (-row[1], row[0]))
    return [
        (
            post_id,
            SourceHit(source=name, rank=index, raw_score=float(score), seed_post_ids=seeds),
        )
        for index, (post_id, score, seeds) in enumerate(scored[:MAX_SOURCE_RESULTS], start=1)
    ]


class ManualOrderSource:
    name = "manual_order"

    def generate(self, context: PipelineContext) -> list[tuple[str, SourceHit]]:
        if context.manual_order is None:
            return []
        ordered = [post_id for post_id in context.manual_order if post_id in context.items]
        total = max(1, len(ordered))
        return [
            (
                post_id,
                SourceHit(self.name, index, (total - index + 1) / total),
            )
            for index, post_id in enumerate(ordered[:MAX_SOURCE_RESULTS], start=1)
        ]


class FollowingRecentSource:
    name = "following_recent"

    def generate(self, context: PipelineContext) -> list[tuple[str, SourceHit]]:
        if not context.actor.user_id:
            return []
        rows = [
            (item.post_id, item.created_at.timestamp(), ())
            for item in context.items.values()
            if item.owner_id in context.following_ids or item.owner_id == context.actor.user_id
        ]
        return _ranked_hits(self.name, rows)


class CreatorAffinitySource:
    name = "creator_affinity"

    def generate(self, context: PipelineContext) -> list[tuple[str, SourceHit]]:
        scores = {
            creator_id: score + context.session_creator_affinity.get(creator_id, 0.0)
            for creator_id, score in context.creator_affinity.items()
        }
        for creator_id, score in context.session_creator_affinity.items():
            scores.setdefault(creator_id, score)
        rows = [
            (item.post_id, scores.get(item.owner_id, 0.0), ())
            for item in context.items.values()
            if scores.get(item.owner_id, 0.0) > 0
        ]
        return _ranked_hits(self.name, rows)


class TagAffinitySource:
    name = "tag_affinity"

    def generate(self, context: PipelineContext) -> list[tuple[str, SourceHit]]:
        combined = dict(context.tag_affinity)
        for tag_id, score in context.session_tag_affinity.items():
            combined[tag_id] = combined.get(tag_id, 0.0) + score
        rows = []
        for item in context.items.values():
            score = sum(max(0.0, combined.get(tag_id, 0.0)) for tag_id in item.tag_ids)
            if score > 0:
                rows.append((item.post_id, score, ()))
        return _ranked_hits(self.name, rows)


class RelatedItemSource:
    name = "recent_item_related"

    def generate(self, context: PipelineContext) -> list[tuple[str, SourceHit]]:
        rows = [
            (post_id, score, seeds)
            for post_id, (score, seeds) in context.related_scores.items()
            if post_id in context.items and score > 0
        ]
        if context.seed_post_id and context.seed_post_id in context.items:
            rows.append((context.seed_post_id, 10.0, (context.seed_post_id,)))
        return _ranked_hits(self.name, rows)


class SessionContextSource:
    name = "session_context"

    def generate(self, context: PipelineContext) -> list[tuple[str, SourceHit]]:
        rows = []
        for item in context.items.values():
            score = max(0.0, context.session_creator_affinity.get(item.owner_id, 0.0))
            score += sum(max(0.0, context.session_tag_affinity.get(tag_id, 0.0)) for tag_id in item.tag_ids)
            if score > 0:
                rows.append((item.post_id, score, ()))
        return _ranked_hits(self.name, rows)


class TrendingSource:
    name = "global_quality_trending"

    def generate(self, context: PipelineContext) -> list[tuple[str, SourceHit]]:
        rows = []
        for item in context.items.values():
            stat = context.stats.get(item.post_id)
            impressions = max(0, int(getattr(stat, "impressions", 0) or 0))
            qualified = max(0, int(getattr(stat, "qualified_views", 0) or 0))
            completions = max(0, int(getattr(stat, "completions", 0) or 0))
            positives = (
                int(getattr(stat, "likes", 0) or 0)
                + 2 * int(getattr(stat, "saves", 0) or 0)
                + 3 * int(getattr(stat, "shares", 0) or 0)
            )
            evidence = (qualified + 2.0) / (impressions + 5.0)
            completion = (completions + 1.0) / (qualified + 3.0)
            legacy = math.log1p(max(0, item.view_count) + 5 * max(0, item.like_count))
            rows.append((item.post_id, evidence + 0.5 * completion + 0.05 * legacy + math.log1p(positives), ()))
        return _ranked_hits(self.name, rows)


class FreshExplorationSource:
    name = "fresh_exploration"

    def generate(self, context: PipelineContext) -> list[tuple[str, SourceHit]]:
        rows = []
        for item in context.items.values():
            age_days = max(0.0, (context.now - item.created_at).total_seconds() / 86400.0)
            impressions = int(getattr(context.stats.get(item.post_id), "impressions", 0) or 0)
            score = math.exp(-age_days / 14.0) / math.sqrt(1.0 + impressions)
            rows.append((item.post_id, score, ()))
        return _ranked_hits(self.name, rows)


DEFAULT_SOURCES: tuple[CandidateSource, ...] = (
    CreatorAffinitySource(),
    TagAffinitySource(),
    RelatedItemSource(),
    SessionContextSource(),
    TrendingSource(),
    FreshExplorationSource(),
)


def gather_source_hits(context: PipelineContext) -> dict[str, dict[str, SourceHit]]:
    """Return post -> source -> hit while preserving all provenance."""
    if context.manual_order is not None:
        sources: tuple[CandidateSource, ...] = (ManualOrderSource(),)
    elif context.surface == "following":
        sources = (FollowingRecentSource(),)
    else:
        sources = DEFAULT_SOURCES

    merged: dict[str, dict[str, SourceHit]] = {}
    for source in sources:
        for post_id, hit in source.generate(context):
            merged.setdefault(post_id, {})[hit.source] = hit
    return merged
