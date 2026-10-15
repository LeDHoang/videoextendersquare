"""Small, storage-neutral types shared by recommendation pipeline stages."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass(frozen=True, slots=True)
class ActorIdentity:
    actor_key: str
    user_id: str | None
    anonymous_id: str | None


@dataclass(frozen=True, slots=True)
class CatalogItem:
    post_id: str
    owner_id: str
    tag_ids: tuple[str, ...]
    created_at: datetime
    like_count: int
    view_count: int


@dataclass(frozen=True, slots=True)
class SourceHit:
    source: str
    rank: int
    raw_score: float
    seed_post_ids: tuple[str, ...] = ()


@dataclass(slots=True)
class Candidate:
    item: CatalogItem
    hits: dict[str, SourceHit] = field(default_factory=dict)
    retrieval_score: float = 0.0
    final_score: float = 0.0
    primary_source: str = "global_quality_trending"
    reason_key: str = "popular_now"
    features: dict[str, float] = field(default_factory=dict)


@dataclass(slots=True)
class PipelineContext:
    actor: ActorIdentity
    surface: str
    now: datetime
    session_id: str
    seed_post_id: str | None
    manual_order: list[str] | None
    items: dict[str, CatalogItem]
    following_ids: set[str]
    creator_affinity: dict[str, float]
    tag_affinity: dict[str, float]
    item_affinity: dict[str, float]
    related_scores: dict[str, tuple[float, tuple[str, ...]]]
    session_creator_affinity: dict[str, float]
    session_tag_affinity: dict[str, float]
    stats: dict[str, object]
    exposures_by_creator: dict[str, int]


@dataclass(frozen=True, slots=True)
class MaterializedResult:
    target_id: str
    impression_id: str
    position: int
    primary_source: str
    source_rank: int | None
    retrieval_score: float
    final_score: float
    reason_key: str
    provenance: dict


@dataclass(frozen=True, slots=True)
class RecommendationPage:
    session_id: str
    request_id: str
    algorithm_version: str
    page_index: int
    items: tuple[MaterializedResult, ...]
    next_cursor: str | None
    has_more: bool
    restarted: bool = False
