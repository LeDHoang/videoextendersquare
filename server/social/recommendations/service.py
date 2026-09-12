"""Session materialization, cursor handling, eligibility, and creator suggestions."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_
from sqlalchemy.orm import Session, selectinload

from server.social.auth import SECURITY_SECRET, public_user
from server.social.models import (
    ActorCreatorAffinity,
    ActorItemAffinity,
    ActorTagAffinity,
    EngagementEvent,
    Follow,
    ItemSimilarity,
    Post,
    PostRecommendationStats,
    PostTag,
    RecommendationDismissal,
    RecommendationImpression,
    RecommendationRequest,
    RecommendationSession,
    User,
    utcnow,
)
from server.social.safety import blocked_user_ids

from .config import (
    CREATOR_ALGORITHM_VERSION,
    CURSOR_VERSION,
    DEFAULT_PAGE_SIZE,
    MAX_CATALOG_SIZE,
    MAX_PAGE_SIZE,
    REELS_ALGORITHM_VERSION,
    SESSION_IDLE_MINUTES,
    SESSION_MAX_HOURS,
)
from .ranking import rank_candidates, rerank_page
from .sources import gather_source_hits
from .types import (
    ActorIdentity,
    CatalogItem,
    MaterializedResult,
    PipelineContext,
    RecommendationPage,
)


class RecommendationCursorError(ValueError):
    pass


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def actor_identity(user_id: str | None, anonymous_id: str | None) -> ActorIdentity:
    if user_id:
        return ActorIdentity(actor_key=f"u:{user_id}", user_id=user_id, anonymous_id=None)
    if not anonymous_id:
        raise ValueError("Anonymous recommendation requests require an anonymous identity.")
    return ActorIdentity(actor_key=f"a:{anonymous_id}", user_id=None, anonymous_id=anonymous_id)


def _canonical_json(value: dict) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def filter_hash(filters: dict) -> str:
    return hashlib.sha256(_canonical_json(filters).encode("utf-8")).hexdigest()


def _encode_cursor(session_id: str, page_index: int) -> str:
    payload = base64.urlsafe_b64encode(
        _canonical_json({"v": CURSOR_VERSION, "s": session_id, "p": page_index}).encode("utf-8")
    ).decode("ascii").rstrip("=")
    signature = hmac.new(SECURITY_SECRET.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).hexdigest()[:32]
    return f"{payload}.{signature}"


def _decode_cursor(value: str) -> tuple[str, int]:
    try:
        payload, signature = value.split(".", 1)
        expected = hmac.new(SECURITY_SECRET.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(signature, expected):
            raise RecommendationCursorError("Recommendation cursor signature is invalid.")
        decoded = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode("utf-8"))
        if int(decoded.get("v", 0)) != CURSOR_VERSION:
            raise RecommendationCursorError("Recommendation cursor version is unsupported.")
        page_index = int(decoded["p"])
        if page_index < 0:
            raise RecommendationCursorError("Recommendation cursor page is invalid.")
        return str(decoded["s"]), page_index
    except RecommendationCursorError:
        raise
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RecommendationCursorError("Recommendation cursor is malformed.") from exc


def _new_session(
    db: Session,
    *,
    actor: ActorIdentity,
    surface: str,
    seed_post_id: str | None,
    filters: dict,
    algorithm_version: str,
    restart_reason: str | None = None,
) -> RecommendationSession:
    now = utcnow()
    row = RecommendationSession(
        actor_key=actor.actor_key,
        user_id=actor.user_id,
        anonymous_id=actor.anonymous_id,
        surface=surface,
        seed_post_id=seed_post_id,
        filter_hash=filter_hash(filters),
        filters=filters,
        algorithm_version=algorithm_version,
        status="active",
        restart_reason=restart_reason,
        created_at=now,
        last_accessed_at=now,
        expires_at=now + timedelta(hours=SESSION_MAX_HOURS),
    )
    db.add(row)
    db.flush()
    return row


def _resolve_session(
    db: Session,
    *,
    actor: ActorIdentity,
    surface: str,
    seed_post_id: str | None,
    filters: dict,
    algorithm_version: str,
    cursor: str | None,
) -> tuple[RecommendationSession, int, bool]:
    if not cursor:
        return _new_session(
            db,
            actor=actor,
            surface=surface,
            seed_post_id=seed_post_id,
            filters=filters,
            algorithm_version=algorithm_version,
        ), 0, False

    session_id, page_index = _decode_cursor(cursor)
    row = db.get(RecommendationSession, session_id)
    if not row:
        raise RecommendationCursorError("Recommendation session no longer exists.")
    if row.actor_key != actor.actor_key:
        raise RecommendationCursorError("Recommendation cursor belongs to another viewer.")
    if row.surface != surface or row.filter_hash != filter_hash(filters):
        raise RecommendationCursorError("Recommendation cursor does not match this feed.")
    now = utcnow()
    idle_expired = (now - aware(row.last_accessed_at)) > timedelta(minutes=SESSION_IDLE_MINUTES)
    hard_expired = aware(row.expires_at) <= now
    version_changed = row.algorithm_version != algorithm_version
    if row.status != "active" or idle_expired or hard_expired or version_changed:
        row.status = "expired"
        return _new_session(
            db,
            actor=actor,
            surface=surface,
            seed_post_id=seed_post_id,
            filters=filters,
            algorithm_version=algorithm_version,
            restart_reason="algorithm_version_changed" if version_changed else "expired_cursor",
        ), 0, True
    row.last_accessed_at = now
    return row, page_index, False


def _active_dismissals(db: Session, actor_key: str) -> tuple[set[str], set[str]]:
    now = utcnow()
    rows = db.query(RecommendationDismissal).filter(
        RecommendationDismissal.actor_key == actor_key,
        or_(RecommendationDismissal.expires_at.is_(None), RecommendationDismissal.expires_at > now),
    ).all()
    return (
        {row.post_id for row in rows if row.post_id},
        {row.creator_id for row in rows if row.creator_id},
    )


def _catalog(
    db: Session,
    *,
    actor: ActorIdentity,
    allowed_post_ids: set[str] | None,
    excluded_post_ids: set[str],
    surface: str,
) -> dict[str, CatalogItem]:
    hidden_users = blocked_user_ids(db, actor.user_id)
    dismissed_posts, dismissed_creators = _active_dismissals(db, actor.actor_key)
    query = (
        db.query(Post)
        .join(User, User.id == Post.owner_id)
        .options(selectinload(Post.tags).selectinload(PostTag.tag))
        .filter(Post.status == "published", Post.deleted_at.is_(None), User.status == "active")
    )
    excluded_creators = hidden_users | dismissed_creators
    if excluded_creators:
        query = query.filter(~Post.owner_id.in_(excluded_creators))
    excluded = excluded_post_ids | dismissed_posts
    if excluded:
        query = query.filter(~Post.id.in_(excluded))
    if allowed_post_ids is not None:
        if not allowed_post_ids:
            return {}
        query = query.filter(Post.id.in_(allowed_post_ids))
    if surface == "following":
        if not actor.user_id:
            return {}
        followed = db.query(Follow.followee_id).filter(Follow.follower_id == actor.user_id)
        query = query.filter(or_(Post.owner_id == actor.user_id, Post.owner_id.in_(followed)))
    posts = query.order_by(Post.created_at.desc(), Post.id.desc()).limit(MAX_CATALOG_SIZE).all()
    return {
        post.id: CatalogItem(
            post_id=post.id,
            owner_id=post.owner_id,
            tag_ids=tuple(link.tag_id for link in post.tags),
            created_at=aware(post.created_at),
            like_count=int(post.like_count or 0),
            view_count=int(post.view_count or 0),
        )
        for post in posts
    }


def _pipeline_context(
    db: Session,
    *,
    actor: ActorIdentity,
    session: RecommendationSession,
    surface: str,
    seed_post_id: str | None,
    allowed_post_ids: set[str] | None,
    manual_order: list[str] | None,
) -> PipelineContext:
    delivered = {
        row[0]
        for row in db.query(RecommendationImpression.post_id)
        .filter(
            RecommendationImpression.session_id == session.id,
            RecommendationImpression.post_id.is_not(None),
        )
        .all()
    }
    items = _catalog(
        db,
        actor=actor,
        allowed_post_ids=allowed_post_ids,
        excluded_post_ids=delivered,
        surface=surface,
    )
    post_ids = set(items)
    owner_ids = {item.owner_id for item in items.values()}
    tag_ids = {tag_id for item in items.values() for tag_id in item.tag_ids}

    creator_affinity = {
        row.creator_id: float(row.score or 0.0)
        for row in db.query(ActorCreatorAffinity)
        .filter(
            ActorCreatorAffinity.actor_key == actor.actor_key,
            ActorCreatorAffinity.creator_id.in_(owner_ids) if owner_ids else False,
        )
        .all()
    }
    tag_affinity = {
        row.tag_id: float(row.score or 0.0)
        for row in db.query(ActorTagAffinity)
        .filter(
            ActorTagAffinity.actor_key == actor.actor_key,
            ActorTagAffinity.tag_id.in_(tag_ids) if tag_ids else False,
        )
        .all()
    }
    item_rows = (
        db.query(ActorItemAffinity)
        .filter(ActorItemAffinity.actor_key == actor.actor_key)
        .order_by(ActorItemAffinity.score.desc(), ActorItemAffinity.last_event_at.desc())
        .limit(24)
        .all()
    )
    item_affinity = {row.post_id: float(row.score or 0.0) for row in item_rows}
    seed_ids = [row.post_id for row in item_rows if row.score > 0][:8]
    if seed_post_id:
        seed_ids.insert(0, seed_post_id)

    related: dict[str, tuple[float, tuple[str, ...]]] = {}
    if seed_ids and post_ids:
        similarities = db.query(ItemSimilarity).filter(
            ItemSimilarity.source_post_id.in_(set(seed_ids)),
            ItemSimilarity.target_post_id.in_(post_ids),
        ).all()
        related_seeds: dict[str, list[str]] = defaultdict(list)
        related_scores: dict[str, float] = defaultdict(float)
        for row in similarities:
            related_scores[row.target_post_id] = max(related_scores[row.target_post_id], float(row.score or 0.0))
            related_seeds[row.target_post_id].append(row.source_post_id)
        for post_id, score in related_scores.items():
            related[post_id] = (score, tuple(related_seeds[post_id][:4]))

        seed_tag_rows = db.query(PostTag).filter(PostTag.post_id.in_(set(seed_ids))).all()
        seed_tags = {row.tag_id for row in seed_tag_rows}
        if seed_tags:
            for item in items.values():
                overlap = len(seed_tags.intersection(item.tag_ids))
                if overlap:
                    old_score, old_seeds = related.get(item.post_id, (0.0, ()))
                    related[item.post_id] = (max(old_score, min(1.0, overlap / max(1, len(seed_tags)))), old_seeds or tuple(seed_ids[:2]))

    stats = {
        row.post_id: row
        for row in db.query(PostRecommendationStats)
        .filter(PostRecommendationStats.post_id.in_(post_ids) if post_ids else False)
        .all()
    }
    following_ids = set()
    if actor.user_id:
        following_ids = {
            row[0]
            for row in db.query(Follow.followee_id).filter(Follow.follower_id == actor.user_id).all()
        }

    session_creator: dict[str, float] = defaultdict(float)
    session_tag: dict[str, float] = defaultdict(float)
    session_events = (
        db.query(EngagementEvent)
        .filter(
            EngagementEvent.recommendation_session_id == session.id,
            EngagementEvent.post_id.is_not(None),
        )
        .order_by(EngagementEvent.created_at.desc())
        .limit(100)
        .all()
    )
    event_post_ids = {event.post_id for event in session_events if event.post_id}
    event_posts = {
        post.id: post
        for post in db.query(Post)
        .options(selectinload(Post.tags))
        .filter(Post.id.in_(event_post_ids) if event_post_ids else False)
        .all()
    }
    event_values = {
        "view": 0.8,
        "complete": 1.0,
        "like": 2.0,
        "save": 2.5,
        "share": 2.5,
        "skip": -1.0,
        "not_interested": -4.0,
    }
    for event in session_events:
        post = event_posts.get(event.post_id)
        if not post:
            continue
        value = event_values.get(event.event_type, 0.0)
        session_creator[post.owner_id] += value
        for link in post.tags:
            session_tag[link.tag_id] += value

    exposures = Counter(
        owner_id
        for (owner_id,) in db.query(Post.owner_id)
        .join(RecommendationImpression, RecommendationImpression.post_id == Post.id)
        .filter(RecommendationImpression.session_id == session.id)
        .all()
    )
    return PipelineContext(
        actor=actor,
        surface=surface,
        now=utcnow(),
        session_id=session.id,
        seed_post_id=seed_post_id,
        manual_order=manual_order,
        items=items,
        following_ids=following_ids,
        creator_affinity=creator_affinity,
        tag_affinity=tag_affinity,
        item_affinity=item_affinity,
        related_scores=related,
        session_creator_affinity=dict(session_creator),
        session_tag_affinity=dict(session_tag),
        stats=stats,
        exposures_by_creator=dict(exposures),
    )


def _provenance(candidate) -> dict:
    return {
        "sources": [
            {
                "name": hit.source,
                "rank": hit.rank,
                "raw_score": round(hit.raw_score, 6),
                "seed_post_ids": list(hit.seed_post_ids),
            }
            for hit in sorted(candidate.hits.values(), key=lambda value: (value.rank, value.source))
        ],
        "features": {key: round(value, 6) for key, value in candidate.features.items()},
    }


def _page_from_request(
    session: RecommendationSession,
    request: RecommendationRequest,
    rows: list[RecommendationImpression],
    *,
    restarted: bool,
) -> RecommendationPage:
    has_more = bool((request.diagnostics or {}).get("has_more"))
    results = tuple(
        MaterializedResult(
            target_id=row.post_id or row.creator_id or "",
            impression_id=row.id,
            position=row.position,
            primary_source=row.primary_source,
            source_rank=row.source_rank,
            retrieval_score=float(row.retrieval_score or 0.0),
            final_score=float(row.final_score or 0.0),
            reason_key=row.reason_key,
            provenance=dict(row.provenance or {}),
        )
        for row in sorted(rows, key=lambda value: value.position)
        if row.post_id or row.creator_id
    )
    return RecommendationPage(
        session_id=session.id,
        request_id=request.id,
        algorithm_version=session.algorithm_version,
        page_index=request.page_index,
        items=results,
        next_cursor=_encode_cursor(session.id, request.page_index + 1) if has_more else None,
        has_more=has_more,
        restarted=restarted,
    )


def get_reel_page(
    db: Session,
    *,
    actor: ActorIdentity,
    surface: str = "for_you",
    seed_post_id: str | None = None,
    allowed_post_ids: set[str] | None = None,
    manual_order: list[str] | None = None,
    filters: dict | None = None,
    cursor: str | None = None,
    limit: int = DEFAULT_PAGE_SIZE,
) -> RecommendationPage:
    started = time.perf_counter()
    limit = max(1, min(int(limit), MAX_PAGE_SIZE))
    normalized_filters = dict(filters or {})
    normalized_filters["limit"] = limit
    session, page_index, restarted = _resolve_session(
        db,
        actor=actor,
        surface=surface,
        seed_post_id=seed_post_id,
        filters=normalized_filters,
        algorithm_version=REELS_ALGORITHM_VERSION,
        cursor=cursor,
    )
    existing = db.query(RecommendationRequest).filter(
        RecommendationRequest.session_id == session.id,
        RecommendationRequest.page_index == page_index,
    ).first()
    if existing:
        rows = db.query(RecommendationImpression).filter(
            RecommendationImpression.request_id == existing.id,
            RecommendationImpression.post_id.is_not(None),
        ).all()
        eligible = _catalog(
            db,
            actor=actor,
            allowed_post_ids=allowed_post_ids,
            excluded_post_ids=set(),
            surface=surface,
        )
        rows = [row for row in rows if row.post_id in eligible]
        db.commit()
        return _page_from_request(session, existing, rows, restarted=restarted)

    context = _pipeline_context(
        db,
        actor=actor,
        session=session,
        surface=surface,
        seed_post_id=seed_post_id,
        allowed_post_ids=allowed_post_ids,
        manual_order=manual_order,
    )
    hits = gather_source_hits(context)
    ranked = rank_candidates(context, hits)
    pinned = None
    if page_index == 0 and seed_post_id:
        pinned = next((candidate for candidate in ranked if candidate.item.post_id == seed_post_id), None)
    if pinned:
        selected = [pinned, *rerank_page([candidate for candidate in ranked if candidate is not pinned], limit - 1)]
    else:
        selected = rerank_page(ranked, limit)
    has_more = len(ranked) > len(selected)
    request = RecommendationRequest(
        session_id=session.id,
        page_index=page_index,
        requested_count=limit,
        returned_count=len(selected),
        candidate_count=len(ranked),
        fallback_reason=None if ranked else "no_eligible_candidates",
        diagnostics={
            "has_more": has_more,
            "source_counts": dict(Counter(candidate.primary_source for candidate in selected)),
        },
    )
    db.add(request)
    db.flush()
    base_position = page_index * limit
    rows = []
    for offset, candidate in enumerate(selected):
        primary_hit = candidate.hits.get(candidate.primary_source)
        row = RecommendationImpression(
            request_id=request.id,
            session_id=session.id,
            post_id=candidate.item.post_id,
            position=base_position + offset,
            primary_source=candidate.primary_source,
            source_rank=primary_hit.rank if primary_hit else None,
            retrieval_score=candidate.retrieval_score,
            final_score=candidate.final_score,
            reason_key=candidate.reason_key,
            provenance=_provenance(candidate),
        )
        db.add(row)
        rows.append(row)
    db.flush()
    request.latency_ms = max(0, round((time.perf_counter() - started) * 1000))
    db.commit()
    return _page_from_request(session, request, rows, restarted=restarted)


def dismiss_recommendation(
    db: Session,
    *,
    actor: ActorIdentity,
    action: str,
    post: Post,
) -> RecommendationDismissal:
    if action not in {"not_interested", "hide_creator"}:
        raise ValueError("Unsupported recommendation feedback action.")
    target_type = "post" if action == "not_interested" else "creator"
    query = db.query(RecommendationDismissal).filter(
        RecommendationDismissal.actor_key == actor.actor_key,
        RecommendationDismissal.target_type == target_type,
    )
    if target_type == "post":
        query = query.filter(RecommendationDismissal.post_id == post.id)
    else:
        query = query.filter(RecommendationDismissal.creator_id == post.owner_id)
    row = query.first()
    now = utcnow()
    if not row:
        row = RecommendationDismissal(
            actor_key=actor.actor_key,
            user_id=actor.user_id,
            anonymous_id=actor.anonymous_id,
            target_type=target_type,
            post_id=post.id if target_type == "post" else None,
            creator_id=post.owner_id if target_type == "creator" else None,
            reason=action,
        )
        db.add(row)
    row.reason = action
    row.created_at = now
    row.expires_at = now + timedelta(days=90) if target_type == "post" else None
    return row


def dismiss_creator_recommendation(
    db: Session,
    *,
    actor: ActorIdentity,
    creator_id: str,
    reason: str = "dismiss_creator",
) -> RecommendationDismissal:
    row = db.query(RecommendationDismissal).filter(
        RecommendationDismissal.actor_key == actor.actor_key,
        RecommendationDismissal.target_type == "creator",
        RecommendationDismissal.creator_id == creator_id,
    ).first()
    now = utcnow()
    if not row:
        row = RecommendationDismissal(
            actor_key=actor.actor_key,
            user_id=actor.user_id,
            anonymous_id=actor.anonymous_id,
            target_type="creator",
            creator_id=creator_id,
            reason=reason,
        )
        db.add(row)
    row.reason = reason
    row.created_at = now
    row.expires_at = None if reason == "hide_creator" else now + timedelta(days=90)
    return row


def get_creator_page(
    db: Session,
    *,
    actor: ActorIdentity,
    cursor: str | None = None,
    limit: int = 8,
) -> tuple[RecommendationPage, list[dict]]:
    limit = max(1, min(int(limit), 20))
    filters = {"limit": limit}
    session, page_index, restarted = _resolve_session(
        db,
        actor=actor,
        surface="creator_follow",
        seed_post_id=None,
        filters=filters,
        algorithm_version=CREATOR_ALGORITHM_VERSION,
        cursor=cursor,
    )
    followed = set()
    if actor.user_id:
        followed = {
            row[0]
            for row in db.query(Follow.followee_id).filter(Follow.follower_id == actor.user_id).all()
        }
    hidden = blocked_user_ids(db, actor.user_id)
    _, dismissed = _active_dismissals(db, actor.actor_key)
    hard_excluded = hidden | dismissed | followed
    if actor.user_id:
        hard_excluded.add(actor.user_id)

    existing = db.query(RecommendationRequest).filter(
        RecommendationRequest.session_id == session.id,
        RecommendationRequest.page_index == page_index,
    ).first()
    if existing:
        rows = db.query(RecommendationImpression).filter(
            RecommendationImpression.request_id == existing.id,
            RecommendationImpression.creator_id.is_not(None),
        ).order_by(RecommendationImpression.position).all()
        eligible_ids = {row.creator_id for row in rows if row.creator_id not in hard_excluded}
        users = {
            user.id: user
            for user in db.query(User).filter(
                User.id.in_(eligible_ids) if eligible_ids else False,
                User.status == "active",
            ).all()
        }
        valid_rows = [row for row in rows if row.creator_id in users]
        db.commit()
        page = _page_from_request(session, existing, valid_rows, restarted=restarted)
        return page, [public_user(users[row.creator_id], actor.user_id, False) for row in valid_rows]

    served = {
        row[0]
        for row in db.query(RecommendationImpression.creator_id).filter(
            RecommendationImpression.session_id == session.id,
            RecommendationImpression.creator_id.is_not(None),
        ).all()
    }
    excluded = hard_excluded | served
    users = db.query(User).filter(User.status == "active")
    if excluded:
        users = users.filter(~User.id.in_(excluded))
    users = users.limit(MAX_CATALOG_SIZE).all()
    user_ids = {user.id for user in users}

    eligible_post_rows = (
        db.query(Post)
        .options(selectinload(Post.tags))
        .filter(
            Post.owner_id.in_(user_ids) if user_ids else False,
            Post.status == "published",
            Post.deleted_at.is_(None),
        )
        .all()
    )
    posts_by_creator: dict[str, list[Post]] = defaultdict(list)
    for post in eligible_post_rows:
        posts_by_creator[post.owner_id].append(post)
    users = [user for user in users if posts_by_creator.get(user.id)]
    user_ids = {user.id for user in users}
    affinities = {
        row.creator_id: float(row.score or 0.0)
        for row in db.query(ActorCreatorAffinity).filter(
            ActorCreatorAffinity.actor_key == actor.actor_key,
            ActorCreatorAffinity.creator_id.in_(user_ids) if user_ids else False,
        ).all()
    }
    tag_scores = {
        row.tag_id: float(row.score or 0.0)
        for row in db.query(ActorTagAffinity).filter(
            ActorTagAffinity.actor_key == actor.actor_key,
            ActorTagAffinity.score > 0,
        ).all()
    }
    two_hop = Counter()
    if followed:
        for (creator_id,) in db.query(Follow.followee_id).filter(
            Follow.follower_id.in_(followed),
            Follow.followee_id.in_(user_ids) if user_ids else False,
        ).all():
            two_hop[creator_id] += 1

    scored = []
    now = utcnow()
    for user in users:
        creator_posts = posts_by_creator[user.id]
        newest = max(aware(post.created_at) for post in creator_posts)
        age_days = max(0.0, (now - newest).total_seconds() / 86400.0)
        tag_overlap = sum(
            max(0.0, tag_scores.get(link.tag_id, 0.0))
            for post in creator_posts[:20]
            for link in post.tags
        )
        affinity = affinities.get(user.id, 0.0)
        social = math.log1p(two_hop.get(user.id, 0))
        popularity = math.tanh(math.log1p(max(0, user.follower_count) + len(creator_posts)) / 6.0)
        freshness = math.exp(-age_days / 45.0)
        score = 1.8 * math.tanh(max(0.0, affinity) / 8.0) + 0.8 * math.tanh(tag_overlap / 8.0) + 0.7 * social + 0.5 * popularity + 0.4 * freshness
        if affinity > 0:
            source, reason = "creator_affinity", "creator_you_watch"
        elif social > 0:
            source, reason = "social_expansion", "followed_by_people_you_follow"
        elif tag_overlap > 0:
            source, reason = "tag_affinity", "topics_you_watch"
        else:
            source, reason = "popular_active", "popular_creator"
        scored.append((score, newest, user, source, reason, tag_overlap, social))
    scored.sort(key=lambda row: (-row[0], -row[1].timestamp(), row[2].id))
    selected = scored[:limit]
    has_more = len(scored) > len(selected)
    request = RecommendationRequest(
        session_id=session.id,
        page_index=page_index,
        requested_count=limit,
        returned_count=len(selected),
        candidate_count=len(scored),
        diagnostics={"has_more": has_more},
        fallback_reason=None if scored else "no_eligible_creators",
    )
    db.add(request)
    db.flush()
    rows = []
    serialized = []
    for offset, (score, _newest, user, source, reason, tag_overlap, social) in enumerate(selected):
        row = RecommendationImpression(
            request_id=request.id,
            session_id=session.id,
            creator_id=user.id,
            position=page_index * limit + offset,
            primary_source=source,
            source_rank=offset + 1,
            retrieval_score=score,
            final_score=score,
            reason_key=reason,
            provenance={
                "features": {
                    "creator_affinity": round(affinities.get(user.id, 0.0), 6),
                    "tag_overlap": round(tag_overlap, 6),
                    "two_hop": round(social, 6),
                }
            },
        )
        db.add(row)
        rows.append(row)
        serialized.append(public_user(user, actor.user_id, False))
    db.flush()
    db.commit()
    return _page_from_request(session, request, rows, restarted=restarted), serialized
