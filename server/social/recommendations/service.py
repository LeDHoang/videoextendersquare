"""Session materialization, cursor handling, eligibility, and creator suggestions."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import threading
import time
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from server.social.geo import location_coords, location_key
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
from server.social.services import reel_records_version

from .config import (
    CATALOG_NEWEST_SHARE,
    CREATOR_ALGORITHM_VERSION,
    CURSOR_VERSION,
    DEFAULT_PAGE_SIZE,
    FOLLOWING_WATCHED_DAYS,
    FOLLOWING_WATCHED_MS,
    LONG_TAIL_MAX,
    GRID_BLOCK,
    GRID_CACHE_ANON_MAX,
    GRID_CACHE_MAX,
    GRID_CACHE_TTL_S,
    GRID_CREATOR_CAP,
    MAX_CATALOG_SIZE,
    MAX_PAGE_SIZE,
    REELS_ALGORITHM_VERSION,
    SESSION_IDLE_MINUTES,
    SESSION_MAX_HOURS,
)
from .events import get_or_create
from .relatedness import age_factor, block_diverse, build_idf, legacy_prior, location_scores, text_scores, tokenize
from .ranking import rank_candidates, rerank_page
from .sources import gather_source_hits
from .types import (
    ActorIdentity,
    Candidate,
    CatalogItem,
    MaterializedResult,
    PipelineContext,
    PostLocation,
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
    _purge_actor_history(db, actor=actor, now=now, keep_session_id=row.id)
    return row


def _purge_actor_history(db: Session, *, actor: ActorIdentity, now: datetime, keep_session_id: str) -> None:
    """Delete this actor's expired sessions and stale dismissals (capped).

    Runs lazily on every new session: no scheduler needed, each purge stays
    tiny and contention-free. Engagement history survives via SET NULL FKs.
    """
    stale_ids = [
        row[0]
        for row in db.query(RecommendationSession.id)
        .filter(
            RecommendationSession.actor_key == actor.actor_key,
            RecommendationSession.id != keep_session_id,
            RecommendationSession.expires_at <= now,
        )
        .limit(100)
        .all()
    ]
    if stale_ids:
        db.query(RecommendationSession).filter(RecommendationSession.id.in_(stale_ids)).delete(
            synchronize_session=False
        )
    db.query(RecommendationDismissal).filter(
        RecommendationDismissal.actor_key == actor.actor_key,
        RecommendationDismissal.expires_at.is_not(None),
        RecommendationDismissal.expires_at <= now,
    ).delete(synchronize_session=False)


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
        # Filters changed mid-feed (new search, different page size, ...):
        # restart cleanly instead of 422ing — the restarted flag tells the
        # client to swap queues.
        row.status = "expired"
        return _new_session(
            db,
            actor=actor,
            surface=surface,
            seed_post_id=seed_post_id,
            filters=filters,
            algorithm_version=algorithm_version,
            restart_reason="filters_changed",
        ), 0, True
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


# Every published post of an active creator, newest first: the part of the
# catalog that is the same for every viewer. It is kept with the reel-record
# store it was built against, so it lasts as long as that store (its TTL) and
# is dropped by the same writes. One tuple, so a reader never sees a store
# paired with another store's items.
_catalog_base_cache: dict = {"entry": (None, ())}


def _post_location(raw) -> PostLocation | None:
    loc = raw if isinstance(raw, dict) else {}
    city, country = str(loc.get("city") or ""), str(loc.get("country") or "")
    slug = location_key(city, country)
    if not slug:
        return None
    return PostLocation(slug, city, country, location_coords(city, country, loc.get("lat"), loc.get("lon")))


def _catalog_base(db: Session) -> tuple[CatalogItem, ...]:
    store = reel_records_version(False)
    cached_store, items = _catalog_base_cache["entry"]
    if cached_store is store:
        return items
    # Plain columns, not Post entities: the catalog spans every published post
    # and needs only these.
    posts = (
        db.query(
            Post.id, Post.owner_id, Post.created_at, Post.like_count, Post.view_count,
            Post.title, Post.caption, Post.location,
        )
        .join(User, User.id == Post.owner_id)
        .filter(Post.status == "published", Post.deleted_at.is_(None), User.status == "active")
        .order_by(Post.created_at.desc(), Post.id.desc())
        .all()
    )
    tags: dict[str, list[str]] = defaultdict(list)
    if posts:
        for post_id, tag_id in db.query(PostTag.post_id, PostTag.tag_id).filter(
            PostTag.post_id.in_([post.id for post in posts])
        ):
            tags[post_id].append(tag_id)
    items = tuple(
        CatalogItem(
            post_id=post.id,
            owner_id=post.owner_id,
            tag_ids=tuple(tags.get(post.id, ())),
            created_at=aware(post.created_at),
            like_count=int(post.like_count or 0),
            view_count=int(post.view_count or 0),
            text_tokens=tokenize(f"{post.title} {post.caption}"),
            location=_post_location(post.location),
        )
        for post in posts
    )
    _catalog_base_cache["entry"] = (store, items)
    return items


# The per-request pool order, kept against the base tuple and the cap it was
# built for: the newest share first, then everything else by prior x age factor.
_catalog_pool_cache: dict = {"entry": (None, 0, ())}


def _catalog_pool_order(db: Session) -> tuple[CatalogItem, ...]:
    base = _catalog_base(db)
    cached_base, cached_cap, order = _catalog_pool_cache["entry"]
    if cached_base is base and cached_cap == MAX_CATALOG_SIZE:
        return order
    newest = int(MAX_CATALOG_SIZE * CATALOG_NEWEST_SHARE)
    now = datetime.now(timezone.utc)
    # `base` is newest first, so the stable sort keeps ties newest first.
    rest = sorted(
        base[newest:],
        key=lambda item: -legacy_prior(item.like_count, item.view_count)
        * age_factor(max(0.0, (now - item.created_at).total_seconds() / 86400.0)),
    )
    order = (*base[:newest], *rest)
    _catalog_pool_cache["entry"] = (base, MAX_CATALOG_SIZE, order)
    return order


def _long_tail_ids(
    db: Session,
    *,
    actor: ActorIdentity,
    outside: Sequence[CatalogItem],
    seed_ids: list[str],
) -> frozenset[str]:
    """Posts past the pool that this viewer likely wants, up to LONG_TAIL_MAX."""
    if not outside:
        return frozenset()
    picked: dict[str, None] = {}

    def take(ids: Iterable[str], limit: int) -> None:
        taken = 0
        for post_id in ids:
            if taken >= limit or len(picked) >= LONG_TAIL_MAX:
                return
            if post_id not in picked:
                picked[post_id] = None
                taken += 1

    newest_first = sorted(outside, key=lambda item: (item.created_at, item.post_id), reverse=True)
    top_creators = [
        row[0]
        for row in db.query(ActorCreatorAffinity.creator_id)
        .filter(ActorCreatorAffinity.actor_key == actor.actor_key, ActorCreatorAffinity.score > 0)
        .order_by(ActorCreatorAffinity.score.desc())
        .limit(20)
        .all()
    ]
    by_creator: dict[str, list[str]] = defaultdict(list)
    for item in newest_first:
        by_creator[item.owner_id].append(item.post_id)
    for creator_id in top_creators:
        take(by_creator.get(creator_id, ())[:5], 5)

    top_tags = {
        row[0]
        for row in db.query(ActorTagAffinity.tag_id)
        .filter(ActorTagAffinity.actor_key == actor.actor_key, ActorTagAffinity.score > 0)
        .order_by(ActorTagAffinity.score.desc())
        .limit(20)
        .all()
    }
    if top_tags:
        take((item.post_id for item in newest_first if top_tags.intersection(item.tag_ids)), 50)

    if seed_ids:
        outside_ids = {item.post_id for item in outside}
        similar = (
            db.query(ItemSimilarity.target_post_id)
            .filter(ItemSimilarity.source_post_id.in_(set(seed_ids)))
            .order_by(ItemSimilarity.score.desc())
            .all()
        )
        take((row[0] for row in similar if row[0] in outside_ids), LONG_TAIL_MAX)

        seed = _catalog_index(db).get(seed_ids[0])
        if seed is not None and seed.location is not None:
            slug = seed.location.slug
            take((item.post_id for item in newest_first if item.location and item.location.slug == slug), 20)
    return frozenset(picked)


# The catalog by post id and its IDF table, derived from `_catalog_base` and
# kept against the same items tuple, so they are rebuilt whenever it is.
_catalog_index_cache: dict = {"entry": (None, {})}
_catalog_idf_cache: dict = {"entry": (None, {})}


def _catalog_index(db: Session) -> dict[str, CatalogItem]:
    base = _catalog_base(db)
    cached_base, index = _catalog_index_cache["entry"]
    if cached_base is base:
        return index
    index = {item.post_id: item for item in base}
    _catalog_index_cache["entry"] = (base, index)
    return index


def _catalog_idf(db: Session) -> dict[str, float]:
    base = _catalog_base(db)
    cached_base, idf = _catalog_idf_cache["entry"]
    if cached_base is base:
        return idf
    idf = build_idf(base)
    _catalog_idf_cache["entry"] = (base, idf)
    return idf


def _catalog(
    db: Session,
    *,
    actor: ActorIdentity,
    allowed_post_ids: set[str] | None,
    excluded_post_ids: set[str],
    surface: str,
    extra_post_ids: frozenset[str] = frozenset(),
    capped: bool = True,
) -> dict[str, CatalogItem]:
    hidden_users = blocked_user_ids(db, actor.user_id)
    dismissed_posts, dismissed_creators = _active_dismissals(db, actor.actor_key)
    if allowed_post_ids is not None and not allowed_post_ids:
        return {}
    followed = None
    if surface == "following":
        if not actor.user_id:
            return {}
        followed = {actor.user_id}
        followed.update(
            row[0] for row in db.query(Follow.followee_id).filter(Follow.follower_id == actor.user_id)
        )
    excluded_creators = hidden_users | dismissed_creators
    excluded = excluded_post_ids | dismissed_posts
    catalog: dict[str, CatalogItem] = {}
    for item in _catalog_pool_order(db):
        if item.owner_id in excluded_creators or item.post_id in excluded:
            continue
        if allowed_post_ids is not None and item.post_id not in allowed_post_ids:
            continue
        if followed is not None and item.owner_id not in followed:
            continue
        # Past the cap only the extras get in; the rest of the base is still scanned for them.
        if capped and len(catalog) >= MAX_CATALOG_SIZE and item.post_id not in extra_post_ids:
            continue
        catalog[item.post_id] = item
    return catalog


def _pipeline_context(
    db: Session,
    *,
    actor: ActorIdentity,
    session: RecommendationSession | None,
    surface: str,
    seed_post_id: str | None,
    allowed_post_ids: set[str] | None,
    manual_order: list[str] | None,
    scope_order: list[str] | None = None,
    pool_only: bool = False,
    capped: bool = True,
    extra_post_ids: frozenset[str] = frozenset(),
) -> PipelineContext:
    delivered = set()
    if session is not None:
        delivered = {
            row[0]
            for row in db.query(RecommendationImpression.post_id)
            .filter(
                RecommendationImpression.session_id == session.id,
                RecommendationImpression.post_id.is_not(None),
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

    if surface != "following" and not pool_only and capped:
        extra_post_ids = extra_post_ids | _long_tail_ids(
            db, actor=actor, outside=_catalog_pool_order(db)[MAX_CATALOG_SIZE:], seed_ids=seed_ids
        )
    items = _catalog(
        db,
        actor=actor,
        allowed_post_ids=allowed_post_ids,
        excluded_post_ids=delivered,
        surface=surface,
        extra_post_ids=extra_post_ids,
        capped=capped,
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

    seed_items: tuple[tuple[CatalogItem, float], ...] = ()
    scores_by_text: dict[str, tuple[float, tuple[str, ...]]] = {}
    scores_by_location: dict[str, tuple[float, tuple[str, ...]]] = {}
    if seed_ids:
        index = _catalog_index(db)
        affinity_weight = 0.5 if surface == "related" else 1.0
        seed_items = tuple(
            (index[post_id], 1.0 if post_id == seed_post_id else affinity_weight)
            for post_id in dict.fromkeys(seed_ids)
            if post_id in index
        )
        scores_by_text = text_scores(list(seed_items), items, _catalog_idf(db))
        scores_by_location = location_scores(list(seed_items), items)
        for post_id, (score, seeds) in (*scores_by_text.items(), *scores_by_location.items()):
            if score > related.get(post_id, (0.0, ()))[0]:
                related[post_id] = (score, seeds)

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
    # Events sent without an impression (a like from a grid or profile) carry no
    # session id; count the actor's own since this session began.
    actor_column = (
        EngagementEvent.user_id == actor.user_id
        if actor.user_id
        else EngagementEvent.anonymous_id == actor.anonymous_id
    )
    session_events = [] if session is None else (
        db.query(EngagementEvent)
        .filter(
            or_(
                EngagementEvent.recommendation_session_id == session.id,
                and_(
                    EngagementEvent.recommendation_session_id.is_(None),
                    actor_column,
                    EngagementEvent.created_at >= session.created_at,
                ),
            ),
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
        for (owner_id,) in (
            []
            if session is None
            else db.query(Post.owner_id)
            .join(RecommendationImpression, RecommendationImpression.post_id == Post.id)
            .filter(RecommendationImpression.session_id == session.id)
            .all()
        )
    )
    watched_post_ids: frozenset[str] = frozenset()
    if surface == "following" and items:
        watched_post_ids = frozenset(
            post_id
            for (post_id,) in db.query(EngagementEvent.post_id)
            .filter(
                actor_column,
                EngagementEvent.post_id.in_(list(items)),
                EngagementEvent.created_at >= utcnow() - timedelta(days=FOLLOWING_WATCHED_DAYS),
                or_(
                    EngagementEvent.event_type == "complete",
                    and_(
                        EngagementEvent.event_type == "view",
                        EngagementEvent.watch_ms >= FOLLOWING_WATCHED_MS,
                    ),
                ),
            )
            .distinct()
            .all()
        )
    return PipelineContext(
        actor=actor,
        surface=surface,
        now=utcnow(),
        session_id=session.id if session is not None else "",
        seed_post_id=seed_post_id,
        manual_order=manual_order,
        scope_order=scope_order,
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
        seed_items=seed_items,
        text_scores=scores_by_text,
        location_scores=scores_by_location,
        pool_only=pool_only,
        watched_post_ids=watched_post_ids,
    )


def rank_pool(db: Session, *, actor: ActorIdentity, allowed_post_ids: set[str]) -> list[Candidate]:
    """Score every allowed post (capped to the catalog pool) for one actor; no session, no rerank."""
    context = _pipeline_context(
        db,
        actor=actor,
        session=None,
        surface="for_you",
        seed_post_id=None,
        allowed_post_ids=allowed_post_ids,
        manual_order=None,
        pool_only=True,
        capped=True,
    )
    return rank_candidates(context, gather_source_hits(context))


# (actor key, filters key, seed) -> (created monotonic, ids). Entries age out by
# time alone: the store behind reel_records_version swaps every few seconds, so
# keying on it would re-rank between pages.
_grid_cache: dict[tuple[str, str, int], tuple[float, list[str]]] = {}
_grid_cache_lock = threading.Lock()
_GRID_ANONYMOUS_KEY = "grid:anonymous"


def rank_grid(
    db: Session, *, actor: ActorIdentity, allowed_post_ids: set[str], filters_key: str, seed: int
) -> list[str]:
    key = (actor.actor_key, filters_key, seed)
    now = time.monotonic()
    entry = _grid_cache.get(key)
    if entry is not None and now - entry[0] < GRID_CACHE_TTL_S:
        return entry[1]
    ranked = rank_pool(db, actor=actor, allowed_post_ids=allowed_post_ids)
    owner_of = {candidate.item.post_id: candidate.item.owner_id for candidate in ranked}
    ids = block_diverse([candidate.item.post_id for candidate in ranked], owner_of, GRID_BLOCK, GRID_CREATOR_CAP)
    with _grid_cache_lock:
        _grid_cache[key] = (now, ids)
        # Anonymous keys evict only among themselves, so they cannot push out
        # signed-in entries.
        anonymous = actor.actor_key == _GRID_ANONYMOUS_KEY
        peers = [k for k in _grid_cache if (k[0] == _GRID_ANONYMOUS_KEY) == anonymous]
        while len(peers) > (GRID_CACHE_ANON_MAX if anonymous else GRID_CACHE_MAX):
            oldest = min(peers, key=lambda k: _grid_cache[k][0])
            del _grid_cache[oldest]
            peers.remove(oldest)
    return ids


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
    scope_order: list[str] | None = None,
    filters: dict | None = None,
    cursor: str | None = None,
    limit: int = DEFAULT_PAGE_SIZE,
    pool_only: bool = False,
    extra_post_ids: frozenset[str] = frozenset(),
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
    # Persist session setup first: concurrent requests for the same
    # unmaterialized page race on uq_recommendation_request_session_page.
    # With the session committed, the loser can roll back just its own
    # materialization inserts and replay the winner's rows below.
    db.commit()
    existing = db.query(RecommendationRequest).filter(
        RecommendationRequest.session_id == session.id,
        RecommendationRequest.page_index == page_index,
    ).first()
    if existing:
        return _replay_reel_page(
            db,
            actor=actor,
            session=session,
            page_index=page_index,
            restarted=restarted,
            allowed_post_ids=allowed_post_ids,
            surface=surface,
        )
    try:
        return _materialize_reel_page(
            db,
            actor=actor,
            session=session,
            surface=surface,
            seed_post_id=seed_post_id,
            allowed_post_ids=allowed_post_ids,
            manual_order=manual_order,
            scope_order=scope_order,
            page_index=page_index,
            restarted=restarted,
            limit=limit,
            started=started,
            pool_only=pool_only,
            extra_post_ids=extra_post_ids,
        )
    except IntegrityError:
        db.rollback()
        existing = None
        for _ in range(5):
            existing = db.query(RecommendationRequest).filter(
                RecommendationRequest.session_id == session.id,
                RecommendationRequest.page_index == page_index,
            ).first()
            if existing is not None:
                break
            time.sleep(0.02)
        if existing is None:
            raise
        return _replay_reel_page(
            db,
            actor=actor,
            session=session,
            page_index=page_index,
            restarted=restarted,
            allowed_post_ids=allowed_post_ids,
            surface=surface,
        )


def _replay_reel_page(
    db: Session,
    *,
    actor: ActorIdentity,
    session: RecommendationSession,
    page_index: int,
    restarted: bool,
    allowed_post_ids: set[str] | None,
    surface: str,
) -> RecommendationPage:
    existing = db.query(RecommendationRequest).filter(
        RecommendationRequest.session_id == session.id,
        RecommendationRequest.page_index == page_index,
    ).first()
    if existing is None:
        raise RecommendationCursorError("Recommendation page no longer exists.")
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
        extra_post_ids=frozenset(row.post_id for row in rows),
    )
    rows = [row for row in rows if row.post_id in eligible]
    db.commit()
    return _page_from_request(session, existing, rows, restarted=restarted)


def _materialize_reel_page(
    db: Session,
    *,
    actor: ActorIdentity,
    session: RecommendationSession,
    surface: str,
    seed_post_id: str | None,
    allowed_post_ids: set[str] | None,
    manual_order: list[str] | None,
    scope_order: list[str] | None,
    page_index: int,
    restarted: bool,
    limit: int,
    started: float,
    pool_only: bool = False,
    extra_post_ids: frozenset[str] = frozenset(),
) -> RecommendationPage:
    context = _pipeline_context(
        db,
        actor=actor,
        session=session,
        surface=surface,
        seed_post_id=seed_post_id,
        allowed_post_ids=allowed_post_ids,
        manual_order=manual_order,
        scope_order=scope_order,
        pool_only=pool_only,
        capped=not pool_only,
        extra_post_ids=extra_post_ids,
    )
    hits = gather_source_hits(context)
    ranked = rank_candidates(context, hits)
    pinned = None
    if page_index == 0 and seed_post_id:
        pinned = next((candidate for candidate in ranked if candidate.item.post_id == seed_post_id), None)
    uncapped_owner = None
    if surface == "related" and seed_post_id:
        # The seed may already be delivered (pages 1+), so resolve it from the seed items.
        uncapped_owner = next(
            (item.owner_id for item, _ in context.seed_items if item.post_id == seed_post_id), None
        )
    explore = not context.pool_only
    if surface == "following":
        # Unwatched reels fill the page first; the watched ones only top it up.
        unwatched = [c for c in ranked if c.item.post_id not in context.watched_post_ids]
        watched = [c for c in ranked if c.item.post_id in context.watched_post_ids]
        head = [pinned] if pinned else []
        first = rerank_page(
            [c for c in unwatched if c is not pinned],
            limit - len(head),
            explore=False,
            preselected=head,
        )
        rest = rerank_page(
            [c for c in watched if c is not pinned],
            limit - len(head) - len(first),
            explore=False,
            preselected=[*head, *first],
        )
        selected = [*head, *first, *rest]
    elif pinned:
        selected = [
            pinned,
            *rerank_page(
                [candidate for candidate in ranked if candidate is not pinned],
                limit - 1,
                preselected=[pinned],
                explore=explore,
                uncapped_owner=uncapped_owner,
            ),
        ]
    else:
        selected = rerank_page(ranked, limit, explore=explore, uncapped_owner=uncapped_owner)
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
    now = utcnow()
    if target_type == "post":
        row = get_or_create(
            db,
            RecommendationDismissal,
            RecommendationDismissal.actor_key == actor.actor_key,
            RecommendationDismissal.target_type == "post",
            RecommendationDismissal.post_id == post.id,
            actor_key=actor.actor_key,
            user_id=actor.user_id,
            anonymous_id=actor.anonymous_id,
            target_type="post",
            post_id=post.id,
            reason=action,
        )
    else:
        row = get_or_create(
            db,
            RecommendationDismissal,
            RecommendationDismissal.actor_key == actor.actor_key,
            RecommendationDismissal.target_type == "creator",
            RecommendationDismissal.creator_id == post.owner_id,
            actor_key=actor.actor_key,
            user_id=actor.user_id,
            anonymous_id=actor.anonymous_id,
            target_type="creator",
            creator_id=post.owner_id,
            reason=action,
        )
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
    row = get_or_create(
        db,
        RecommendationDismissal,
        RecommendationDismissal.actor_key == actor.actor_key,
        RecommendationDismissal.target_type == "creator",
        RecommendationDismissal.creator_id == creator_id,
        actor_key=actor.actor_key,
        user_id=actor.user_id,
        anonymous_id=actor.anonymous_id,
        target_type="creator",
        creator_id=creator_id,
        reason=reason,
    )
    now = utcnow()
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
    # See get_reel_page: persist session setup so a materialization race can
    # roll back to it and replay the winner's rows.
    db.commit()
    existing = db.query(RecommendationRequest).filter(
        RecommendationRequest.session_id == session.id,
        RecommendationRequest.page_index == page_index,
    ).first()
    if existing:
        return _replay_creator_page(db, actor=actor, session=session, page_index=page_index, restarted=restarted)
    try:
        return _materialize_creator_page(
            db, actor=actor, session=session, page_index=page_index,
            restarted=restarted, limit=limit,
        )
    except IntegrityError:
        db.rollback()
        existing = None
        for _ in range(5):
            existing = db.query(RecommendationRequest).filter(
                RecommendationRequest.session_id == session.id,
                RecommendationRequest.page_index == page_index,
            ).first()
            if existing is not None:
                break
            time.sleep(0.02)
        if existing is None:
            raise
        return _replay_creator_page(db, actor=actor, session=session, page_index=page_index, restarted=restarted)


def _replay_creator_page(
    db: Session,
    *,
    actor: ActorIdentity,
    session: RecommendationSession,
    page_index: int,
    restarted: bool,
) -> tuple[RecommendationPage, list[dict]]:
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
    if existing is None:
        raise RecommendationCursorError("Recommendation page no longer exists.")
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


def _materialize_creator_page(
    db: Session,
    *,
    actor: ActorIdentity,
    session: RecommendationSession,
    page_index: int,
    restarted: bool,
    limit: int,
) -> tuple[RecommendationPage, list[dict]]:
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
