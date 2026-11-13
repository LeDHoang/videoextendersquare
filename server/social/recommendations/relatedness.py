"""Text relatedness helpers for the recommender."""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Iterable, Mapping

from server.social.geo import haversine_km

from .types import CatalogItem, PostLocation

_URL = re.compile(r"https?://\S+")
_SPLIT = re.compile(r"[^\w#]+")

STOPWORDS = frozenset(
    """
    the and for with that this from have has had was were are not but you your our their its his her
    they them what when where which who whom how why all any can will just into out about over than
    then there here also been being very more most some such only own same too use used get got
    của và là có không được cho một những các trong này đó khi với cũng đã sẽ rất nhưng như thì mà
    để từ ở ra vào lại còn hay nên bị tại theo về đang nào ai gì sao đây
    """.split()
)


def tokenize(text: str) -> tuple[str, ...]:
    """Lowercased word tokens: URLs dropped, hashtags kept as plain words, short and stop words dropped."""
    cleaned = _URL.sub(" ", str(text or "").lower())
    tokens = (part.lstrip("#") for part in _SPLIT.split(cleaned))
    return tuple(token for token in tokens if len(token) >= 3 and token not in STOPWORDS)


def build_idf(items: Iterable[CatalogItem]) -> dict[str, float]:
    """Unsmoothed log(N / df): a token in every item weighs 0."""
    frequency: Counter[str] = Counter()
    total = 0
    for item in items:
        total += 1
        frequency.update(set(item.text_tokens))
    return {token: math.log(total / count) for token, count in frequency.items()}


def tfidf_vector(tokens: Iterable[str], idf: Mapping[str, float]) -> dict[str, float]:
    """L2-normalized TF-IDF weights; empty when nothing carries weight."""
    weights = {token: count * idf.get(token, 0.0) for token, count in Counter(tokens).items()}
    weights = {token: weight for token, weight in weights.items() if weight > 0}
    norm = math.sqrt(sum(weight * weight for weight in weights.values()))
    if norm <= 0:
        return {}
    return {token: weight / norm for token, weight in weights.items()}


def cosine(a: Mapping[str, float], b: Mapping[str, float]) -> float:
    if len(b) < len(a):
        a, b = b, a
    return sum(weight * b[token] for token, weight in a.items() if token in b)


def text_scores(
    seeds: list[tuple[CatalogItem, float]],
    items: Mapping[str, CatalogItem],
    idf: Mapping[str, float],
    threshold: float = 0.1,
) -> dict[str, tuple[float, tuple[str, ...]]]:
    """Per candidate: the best seed-weighted caption cosine and the seeds that match."""
    seed_ids = {seed.post_id for seed, _ in seeds}
    seed_vectors = [(seed.post_id, tfidf_vector(seed.text_tokens, idf), weight) for seed, weight in seeds]
    seed_vectors = [row for row in seed_vectors if row[1]]
    if not seed_vectors:
        return {}
    scores: dict[str, tuple[float, tuple[str, ...]]] = {}
    for post_id, item in items.items():
        if post_id in seed_ids or not item.text_tokens:
            continue
        vector = tfidf_vector(item.text_tokens, idf)
        if not vector:
            continue
        best, matched = 0.0, []
        for seed_id, seed_vector, weight in seed_vectors:
            similarity = cosine(seed_vector, vector)
            if similarity < threshold:
                continue
            matched.append(seed_id)
            best = max(best, min(1.0, similarity * weight))
        if matched:
            scores[post_id] = (best, tuple(matched[:4]))
    return scores


def location_score(a: PostLocation | None, b: PostLocation | None) -> float:
    if a is None or b is None:
        return 0.0
    if a.slug == b.slug:
        return 1.0
    if a.coords and b.coords:
        score = math.exp(-haversine_km(a.coords, b.coords) / 50.0)
        return score if score >= 0.05 else 0.0
    if a.country.casefold() == b.country.casefold():
        return 0.6 if a.city.casefold() == b.city.casefold() else 0.15
    return 0.0


def location_scores(
    seeds: list[tuple[CatalogItem, float]],
    items: Mapping[str, CatalogItem],
) -> dict[str, tuple[float, tuple[str, ...]]]:
    """Per candidate: the best seed-weighted place closeness and the seeds that match."""
    seeds = [(seed, weight) for seed, weight in seeds if seed.location is not None]
    if not seeds:
        return {}
    seed_ids = {seed.post_id for seed, _ in seeds}
    scores: dict[str, tuple[float, tuple[str, ...]]] = {}
    for post_id, item in items.items():
        if post_id in seed_ids or item.location is None:
            continue
        best, matched = 0.0, []
        for seed, weight in seeds:
            closeness = location_score(seed.location, item.location)
            if closeness <= 0:
                continue
            matched.append(seed.post_id)
            best = max(best, min(1.0, closeness * weight))
        if matched:
            scores[post_id] = (best, tuple(matched[:4]))
    return scores
