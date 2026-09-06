"""Reels router — output scan, filtering, H.264 proxy generation, time-synced comments,
and the full Reels/VR player page (replaces the Streamlit reels_view iframe)."""

import hashlib
import json
import random
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel

from server import media as SM
from server.jobs import job_manager

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
    """Retrieve comments for a video, seeding default mock comments if none exist."""
    key = rel_path.strip().replace("\\", "/")
    all_comments = _load_comments_raw()
    
    if key not in all_comments or not all_comments[key]:
        # Also try matching by filename stem
        found = None
        for k, v in all_comments.items():
            if Path(k).name == Path(rel_path).name:
                found = v
                break
        if found:
            return found
        
        seeds = _generate_seed_comments(rel_path, filename)
        all_comments[key] = seeds
        _save_comments_raw(all_comments)
        return seeds

    return all_comments[key]


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
    """Retrieve metadata for a video, seeding fakes on first sight.

    Seeding uses a path-hash RNG so each reel gets stable, varied values;
    the result persists to reels_meta.json (user/real data can replace
    fakes later with no API change).
    """
    key = rel_path.strip().replace("\\", "/")
    all_meta = _load_meta_raw()
    if key in all_meta and isinstance(all_meta[key], dict):
        entry = all_meta[key]
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
            # Migrate pre-country entries: look up by city, drop the county.
            loc["country"] = _CITY_TO_COUNTRY.get(loc.get("city", ""), "")
        loc.pop("county", None)
        loc.setdefault("display_name", "")
        loc.setdefault("lat", None)
        loc.setdefault("lon", None)
        loc.setdefault("osm_id", None)
        entry.setdefault("likes", 0)
        entry.setdefault("views", 0)
        entry.setdefault("liked_by_me", False)
        return entry
    seed = int(hashlib.md5(key.encode("utf-8")).hexdigest()[:8], 16)
    entry = _seed_meta(key, filename, random.Random(seed))
    all_meta[key] = entry
    _save_meta_raw(all_meta)
    return entry


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
    timestamp: float | None = None  # None for general / non-time-synced
    author_name: str
    text: str
    author_avatar: str | None = "👤"
    avatar_color: str | None = "#FF3B1F"


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
                   sort: str, media: str | None = None) -> list[dict]:
    videos = list(raw)
    if media in ("video", "videos"):
        videos = [v for v in videos if not _is_image_item(v)]
    elif media in ("image", "images"):
        videos = [v for v in videos if _is_image_item(v)]
    if folder and folder != "ALL FOLDERS":
        videos = [v for v in videos if v["folder"] == folder]
    if search.strip():
        q = search.strip().lower()
        videos = [v for v in videos if q in v["filename"].lower()]
    if sort == "oldest":
        videos.sort(key=lambda x: x["mtime"])
    elif sort == "alphabetical":
        videos.sort(key=lambda x: x["filename"].lower())
    elif sort == "shuffle":
        r = random.Random(int(time.time()) // 60)
        r.shuffle(videos)
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


def _build_payload(videos: list[dict], codec: str | None, tunnel: str = "") -> list[dict]:
    """Map scanned media to the reels player payload (relative /media/ URLs),
    including embedded time-synced and general comments.

    Video items keep the codec-aware proxy logic; image items (single image
    tiles) serve the original file directly with a lightweight poster thumb.
    """
    mode = _codec_key(codec)
    payload = []
    for item in videos:
        src_path = item["path"]
        comments = _get_comments_for_video(item["rel_path"], item["filename"])
        meta = _get_meta_for_video(item["rel_path"], item["filename"])
        loc = meta.get("location", {"city": "", "country": ""})
        base = {
            "tags": meta.get("tags", []),
            "title": meta.get("title", ""),
            "caption": meta.get("caption", ""),
            "author_name": meta.get("author_name", ""),
            "source": meta.get("source", ""),
            "location": loc,
            "likes": meta.get("likes", 0),
            "views": meta.get("views", 0),
            "liked_by_me": bool(meta.get("liked_by_me", False)),
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


@router.get("")
def list_reels(
    folder: str | None = None,
    codec: str | None = "hevc",
    search: str = "",
    sort: str = "newest",
    refresh: bool = False,
    media: str | None = None,
):
    """Scan output dir and return the filtered, codec-aware reels list.

    media: all (default) | video | image — lets callers filter to one kind.
    """
    if refresh:
        _scan_cache["at"] = 0.0
    raw = _scan_cached()
    videos = _apply_filters(raw, folder, search, sort, media)
    return {
        "total": len(raw),
        "count": len(videos),
        "folders": sorted({v["folder"] for v in raw}),
        "videos": _build_payload(videos, codec),
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


# ─── COMMENTS ENDPOINTS ──────────────────────────────────────────────────

@router.get("/comments")
def get_comments(video_path: str):
    """Get all comments (time-synced & general) for a given video."""
    comments = _get_comments_for_video(video_path)
    return {"video_path": video_path, "comments": comments}


@router.post("/comments")
def create_comment(req: CommentCreate):
    """Create a new time-synced or general comment."""
    key = req.video_path.strip().replace("\\", "/")
    all_comments = _load_comments_raw()
    
    if key not in all_comments:
        all_comments[key] = _get_comments_for_video(req.video_path)

    new_comment = {
        "id": f"c_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}",
        "video_path": req.video_path,
        "timestamp": round(req.timestamp, 2) if req.timestamp is not None else None,
        "author_name": req.author_name.strip() or "Anonymous_VR",
        "author_avatar": req.author_avatar or "👤",
        "avatar_color": req.avatar_color or "#FF3B1F",
        "text": req.text.strip(),
        "likes": 0,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    
    if not new_comment["text"]:
        raise HTTPException(status_code=400, detail="Comment text cannot be empty")

    all_comments[key].append(new_comment)
    _save_comments_raw(all_comments)
    return new_comment


@router.post("/comments/{comment_id}/like")
def like_comment(comment_id: str):
    """Toggle or increment like for a comment."""
    all_comments = _load_comments_raw()
    for video_key, c_list in all_comments.items():
        for c in c_list:
            if c.get("id") == comment_id:
                c["likes"] = c.get("likes", 0) + 1
                _save_comments_raw(all_comments)
                return {"id": comment_id, "likes": c["likes"]}
    raise HTTPException(status_code=404, detail="Comment not found")


@router.delete("/comments/{comment_id}")
def delete_comment(comment_id: str):
    """Delete a comment by ID."""
    all_comments = _load_comments_raw()
    found = False
    for video_key, c_list in all_comments.items():
        original_len = len(c_list)
        all_comments[video_key] = [c for c in c_list if c.get("id") != comment_id]
        if len(all_comments[video_key]) != original_len:
            found = True
            break
    if found:
        _save_comments_raw(all_comments)
        return {"ok": True}
    raise HTTPException(status_code=404, detail="Comment not found")


# ─── REEL ENGAGEMENT (likes / views) ───────────────────────────────────

class EngagementRequest(BaseModel):
    video_path: str


def _bump_meta_counter(video_path: str, field: str, delta: int = 1,
                       liked_by_me: bool | None = None) -> dict:
    """Change a numeric metadata counter, seeding the entry if needed.
    Decrements floor at zero so unlikes can never drive counts negative."""
    key = video_path.strip().replace("\\", "/")
    all_meta = _load_meta_raw()
    entry = all_meta.get(key)
    if not isinstance(entry, dict):
        seed = int(hashlib.md5(key.encode("utf-8")).hexdigest()[:8], 16)
        entry = _seed_meta(key, Path(key).name, random.Random(seed))
        all_meta[key] = entry
    entry[field] = max(0, int(entry.get(field, 0) or 0) + delta)
    if liked_by_me is not None:
        entry["liked_by_me"] = liked_by_me
    _save_meta_raw(all_meta)
    return {
        "video_path": key,
        "likes": entry.get("likes", 0),
        "views": entry.get("views", 0),
        "liked_by_me": bool(entry.get("liked_by_me", False)),
    }


@router.post("/like")
def like_reel(req: EngagementRequest):
    """Like a reel (+1, marks liked_by_me). No identity system exists yet —
    single local user is assumed; a true per-user toggle needs user auth."""
    if not req.video_path.strip():
        raise HTTPException(status_code=400, detail="video_path is required")
    return _bump_meta_counter(req.video_path, "likes", 1, liked_by_me=True)


@router.post("/unlike")
def unlike_reel(req: EngagementRequest):
    """Unlike a reel (−1 floored at zero, clears liked_by_me). Pairs with
    the player's like/unlike toggle."""
    if not req.video_path.strip():
        raise HTTPException(status_code=400, detail="video_path is required")
    return _bump_meta_counter(req.video_path, "likes", -1, liked_by_me=False)


@router.post("/view")
def view_reel(req: EngagementRequest):
    """Record a reel view (+1). Fire-and-forget from the player on each
    video load; per-swipe inflation is accepted for now."""
    if not req.video_path.strip():
        raise HTTPException(status_code=400, detail="video_path is required")
    return _bump_meta_counter(req.video_path, "views")


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
    folder: str | None = None,
    codec: str | None = "hevc",
    search: str = "",
    sort: str = "newest",
    tunnel: str = "",
    refresh: bool = False,
    start: int = 0,
    media: str | None = None,
):
    """Render the full Reels/VR player page for embedding in an iframe."""
    if refresh:
        _scan_cache["at"] = 0.0
    raw = _scan_cached()
    videos = _apply_filters(raw, folder, search, sort, media)
    payload = _build_payload(videos, codec, tunnel=tunnel)
    try:
        start_idx = max(0, min(int(start), max(0, len(payload) - 1)))
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
    vr_js = ASSETS_DIR / "webxr_vr.js"
    if vr_js.exists():
        html = html.replace("__WEBXR_VR_JS__", vr_js.read_text(encoding="utf-8"))

    html = html.replace("__VIDEO_DATA_JSON__", _json_for_script(payload))
    html = html.replace("loadVideo(0);", f"loadVideo(__SX_START_INDEX__);")
    html = html.replace("__SX_START_INDEX__", str(start_idx))
    return Response(
        content=html,
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


def _scope_css(css: str, root: str = "#sxReelsRoot") -> str:
    """Scope the player's page-level CSS to the mount root so it can be
    embedded directly in the SPA without clobbering the app's own styles."""
    # Preserve @import statements (e.g. Google Fonts / Material Symbols).
    # URLs contain `;` (font-weight ranges) so match `url(...)` not bare `;`.
    imports = re.findall(r"@import\s+url\([^)]+\)\s*;", css)
    out = []
    # Remove imports before block parsing so they don't get split on '}'
    css_no_imports = re.sub(r"@import\s+url\([^)]+\)\s*;", "", css)
    for rule in css_no_imports.split("}"):
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
    # Keep imports at top so font loads before scoped rules
    if imports:
        return "\n".join(imports) + "\n" + "\n".join(out)
    return "\n".join(out)


@router.get("/player-inline")
def reels_player_inline(
    folder: str | None = None,
    codec: str | None = "hevc",
    search: str = "",
    sort: str = "newest",
    tunnel: str = "",
    refresh: bool = False,
    start: int = 0,
    media: str | None = None,
):
    """Return the Reels/VR player as CSS + HTML + scripts for direct in-SPA
    embedding (no iframe, so the player sizes itself to the page)."""
    if refresh:
        _scan_cache["at"] = 0.0
    raw = _scan_cached()
    videos = _apply_filters(raw, folder, search, sort, media)
    payload = _build_payload(videos, codec, tunnel=tunnel)
    try:
        start_idx = max(0, min(int(start), max(0, len(payload) - 1)))
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
    vr_js = ASSETS_DIR / "webxr_vr.js"

    scripts: list[str] = []
    for tag in re.findall(r"<script>(.*?)</script>", html, re.S):
        stripped = tag.strip()
        if stripped.startswith("__QUEST_CONTROLLER_IMG_JS__"):
            if img_js.exists():
                scripts.append(img_js.read_text(encoding="utf-8"))
        elif stripped.startswith("__WEBXR_VR_JS__"):
            if vr_js.exists():
                scripts.append(vr_js.read_text(encoding="utf-8"))
        else:
            scripts.append(tag.replace("__VIDEO_DATA_JSON__", _json_for_script(payload)))

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
            "\nwindow.__sxReelsCleanup = function () {\n"
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
            "    const v = document.getElementById('mainVideo');\n"
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
        " width: min(92vw, 84vh, 860px);"
        " height: min(92vw, 84vh, 860px);"
        "}"
    )

    body_match = re.search(r"<body>(.*?)</body>", html, re.S)
    body_html = body_match.group(1) if body_match else ""
    # Strip <script> tags from body_html so innerHTML gets clean markup without unparsed placeholders
    body_html = re.sub(r"<script.*?>.*?</script>", "", body_html, flags=re.S)

    return JSONResponse(
        {
            "count": len(videos),
            "start": start_idx,
            "css": css,
            "html": body_html,
            "scripts": scripts,
        },
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )