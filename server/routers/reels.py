"""Reels router — output scan, filtering, H.264 proxy generation, and the
full Reels/VR player page (replaces the Streamlit reels_view iframe)."""

import json
import random
import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from server import media as SM

router = APIRouter(prefix="/api/reels", tags=["reels"])

OUTPUT_DIR = Path("output")
ASSETS_DIR = Path(__file__).resolve().parent.parent.parent / "ui" / "assets"

# Tiny in-process TTL cache for the output scan (rglob over output/ is cheap
# enough to re-run, but not on every keystroke of a search box).
_scan_cache: dict = {"at": 0.0, "data": []}
_SCAN_TTL = 10.0


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
    """Map scanned videos to the reels player payload (relative /media/ URLs)."""
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


MAX_PROXY_PATHS = 50


@router.post("/proxy")
def generate_proxies(paths: list[str]):
    """Generate H.264 preview proxies for the given output-relative paths.

    Each proxy is a synchronous ffmpeg transcode (server/media.py's
    make_web_preview), so an unbounded list here is effectively an
    unauthenticated way to queue arbitrarily many transcodes in one request.
    """
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
    """JSON-serialize *payload* for embedding inside an inline <script> tag.

    A filename/folder containing the literal substring `</script>` would
    otherwise close the tag early and let the rest execute as raw HTML/JS —
    escape the one sequence that matters rather than trying to sanitize
    every field at the source.
    """
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
    """Render the full Reels/VR player page for embedding in an iframe.

    Same-origin relative /media/ URLs mean the Quest browser and HTTPS tunnels
    work with zero extra configuration.
    """
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
            "\nwindow.__sxReelsCleanup = function () {"
            " if (window.__sxReelsKeydown) {"
            "  window.removeEventListener('keydown', window.__sxReelsKeydown);"
            "  window.__sxReelsKeydown = null;"
            " }"
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

    return {
        "count": len(videos),
        "css": css,
        "html": body_html,
        "scripts": scripts,
    }