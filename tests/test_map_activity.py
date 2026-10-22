"""Z3 (docs/earth-zoom-map-plan.md §8): zoom-aware heat clustering + privacy."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from server.routers import reels


RAW_MEDIA = [
    {
        "rel_path": "uploads/tokyo-night.mp4",
        "path": "output/uploads/tokyo-night.mp4",
        "filename": "tokyo-night.mp4",
        "folder": "uploads",
        "mtime": 30,
        "media_type": "video",
    },
    {
        "rel_path": "uploads/tokyo-tower.mp4",
        "path": "output/uploads/tokyo-tower.mp4",
        "filename": "tokyo-tower.mp4",
        "folder": "uploads",
        "mtime": 20,
        "media_type": "video",
    },
    {
        "rel_path": "uploads/seoul-rain.mp4",
        "path": "output/uploads/seoul-rain.mp4",
        "filename": "seoul-rain.mp4",
        "folder": "uploads",
        "mtime": 10,
        "media_type": "video",
    },
    {
        "rel_path": "uploads/seattle-pine.mp4",
        "path": "output/uploads/seattle-pine.mp4",
        "filename": "seattle-pine.mp4",
        "folder": "uploads",
        "mtime": 5,
        "media_type": "video",
    },
]

META = {
    "uploads/tokyo-night.mp4": {"location": {"city": "Tokyo", "country": "Japan"}},
    "uploads/tokyo-tower.mp4": {"location": {"city": "Tokyo", "country": "Japan"}},
    "uploads/seoul-rain.mp4": {"location": {"city": "Seoul", "country": "South Korea"}},
    "uploads/seattle-pine.mp4": {"location": {"city": "Seattle", "country": "USA"}},
}

ACTIVITY = {
    "uploads/tokyo-night.mp4": {"score": 9.0, "is_new": True},
    "uploads/tokyo-tower.mp4": {"score": 7.0, "is_new": False},
    "uploads/seoul-rain.mp4": {"score": 4.0, "is_new": True},
    "uploads/seattle-pine.mp4": {"score": 1.0, "is_new": False},
}


def _city_rows():
    return reels._location_activity_rows(RAW_MEDIA, ACTIVITY, metadata=META)


class GeohashTests(unittest.TestCase):
    def test_encode_matches_known_vectors(self):
        # Classic reference vector: (42.6, -5.6) at precision 5 → 'ezs42'.
        self.assertEqual(reels._geohash_encode(42.6, -5.6, 5), "ezs42")
        self.assertEqual(reels._geohash_encode(0, 0, 1), "s")
        self.assertEqual(len(reels._geohash_encode(35.6762, 139.6503, 4)), 4)

    def test_cell_center_reencodes_to_the_same_cell(self):
        for lat, lon, precision in [
            (35.6762, 139.6503, 4),
            (37.5665, 126.9780, 4),
            (47.6062, -122.3321, 3),
            (-33.8688, 151.2093, 5),
        ]:
            gh = reels._geohash_encode(lat, lon, precision)
            clat, clon = reels._geohash_cell_center(gh)
            self.assertEqual(reels._geohash_encode(clat, clon, precision), gh)
            # The center is inside the cell that contains the original point.
            self.assertLess(abs(clat - lat), 90.0)
            self.assertLess(abs(clon - lon), 180.0)

    def test_cluster_precision_bands(self):
        self.assertEqual(reels._cluster_precision(0), 2)
        self.assertEqual(reels._cluster_precision(2), 2)
        self.assertEqual(reels._cluster_precision(3), 3)
        self.assertEqual(reels._cluster_precision(5), 3)
        self.assertEqual(reels._cluster_precision(6), 4)
        self.assertEqual(reels._cluster_precision(8), 4)
        self.assertEqual(reels._cluster_precision(9), 5)
        self.assertEqual(reels._cluster_precision(17), 5)


class BboxTests(unittest.TestCase):
    def test_parse_bbox_accepts_valid_and_rejects_malformed(self):
        self.assertEqual(reels._parse_bbox("100,-10,150,45"), (100.0, -10.0, 150.0, 45.0))
        self.assertIsNone(reels._parse_bbox(""))
        self.assertIsNone(reels._parse_bbox("1,2,3"))
        self.assertIsNone(reels._parse_bbox("a,b,c,d"))
        self.assertIsNone(reels._parse_bbox("0,90,10,-90"))     # south > north
        # R4 dateline wrap: west > east is a valid crossing box.
        self.assertEqual(reels._parse_bbox("179,-10,-179,10"), (179.0, -10.0, -179.0, 10.0))

    def test_in_bbox_bounds(self):
        bounds = (100.0, -10.0, 150.0, 45.0)
        self.assertTrue(reels._in_bbox(35.0, 139.0, bounds))
        self.assertFalse(reels._in_bbox(47.6, -122.3, bounds))
        self.assertTrue(reels._in_bbox(35.0, 139.0, None))

    def test_in_bbox_crossing_box(self):
        crossing = (179.0, -10.0, -179.0, 10.0)
        self.assertTrue(reels._in_bbox(0.0, 179.5, crossing))
        self.assertTrue(reels._in_bbox(0.0, -179.5, crossing))
        self.assertFalse(reels._in_bbox(0.0, 0.0, crossing))
        self.assertFalse(reels._in_bbox(45.0, 179.5, crossing))  # lat outside


class ClusterTests(unittest.TestCase):
    def setUp(self):
        # These fixtures model local, unpublished files: the database answers
        # "no published post" so the persisted META fallback applies. (A
        # failed lookup raises a 503 instead; see test_reels_metadata_failures.)
        self.lookup_patch = patch.object(reels, "metadata_for_paths", return_value={})
        self.lookup_patch.start()
        self.addCleanup(self.lookup_patch.stop)
        self.meta_patch = patch.object(reels, "_load_meta_raw", return_value=META)
        self.meta_patch.start()
        self.addCleanup(self.meta_patch.stop)
        self.visibility_patch = patch.object(
            reels, "unavailable_media_paths_for_viewer", return_value=set()
        )
        self.visibility_patch.start()
        self.addCleanup(self.visibility_patch.stop)

    def _activity_endpoint(self, **kwargs):
        with (
            patch.object(reels, "_scan_cached", return_value=RAW_MEDIA),
            patch.object(
                reels,
                "_recent_activity_by_path",
                side_effect=lambda _db, _raw, _days: dict(ACTIVITY),
            ),
        ):
            return reels.list_reel_location_activity(
                window_days=7, limit=128, viewer=None, db=object(), **kwargs
            )

    def test_no_zoom_keeps_the_legacy_city_payload(self):
        response = self._activity_endpoint()
        self.assertEqual(response["strategy"], "recent-activity-v1")
        self.assertNotIn("zoom", response)
        slugs = [row["slug"] for row in response["locations"]]
        self.assertIn("tokyo--japan", slugs)
        self.assertIn("seattle--usa", slugs)

    def test_zoom_clusters_cities_into_geohash_cells(self):
        response = self._activity_endpoint(zoom=6)
        self.assertEqual(response["strategy"], "zoom-cluster-v1")
        self.assertEqual(response["zoom"], 6)
        self.assertEqual(response["cluster_precision"], 4)
        self.assertTrue(all(row["kind"] == "cluster" for row in response["locations"]))
        by_geohash = {row["geohash"]: row for row in response["locations"]}
        # Tokyo's two reels collapse into one 4-char cell; coordinates are the
        # CELL CENTER (quantized), not the city centroid.
        tokyo_city = next(row for row in _city_rows() if row["slug"] == "tokyo--japan")
        gh = reels._geohash_encode(tokyo_city["lat"], tokyo_city["lon"], 4)
        self.assertIn(gh, by_geohash)
        cell = by_geohash[gh]
        self.assertEqual(cell["location_count"], 1)
        self.assertEqual(cell["active_reel_count"], 2)
        self.assertNotEqual((cell["lat"], cell["lon"]), (tokyo_city["lat"], tokyo_city["lon"]))
        center = reels._geohash_cell_center(gh)
        self.assertEqual((cell["lat"], cell["lon"]), (round(center[0], 6), round(center[1], 6)))
        # Slug alias: hover previews, feed selects, and label keys all
        # address rows by slug — clusters expose the hottest member city's.
        self.assertTrue(cell["slug"], "cluster rows must carry a slug")
        self.assertEqual(cell["slug"], cell["primary_slug"])
        self.assertEqual(cell["slug"], tokyo_city["slug"])
        # Heat is renormalized within the returned set, ramp bounded.
        self.assertTrue(all(0.0 <= row["heat"] <= 1.0 for row in response["locations"]))
        hottest = max(response["locations"], key=lambda row: row["score"])
        self.assertEqual(hottest["heat"], 1.0)

    def test_zoom_band_changes_cell_granularity(self):
        coarse = self._activity_endpoint(zoom=1)
        fine = self._activity_endpoint(zoom=10)
        self.assertEqual(coarse["cluster_precision"], 2)
        self.assertEqual(fine["cluster_precision"], 5)
        self.assertTrue(all(len(row["geohash"]) == 2 for row in coarse["locations"]))
        self.assertTrue(all(len(row["geohash"]) == 5 for row in fine["locations"]))
        self.assertLessEqual(len(coarse["locations"]), len(fine["locations"]))

    def test_deep_zoom_keeps_city_rows_as_the_privacy_floor(self):
        response = self._activity_endpoint(zoom=14)
        self.assertEqual(response["strategy"], "zoom-cluster-v1")
        self.assertIsNone(response["cluster_precision"])
        self.assertTrue(all("kind" not in row for row in response["locations"]))
        self.assertEqual(
            {row["slug"] for row in response["locations"]},
            {"tokyo--japan", "seoul--south-korea", "seattle--usa"},
        )

    def test_bbox_narrows_the_clustered_set(self):
        response = self._activity_endpoint(zoom=6, bbox="100,-10,150,45")
        self.assertEqual(response["bbox"], [100.0, -10.0, 150.0, 45.0])
        self.assertTrue(response["locations"])
        for row in response["locations"]:
            self.assertTrue(100.0 <= row["lon"] <= 150.0)
            self.assertTrue(-10.0 <= row["lat"] <= 45.0)

    def test_malformed_bbox_degrades_to_the_full_set(self):
        response = self._activity_endpoint(zoom=6, bbox="nonsense")
        self.assertIsNone(response["bbox"])
        self.assertTrue(response["locations"])

    def test_cluster_rows_never_leak_media_or_actor_fields(self):
        response = self._activity_endpoint(zoom=6)
        forbidden = {"rel_path", "path", "filename", "folder", "_lat_sum", "_lon_sum", "_coord_count"}
        for row in response["locations"]:
            self.assertFalse(forbidden & set(row))
            self.assertLessEqual(len(row["sample_names"]), 3)

    def test_sub_city_cells_respect_the_k_anonymity_floor(self):
        rows = [
            {"slug": "a", "name": "A", "lat": 35.0, "lon": 139.0, "score": 5.0,
             "heat": 0.5, "active_reel_count": 1, "new_reel_count": 1},
            {"slug": "b", "name": "B", "lat": 35.01, "lon": 139.01, "score": 4.0,
             "heat": 0.4, "active_reel_count": 2, "new_reel_count": 0},
        ]
        # Precision 7 (~150 m cells): the two rows are ~1.3 km apart, so each
        # sub-city cell sits below the floor alone and is suppressed.
        suppressed = reels._cluster_activity_rows(rows, 7, min_reels=3)
        self.assertEqual(suppressed, [])
        # With the floor met (4 reels in one cell) the cell survives.
        rows[1]["lat"], rows[1]["lon"] = 35.0, 139.0
        rows[1]["active_reel_count"] = 3
        kept = reels._cluster_activity_rows(rows, 7, min_reels=3)
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["active_reel_count"], 4)
        # City-level cells are never throttled (already the published unit).
        city_level = reels._cluster_activity_rows(rows, 5, min_reels=3)
        self.assertTrue(city_level)

    def test_cluster_name_follows_the_hottest_member(self):
        rows = [
            {"slug": "cold", "name": "Cold Town", "lat": 10.0, "lon": 10.0, "score": 1.0,
             "heat": 0.1, "active_reel_count": 1, "new_reel_count": 0},
            {"slug": "hot", "name": "Hot City", "lat": 10.1, "lon": 10.1, "score": 9.0,
             "heat": 0.9, "active_reel_count": 2, "new_reel_count": 1},
        ]
        cells = reels._cluster_activity_rows(rows, 3)
        self.assertEqual(len(cells), 1)
        self.assertEqual(cells[0]["name"], "Hot City")
        self.assertEqual(cells[0]["primary_slug"], "hot")
        self.assertEqual(cells[0]["sample_names"], ["Cold Town", "Hot City"])


if __name__ == "__main__":
    unittest.main()
