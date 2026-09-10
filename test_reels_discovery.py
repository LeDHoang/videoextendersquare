import unittest
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


class ReelDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.meta_patch = patch.object(reels, "_load_meta_raw", return_value=META)
        self.meta_patch.start()
        self.addCleanup(self.meta_patch.stop)

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
                side_effect=lambda items, codec: [item["rel_path"] for item in items],
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


if __name__ == "__main__":
    unittest.main()
