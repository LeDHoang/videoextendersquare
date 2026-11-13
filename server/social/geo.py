"""Place helpers shared by the reels router and the recommender."""

from __future__ import annotations

import math
import re

# Static coordinates for the seeded LOCATION_POOL cities so proximity
# ranking works even when reels carry no per-reel lat/lon.
CITY_COORDS = {
    "austin,usa": (30.2672, -97.7431),
    "los angeles,usa": (34.0522, -118.2437),
    "new york,usa": (40.7128, -74.0060),
    "miami,usa": (25.7617, -80.1918),
    "chicago,usa": (41.8781, -87.6298),
    "seattle,usa": (47.6062, -122.3321),
    "london,uk": (51.5074, -0.1278),
    "manchester,uk": (53.4808, -2.2426),
    "paris,france": (48.8566, 2.3522),
    "berlin,germany": (52.5200, 13.4050),
    "tokyo,japan": (35.6762, 139.6503),
    "osaka,japan": (34.6937, 135.5023),
    "seoul,south korea": (37.5665, 126.9780),
    "bangkok,thailand": (13.7563, 100.5018),
    "singapore,singapore": (1.3521, 103.8198),
    "mumbai,india": (19.0760, 72.8777),
    "sydney,australia": (-33.8688, 151.2093),
    "toronto,canada": (43.6532, -79.3832),
    "mexico city,mexico": (19.4326, -99.1332),
    "são paulo,brazil": (-23.5505, -46.6333),
    "lagos,nigeria": (6.5244, 3.3792),
    "cairo,egypt": (30.0444, 31.2357),
    "nairobi,kenya": (-1.2921, 36.8219),
    "auckland,new zealand": (-36.8509, 174.7645),
}


def location_key(city: str, country: str) -> str:
    """Return the stable URL key for a city+country place."""
    city_slug = re.sub(r"[^\w]+|_+", "-", str(city or "").casefold()).strip("-")
    country_slug = re.sub(r"[^\w]+|_+", "-", str(country or "").casefold()).strip("-")
    if not city_slug:
        return ""
    return city_slug + ("--" + country_slug if country_slug else "")


def location_coords(city: str, country: str, lat=None, lon=None) -> tuple[float, float] | None:
    """Prefer per-reel coordinates, fall back to the static city table."""
    try:
        if lat is not None and lon is not None:
            return (float(lat), float(lon))
    except (TypeError, ValueError):
        pass
    lookup = (str(city or "").casefold().strip() + "," + str(country or "").casefold().strip())
    return CITY_COORDS.get(lookup)


def haversine_km(first: tuple[float, float], second: tuple[float, float]) -> float:
    lat1, lon1 = math.radians(first[0]), math.radians(first[1])
    lat2, lon2 = math.radians(second[0]), math.radians(second[1])
    delta_lat, delta_lon = lat2 - lat1, lon2 - lon1
    inner = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 2 * 6371.0 * math.asin(min(1.0, math.sqrt(inner)))
