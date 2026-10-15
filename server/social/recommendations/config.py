"""Versioned policy constants for the first ECHO recommendation ranker."""

from __future__ import annotations


REELS_ALGORITHM_VERSION = "reels-heuristic-v1"
CREATOR_ALGORITHM_VERSION = "creator-heuristic-v1"
CURSOR_VERSION = 1
SESSION_IDLE_MINUTES = 30
SESSION_MAX_HOURS = 6
DEFAULT_PAGE_SIZE = 12
MAX_PAGE_SIZE = 24
MAX_CATALOG_SIZE = 1000
MAX_SOURCE_RESULTS = 160
RRF_RANK_CONSTANT = 20.0

SOURCE_WEIGHTS = {
    "manual_order": 8.0,
    "following_recent": 4.0,
    "creator_affinity": 3.0,
    "tag_affinity": 2.5,
    "recent_item_related": 2.8,
    "session_context": 3.2,
    "global_quality_trending": 1.5,
    "fresh_exploration": 1.0,
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
