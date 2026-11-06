import unittest

from server.routers import reels


class ReelLocationCoordsTest(unittest.TestCase):
    def test_seeded_city_gets_table_coordinates(self):
        stored = {"city": "Tokyo", "country": "Japan", "lat": None, "lon": None}
        loc = reels._location_with_coords(stored)
        self.assertEqual((loc["lat"], loc["lon"]), reels.CITY_COORDS["tokyo,japan"])
        self.assertEqual(loc["city"], "Tokyo")
        # The stored meta is not mutated.
        self.assertIsNone(stored["lat"])

    def test_missing_keys_are_filled_too(self):
        loc = reels._location_with_coords({"city": "Tokyo", "country": "Japan"})
        self.assertEqual((loc["lat"], loc["lon"]), reels.CITY_COORDS["tokyo,japan"])

    def test_unknown_city_keeps_no_coordinates(self):
        stored = {"city": "Nowhere", "country": "Atlantis", "lat": None, "lon": None}
        loc = reels._location_with_coords(stored)
        self.assertIsNone(loc["lat"])
        self.assertIsNone(loc["lon"])

    def test_real_coordinates_are_not_overwritten(self):
        loc = reels._location_with_coords({"city": "Tokyo", "country": "Japan", "lat": 35.01, "lon": 135.77})
        self.assertEqual((loc["lat"], loc["lon"]), (35.01, 135.77))

    def test_non_dict_passes_through(self):
        self.assertIsNone(reels._location_with_coords(None))


if __name__ == "__main__":
    unittest.main()
