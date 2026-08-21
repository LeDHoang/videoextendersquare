"""Reels router — output scan, filtering, H.264 proxy generation, time-synced comments,
and the full Reels/VR player page (replaces the Streamlit reels_view iframe)."""

import json
import random
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from server import media as SM

router = APIRouter(prefix="/api/reels", tags=["reels"])

OUTPUT_DIR = Path("output")
COMMENTS_FILE = OUTPUT_DIR / "reels_comments.json"
ASSETS_DIR = Path(__file__).resolve().parent.parent.parent / "ui" / "assets"

# Tiny in-process TTL cache for the output scan (rglob over output/ is cheap
# enough to re-run, but not on every keystroke of a search box).
_scan_cache: dict = {"at": 0.0, "data": []}
_SCAN_TTL = 10.0


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
        _scan_cache["data"] = SM.scan_output_videos(str(OUTPUT_DIR))
    return _scan_cache["data"]


def _apply_filters(raw: list[dict], folder: str | None, search: str,
                   sort: str) -> list[dict]:
    videos = list(raw)
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


def _build_payload(videos: list[dict], codec: str | None, tunnel: str = "") -> list[dict]:
    """Map scanned videos to the reels player payload (relative /media/ URLs),
    including embedded time-synced and general comments."""
    mode = _codec_key(codec)
    payload = []
    for item in videos:
        src_path = item["path"]
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
        
        # Load comments for this reel
        comments = _get_comments_for_video(item["rel_path"], item["filename"])

        payload.append({
            "url": f"/media/{rel}",
            "filename": item["filename"],
            "folder": item["folder"],
            "size": item["size_human"],
            "path": item["rel_path"],
            "codec": play_codec.upper(),
            "is_proxy": is_proxy,
            "stream_tag": "H.264 4K PROXY" if is_proxy else f"{codec_name.upper()} MASTER",
            "tunnel_url": tunnel.strip(),
            "comments": comments,
        })
    return payload


@router.get("")
def list_reels(
    folder: str | None = None,
    codec: str | None = "hevc",
    search: str = "",
    sort: str = "newest",
    refresh: bool = False,
):
    """Scan output dir and return the filtered, codec-aware reels list."""
    if refresh:
        _scan_cache["at"] = 0.0
    raw = _scan_cached()
    videos = _apply_filters(raw, folder, search, sort)
    return {
        "total": len(raw),
        "count": len(videos),
        "folders": sorted({v["folder"] for v in raw}),
        "videos": _build_payload(videos, codec),
    }


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
):
    """Render the full Reels/VR player page for embedding in an iframe."""
    if refresh:
        _scan_cache["at"] = 0.0
    raw = _scan_cached()
    videos = _apply_filters(raw, folder, search, sort)
    payload = _build_payload(videos, codec, tunnel=tunnel)

    try:
        html = (ASSETS_DIR / "reels.html").read_text(encoding="utf-8")
    except OSError as ex:
        raise HTTPException(status_code=500, detail=f"Template missing: {ex}") from ex

    img_js = ASSETS_DIR / "quest_controller_img.js"
    if img_js.exists():
        html = html.replace("__QUEST_CONTROLLER_IMG_JS__",
                            img_js.read_text(encoding="utf-8"))
    vr_js = ASSETS_DIR / "webxr_vr.js"
    if vr_js.exists():
        html = html.replace("__WEBXR_VR_JS__", vr_js.read_text(encoding="utf-8"))

    html = html.replace("__VIDEO_DATA_JSON__", _json_for_script(payload))
    return HTMLResponse(html)


def _scope_css(css: str, root: str = "#sxReelsRoot") -> str:
    """Scope the player's page-level CSS to the mount root so it can be
    embedded directly in the SPA without clobbering the app's own styles."""
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
    return "\n".join(out)


@router.get("/player-inline")
def reels_player_inline(
    folder: str | None = None,
    codec: str | None = "hevc",
    search: str = "",
    sort: str = "newest",
    tunnel: str = "",
    refresh: bool = False,
):
    """Return the Reels/VR player as CSS + HTML + scripts for direct in-SPA
    embedding (no iframe, so the player sizes itself to the page)."""
    if refresh:
        _scan_cache["at"] = 0.0
    raw = _scan_cached()
    videos = _apply_filters(raw, folder, search, sort)
    payload = _build_payload(videos, codec, tunnel=tunnel)

    try:
        html = (ASSETS_DIR / "reels.html").read_text(encoding="utf-8")
    except OSError as ex:
        raise HTTPException(status_code=500, detail=f"Template missing: {ex}") from ex

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
        init += (
            "\nwindow.__sxReelsCleanup = function () {\n"
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

    return {
        "count": len(videos),
        "css": css,
        "html": body_html,
        "scripts": scripts,
    }