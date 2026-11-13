"""Versioned policy constants for the first ECHO recommendation ranker."""

from __future__ import annotations


REELS_ALGORITHM_VERSION = "reels-heuristic-v2"
CREATOR_ALGORITHM_VERSION = "creator-heuristic-v1"
CURSOR_VERSION = 1
SESSION_IDLE_MINUTES = 30
SESSION_MAX_HOURS = 6
DEFAULT_PAGE_SIZE = 12
MAX_PAGE_SIZE = 24
MAX_CATALOG_SIZE = 1000
# Share of the per-request pool kept for the newest posts; the rest goes to the best older ones.
CATALOG_NEWEST_SHARE = 0.5
LONG_TAIL_MAX = 150
GRID_CACHE_TTL_S = 600
GRID_CACHE_MAX = 256
GRID_BLOCK = 24
GRID_CREATOR_CAP = 3
# (age in days, freshness factor): small penalty within 3 months, larger within 6, a year, then the most.
AGE_FACTOR_POINTS = ((0, 1.0), (90, 0.85), (180, 0.70), (365, 0.55), (730, 0.40))
MAX_SOURCE_RESULTS = 160
RRF_RANK_CONSTANT = 20.0
FOLLOWING_PERSONAL_WEIGHT = 0.5
# e-folding time in exp(-age_hours / FOLLOWING_RECENCY_DECAY_HOURS), not a half-life.
FOLLOWING_RECENCY_DECAY_HOURS = 48.0
# Scales the following score so the 0.45 creator and 2.5 back-to-back penalties keep their proportion.
FOLLOWING_SCORE_SCALE = 4.0
FOLLOWING_WATCHED_DAYS = 7
FOLLOWING_WATCHED_MS = 3000

SOURCE_WEIGHTS = {
    "manual_order": 8.0,
    "following_recent": 4.0,
    "creator_affinity": 3.0,
    "tag_affinity": 2.5,
    "recent_item_related": 2.8,
    "text_related": 0.9,
    "location_related": 0.7,
    "creator_other_reels": 0.8,
    "session_context": 3.2,
    "global_quality_trending": 1.5,
    "fresh_exploration": 1.0,
    "scope_pool": 1.0,
}

RANK_WEIGHTS = {
    "retrieval_fusion": 1.00,
    "creator_affinity": 1.50,
    "topic_affinity": 1.25,
    "co_watch_similarity": 1.00,
    "quality": 0.70,
    "freshness": 0.50,
    "exploration": 0.35,
    "negative_affinity": 1.50,
    "exposure_fatigue": 1.00,
}

EVENT_WEIGHTS = {
    "view": 1.0,
    "complete": 1.0,
    "replay": 2.0,
    "like": 3.0,
    "unlike": -3.0,
    "comment": 3.0,
    "save": 4.0,
    "unsave": -4.0,
    "share": 2.0,
    "share_sent": 5.0,
    "profile_open": 1.0,
    "follow": 6.0,
    "unfollow": -4.0,
    "skip": -1.0,
    "not_interested": -8.0,
    "hide_creator": -12.0,
    "dismiss_creator": -6.0,
}
