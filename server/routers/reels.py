"""Reels router — output scan, filtering, H.264 proxy generation, time-synced comments,
and the full Reels/VR player page (replaces the Streamlit reels_view iframe)."""

import hashlib
import json
import math
import random
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from server import media as SM
from server.jobs import job_manager
from server.social.auth import AuthContext, ensure_anonymous_cookie, get_optional_auth, rate_limiter, request_identity, require_auth_csrf
from server.social.safety import unavailable_media_paths_for_viewer
from server.social.database import get_db
from server.social.models import Comment, EngagementEvent, Post, PostLike, PostSave, ViewDedup
from server.social.recommendations import RecommendationCursorError, actor_identity, get_reel_page
from server.social.services import get_post_by_reference, metadata_for_paths, reel_records, scoped_media_paths

router = APIRouter(prefix="/api/reels", tags=["reels"])

OUTPUT_DIR = Path("output")
COMMENTS_FILE = OUTPUT_DIR / "reels_comments.json"
META_FILE = OUTPUT_DIR / "reels_meta.json"
ASSETS_DIR = Path(__file__).resolve().parent.parent.parent / "ui" / "assets"
# Canonical frontend icon artwork — single source for both the React app
# (imported as components) and this player template (injected below).
ICON_DIR = (
    Path(__file__).resolve().parent.parent.parent
    / "web" / "src" / "components" / "icons" / "svg"
)

# Tiny mtime-checked cache for icon snippets (14 one-KB files; re-read only
# when something on disk actually changed).
_icon_cache: dict = {"sigs": {}, "snippets": {}}


def _icon_snippets() -> dict[str, str]:
    """Load {TOKEN_NAME: svg_markup} from the shared icons folder."""
    try:
        files = sorted(ICON_DIR.glob("*.svg"))
    except OSError:
        return {}
    sigs = {}
    for f in files:
        try:
            sigs[f.name] = f.stat().st_mtime
        except OSError:
            continue
    if sigs != _icon_cache["sigs"]:
        snippets = {}
        for f in files:
            try:
                # Collapse to one line: tokens also land inside single-quoted
                # JS strings (e.g. VIEW_SVG), where raw newlines would be a
                # syntax error. SVG is whitespace-insensitive.
                one_line = " ".join(f.read_text(encoding="utf-8").split())
                snippets[f.stem.upper().replace("-", "_")] = one_line
            except OSError:
                continue
        _icon_cache.update(sigs=sigs, snippets=snippets)
    return _icon_cache["snippets"]


def _inject_icons(html: str) -> str:
    """Replace __ICON_<NAME>__ tokens with shared SVG artwork.

    Runs on the raw template before script extraction so tokens in both the
    markup and the inline player JS resolve from the one icons folder.
    Unknown tokens are left untouched (fail-soft, never break the player).
    """
    for name, svg in _icon_snippets().items():
        html = html.replace(f"__ICON_{name}__", svg)
    return html

# Tiny in-process TTL cache for the output scan (rglob over output/ is cheap
# enough to re-run, but not on every keystroke of a search box).
_scan_cache: dict = {"at": 0.0, "data": []}
_SCAN_TTL = 10.0

RECENT_ACTIVITY_DEFAULT_DAYS = 7
RECENT_ACTIVITY_MAX_DAYS = 30
RECENT_ACTIVITY_HALF_LIFE_HOURS = 48.0
RECENT_ACTIVITY_POST_WEIGHT = 2.0
RECENT_ACTIVITY_VIEW_WEIGHT = 1.0
RECENT_ACTIVITY_COMMENT_WEIGHT = 3.0
RECENT_ACTIVITY_LIKE_WEIGHT = 3.0
RECENT_ACTIVITY_SAVE_WEIGHT = 4.0
RECENT_ACTIVITY_SHARE_WEIGHTS = {"share": 2.0, "share_sent": 5.0}

# Latest VR telemetry snapshot pushed by the in-headset WebXR render loop.
# CDP can't see the Quest tab during immersive VR, so the page POSTs here ~1Hz.
_diag: dict = {}


# ─── COMMENTS PERSISTENCE & SEED ENGINE ─────────────────────────────────

def _load_comments_raw() -> dict[str, list[dict]]:
    """Load all comments from output/reels_comments.json."""
    if not COMMENTS_FILE.exists():
        return {}
    try:
        data = json.loads(COMMENTS_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def _save_comments_raw(data: dict[str, list[dict]]) -> None:
    """Save all comments to output/reels_comments.json."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    COMMENTS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _generate_seed_comments(rel_path: str, filename: str) -> list[dict]:
    """Generate realistic seed comments covering:
    - Time-synced comments
    - Multiple concurrent comments at the exact same timestamp (e.g. t=3.0s)
    - Non-time-synced (general) comments
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    return [
        {
            "id": f"seed_{uuid.uuid4().hex[:8]}",
            "video_path": rel_path,
            "timestamp": 1.2,
            "author_name": "Kira_VR",
            "author_avatar": "🦊",
            "avatar_color": "#FF3B1F",
            "text": "The 4K spatial outpaint is super crisp! 🌟",
            "likes": 14,
            "created_at": now_iso,
        },
        {
            "id": f"seed_{uuid.uuid4().hex[:8]}",
            "video_path": rel_path,
            "timestamp": 3.0,
            "author_name": "CyberSamurai",
            "author_avatar": "⚡",
            "avatar_color": "#00FF88",
            "text": "Look at the lighting transition here 🔥",
            "likes": 28,
            "created_at": now_iso,
        },
        {
            "id": f"seed_{uuid.uuid4().hex[:8]}",
            "video_path": rel_path,
            "timestamp": 3.0,
            "author_name": "NeonRider",
            "author_avatar": "🚀",
            "avatar_color": "#00E5FF",
            "text": "Whoa that depth curvature is crazy in VR",
            "likes": 19,
            "created_at": now_iso,
        },
        {
            "id": f"seed_{uuid.uuid4().hex[:8]}",
            "video_path": rel_path,
            "timestamp": 6.5,
            "author_name": "AuraVibe",
            "author_avatar": "🌌",
            "avatar_color": "#A855F7",
            "text": "Quest 3 90fps feels like IMAX 🥽",
            "likes": 32,
            "created_at": now_iso,
        },
        {
            "id": f"seed_{uuid.uuid4().hex[:8]}",
            "video_path": rel_path,
            "timestamp": None,
            "author_name": "PixelNomad",
            "author_avatar": "👾",
            "avatar_color": "#FF9900",
            "text": "Master render quality is next level. Loving this player.",
            "likes": 9,
            "created_at": now_iso,
        },
        {
            "id": f"seed_{uuid.uuid4().hex[:8]}",
            "video_path": rel_path,
            "timestamp": None,
            "author_name": "EchoDev",
            "author_avatar": "💎",
            "avatar_color": "#FF0055",
            "text": "Spatial video extending algorithm v2.0 tested & verified.",
            "likes": 41,
            "created_at": now_iso,
        },
    ]


def _get_comments_for_video(rel_path: str, filename: str = "") -> list[dict]:
    """Retrieve comments from the social database with read-only JSON fallback."""
    key = rel_path.strip().replace(chr(92), "/")
    try:
        record = reel_records([key]).get(key)
        if record is not None:
            return record.get("comments", [])
    except Exception:
        pass

    all_comments = _load_comments_raw()
    if key in all_comments and isinstance(all_comments[key], list):
        return all_comments[key]
    for legacy_path, rows in all_comments.items():
        if Path(legacy_path).name == Path(rel_path).name and isinstance(rows, list):
            return rows
    return []


# ─── REEL METADATA (fake tags / location / engagement for future recsys) ──

META_FILE = OUTPUT_DIR / "reels_meta.json"

TAG_POOL = [
    "sci-fi", "music-video", "cyberpunk", "gaming", "concert", "anime",
    "cityscape", "lyric-video", "sports", "comedy", "nature", "tech",
    "dance", "cinematic", "retro", "neon", "live", "remix", "chill", "viral",
]

# Filename keyword hints → tags, applied before random fill.
TAG_HINTS = [
    ("tron", ["sci-fi", "neon"]),
    ("cyberpunk", ["cyberpunk", "neon"]),
    ("travis", ["concert", "music-video"]),
    ("lyric", ["lyric-video", "music-video"]),
    ("music", ["music-video"]),
    ("concert", ["concert", "live"]),
    ("weeknd", ["music-video", "cinematic"]),
    ("madonna", ["music-video", "retro"]),
    ("carti", ["music-video", "viral"]),
    ("king von", ["music-video", "viral"]),
    ("durk", ["music-video"]),
    ("drone", ["tech", "cinematic"]),
    ("ukraine", ["tech"]),
    ("game", ["gaming"]),
    ("anime", ["anime"]),
    ("dance", ["dance", "viral"]),
    ("sport", ["sports"]),
    ("comedy", ["comedy"]),
    ("funny", ["comedy", "viral"]),
    ("nature", ["nature", "chill"]),
    ("city", ["cityscape", "neon"]),
    ("retro", ["retro"]),
    ("live", ["live"]),
    ("remix", ["remix", "music-video"]),
]

# Global city/country pool.
LOCATION_POOL = [
    {"city": "Austin", "country": "USA"},
    {"city": "Los Angeles", "country": "USA"},
    {"city": "New York", "country": "USA"},
    {"city": "Miami", "country": "USA"},
    {"city": "Chicago", "country": "USA"},
    {"city": "Seattle", "country": "USA"},
    {"city": "London", "country": "UK"},
    {"city": "Manchester", "country": "UK"},
    {"city": "Paris", "country": "France"},
    {"city": "Berlin", "country": "Germany"},
    {"city": "Tokyo", "country": "Japan"},
    {"city": "Osaka", "country": "Japan"},
    {"city": "Seoul", "country": "South Korea"},
    {"city": "Bangkok", "country": "Thailand"},
    {"city": "Singapore", "country": "Singapore"},
    {"city": "Mumbai", "country": "India"},
    {"city": "Sydney", "country": "Australia"},
    {"city": "Toronto", "country": "Canada"},
    {"city": "Mexico City", "country": "Mexico"},
    {"city": "São Paulo", "country": "Brazil"},
    {"city": "Lagos", "country": "Nigeria"},
    {"city": "Cairo", "country": "Egypt"},
    {"city": "Nairobi", "country": "Kenya"},
    {"city": "Auckland", "country": "New Zealand"},
]

_CITY_TO_COUNTRY = {loc["city"]: loc["country"] for loc in LOCATION_POOL}


def _tag_slug(value: str) -> str:
    """Return the stable URL/search key for a user-facing tag."""
    cleaned = str(value or "").casefold().lstrip("#")
    return re.sub(r"[^\w]+|_+", "-", cleaned, flags=re.UNICODE).strip("-")


def _search_key(value: str) -> str:
    """Collapse punctuation so queries like sci fi match sci-fi."""
    return "".join(character for character in str(value or "").casefold() if character.isalnum())


def _safe_int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _metadata_snapshot(raw: list[dict]) -> dict[str, dict]:
    """Build metadata from the social database with legacy fallback."""
    persisted = _load_meta_raw()
    keys = [str(item.get("rel_path", "")).strip().replace(chr(92), "/") for item in raw]
    try:
        database_rows = metadata_for_paths(keys)
    except Exception:
        database_rows = {}
    snapshot: dict[str, dict] = {}
    for item in raw:
        key = str(item.get("rel_path", "")).strip().replace(chr(92), "/")
        entry = database_rows.get(key) or persisted.get(key)
        if not isinstance(entry, dict):
            seed = int(hashlib.md5(key.encode("utf-8")).hexdigest()[:8], 16)
            entry = _seed_meta(key, item.get("filename", ""), random.Random(seed))
        snapshot[key] = entry
    return snapshot


def _item_meta(item: dict, snapshot: dict[str, dict]) -> dict:
    key = str(item.get("rel_path", "")).strip().replace("\\", "/")
    return snapshot.get(key, {})


def _item_search_text(item: dict, meta: dict, include_tags: bool = True) -> str:
    location = meta.get("location") if isinstance(meta.get("location"), dict) else {}
    values = [
        item.get("filename", ""),
        item.get("folder", ""),
        meta.get("title", ""),
        meta.get("caption", ""),
        meta.get("author_name", ""),
        location.get("city", ""),
        location.get("country", ""),
        location.get("display_name", ""),
    ]
    if include_tags:
        values.extend(meta.get("tags", []))
    return " ".join(str(value) for value in values if value).casefold()


def _tag_catalog(raw: list[dict]) -> tuple[dict[str, dict], list[tuple[str, str, list[str]]]]:
    """Aggregate tag stats, co-occurrence, and searchable reel context."""
    snapshot = _metadata_snapshot(raw)
    catalog: dict[str, dict] = {}
    contexts: list[tuple[str, str, list[str]]] = []

    for item in raw:
        meta = _item_meta(item, snapshot)
        tag_pairs = []
        seen = set()
        for raw_tag in meta.get("tags", []):
            slug = _tag_slug(raw_tag)
            if not slug or slug in seen:
                continue
            seen.add(slug)
            name = str(raw_tag).strip().lstrip("#").casefold() or slug
            tag_pairs.append((slug, name))

        if not tag_pairs:
            continue

        views = _safe_int(meta.get("views"))
        likes = _safe_int(meta.get("likes"))
        is_image = _is_image_item(item)
        slugs = [slug for slug, _ in tag_pairs]
        context_text = _item_search_text(item, meta, include_tags=False)
        contexts.append((context_text, _search_key(context_text), slugs))

        for slug, name in tag_pairs:
            row = catalog.setdefault(slug, {
                "name": name,
                "slug": slug,
                "reel_count": 0,
                "views": 0,
                "likes": 0,
                "image_count": 0,
                "video_count": 0,
                "related": {},
            })
            row["reel_count"] += 1
            row["views"] += views
            row["likes"] += likes
            row["image_count" if is_image else "video_count"] += 1
            for other in slugs:
                if other != slug:
                    row["related"][other] = row["related"].get(other, 0) + 1

    return catalog, contexts


def _related_tag_rows(slug: str, catalog: dict[str, dict], limit: int = 5) -> list[dict]:
    row = catalog.get(slug, {})
    related = row.get("related", {})
    ranked = sorted(
        related.items(),
        key=lambda pair: (
            -pair[1],
            -catalog.get(pair[0], {}).get("reel_count", 0),
            pair[0],
        ),
    )[:limit]
    return [
        {
            "name": catalog[other]["name"],
            "slug": other,
            "shared_reels": shared,
            "reel_count": catalog[other]["reel_count"],
        }
        for other, shared in ranked
        if other in catalog
    ]


# ─── LOCATION EXPLORE ───────────────────────────────────────────────────

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


def _location_key(city: str, country: str) -> str:
    """Return the stable URL key for a city+country place."""
    city_slug = re.sub(r"[^\w]+|_+", "-", str(city or "").casefold()).strip("-")
    country_slug = re.sub(r"[^\w]+|_+", "-", str(country or "").casefold()).strip("-")
    if not city_slug:
        return ""
    return city_slug + ("--" + country_slug if country_slug else "")


def _location_coords(city: str, country: str, lat=None, lon=None) -> tuple[float, float] | None:
    """Prefer per-reel coordinates, fall back to the static city table."""
    try:
        if lat is not None and lon is not None:
            return (float(lat), float(lon))
    except (TypeError, ValueError):
        pass
    lookup = (str(city or "").casefold().strip() + "," + str(country or "").casefold().strip())
    return CITY_COORDS.get(lookup)


def _split_location_key(value: str) -> tuple[str, str]:
    """Split a location slug back into (city, country) for key comparison."""
    text = str(value or "")
    if "--" in text:
        city_part, _, country_part = text.rpartition("--")
        return (city_part.replace("-", " "), country_part.replace("-", " "))
    return (text.replace("-", " "), "")


def _item_location_key(video: dict, metadata: dict) -> str:
    meta = _item_meta(video, metadata)
    location = meta.get("location") if isinstance(meta.get("location"), dict) else {}
    return _location_key(location.get("city", ""), location.get("country", ""))


def _haversine_km(first: tuple[float, float], second: tuple[float, float]) -> float:
    lat1, lon1 = math.radians(first[0]), math.radians(first[1])
    lat2, lon2 = math.radians(second[0]), math.radians(second[1])
    delta_lat, delta_lon = lat2 - lat1, lon2 - lon1
    inner = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 2 * 6371.0 * math.asin(min(1.0, math.sqrt(inner)))


def _location_catalog(raw: list[dict]) -> dict[str, dict]:
    """Aggregate reel stats per city+country place."""
    snapshot = _metadata_snapshot(raw)
    catalog: dict[str, dict] = {}
    for item in raw:
        meta = _item_meta(item, snapshot)
        location = meta.get("location") if isinstance(meta.get("location"), dict) else {}
        city = str(location.get("city") or "").strip()
        country = str(location.get("country") or "").strip()
        key = _location_key(city, country)
        if not key:
            continue
        row = catalog.setdefault(key, {
            "name": (city + (", " + country if country else "")),
            "slug": key,
            "city": city,
            "country": country,
            "reel_count": 0,
            "views": 0,
            "likes": 0,
            "image_count": 0,
            "video_count": 0,
            "lat": None,
            "lon": None,
            "_lat_sum": 0.0,
            "_lon_sum": 0.0,
            "_coord_count": 0,
        })
        row["reel_count"] += 1
        row["views"] += _safe_int(meta.get("views"))
        row["likes"] += _safe_int(meta.get("likes"))
        row["image_count" if _is_image_item(item) else "video_count"] += 1
        coords = _location_coords(city, country, location.get("lat"), location.get("lon"))
        if coords:
            row["_lat_sum"] += coords[0]
            row["_lon_sum"] += coords[1]
            row["_coord_count"] += 1
    for row in catalog.values():
        if row["_coord_count"]:
            row["lat"] = row["_lat_sum"] / row["_coord_count"]
            row["lon"] = row["_lon_sum"] / row["_coord_count"]
        del row["_lat_sum"]
        del row["_lon_sum"]
        del row["_coord_count"]
    return catalog


def _related_location_rows(slug: str, catalog: dict[str, dict], limit: int = 5) -> list[dict]:
    current = catalog.get(slug, {})
    current_country = (current.get("country") or "").casefold()
    current_coords = (current.get("lat"), current.get("lon")) if current.get("lat") is not None else None

    def distance_to(other: dict) -> float | None:
        if not current_coords or other.get("lat") is None:
            return None
        return _haversine_km(current_coords, (other["lat"], other["lon"]))

    ranked = sorted(
        (row for key, row in catalog.items() if key != slug),
        key=lambda row: (
            0 if (row.get("country") or "").casefold() == current_country and current_country else 1,
            distance_to(row) if distance_to(row) is not None else float("inf"),
            -row.get("reel_count", 0),
            row.get("slug", ""),
        ),
    )[:limit]
    results = []
    for row in ranked:
        entry = {
            "name": row["name"],
            "slug": row["slug"],
            "reel_count": row["reel_count"],
            "same_country": bool(current_country and (row.get("country") or "").casefold() == current_country),
        }
        dist = distance_to(row)
        if dist is not None:
            entry["distance_km"] = round(dist)
        results.append(entry)
    return results


def _rank_location_catalog(catalog: dict[str, dict], q: str = "", limit: int = 8) -> list[dict]:
    query = str(q or "").casefold().strip()
    rows = list(catalog.values())
    if query:
        rows = [row for row in rows if query in (row["name"] or "").casefold()]
    rows.sort(key=lambda row: (-row["reel_count"], row["name"]))
    return [
        {key: row[key] for key in ("name", "slug", "city", "country", "reel_count", "views", "likes")}
        for row in rows[:max(1, min(int(limit), 20))]
    ]


def _bounded_activity_window(window_days: int | str | None) -> int:
    """Clamp public activity queries to a small, predictable time window."""
    try:
        requested = int(window_days or RECENT_ACTIVITY_DEFAULT_DAYS)
    except (TypeError, ValueError):
        requested = RECENT_ACTIVITY_DEFAULT_DAYS
    return max(1, min(requested, RECENT_ACTIVITY_MAX_DAYS))


def _as_utc_datetime(value) -> datetime | None:
    """Normalize database, ISO, and epoch timestamps for decay calculations."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, TypeError, ValueError):
            return None
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    return None


def _activity_decay(occurred_at, now: datetime | None = None) -> float:
    """Return a 48-hour half-life multiplier, capped at one for future clocks."""
    timestamp = _as_utc_datetime(occurred_at)
    current = _as_utc_datetime(now) or datetime.now(timezone.utc)
    if timestamp is None:
        return 0.0
    age_hours = max(0.0, (current - timestamp).total_seconds() / 3600.0)
    return math.pow(0.5, age_hours / RECENT_ACTIVITY_HALF_LIFE_HOURS)


def _recent_activity_by_path(
    db: Session,
    raw: list[dict],
    window_days: int | str | None = RECENT_ACTIVITY_DEFAULT_DAYS,
    now: datetime | None = None,
) -> dict[str, dict]:
    """Score recent positive activity per media path without exposing actors."""
    days = _bounded_activity_window(window_days)
    current = _as_utc_datetime(now) or datetime.now(timezone.utc)
    cutoff = current - timedelta(days=days)
    paths = [str(item.get("rel_path") or "").strip().replace("\\", "/") for item in raw]
    paths = [path for path in paths if path]
    result = {
        path: {"score": 0.0, "is_new": False, "active": False, "last_activity_at": None}
        for path in paths
    }
    if not paths:
        return result

    posts = (
        db.query(Post)
        .filter(
            Post.media_path.in_(paths),
            Post.status == "published",
            Post.deleted_at.is_(None),
        )
        .all()
    )
    posts_by_path = {post.media_path: post for post in posts}
    paths_by_post = {post.id: post.media_path for post in posts}

    def add(path: str | None, weight: float, occurred_at) -> None:
        if not path or path not in result:
            return
        timestamp = _as_utc_datetime(occurred_at)
        if timestamp is None or timestamp < cutoff:
            return
        contribution = float(weight) * _activity_decay(timestamp, current)
        if contribution <= 0.0:
            return
        entry = result[path]
        entry["score"] += contribution
        entry["active"] = True
        previous = entry["last_activity_at"]
        if previous is None or timestamp > previous:
            entry["last_activity_at"] = timestamp

    for item in raw:
        path = str(item.get("rel_path") or "").strip().replace("\\", "/")
        post = posts_by_path.get(path)
        published_at = _as_utc_datetime(post.created_at if post is not None else None)
        if published_at is None:
            published_at = _as_utc_datetime(item.get("mtime"))
        if published_at is not None and published_at >= cutoff:
            add(path, RECENT_ACTIVITY_POST_WEIGHT, published_at)
            result[path]["is_new"] = True

    post_ids = list(paths_by_post)
    if not post_ids:
        return result

    for row in db.query(ViewDedup).filter(
        ViewDedup.post_id.in_(post_ids), ViewDedup.created_at >= cutoff
    ).all():
        add(paths_by_post.get(row.post_id), RECENT_ACTIVITY_VIEW_WEIGHT, row.created_at)
    for row in db.query(PostLike).filter(
        PostLike.post_id.in_(post_ids), PostLike.created_at >= cutoff
    ).all():
        add(paths_by_post.get(row.post_id), RECENT_ACTIVITY_LIKE_WEIGHT, row.created_at)
    for row in db.query(Comment).filter(
        Comment.post_id.in_(post_ids),
        Comment.created_at >= cutoff,
        Comment.deleted_at.is_(None),
    ).all():
        add(paths_by_post.get(row.post_id), RECENT_ACTIVITY_COMMENT_WEIGHT, row.created_at)
    for row in db.query(PostSave).filter(
        PostSave.post_id.in_(post_ids), PostSave.created_at >= cutoff
    ).all():
        add(paths_by_post.get(row.post_id), RECENT_ACTIVITY_SAVE_WEIGHT, row.created_at)
    for row in db.query(EngagementEvent).filter(
        EngagementEvent.post_id.in_(post_ids),
        EngagementEvent.event_type.in_(tuple(RECENT_ACTIVITY_SHARE_WEIGHTS)),
        EngagementEvent.created_at >= cutoff,
    ).all():
        occurred_at = row.client_occurred_at or row.created_at
        weight = RECENT_ACTIVITY_SHARE_WEIGHTS.get(str(row.event_type or "").casefold())
        if weight is not None:
            add(paths_by_post.get(row.post_id), weight, occurred_at)
    return result


def _location_activity_rows(
    raw: list[dict],
    activity_by_path: dict[str, dict],
    metadata: dict[str, dict] | None = None,
    limit: int = 128,
) -> list[dict]:
    """Aggregate activity into privacy-safe city centroids and normalized heat."""
    snapshot = metadata if metadata is not None else _metadata_snapshot(raw)
    catalog: dict[str, dict] = {}
    for item in raw:
        path = str(item.get("rel_path") or "").strip().replace("\\", "/")
        activity = activity_by_path.get(path) or {}
        score = max(0.0, float(activity.get("score") or 0.0))
        if score <= 0.0:
            continue
        meta = _item_meta(item, snapshot)
        location = meta.get("location") if isinstance(meta.get("location"), dict) else {}
        city = str(location.get("city") or "").strip()
        country = str(location.get("country") or "").strip()
        slug = _location_key(city, country)
        coords = _location_coords(city, country, location.get("lat"), location.get("lon"))
        if not slug or coords is None:
            continue
        row = catalog.setdefault(slug, {
            "slug": slug,
            "name": city + ((", " + country) if country else ""),
            "city": city,
            "country": country,
            "active_reel_count": 0,
            "new_reel_count": 0,
            "score": 0.0,
            "_lat_sum": 0.0,
            "_lon_sum": 0.0,
            "_coord_count": 0,
        })
        row["active_reel_count"] += 1
        row["new_reel_count"] += 1 if activity.get("is_new") else 0
        row["score"] += score
        row["_lat_sum"] += coords[0]
        row["_lon_sum"] += coords[1]
        row["_coord_count"] += 1

    rows = list(catalog.values())
    scores = sorted(row["score"] for row in rows if row["score"] > 0.0)
    p95 = scores[max(0, math.ceil(len(scores) * 0.95) - 1)] if scores else 0.0
    heat_denominator = math.log1p(p95) if p95 > 0.0 else 1.0
    for row in rows:
        count = max(1, row.pop("_coord_count"))
        row["lat"] = round(row.pop("_lat_sum") / count, 6)
        row["lon"] = round(row.pop("_lon_sum") / count, 6)
        row["score"] = round(row["score"], 6)
        row["heat"] = round(min(1.0, math.log1p(row["score"]) / heat_denominator), 6)
    rows.sort(key=lambda row: (-row["score"], row["name"]))
    return rows[:max(1, min(int(limit), 128))]


def _rank_tag_catalog(
    catalog: dict[str, dict],
    contexts: list[tuple[str, str, list[str]]],
    query: str,
    limit: int,
) -> list[dict]:
    """Rank direct tag matches plus tags attached to matching reel names.

    This deliberately exposes simple, inspectable signals. It is the baseline
    that a later recommendation model can replace without changing the UI/API
    contract.
    """
    query_text = str(query or "").strip().casefold().lstrip("#")
    query_key = _search_key(query_text)
    scores: dict[str, int] = {}
    reasons: dict[str, str] = {}

    if query_key:
        for slug, row in catalog.items():
            tag_key = _search_key(row["name"])
            if query_key == tag_key:
                scores[slug] = 1000
                reasons[slug] = "EXACT TAG"
            elif tag_key.startswith(query_key):
                scores[slug] = 760
                reasons[slug] = "TAG PREFIX"
            elif query_key in tag_key:
                scores[slug] = 560
                reasons[slug] = "TAG MATCH"

        if len(query_key) >= 2:
            # Existing filename hints double as transparent name-to-tag aliases.
            for keyword, hinted_tags in TAG_HINTS:
                keyword_key = _search_key(keyword)
                if query_key in keyword_key or keyword_key in query_key:
                    for hinted in hinted_tags:
                        slug = _tag_slug(hinted)
                        if slug in catalog:
                            scores[slug] = max(scores.get(slug, 0), 680)
                            reasons.setdefault(slug, "RELATED NAME")

            # A query that matches a reel title, filename, creator, or place
            # lends relevance to every tag attached to that reel.
            for context_text, context_key, slugs in contexts:
                if query_text in context_text or query_key in context_key:
                    for slug in slugs:
                        scores[slug] = scores.get(slug, 0) + 120
                        reasons.setdefault(slug, "RELATED CONTENT")
    else:
        for slug, row in catalog.items():
            scores[slug] = row["reel_count"] * 20 + min(row["views"] // 1000, 200)
            reasons[slug] = "POPULAR"

    ranked_slugs = sorted(
        (slug for slug, score in scores.items() if score > 0),
        key=lambda slug: (
            -scores[slug],
            -catalog[slug]["reel_count"],
            -catalog[slug]["views"],
            slug,
        ),
    )[:limit]

    results = []
    for slug in ranked_slugs:
        row = catalog[slug]
        results.append({
            **{key: value for key, value in row.items() if key != "related"},
            "score": scores[slug],
            "reason": reasons[slug],
            "related_tags": _related_tag_rows(slug, catalog, limit=3),
        })
    return results


def _load_meta_raw() -> dict[str, dict]:
    """Load all reel metadata from output/reels_meta.json."""
    if not META_FILE.exists():
        return {}
    try:
        data = json.loads(META_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def _save_meta_raw(data: dict[str, dict]) -> None:
    """Save all reel metadata to output/reels_meta.json."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    META_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _seed_meta(rel_path: str, filename: str, rng: random.Random) -> dict:
    """Generate fake metadata: 2–4 tags (filename hints + random fill),
    one global city/country location, and plausible engagement numbers."""
    lowered = (filename or "").lower()
    tags: list[str] = []
    for keyword, hinted in TAG_HINTS:
        if keyword in lowered:
            for t in hinted:
                if t not in tags:
                    tags.append(t)
        if len(tags) >= 4:
            break
    pool = [t for t in TAG_POOL if t not in tags]
    rng.shuffle(pool)
    while len(tags) < 2 and pool:
        tags.append(pool.pop())
    while len(tags) < 4 and pool and rng.random() < 0.6:
        tags.append(pool.pop())
    likes = rng.randint(50, 5000)
    views = likes * rng.randint(8, 25)
    loc = rng.choice(LOCATION_POOL)
    return {
        "tags": tags[:4],
        "location": {"city": loc["city"], "country": loc["country"]},
        "likes": likes,
        "views": views,
        "liked_by_me": False,
    }


def _get_meta_for_video(rel_path: str, filename: str = "") -> dict:
    """Retrieve database metadata with read-only legacy JSON fallback."""
    key = rel_path.strip().replace(chr(92), "/")
    try:
        record = metadata_for_paths([key]).get(key)
        if record is not None:
            return record
    except Exception:
        pass

    all_meta = _load_meta_raw()
    if key in all_meta and isinstance(all_meta[key], dict):
        entry = dict(all_meta[key])
        entry.setdefault("tags", [])
        entry.setdefault("title", "")
        entry.setdefault("caption", "")
        entry.setdefault("author_name", "")
        entry.setdefault("source", "")
        entry.setdefault("created_at", "")
        loc = entry.get("location")
        if not isinstance(loc, dict):
            loc = {}
            entry["location"] = loc
        loc.setdefault("city", "")
        if not loc.get("country"):
            loc["country"] = _CITY_TO_COUNTRY.get(loc.get("city", ""), "")
        loc.pop("county", None)
        loc.setdefault("display_name", "")
        loc.setdefault("lat", None)
        loc.setdefault("lon", None)
        loc.setdefault("osm_id", None)
        entry.setdefault("likes", 0)
        entry.setdefault("views", 0)
        entry["liked_by_me"] = False
        return entry
    seed = int(hashlib.md5(key.encode("utf-8")).hexdigest()[:8], 16)
    return _seed_meta(key, filename, random.Random(seed))


def upsert_upload_meta(rel_path: str, meta: dict) -> dict:
    """Persist real user-supplied metadata for an uploaded reel.

    Unlike the fake seeding in _get_meta_for_video, this writes the user's
    title/caption/tags/location verbatim (plus zeroed engagement counters)
    so the new item never gets random likes/views/tags. Invalidates the
    output scan cache so the item appears in feeds immediately.
    """
    key = rel_path.strip().replace("\\", "/")
    all_meta = _load_meta_raw()
    entry = {
        "title": str(meta.get("title", ""))[:100],
        "caption": str(meta.get("caption", ""))[:2200],
        "tags": list(meta.get("tags", []))[:5],
        "location": {
            "city": str((meta.get("location") or {}).get("city", ""))[:120],
            "country": str((meta.get("location") or {}).get("country", ""))[:120],
            "display_name": str((meta.get("location") or {}).get("display_name", ""))[:300],
            "lat": (meta.get("location") or {}).get("lat"),
            "lon": (meta.get("location") or {}).get("lon"),
            "osm_id": (meta.get("location") or {}).get("osm_id"),
        },
        "author_name": str(meta.get("author_name", "local_user"))[:60] or "local_user",
        "source": str(meta.get("source", "upload"))[:20],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "likes": 0,
        "views": 0,
        "liked_by_me": False,
    }
    all_meta[key] = entry
    _save_meta_raw(all_meta)
    invalidate_scan_cache()
    return entry


def invalidate_scan_cache() -> None:
    """Force the next reels query to re-scan output/ from disk."""
    _scan_cache["at"] = 0.0


# ─── Pydantic Models for Comments API ────────────────────────────────────

class CommentCreate(BaseModel):
    video_path: str
    timestamp: float | None = None
    text: str
    # Retained only for wire compatibility. Identity comes from the session.
    author_name: str | None = None
    author_avatar: str | None = None
    avatar_color: str | None = None


# ─── SCAN & FILTER ───────────────────────────────────────────────────────

def _scan_cached() -> list[dict]:
    now = time.monotonic()
    if now - _scan_cache["at"] > _SCAN_TTL or not _scan_cache["data"]:
        _scan_cache["at"] = now
        _scan_cache["data"] = SM.scan_output_media(str(OUTPUT_DIR))
    return _scan_cache["data"]


def _is_image_item(item: dict) -> bool:
    if item.get("media_type") == "image":
        return True
    return Path(item.get("filename", "")).suffix.lstrip(".").lower() in SM.IMAGE_EXTS


def _apply_filters(raw: list[dict], folder: str | None, search: str,
                   sort: str, media: str | None = None,
                   tag: str | None = None, location: str | None = None,
                   recent_activity: dict[str, dict] | None = None) -> list[dict]:
    videos = list(raw)
    metadata = None
    if media in ("video", "videos"):
        videos = [v for v in videos if not _is_image_item(v)]
    elif media in ("image", "images"):
        videos = [v for v in videos if _is_image_item(v)]
    if folder and folder != "ALL FOLDERS":
        videos = [v for v in videos if v["folder"] == folder]
    if tag and _tag_slug(tag):
        wanted = _tag_slug(tag)
        metadata = _metadata_snapshot(videos)
        videos = [
            video
            for video in videos
            if wanted in {
                _tag_slug(item_tag)
                for item_tag in _item_meta(video, metadata).get("tags", [])
            }
        ]
    if location and _location_key(*_split_location_key(location)):
        wanted_loc = _location_key(*_split_location_key(location))
        metadata = metadata or _metadata_snapshot(videos)
        videos = [video for video in videos if _item_location_key(video, metadata) == wanted_loc]
    if search.strip():
        query_text = search.strip().casefold().lstrip("#")
        query_key = _search_key(query_text)
        metadata = metadata or _metadata_snapshot(videos)
        videos = [
            video
            for video in videos
            if query_text in _item_search_text(video, _item_meta(video, metadata))
            or (query_key and query_key in _search_key(_item_search_text(video, _item_meta(video, metadata))))
        ]
    if sort == "oldest":
        videos.sort(key=lambda x: x["mtime"])
    elif sort == "alphabetical":
        videos.sort(key=lambda x: x["filename"].lower())
    elif sort == "shuffle":
        r = random.Random(int(time.time()) // 60)
        r.shuffle(videos)
    elif sort == "recent_trending":
        activity = recent_activity or {}

        def _recent_score(item: dict) -> tuple[float, float]:
            row = activity.get(item.get("rel_path", "")) or {}
            return (
                float(row.get("score") or 0.0),
                float(item.get("mtime") or 0.0),
            )

        videos.sort(key=_recent_score, reverse=True)
    elif sort in ("views", "likes", "trending"):
        metadata = metadata or _metadata_snapshot(videos)

        def _engagement(item: dict) -> tuple[int, float]:
            meta = _item_meta(item, metadata)
            views = _safe_int(meta.get("views"))
            likes = _safe_int(meta.get("likes"))
            if sort == "views":
                score = views
            elif sort == "likes":
                score = likes
            else:
                score = views + likes * 20
            return score, float(item.get("mtime", 0))

        videos.sort(key=_engagement, reverse=True)
    else:
        videos.sort(key=lambda x: x["mtime"], reverse=True)
    return videos


def _codec_key(codec: str | None) -> str:
    return (codec or "hevc").lower()


def _sibling_media_url(play_path: str, sibling: Path) -> str | None:
    """Reference a cached sibling file (<stem>-explore.mp4 / -poster.jpg) as
    a /media/ URL if present and fresh, else None."""
    try:
        if sibling.exists() and sibling.stat().st_size > 0:
            try:
                fresh = sibling.stat().st_mtime >= Path(play_path).stat().st_mtime
            except OSError:
                fresh = True
            if fresh:
                prel = sibling.resolve().relative_to(OUTPUT_DIR.resolve()).as_posix()
                return f"/media/{prel}"
    except (OSError, ValueError):
        pass
    return None


def _build_payload(
    videos: list[dict],
    codec: str | None,
    tunnel: str = "",
    viewer_id: str | None = None,
) -> list[dict]:
    """Map scanned media to the reels player payload (relative /media/ URLs),
    including embedded time-synced and general comments.

    Video items keep the codec-aware proxy logic; image items (single image
    tiles) serve the original file directly with a lightweight poster thumb.
    """
    mode = _codec_key(codec)
    payload = []
    paths = [item["rel_path"] for item in videos]
    try:
        social_rows = reel_records(paths, viewer_id=viewer_id)
    except Exception:
        social_rows = {}
    for item in videos:
        src_path = item["path"]
        social_row = social_rows.get(item["rel_path"])
        comments = (
            social_row.get("comments", [])
            if social_row is not None
            else _get_comments_for_video(item["rel_path"], item["filename"])
        )
        meta = social_row or _get_meta_for_video(item["rel_path"], item["filename"])
        loc = meta.get("location", {"city": "", "country": ""})
        base = {
            "post_id": meta.get("post_id"),
            "tags": meta.get("tags", []),
            "title": meta.get("title", ""),
            "caption": meta.get("caption", ""),
            "author_name": meta.get("author_name", ""),
            "author_avatar": meta.get("author_avatar", "👤"),
            "author_avatar_url": meta.get("author_avatar_url"),
            "creator": meta.get("creator"),
            "viewer_state": meta.get("viewer_state", {
                "liked": False,
                "saved": False,
                "following_creator": False,
                "can_edit": False,
            }),
            "source": meta.get("source", ""),
            "created_at": meta.get("created_at", ""),
            "location": loc,
            "likes": meta.get("likes", 0),
            "views": meta.get("views", 0),
            "saves": meta.get("saves", 0),
            "liked_by_me": bool(meta.get("liked_by_me", False)),
            "saved_by_me": bool(meta.get("saved_by_me", False)),
            "filename": item["filename"],
            "folder": item["folder"],
            "size": item["size_human"],
            "path": item["rel_path"],
            "tunnel_url": tunnel.strip(),
            "comments": comments,
        }


        if _is_image_item(item):
            # Single image tile: no codec/proxy/transcode needed.
            try:
                rel = Path(src_path).resolve().relative_to(OUTPUT_DIR.resolve()).as_posix()
            except (OSError, ValueError):
                continue
            poster_url = _sibling_media_url(src_path, SM.explore_poster_path(src_path))
            payload.append({
                **base,
                "media_type": "image",
                "url": f"/media/{rel}",
                "preview_url": f"/media/{rel}",
                "poster_url": poster_url or f"/media/{rel}",
                "codec": "IMG",
                "is_proxy": False,
                "stream_tag": "IMAGE",
            })
            continue

        codec_name = SM.get_video_codec(src_path)
        play_path = src_path
        is_proxy = False

        if mode in ("h264", "all"):
            if codec_name not in {"h264", "avc1"}:
                preview_p = Path(src_path).with_name(Path(src_path).stem + "-preview.mp4")
                if preview_p.exists() and preview_p.stat().st_size > 0:
                    play_path = str(preview_p)
                    is_proxy = True

        rel = Path(play_path).resolve().relative_to(OUTPUT_DIR.resolve()).as_posix()
        play_codec = SM.get_video_codec(play_path)

        # Lightweight Explore-grid assets: reference the cached
        # <stem>-explore.mp4 / <stem>-poster.jpg if present and fresh, else
        # None (the grid generates them via POST /explore-preview).
        preview_url = _sibling_media_url(play_path, SM.explore_preview_path(play_path))
        poster_url = _sibling_media_url(play_path, SM.explore_poster_path(play_path))

        payload.append({
            **base,
            "media_type": "video",
            "url": f"/media/{rel}",
            "preview_url": preview_url,
            "poster_url": poster_url,
            "codec": play_codec.upper(),
            "is_proxy": is_proxy,
            "stream_tag": "H.264 4K PROXY" if is_proxy else f"{codec_name.upper()} MASTER",
        })
    return payload


def _recommendation_feed_data(
    *,
    request: Request,
    response: Response,
    db: Session,
    viewer: AuthContext | None,
    surface: str | None = None,
    folder: str | None = None,
    codec: str | None = "hevc",
    search: str = "",
    sort: str = "for_you",
    window_days: int = RECENT_ACTIVITY_DEFAULT_DAYS,
    tunnel: str = "",
    refresh: bool = False,
    media: str | None = None,
    tag: str | None = None,
    location: str | None = None,
    feed: str | None = None,
    author: str | None = None,
    post: str | None = None,
    cursor: str | None = None,
    limit: int = 12,
) -> dict:
    """Build one stable materialized feed page and hydrate its media payload."""
    if refresh:
        _scan_cache["at"] = 0.0
    viewer_id = viewer.user.id if isinstance(viewer, AuthContext) else None
    requested_surface = (surface or "").strip().casefold()
    if post or requested_surface == "related":
        requested_surface = "related"
    elif feed == "following" or requested_surface == "following":
        requested_surface = "following"
    elif requested_surface in {"", "discover", "for_you"}:
        requested_surface = "for_you"
    else:
        raise HTTPException(
            status_code=422,
            detail={"code": "INVALID_FEED", "message": "Surface must be for_you, following, or related."},
        )
    if requested_surface == "following" and not viewer_id:
        raise HTTPException(
            status_code=401,
            detail={"code": "AUTH_REQUIRED", "message": "Sign in to view your Following feed."},
        )

    hidden_paths = unavailable_media_paths_for_viewer(viewer_id)
    raw = [item for item in _scan_cached() if item["rel_path"] not in hidden_paths]
    activity_days = _bounded_activity_window(window_days)
    recent_activity = _recent_activity_by_path(db, raw, activity_days) if sort == "recent_trending" else None

    seed_post = get_post_by_reference(db, post_id=post) if post else None
    if post and not seed_post:
        raise HTTPException(
            status_code=404,
            detail={"code": "POST_NOT_FOUND", "message": "Reel not found."},
        )
    if requested_surface == "related":
        videos = _apply_filters(raw, folder, "", "newest", media)
        if seed_post and seed_post.media_path not in {video["rel_path"] for video in videos}:
            seed_video = next((video for video in raw if video["rel_path"] == seed_post.media_path), None)
            if seed_video:
                videos.insert(0, seed_video)
    else:
        videos = _apply_filters(
            raw,
            folder,
            search,
            sort,
            media,
            tag,
            location,
            recent_activity=recent_activity,
        )

    scoped_paths = scoped_media_paths(viewer_id=viewer_id, feed=feed, author=author)
    if scoped_paths is not None and requested_surface != "related":
        positions = {value: index for index, value in enumerate(scoped_paths)}
        videos = [video for video in videos if video["rel_path"] in positions]
        videos.sort(key=lambda video: positions[video["rel_path"]])

    paths = [video["rel_path"] for video in videos]
    path_to_post_id = {
        media_path: post_id
        for media_path, post_id in db.query(Post.media_path, Post.id)
        .filter(Post.media_path.in_(paths) if paths else False)
        .all()
    }
    allowed_post_ids = set(path_to_post_id.values())
    explicit_scope = bool(search.strip() or tag or location or author)
    personalized = requested_surface == "for_you" and sort in {"for_you", "personalized"} and not explicit_scope
    manual_order = None
    if requested_surface == "for_you" and not personalized:
        manual_order = [path_to_post_id[path] for path in paths if path in path_to_post_id]

    anonymous_hash = ensure_anonymous_cookie(request, response)
    actor = actor_identity(viewer_id, None if viewer_id else anonymous_hash)
    feed_filters = {
        "folder": folder or "",
        "codec": _codec_key(codec),
        "search": search.strip(),
        "sort": sort,
        "media": media or "all",
        "window_days": activity_days,
        "tag": _tag_slug(tag) if tag else "",
        "location": location or "",
        "feed": feed or "",
        "author": author or "",
        "post": post or "",
    }
    try:
        page = get_reel_page(
            db,
            actor=actor,
            surface=requested_surface,
            seed_post_id=seed_post.id if seed_post else None,
            allowed_post_ids=allowed_post_ids,
            manual_order=manual_order,
            filters=feed_filters,
            cursor=cursor,
            limit=limit,
        )
    except RecommendationCursorError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "INVALID_CURSOR", "message": str(exc), "field": "cursor"},
        ) from exc

    post_id_to_video = {
        path_to_post_id[video["rel_path"]]: video
        for video in videos
        if video["rel_path"] in path_to_post_id
    }
    selected_videos = [
        post_id_to_video[item.target_id]
        for item in page.items
        if item.target_id in post_id_to_video
    ]
    hydrated = _build_payload(selected_videos, codec, tunnel=tunnel, viewer_id=viewer_id)
    payload_by_post = {item.get("post_id"): item for item in hydrated if item.get("post_id")}
    items = []
    for recommendation in page.items:
        item = payload_by_post.get(recommendation.target_id)
        if not item:
            continue
        item["recommendation"] = {
            "impression_id": recommendation.impression_id,
            "position": recommendation.position,
            "reason_key": recommendation.reason_key,
        }
        items.append(item)
    return {
        "surface": requested_surface,
        "session_id": page.session_id,
        "request_id": page.request_id,
        "algorithm_version": page.algorithm_version,
        "items": items,
        "next_cursor": page.next_cursor,
        "has_more": page.has_more,
        "restarted": page.restarted,
        "total_eligible": len(videos),
        "feed_params": {
            "surface": requested_surface,
            "folder": folder,
            "codec": codec,
            "search": search,
            "sort": sort,
            "tunnel": tunnel,
            "window_days": activity_days,
            "media": media,
            "tag": tag,
            "location": location,
            "feed": feed,
            "author": author,
            "post": post,
            "limit": max(1, min(int(limit), 24)),
        },
    }


@router.get("")
def list_reels(
    folder: str | None = None,
    codec: str | None = "hevc",
    search: str = "",
    sort: str = "newest",
    window_days: int = RECENT_ACTIVITY_DEFAULT_DAYS,
    refresh: bool = False,
    media: str | None = None,
    tag: str | None = None,
    location: str | None = None,
    feed: str | None = None,
    author: str | None = None,
    post: str | None = None,
    viewer: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    """Scan output dir and return the filtered, codec-aware reels list.

    media: all (default) | video | image — lets callers filter to one kind.
    """
    if refresh:
        _scan_cache["at"] = 0.0
    hidden_paths = unavailable_media_paths_for_viewer(viewer.user.id if isinstance(viewer, AuthContext) else None)
    raw = [item for item in _scan_cached() if item["rel_path"] not in hidden_paths]
    viewer_id = viewer.user.id if isinstance(viewer, AuthContext) else None
    recent_activity = _recent_activity_by_path(db, raw, window_days) if sort == "recent_trending" else None

    if post:
        target = get_post_by_reference(db, post_id=post)
        videos = [item for item in raw if target and item["rel_path"] == target.media_path]
        if not videos:
            raise HTTPException(status_code=404, detail={"code": "POST_NOT_FOUND", "message": "Reel not found."})
    else:
        videos = _apply_filters(
            raw,
            folder,
            search,
            sort,
            media,
            tag,
            location,
            recent_activity=recent_activity,
        )
    scoped_paths = scoped_media_paths(
        viewer_id=viewer.user.id if isinstance(viewer, AuthContext) else None,
        feed=feed,
        author=author,
    )
    if feed == "following" and not isinstance(viewer, AuthContext):
        raise HTTPException(status_code=401, detail={"code": "AUTH_REQUIRED", "message": "Sign in to view your Following feed."})
    if scoped_paths is not None and not post:
        positions = {value: index for index, value in enumerate(scoped_paths)}
        videos = [video for video in videos if video["rel_path"] in positions]
        videos.sort(key=lambda video: positions[video["rel_path"]])
    return {
        "total": len(raw),
        "count": len(videos),
        "folders": sorted({v["folder"] for v in raw}),
        "active_tag": _tag_slug(tag) if tag else None,
        "videos": _build_payload(videos, codec, viewer_id=viewer_id),
    }


@router.get("/feed")
def reels_feed(
    request: Request,
    response: Response,
    surface: str = "for_you",
    folder: str | None = None,
    codec: str | None = "hevc",
    search: str = "",
    sort: str = "for_you",
    window_days: int = RECENT_ACTIVITY_DEFAULT_DAYS,
    tunnel: str = "",
    refresh: bool = False,
    media: str | None = None,
    tag: str | None = None,
    location: str | None = None,
    feed: str | None = None,
    author: str | None = None,
    post: str | None = None,
    cursor: str | None = None,
    limit: int = 12,
    viewer: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    limiter_key = viewer.user.id if isinstance(viewer, AuthContext) else f"ip:{request_identity(request)}"
    rate_limiter.check(db, f"rec-feed:{limiter_key}", 60, 60)
    return _recommendation_feed_data(
        request=request,
        response=response,
        db=db,
        viewer=viewer,
        surface=surface,
        folder=folder,
        codec=codec,
        search=search,
        sort=sort,
        tunnel=tunnel,
        window_days=window_days,
        refresh=refresh,
        media=media,
        tag=tag,
        location=location,
        feed=feed,
        author=author,
        post=post,
        cursor=cursor,
        limit=limit,
    )


@router.get("/tags")
def list_reel_tags(q: str = "", limit: int = 8):
    """Return ranked tag suggestions for header search and discovery UI."""
    bounded_limit = max(1, min(int(limit), 20))
    hidden_paths = unavailable_media_paths_for_viewer(None)
    catalog, contexts = _tag_catalog([item for item in _scan_cached() if item["rel_path"] not in hidden_paths])
    return {
        "query": q,
        "strategy": "metadata-v1",
        "tags": _rank_tag_catalog(catalog, contexts, q, bounded_limit),
    }


@router.get("/tags/{tag_name}")
def get_reel_tag(
    tag_name: str,
    codec: str | None = "hevc",
    sort: str = "trending",
    window_days: int = RECENT_ACTIVITY_DEFAULT_DAYS,
    folder: str | None = None,
    refresh: bool = False,
    viewer: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    """Return one exact tag feed plus stats and co-occurring tags."""
    slug = _tag_slug(tag_name)
    if not slug:
        raise HTTPException(status_code=400, detail="Tag cannot be empty")
    if refresh:
        _scan_cache["at"] = 0.0

    hidden_paths = unavailable_media_paths_for_viewer(viewer.user.id if isinstance(viewer, AuthContext) else None)
    raw = [item for item in _scan_cached() if item["rel_path"] not in hidden_paths]
    catalog, _ = _tag_catalog(raw)
    recent_activity = _recent_activity_by_path(db, raw, window_days) if sort == "recent_trending" else None
    videos = _apply_filters(raw, folder, "", sort, tag=slug, recent_activity=recent_activity)
    row = catalog.get(slug, {
        "name": slug,
        "slug": slug,
        "reel_count": 0,
        "views": 0,
        "likes": 0,
        "image_count": 0,
        "video_count": 0,
        "related": {},
    })
    tag_summary = {key: value for key, value in row.items() if key != "related"}
    return {
        "strategy": "cooccurrence-v1",
        "tag": tag_summary,
        "count": len(videos),
        "total": len(raw),
        "folders": sorted({video["folder"] for video in videos}),
        "related_tags": _related_tag_rows(slug, catalog),
        "videos": _build_payload(videos, codec, viewer_id=viewer.user.id if isinstance(viewer, AuthContext) else None),
    }


@router.get("/locations")
def list_reel_locations(q: str = "", limit: int = 8):
    """Return ranked location suggestions for discovery UI."""
    bounded_limit = max(1, min(int(limit), 20))
    hidden_paths = unavailable_media_paths_for_viewer(None)
    catalog = _location_catalog([item for item in _scan_cached() if item["rel_path"] not in hidden_paths])
    return {
        "query": q,
        "strategy": "reel-count-v1",
        "locations": _rank_location_catalog(catalog, q, bounded_limit),
    }


@router.get("/locations/activity")
def list_reel_location_activity(
    window_days: int = RECENT_ACTIVITY_DEFAULT_DAYS,
    limit: int = 128,
    viewer: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    """Return privacy-safe city heat markers for recent positive reel activity."""
    days = _bounded_activity_window(window_days)
    bounded_limit = max(1, min(int(limit), 128))
    viewer_id = viewer.user.id if isinstance(viewer, AuthContext) else None
    hidden_paths = unavailable_media_paths_for_viewer(viewer_id)
    raw = [item for item in _scan_cached() if item["rel_path"] not in hidden_paths]
    activity = _recent_activity_by_path(db, raw, days)
    locations = _location_activity_rows(raw, activity, limit=bounded_limit)
    return {
        "strategy": "recent-activity-v1",
        "window_days": days,
        "half_life_hours": RECENT_ACTIVITY_HALF_LIFE_HOURS,
        "count": len(locations),
        "locations": locations,
    }


@router.get("/locations/{location_key}")
def get_reel_location(
    location_key: str,
    codec: str | None = "hevc",
    sort: str = "trending",
    window_days: int = RECENT_ACTIVITY_DEFAULT_DAYS,
    folder: str | None = None,
    refresh: bool = False,
    viewer: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    """Return one exact city+country feed plus stats and related places."""
    slug = _location_key(*_split_location_key(location_key))
    if not slug:
        raise HTTPException(status_code=400, detail="Location cannot be empty")
    if refresh:
        _scan_cache["at"] = 0.0

    hidden_paths = unavailable_media_paths_for_viewer(viewer.user.id if isinstance(viewer, AuthContext) else None)
    raw = [item for item in _scan_cached() if item["rel_path"] not in hidden_paths]
    catalog = _location_catalog(raw)
    recent_activity = _recent_activity_by_path(db, raw, window_days) if sort == "recent_trending" else None
    videos = _apply_filters(raw, folder, "", sort, location=slug, recent_activity=recent_activity)
    row = catalog.get(slug, {
        "name": slug,
        "slug": slug,
        "city": "",
        "country": "",
        "reel_count": 0,
        "views": 0,
        "likes": 0,
        "image_count": 0,
        "video_count": 0,
        "lat": None,
        "lon": None,
    })
    location_summary = {key: value for key, value in row.items()}
    return {
        "strategy": "proximity-v1",
        "location": location_summary,
        "count": len(videos),
        "total": len(raw),
        "folders": sorted({video["folder"] for video in videos}),
        "related_locations": _related_location_rows(slug, catalog),
        "videos": _build_payload(videos, codec, viewer_id=viewer.user.id if isinstance(viewer, AuthContext) else None),
    }


# ─── EXPLORE PREVIEWS (lightweight 720p muted tiles + posters) ─────────

MAX_EXPLORE_PATHS = 24
EXPLORE_GEN_WORKERS = 4


def _gen_explore_assets(rel: str) -> tuple[str, str | None, str | None, str | None]:
    """Generate one item's Explore assets. Returns
    (rel, preview_url, poster_url, error). Posters are cheap single frames;
    previews are full re-encodes — both run in parallel across videos.
    Image tiles only need a poster (the full image is its own preview)."""
    root = OUTPUT_DIR.resolve()
    p = (root / rel).resolve()
    if not p.is_relative_to(root) or not p.is_file():
        return rel, None, None, "not found"
    if p.suffix.lstrip(".").lower() in SM.IMAGE_EXTS:
        try:
            poster = SM.make_image_poster(str(p))
        except Exception as ex:  # noqa: BLE001
            return rel, None, None, str(ex)

        def _img_url(local: str | None) -> str | None:
            if not local:
                return None
            try:
                return f"/media/{Path(local).resolve().relative_to(root).as_posix()}"
            except ValueError:
                return None

        poster_url = _img_url(poster)
        # The tile uses the full image as its own preview.
        return rel, f"/media/{rel}", poster_url, None
    try:
        prev = SM.make_explore_preview(str(p))
    except Exception as ex:  # noqa: BLE001
        return rel, None, None, str(ex)
    try:
        poster = SM.make_explore_poster(str(p))
    except Exception:  # noqa: BLE001
        poster = None  # poster is best-effort; the tile still works

    def _url(local: str | None) -> str | None:
        if not local:
            return None
        try:
            return f"/media/{Path(local).resolve().relative_to(root).as_posix()}"
        except ValueError:
            return None

    preview_url, poster_url = _url(prev), _url(poster)
    if not preview_url:
        return rel, None, poster_url, "transcode failed"
    return rel, preview_url, poster_url, None


@router.post("/explore-preview")
def generate_explore_previews(paths: list[str]):
    """Generate tiny muted H.264 previews + JPEG posters for Explore tiles.

    Capped per request and fanned out over worker threads so a fresh grid
    visit warms up in seconds, not minutes. Posters generate ~10x faster
    than previews, so tiles paint instantly and upgrade to video as each
    transcode lands. Returns {generated: {rel: preview_url},
    posters: {rel: poster_url}, failed: [...]}.
    """
    if len(paths) > MAX_EXPLORE_PATHS:
        raise HTTPException(
            status_code=400,
            detail=f"Too many paths in one request (max {MAX_EXPLORE_PATHS})",
        )
    from concurrent.futures import ThreadPoolExecutor

    generated: dict[str, str] = {}
    posters: dict[str, str] = {}
    failed = []
    with ThreadPoolExecutor(max_workers=EXPLORE_GEN_WORKERS) as ex:
        for rel, preview_url, poster_url, err in ex.map(_gen_explore_assets, list(paths)):
            if preview_url:
                generated[rel] = preview_url
            if poster_url:
                posters[rel] = poster_url
            if err:
                failed.append({"path": rel, "error": err})
    return {"generated": generated, "posters": posters, "failed": failed}


# ─── VR TELEMETRY (in-headset diagnostics) ──────────────────────────────

@router.post("/diag")
def post_diag(payload: dict):
    """Receive a live VR telemetry snapshot from the WebXR render loop."""
    _diag.clear()
    _diag.update(payload)
    _diag["server_ts"] = time.time()
    return {"ok": True}


@router.get("/diag")
def get_diag():
    """Return the most recent VR telemetry snapshot (empty until first POST)."""
    if not _diag:
        return {"empty": True}
    return _diag


# ─── COMMENTS + ENGAGEMENT COMPATIBILITY ENDPOINTS ──────────────────────

@router.get("/comments")
def get_comments(
    video_path: str,
    viewer: AuthContext | None = Depends(get_optional_auth),
):
    """Return database-backed comments for the legacy player route."""
    records = reel_records(
        [video_path.strip().replace(chr(92), "/")],
        viewer_id=viewer.user.id if isinstance(viewer, AuthContext) else None,
    )
    return {"video_path": video_path, "comments": records.get(video_path, {}).get("comments", [])}


@router.post("/comments")
def create_comment(
    req: CommentCreate,
    request: Request,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    """Create a comment using the authenticated account."""
    from server.routers.social import CommentRequest, create_post_comment

    post = get_post_by_reference(db, media_path=req.video_path)
    if not post:
        raise HTTPException(status_code=404, detail={"code": "POST_NOT_FOUND", "message": "Post not found."})
    return create_post_comment(
        post.id,
        CommentRequest(text=req.text, timestamp=req.timestamp),
        request,
        context,
        db,
    )


@router.post("/comments/{comment_id}/like")
def like_comment(
    comment_id: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    """Like a comment through the legacy player route."""
    from server.routers.social import like_social_comment

    return like_social_comment(comment_id, context, db)


@router.delete("/comments/{comment_id}")
def delete_comment(
    comment_id: str,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    from server.routers.social import delete_social_comment

    return delete_social_comment(comment_id, context, db)


class EngagementRequest(BaseModel):
    video_path: str


@router.post("/like")
def like_reel(
    req: EngagementRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    from server.routers.social import set_post_like

    post = get_post_by_reference(db, media_path=req.video_path)
    if not post:
        raise HTTPException(status_code=404, detail={"code": "POST_NOT_FOUND", "message": "Post not found."})
    result = set_post_like(db, post, context.user.id, True)
    return {**result, "video_path": post.media_path}


@router.post("/unlike")
def unlike_reel(
    req: EngagementRequest,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    from server.routers.social import set_post_like

    post = get_post_by_reference(db, media_path=req.video_path)
    if not post:
        raise HTTPException(status_code=404, detail={"code": "POST_NOT_FOUND", "message": "Post not found."})
    result = set_post_like(db, post, context.user.id, False)
    return {**result, "video_path": post.media_path}


@router.post("/view")
def view_reel(
    req: EngagementRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    viewer: AuthContext | None = Depends(get_optional_auth),
):
    """Compatibility view route; a loaded reel qualifies as a three-second view."""
    from server.routers.social import ViewRequest, record_view

    post = get_post_by_reference(db, media_path=req.video_path)
    if not post:
        raise HTTPException(status_code=404, detail={"code": "POST_NOT_FOUND", "message": "Post not found."})
    return record_view(
        post.id,
        ViewRequest(watch_ms=3000, source="reels"),
        request,
        response,
        db,
        viewer,
    )


# ─── PROXY GENERATION ────────────────────────────────────────────────────

MAX_PROXY_PATHS = 50


@router.post("/proxy")
def generate_proxies(paths: list[str]):
    """Generate H.264 preview proxies for the given output-relative paths."""
    if len(paths) > MAX_PROXY_PATHS:
        raise HTTPException(
            status_code=400,
            detail=f"Too many paths in one request (max {MAX_PROXY_PATHS})",
        )
    root = OUTPUT_DIR.resolve()
    generated = []
    failed = []
    for rel in paths:
        p = (root / rel).resolve()
        if not p.is_relative_to(root) or not p.is_file():
            failed.append({"path": rel, "error": "not found"})
            continue
        try:
            proxy = SM.make_web_preview(str(p))
            if proxy:
                generated.append(rel)
            else:
                failed.append({"path": rel, "error": "transcode failed"})
        except Exception as ex:  # noqa: BLE001
            failed.append({"path": rel, "error": str(ex)})
    _scan_cache["at"] = 0.0
    return {"generated": generated, "failed": failed}


# ─── LOCAL 2D -> SBS SPATIALIZATION ──────────────────────────────────────

SPATIALIZE_SRC_DIR = "output/testpipeline"
SPATIALIZE_OUT_DIR = "output/testpipeline-3d"


class SpatializeRequest(BaseModel):
    paths: list[str] | None = None  # output-relative; defaults to all HEVC masters in testpipeline
    strength: float = 1.0
    half_sbs: bool = False


@router.post("/spatialize")
def spatialize(req: SpatializeRequest):
    """Queue local depth-based SBS conversion of HEVC masters as a background job."""
    from pipeline.spatial_worker import SpatializeError, discover_hevc_sources

    if req.paths:
        root = Path(SPATIALIZE_SRC_DIR).resolve()
        sources = []
        for rel in req.paths[:MAX_PROXY_PATHS]:
            p = (root / rel).resolve()
            if p.is_relative_to(root) and p.is_file():
                sources.append(str(p))
        if not sources:
            raise HTTPException(status_code=400, detail="No valid HEVC sources under testpipeline")
    else:
        sources = discover_hevc_sources(SPATIALIZE_SRC_DIR)
        if not sources:
            raise HTTPException(
                status_code=400,
                detail=f"No HEVC masters found in {SPATIALIZE_SRC_DIR}",
            )

    def _run(status_callback=None, _sources=tuple(sources)):
        from pipeline.spatial_worker import process_video_spatial

        out_root = Path(SPATIALIZE_OUT_DIR)
        out_root.mkdir(parents=True, exist_ok=True)
        done, failed = [], []
        total = len(_sources)
        for i, src in enumerate(_sources, 1):
            dest = out_root / Path(src).name

            def per_file(msg, _i=i, _n=total, _name=Path(src).name):
                status_callback(f"[{_i}/{_n}] {_name}: {msg}")

            try:
                _, metrics = process_video_spatial(
                    src, str(dest),
                    status_callback=per_file,
                    strength=req.strength,
                    half_sbs=req.half_sbs,
                )
                done.append({"path": dest.as_posix(), **metrics})
            except Exception as ex:  # noqa: BLE001
                if isinstance(ex, SpatializeError):
                    failed.append({"path": Path(src).name, "error": str(ex)})
                else:
                    failed.append({"path": Path(src).name, "error": f"{type(ex).__name__}: {ex}"})
        _scan_cache["at"] = 0.0
        return {"generated": [d["path"] for d in done], "failed": failed}

    job_id = job_manager.create_job("video")
    job_manager.submit(job_id, _run, {})
    return {
        "job_id": job_id,
        "queued": [Path(s).name for s in sources],
        "out_dir": SPATIALIZE_OUT_DIR,
    }


@router.get("/spatialize/jobs/{job_id}")
def spatialize_status(job_id: str):
    rec = job_manager.get_job(job_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Unknown job")
    return {
        "status": rec.status.value,
        "phase": rec.phase,
        "elapsed": rec.elapsed,
        "messages": rec.messages[-8:],
        "result": rec.result,
        "error": rec.error,
    }


def _json_for_script(payload) -> str:
    """JSON-serialize *payload* for embedding inside an inline <script> tag."""
    return json.dumps(payload).replace("</", "<\\/")


@router.get("/player", response_class=HTMLResponse)
def reels_player(
    request: Request,
    response: Response,
    folder: str | None = None,
    codec: str | None = "hevc",
    search: str = "",
    sort: str = "for_you",
    window_days: int = RECENT_ACTIVITY_DEFAULT_DAYS,
    tunnel: str = "",
    refresh: bool = False,
    start: int = 0,
    media: str | None = None,
    tag: str | None = None,
    location: str | None = None,
    feed: str | None = None,
    author: str | None = None,
    post: str | None = None,
    viewer: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    """Render the full Reels/VR player page for embedding in an iframe."""
    feed_data = _recommendation_feed_data(
        request=request,
        response=response,
        db=db,
        viewer=viewer,
        folder=folder,
        codec=codec,
        search=search,
        window_days=window_days,
        sort=sort,
        tunnel=tunnel,
        refresh=refresh,
        media=media,
        tag=tag,
        location=location,
        feed=feed,
        author=author,
        post=post,
    )
    payload = feed_data["items"]
    try:
        start_idx = 0 if post else max(0, min(int(start), max(0, len(payload) - 1)))
    except (TypeError, ValueError):
        start_idx = 0

    try:
        html = (ASSETS_DIR / "reels.html").read_text(encoding="utf-8")
    except OSError as ex:
        raise HTTPException(status_code=500, detail=f"Template missing: {ex}") from ex

    html = _inject_icons(html)

    img_js = ASSETS_DIR / "quest_controller_img.js"
    if img_js.exists():
        html = html.replace("__QUEST_CONTROLLER_IMG_JS__",
                            img_js.read_text(encoding="utf-8"))
    feed_state_js = ASSETS_DIR / "reels_feed_state.js"
    if feed_state_js.exists():
        html = html.replace("__REELS_FEED_STATE_JS__", feed_state_js.read_text(encoding="utf-8"))
    vr_js = ASSETS_DIR / "webxr_vr.js"
    if vr_js.exists():
        html = html.replace("__WEBXR_VR_JS__", vr_js.read_text(encoding="utf-8"))

    html = html.replace("__VIDEO_DATA_JSON__", _json_for_script(payload))
    html = html.replace("__FEED_STATE_JSON__", _json_for_script(feed_data))
    html = html.replace("loadVideo(0);", f"loadVideo(__SX_START_INDEX__);")
    html = html.replace("__SX_START_INDEX__", str(start_idx))
    result = Response(
        content=html,
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )
    for header, value in response.raw_headers:
        if header.lower() == b"set-cookie":
            result.raw_headers.append((header, value))
    return result


def _scope_rules(css: str, root: str = "#sxReelsRoot") -> list[str]:
    """Scope one flat level of `selector { body }` rules to *root*."""
    out = []
    for rule in css.split("}"):
        rule = rule.strip()
        if "{" not in rule:
            continue
        sel, _, body = rule.partition("{")
        sel = sel.strip()
        if not sel or sel.startswith("@"):
            continue
        if re.fullmatch(r"(html|body)(\s*,\s*(html|body))*", sel):
            continue
        parts = [p.strip() for p in sel.split(",") if p.strip()]
        scoped = ", ".join(f"{root} *" if p == "*" else f"{root} {p}" for p in parts)
        out.append(f"{scoped} {{ {body.strip()} }}")
    return out


def _extract_media_blocks(css: str) -> tuple[str, list[tuple[str, str]]]:
    """Split out `@media cond { ... }` blocks (balanced braces).

    Returns (remaining_css, [(condition, inner_css), ...]).
    """
    blocks = []
    rest: list[str] = []
    i = 0
    while True:
        m = re.search(r"@media[^{]*\{", css[i:])
        if not m:
            rest.append(css[i:])
            break
        start = i + m.start()
        rest.append(css[i:start])
        depth = 0
        j = start
        while j < len(css):
            if css[j] == "{":
                depth += 1
            elif css[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        header, _, _ = css[start:].partition("{")
        inner = css[start + len(header) + 1: j]
        blocks.append((header.strip(), inner))
        i = j + 1
    return "".join(rest), blocks


def _scope_css(css: str, root: str = "#sxReelsRoot") -> str:
    """Scope the player's page-level CSS to the mount root so it can be
    embedded directly in the SPA without clobbering the app's own styles."""
    # Preserve @import statements (e.g. Google Fonts / Material Symbols).
    # URLs contain `;` (font-weight ranges) so match `url(...)` not bare `;`.
    imports = re.findall(r"@import\s+url\([^)]+\)\s*;", css)
    # Remove imports before block parsing so they don't get split on '}'
    css_no_imports = re.sub(r"@import\s+url\([^)]+\)\s*;", "", css)
    # Keep @media blocks (responsive rail/overlay rules) with scoped inners;
    # other @-rules (e.g. @keyframes) are still dropped as before.
    css_no_media, media_blocks = _extract_media_blocks(css_no_imports)
    out = _scope_rules(css_no_media, root)
    for header, inner in media_blocks:
        scoped_inner = _scope_rules(inner, root)
        if scoped_inner:
            out.append(f"{header} {{ {' '.join(scoped_inner)} }}")
    # Keep imports at top so font loads before scoped rules
    if imports:
        return "\n".join(imports) + "\n" + "\n".join(out)
    return "\n".join(out)


@router.get("/player-inline")
def reels_player_inline(
    request: Request,
    response: Response,
    folder: str | None = None,
    codec: str | None = "hevc",
    search: str = "",
    sort: str = "for_you",
    window_days: int = RECENT_ACTIVITY_DEFAULT_DAYS,
    tunnel: str = "",
    refresh: bool = False,
    start: int = 0,
    media: str | None = None,
    tag: str | None = None,
    location: str | None = None,
    feed: str | None = None,
    author: str | None = None,
    post: str | None = None,
    viewer: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    """Return the Reels/VR player as CSS + HTML + scripts for direct in-SPA
    embedding (no iframe, so the player sizes itself to the page)."""
    feed_data = _recommendation_feed_data(
        request=request,
        response=response,
        db=db,
        viewer=viewer,
        folder=folder,
        codec=codec,
        search=search,
        window_days=window_days,
        sort=sort,
        tunnel=tunnel,
        refresh=refresh,
        media=media,
        tag=tag,
        location=location,
        feed=feed,
        author=author,
        post=post,
    )
    payload = feed_data["items"]
    try:
        start_idx = 0 if post else max(0, min(int(start), max(0, len(payload) - 1)))
    except (TypeError, ValueError):
        start_idx = 0

    try:
        html = (ASSETS_DIR / "reels.html").read_text(encoding="utf-8")
    except OSError as ex:
        raise HTTPException(status_code=500, detail=f"Template missing: {ex}") from ex

    # Resolve shared icon tokens before script extraction so both markup
    # and inline player JS get artwork from the one icons folder.
    html = _inject_icons(html)

    img_js = ASSETS_DIR / "quest_controller_img.js"
    feed_state_js = ASSETS_DIR / "reels_feed_state.js"
    vr_js = ASSETS_DIR / "webxr_vr.js"

    scripts: list[str] = []
    for tag in re.findall(r"<script>(.*?)</script>", html, re.S):
        stripped = tag.strip()
        if stripped.startswith("__QUEST_CONTROLLER_IMG_JS__"):
            if img_js.exists():
                scripts.append(img_js.read_text(encoding="utf-8"))
        elif stripped.startswith("__REELS_FEED_STATE_JS__"):
            if feed_state_js.exists():
                scripts.append(feed_state_js.read_text(encoding="utf-8"))
        elif stripped.startswith("__WEBXR_VR_JS__"):
            if vr_js.exists():
                scripts.append(vr_js.read_text(encoding="utf-8"))
        else:
            scripts.append(
                tag.replace("__VIDEO_DATA_JSON__", _json_for_script(payload))
                .replace("__FEED_STATE_JSON__", _json_for_script(feed_data))
            )

    if scripts:
        init = scripts[-1]
        init = init.replace(
            "window.addEventListener('keydown', (e) => {",
            "window.__sxReelsKeydown = (e) => {",
        )
        init = init.replace(
            "});\n\n    // Focus frame on click for direct keyboard capture",
            "};\n\n    // Focus frame on click for direct keyboard capture",
        )
        # Deep-link start index (Explore → Reels): replace the hard-coded
        # initial loadVideo(0) with the clamped start offset.
        init = init.replace("loadVideo(0);", f"loadVideo({start_idx});")
        init += (
            "\nwindow.__sxReelsDomCleanup = window.__sxReelsCleanup;\n"
            "window.__sxReelsCleanup = function () {\n"
            "  if (window.__sxReelsDomCleanup) {\n"
            "    try { window.__sxReelsDomCleanup(); } catch (e) {}\n"
            "    window.__sxReelsDomCleanup = null;\n"
            "  }\n"
            "  if (window.__sxReelsRuntimeCleanup) {\n"
            "    try { window.__sxReelsRuntimeCleanup(); } catch (e) {}\n"
            "    window.__sxReelsRuntimeCleanup = null;\n"
            "  }\n"
            "  if (window.__sxImageTimer) {\n"
            "    clearTimeout(window.__sxImageTimer);\n"
            "    window.__sxImageTimer = null;\n"
            "  }\n"
            "  if (window.__sxReelsKeydown) {\n"
            "    window.removeEventListener('keydown', window.__sxReelsKeydown);\n"
            "    window.__sxReelsKeydown = null;\n"
            "  }\n"
            "  if (window.__sxGlowInterval) {\n"
            "    clearInterval(window.__sxGlowInterval);\n"
            "    window.__sxGlowInterval = null;\n"
            "  }\n"
            "  try {\n"
            "    const v = document.getElementById('reelsVideo');\n"
            "    if (v) {\n"
            "      v.pause();\n"
            "      v.removeAttribute('src');\n"
            "      v.load();\n"
            "    }\n"
            "  } catch (e) {}\n"
            "};"
        )
        scripts[-1] = init

    style_match = re.search(r"<style>(.*?)</style>", html, re.S)
    css = _scope_css(style_match.group(1)) if style_match else ""
    # Also forward any <link rel="stylesheet"> (Google Fonts / Material Symbols) as @import for the SPA mount.
    for href in re.findall(r'<link[^>]+href="([^"]+)"[^>]*>', html):
        if ("fonts.googleapis" in href or "material" in href.lower() or "gstatic" in href) and href not in css:
            css = f'@import url("{href}");\n' + css
    css += (
        "\n#sxReelsRoot .reels-phone-frame {"
        " width: min(92vw, 84dvh, 860px, 100%);"
        " height: auto;"
        " aspect-ratio: 1 / 1;"
        "}"
        "\n#sxReelsRoot .reels-phone-frame:fullscreen,"
        " #sxReelsRoot .reels-phone-frame:-webkit-full-screen {"
        " width: min(100vw, 100vh);"
        " height: min(100vw, 100vh);"
        " max-width: none;"
        " max-height: none;"
        " position: absolute;"
        " inset: 0;"
        " margin: auto;"
        " border: none;"
        "}"
    )

    # Anchor the body search after </style>: a literal "<body>" inside a
    # head comment would otherwise hijack this naive match and leak raw
    # CSS into the player markup.
    _style_end = html.find("</style>")
    _body_scope = html[_style_end:] if _style_end != -1 else html
    body_match = re.search(r"<body>(.*?)</body>", _body_scope, re.S)
    body_html = body_match.group(1) if body_match else ""
    # Strip <script> tags from body_html so innerHTML gets clean markup without unparsed placeholders
    body_html = re.sub(r"<script.*?>.*?</script>", "", body_html, flags=re.S)

    result = JSONResponse(
        {
            "count": len(payload),
            "start": start_idx,
            "feed": {
                key: value
                for key, value in feed_data.items()
                if key not in {"items", "feed_params"}
            },
            "css": css,
            "html": body_html,
            "scripts": scripts,
        },
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )
    for header, value in response.raw_headers:
        if header.lower() == b"set-cookie":
            result.raw_headers.append((header, value))
    return result
