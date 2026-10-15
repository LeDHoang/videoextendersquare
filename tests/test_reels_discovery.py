import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from server.routers import reels


RAW_MEDIA = [
    {
        "rel_path": "uploads/night-runner.mp4",
        "path": "output/uploads/night-runner.mp4",
        "filename": "night-runner.mp4",
        "folder": "uploads",
        "mtime": 30,
        "media_type": "video",
    },
    {
        "rel_path": "uploads/grid-arena.mp4",
        "path": "output/uploads/grid-arena.mp4",
        "filename": "grid-arena.mp4",
        "folder": "uploads",
        "mtime": 20,
        "media_type": "video",
    },
    {
        "rel_path": "uploads/forest.jpg",
        "path": "output/uploads/forest.jpg",
        "filename": "forest.jpg",
        "folder": "uploads",
        "mtime": 10,
        "media_type": "image",
    },
]

META = {
    "uploads/night-runner.mp4": {
        "title": "Night Runner",
        "caption": "Rain over Neo Tokyo",
        "author_name": "Kira",
        "tags": ["cyberpunk", "neon", "sci-fi"],
        "location": {"city": "Tokyo", "country": "Japan"},
        "likes": 50,
        "views": 1000,
    },
    "uploads/grid-arena.mp4": {
        "title": "Grid Arena",
        "caption": "A virtual tournament",
        "author_name": "Sam",
        "tags": ["cyberpunk", "gaming"],
        "location": {"city": "Seoul", "country": "South Korea"},
        "likes": 20,
        "views": 300,
    },
    "uploads/forest.jpg": {
        "title": "Quiet Forest",
        "caption": "Morning light",
        "author_name": "Mika",
        "tags": ["nature", "chill"],
        "location": {"city": "Seattle", "country": "USA"},
        "likes": 10,
        "views": 100,
    },
}


class _FakeQuery:
    def __init__(self, rows):
        self.rows = rows

    def filter(self, *_args):
        return self

    def all(self):
        return list(self.rows)


class _FakeDb:
    def __init__(self, rows_by_model):
        self.rows_by_model = rows_by_model

    def query(self, model, *_columns):
        return _FakeQuery(self.rows_by_model.get(model, []))


class ReelDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.meta_patch = patch.object(reels, "_load_meta_raw", return_value=META)
        self.meta_patch.start()
        self.addCleanup(self.meta_patch.stop)
        self.visibility_patch = patch.object(
            reels,
            "unavailable_media_paths_for_viewer",
            return_value=set(),
        )
        self.visibility_patch.start()
        self.addCleanup(self.visibility_patch.stop)

    def test_exact_tag_filter_is_case_and_hash_insensitive(self):
        matches = reels._apply_filters(
            RAW_MEDIA,
            folder=None,
            search="",
            sort="newest",
            tag="#CyberPunk",
        )
        self.assertEqual(
            [item["rel_path"] for item in matches],
            ["uploads/night-runner.mp4", "uploads/grid-arena.mp4"],
        )

    def test_metadata_search_matches_title_creator_place_and_tag(self):
        for query in ("night runner", "kira", "tokyo", "neon"):
            with self.subTest(query=query):
                matches = reels._apply_filters(RAW_MEDIA, None, query, "newest")
                self.assertEqual(matches[0]["rel_path"], "uploads/night-runner.mp4")

    def test_name_query_ranks_tags_from_matching_reel(self):
        catalog, contexts = reels._tag_catalog(RAW_MEDIA)
        results = reels._rank_tag_catalog(catalog, contexts, "night runner", 5)
        names = {item["name"] for item in results}
        self.assertTrue({"cyberpunk", "neon", "sci-fi"}.issubset(names))

    def test_related_tags_use_shared_reel_counts(self):
        catalog, _ = reels._tag_catalog(RAW_MEDIA)
        related = reels._related_tag_rows("cyberpunk", catalog)
        by_slug = {item["slug"]: item["shared_reels"] for item in related}
        self.assertEqual(by_slug["neon"], 1)
        self.assertEqual(by_slug["gaming"], 1)

    def test_tag_suggestion_contract_includes_reason_and_related_tags(self):
        with patch.object(reels, "_scan_cached", return_value=RAW_MEDIA):
            response = reels.list_reel_tags(q="#cyberpunk", limit=3)
        self.assertEqual(response["strategy"], "metadata-v1")
        self.assertEqual(response["tags"][0]["slug"], "cyberpunk")
        self.assertEqual(response["tags"][0]["reason"], "EXACT TAG")
        self.assertIn("related_tags", response["tags"][0])

    def test_tag_detail_contract_keeps_exact_feed(self):
        with (
            patch.object(reels, "_scan_cached", return_value=RAW_MEDIA),
            patch.object(
                reels,
                "_build_payload",
                side_effect=lambda items, codec, viewer_id=None: [
                    item["rel_path"] for item in items
                ],
            ),
        ):
            response = reels.get_reel_tag("cyberpunk", codec="hevc", sort="trending")
        self.assertEqual(response["strategy"], "cooccurrence-v1")
        self.assertEqual(response["tag"]["slug"], "cyberpunk")
        self.assertEqual(response["count"], 2)
        self.assertEqual(
            set(response["videos"]),
            {"uploads/night-runner.mp4", "uploads/grid-arena.mp4"},
        )
    def test_activity_decay_uses_a_48_hour_half_life(self):
        now = datetime(2026, 9, 12, 12, tzinfo=timezone.utc)
        self.assertAlmostEqual(reels._activity_decay(now, now), 1.0)
        self.assertAlmostEqual(reels._activity_decay(now - timedelta(hours=48), now), 0.5)
        self.assertAlmostEqual(reels._activity_decay(now - timedelta(hours=96), now), 0.25)

    def test_recent_activity_weights_only_positive_qualified_signals(self):
        now = datetime(2026, 9, 12, 12, tzinfo=timezone.utc)
        post = SimpleNamespace(
            id="post-1",
            media_path=RAW_MEDIA[0]["rel_path"],
            status="published",
            deleted_at=None,
            created_at=now,
        )
        rows = {
            reels.Post: [post],
            reels.ViewDedup: [SimpleNamespace(post_id=post.id, created_at=now)],
            reels.PostLike: [SimpleNamespace(post_id=post.id, created_at=now)],
            reels.Comment: [SimpleNamespace(post_id=post.id, created_at=now, deleted_at=None)],
            reels.PostSave: [SimpleNamespace(post_id=post.id, created_at=now)],
            reels.EngagementEvent: [
                SimpleNamespace(post_id=post.id, event_type="share", created_at=now, client_occurred_at=None),
                SimpleNamespace(post_id=post.id, event_type="share_sent", created_at=now, client_occurred_at=None),
                SimpleNamespace(post_id=post.id, event_type="skip", created_at=now, client_occurred_at=None),
                SimpleNamespace(
                    post_id=post.id,
                    event_type="not_interested",
                    created_at=now,
                    client_occurred_at=None,
                ),
            ],
        }

        activity = reels._recent_activity_by_path(_FakeDb(rows), [RAW_MEDIA[0]], 7, now=now)

        self.assertEqual(activity[post.media_path]["score"], 20.0)
        self.assertTrue(activity[post.media_path]["is_new"])
        self.assertTrue(activity[post.media_path]["active"])

    def test_legacy_media_mtime_counts_as_a_new_post(self):
        now = datetime(2026, 9, 12, 12, tzinfo=timezone.utc)
        legacy = {**RAW_MEDIA[0], "mtime": now.timestamp()}
        activity = reels._recent_activity_by_path(_FakeDb({}), [legacy], 7, now=now)
        self.assertEqual(activity[legacy["rel_path"]]["score"], reels.RECENT_ACTIVITY_POST_WEIGHT)
        self.assertTrue(activity[legacy["rel_path"]]["is_new"])

    def test_location_activity_aggregates_centroids_and_log_normalizes_heat(self):
        metadata = {
            RAW_MEDIA[0]["rel_path"]: {
                **META[RAW_MEDIA[0]["rel_path"]],
                "location": {"city": "Tokyo", "country": "Japan", "lat": 35.0, "lon": 139.0},
            },
            RAW_MEDIA[1]["rel_path"]: {
                **META[RAW_MEDIA[1]["rel_path"]],
                "location": {"city": "Tokyo", "country": "Japan", "lat": 36.0, "lon": 140.0},
            },
            RAW_MEDIA[2]["rel_path"]: META[RAW_MEDIA[2]["rel_path"]],
        }
        activity = {
            RAW_MEDIA[0]["rel_path"]: {"score": 9.0, "is_new": True},
            RAW_MEDIA[1]["rel_path"]: {"score": 7.0, "is_new": False},
            RAW_MEDIA[2]["rel_path"]: {"score": 1.0, "is_new": False},
        }

        rows = reels._location_activity_rows(RAW_MEDIA, activity, metadata=metadata)
        tokyo = next(row for row in rows if row["slug"] == "tokyo--japan")
        seattle = next(row for row in rows if row["slug"] == "seattle--usa")

        self.assertEqual(tokyo["active_reel_count"], 2)
        self.assertEqual(tokyo["new_reel_count"], 1)
        self.assertEqual((tokyo["lat"], tokyo["lon"]), (35.5, 139.5))
        self.assertGreater(tokyo["heat"], seattle["heat"])
        self.assertNotIn("path", tokyo)

    def test_location_activity_uses_city_fallback_and_omits_unresolved_places(self):
        raw = [
            RAW_MEDIA[0],
            {**RAW_MEDIA[1], "rel_path": "uploads/moon.mp4"},
        ]
        metadata = {
            RAW_MEDIA[0]["rel_path"]: META[RAW_MEDIA[0]["rel_path"]],
            "uploads/moon.mp4": {"location": {"city": "Moon Base", "country": "Space"}},
        }
        activity = {
            RAW_MEDIA[0]["rel_path"]: {"score": 2.0, "is_new": True},
            "uploads/moon.mp4": {"score": 100.0, "is_new": True},
        }

        rows = reels._location_activity_rows(raw, activity, metadata=metadata)
        self.assertEqual([row["slug"] for row in rows], ["tokyo--japan"])
        self.assertEqual((rows[0]["lat"], rows[0]["lon"]), reels.CITY_COORDS["tokyo,japan"])

    def test_recent_trending_sort_uses_activity_before_mtime(self):
        activity = {
            RAW_MEDIA[0]["rel_path"]: {"score": 1.0},
            RAW_MEDIA[1]["rel_path"]: {"score": 9.0},
            RAW_MEDIA[2]["rel_path"]: {"score": 0.0},
        }
        matches = reels._apply_filters(
            RAW_MEDIA,
            folder=None,
            search="",
            sort="recent_trending",
            recent_activity=activity,
        )
        self.assertEqual(matches[0]["rel_path"], RAW_MEDIA[1]["rel_path"])

    def test_activity_endpoint_filters_hidden_media_and_bounds_parameters(self):
        with (
            patch.object(reels, "_scan_cached", return_value=RAW_MEDIA),
            patch.object(
                reels,
                "unavailable_media_paths_for_viewer",
                return_value={RAW_MEDIA[0]["rel_path"]},
            ),
            patch.object(
                reels,
                "_recent_activity_by_path",
                side_effect=lambda _db, raw, _days: {
                    item["rel_path"]: {"score": 2.0, "is_new": True}
                    for item in raw
                },
            ),
        ):
            response = reels.list_reel_location_activity(
                window_days=999,
                limit=999,
                viewer=None,
                db=object(),
            )

        self.assertEqual(response["window_days"], reels.RECENT_ACTIVITY_MAX_DAYS)
        self.assertEqual(response["count"], 2)
        self.assertNotIn("tokyo--japan", {row["slug"] for row in response["locations"]})


    def test_post_deep_link_returns_only_the_referenced_reel(self):
        target = SimpleNamespace(media_path="uploads/grid-arena.mp4")
        with (
            patch.object(reels, "_scan_cached", return_value=RAW_MEDIA),
            patch.object(reels, "get_post_by_reference", return_value=target),
            patch.object(
                reels,
                "_build_payload",
                side_effect=lambda items, codec, viewer_id=None: [
                    item["rel_path"] for item in items
                ],
            ),
        ):
            response = reels.list_reels(post="post-123", viewer=None, db=object())

        self.assertEqual(response["count"], 1)
        self.assertEqual(response["videos"], ["uploads/grid-arena.mp4"])


if __name__ == "__main__":
    unittest.main()
