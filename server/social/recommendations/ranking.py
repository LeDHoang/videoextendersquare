"""Transparent heuristic ranking and list-level diversity rules."""

from __future__ import annotations

import math

from .config import RANK_WEIGHTS, RRF_RANK_CONSTANT, SOURCE_WEIGHTS
from .types import Candidate, PipelineContext


REASON_BY_SOURCE = {
    "manual_order": "selected_order",
    "following_recent": "from_people_you_follow",
    "creator_affinity": "from_creator_you_watch",
    "tag_affinity": "topic_you_watch",
    "recent_item_related": "similar_to_watched",
    "session_context": "based_on_this_session",
    "global_quality_trending": "popular_now",
    "fresh_exploration": "new_creator",
}


def _bounded_affinity(value: float) -> float:
    return math.tanh(max(0.0, value) / 8.0)


def _negative_affinity(value: float) -> float:
    return math.tanh(max(0.0, -value) / 6.0)


def _quality(context: PipelineContext, post_id: str, like_count: int, view_count: int) -> float:
    stat = context.stats.get(post_id)
    impressions = max(0, int(getattr(stat, "impressions", 0) or 0))
    qualified = max(0, int(getattr(stat, "qualified_views", 0) or 0))
    completions = max(0, int(getattr(stat, "completions", 0) or 0))
    likes = max(0, int(getattr(stat, "likes", 0) or 0))
    saves = max(0, int(getattr(stat, "saves", 0) or 0))
    shares = max(0, int(getattr(stat, "shares", 0) or 0))
    negatives = max(0, int(getattr(stat, "negative_feedback", 0) or 0))
    view_rate = (qualified + 2.0) / (impressions + 5.0)
    complete_rate = (completions + 1.0) / (qualified + 3.0)
    action_rate = (likes + 2.0 * saves + 3.0 * shares + 1.0) / (impressions + 10.0)
    negative_rate = (negatives + 0.5) / (impressions + 10.0)
    legacy_prior = math.tanh(math.log1p(max(0, view_count) + 5 * max(0, like_count)) / 8.0)
    return max(0.0, min(1.0, 0.42 * view_rate + 0.25 * complete_rate + 0.20 * action_rate + 0.13 * legacy_prior - 0.5 * negative_rate))


def rank_candidates(
    context: PipelineContext,
    source_hits: dict[str, dict],
) -> list[Candidate]:
    if context.manual_order is not None:
        order = {post_id: index for index, post_id in enumerate(context.manual_order)}
        candidates = []
        for post_id, hits in source_hits.items():
            item = context.items[post_id]
            hit = hits["manual_order"]
            candidates.append(
                Candidate(
                    item=item,
                    hits=hits,
                    retrieval_score=hit.raw_score,
                    final_score=float(len(order) - order.get(post_id, len(order))),
                    primary_source="manual_order",
                    reason_key="selected_order",
                    features={"manual_order": hit.raw_score},
                )
            )
        return sorted(candidates, key=lambda candidate: order.get(candidate.item.post_id, len(order)))

    if context.surface == "following":
        candidates = []
        for post_id, hits in source_hits.items():
            item = context.items[post_id]
            hit = hits["following_recent"]
            candidates.append(
                Candidate(
                    item=item,
                    hits=hits,
                    retrieval_score=hit.raw_score,
                    final_score=item.created_at.timestamp(),
                    primary_source="following_recent",
                    reason_key="from_people_you_follow",
                    features={"recency": 1.0},
                )
            )
        return sorted(candidates, key=lambda candidate: (-candidate.final_score, candidate.item.post_id))

    raw_retrieval: dict[str, float] = {}
    contribution_by_source: dict[str, dict[str, float]] = {}
    for post_id, hits in source_hits.items():
        contributions = {
            name: SOURCE_WEIGHTS.get(name, 1.0) / (RRF_RANK_CONSTANT + hit.rank)
            for name, hit in hits.items()
        }
        contribution_by_source[post_id] = contributions
        raw_retrieval[post_id] = sum(contributions.values())
    max_retrieval = max(raw_retrieval.values(), default=1.0) or 1.0

    ranked: list[Candidate] = []
    for post_id, hits in source_hits.items():
        item = context.items[post_id]
        creator_raw = context.creator_affinity.get(item.owner_id, 0.0) + context.session_creator_affinity.get(item.owner_id, 0.0)
        tag_values = [
            context.tag_affinity.get(tag_id, 0.0) + context.session_tag_affinity.get(tag_id, 0.0)
            for tag_id in item.tag_ids
        ]
        topic_raw = sum(value for value in tag_values if value > 0) / max(1, len(tag_values))
        negative_raw = max([-creator_raw, *[-value for value in tag_values], -context.item_affinity.get(post_id, 0.0), 0.0])
        related = context.related_scores.get(post_id, (0.0, ()))[0]
        age_days = max(0.0, (context.now - item.created_at).total_seconds() / 86400.0)
        freshness = math.exp(-age_days / 30.0)
        impressions = int(getattr(context.stats.get(post_id), "impressions", 0) or 0)
        exploration = 1.0 / math.sqrt(1.0 + impressions)
        exposure_fatigue = min(1.0, context.exposures_by_creator.get(item.owner_id, 0) / 3.0)
        features = {
            "retrieval_fusion": raw_retrieval[post_id] / max_retrieval,
            "creator_affinity": _bounded_affinity(creator_raw),
            "topic_affinity": _bounded_affinity(topic_raw),
            "co_watch_similarity": max(0.0, min(1.0, related)),
            "quality": _quality(context, post_id, item.like_count, item.view_count),
            "freshness": freshness,
            "exploration": exploration,
            "negative_affinity": _negative_affinity(negative_raw),
            "exposure_fatigue": exposure_fatigue,
        }
        score = (
            RANK_WEIGHTS["retrieval_fusion"] * features["retrieval_fusion"]
            + RANK_WEIGHTS["creator_affinity"] * features["creator_affinity"]
            + RANK_WEIGHTS["topic_affinity"] * features["topic_affinity"]
            + RANK_WEIGHTS["co_watch_similarity"] * features["co_watch_similarity"]
            + RANK_WEIGHTS["quality"] * features["quality"]
            + RANK_WEIGHTS["freshness"] * features["freshness"]
            + RANK_WEIGHTS["exploration"] * features["exploration"]
            - RANK_WEIGHTS["negative_affinity"] * features["negative_affinity"]
            - RANK_WEIGHTS["exposure_fatigue"] * features["exposure_fatigue"]
        )
        contributions = contribution_by_source[post_id]
        primary_source = max(contributions, key=lambda name: (contributions[name], name))
        ranked.append(
            Candidate(
                item=item,
                hits=hits,
                retrieval_score=raw_retrieval[post_id],
                final_score=score,
                primary_source=primary_source,
                reason_key=REASON_BY_SOURCE.get(primary_source, "popular_now"),
                features=features,
            )
        )
    return sorted(ranked, key=lambda candidate: (-candidate.final_score, -candidate.item.created_at.timestamp(), candidate.item.post_id))


def rerank_page(candidates: list[Candidate], limit: int) -> list[Candidate]:
    """Greedy diversity pass with creator/topic/source fatigue."""
    if not candidates or limit <= 0:
        return []
    if candidates[0].primary_source in {"manual_order", "following_recent"}:
        return candidates[:limit]

    remaining = list(candidates)
    selected: list[Candidate] = []
    creator_counts: dict[str, int] = {}
    tag_counts: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    while remaining and len(selected) < limit:
        best_index = 0
        best_adjusted = float("-inf")
        for index, candidate in enumerate(remaining):
            creator_count = creator_counts.get(candidate.item.owner_id, 0)
            if creator_count >= 3 and any(
                creator_counts.get(other.item.owner_id, 0) < 3 for other in remaining
            ):
                continue
            adjusted = candidate.final_score
            if selected and selected[-1].item.owner_id == candidate.item.owner_id:
                adjusted -= 2.5
            adjusted -= 0.45 * creator_count
            dominant_tag_count = max((tag_counts.get(tag_id, 0) for tag_id in candidate.item.tag_ids), default=0)
            adjusted -= 0.30 * max(0, dominant_tag_count - 1)
            adjusted -= 0.20 * max(0, source_counts.get(candidate.primary_source, 0) - 2)
            if adjusted > best_adjusted:
                best_adjusted = adjusted
                best_index = index
        chosen = remaining.pop(best_index)
        selected.append(chosen)
        creator_counts[chosen.item.owner_id] = creator_counts.get(chosen.item.owner_id, 0) + 1
        source_counts[chosen.primary_source] = source_counts.get(chosen.primary_source, 0) + 1
        for tag_id in chosen.item.tag_ids:
            tag_counts[tag_id] = tag_counts.get(tag_id, 0) + 1

    if selected and not any(candidate.features.get("exploration", 0.0) >= 0.7 for candidate in selected):
        exploration = next(
            (candidate for candidate in candidates if candidate not in selected and candidate.features.get("exploration", 0.0) >= 0.7),
            None,
        )
        if exploration is not None:
            selected[-1] = exploration
    return selected
