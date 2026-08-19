"""Compare router — FAST vs STUDIO A/B pairs and the slider player page."""

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from server import media as SM

router = APIRouter(prefix="/api/compare", tags=["compare"])

PAIRS_DIR = Path("output/pairs")
ASSETS_DIR = Path(__file__).resolve().parent.parent.parent / "ui" / "assets"

ACCENT = "#FF3B1F"
INK = "#F2F3F5"
FAST_LABEL = "FAST · LANCZOS4 + CAS"
STUDIO_LABEL = "STUDIO · ZNEDI3"


@router.get("")
def list_pairs(refresh: bool = False):
    """List FAST/STUDIO pairs found in output/pairs (and legacy dirs)."""
    pairs = SM.scan_pairs(str(PAIRS_DIR))
    return {
        "total": len(pairs),
        "complete": [p for p in pairs if p["complete"]],
        "partial": [p for p in pairs if not p["complete"]],
    }


def _media_rel(path: str) -> str:
    root = Path("output").resolve()
    p = Path(path).resolve()
    if not p.is_relative_to(root):
        raise HTTPException(status_code=400, detail=f"Outside output dir: {path}")
    return "/media/" + p.relative_to(root).as_posix()


@router.get("/prepare")
def prepare_pair(pair: str):
    """Return browser-playable (H.264 proxy) URLs for a pair's two renders."""
    pairs = SM.scan_pairs(str(PAIRS_DIR))
    p = next((x for x in pairs if x["name"] == pair), None)
    if not p:
        raise HTTPException(status_code=404, detail=f"Pair not found: {pair}")

    fast_play = SM.make_web_preview(p["fast"], height=720) or p["fast"]
    studio_play = SM.make_web_preview(p["studio"], height=720) or p["studio"]

    return {
        "name": pair,
        "complete": p["complete"],
        "fast_url": _media_rel(fast_play),
        "studio_url": _media_rel(studio_play),
        "aspect": SM.video_aspect(fast_play),
    }


@router.get("/player", response_class=HTMLResponse)
def compare_player(pair: str):
    """Render the before/after slider page for embedding in an iframe."""
    pairs = SM.scan_pairs(str(PAIRS_DIR))
    p = next((x for x in pairs if x["name"] == pair and x["complete"]), None)
    if not p:
        raise HTTPException(status_code=404, detail=f"Complete pair not found: {pair}")

    fast_play = SM.make_web_preview(p["fast"], height=720) or p["fast"]
    studio_play = SM.make_web_preview(p["studio"], height=720) or p["studio"]

    try:
        html = (ASSETS_DIR / "compare.html").read_text(encoding="utf-8")
    except OSError as ex:
        raise HTTPException(status_code=500, detail=f"Template missing: {ex}") from ex

    return HTMLResponse(
        html
        .replace("__BEFORE_URL__", _media_rel(fast_play))
        .replace("__AFTER_URL__", _media_rel(studio_play))
        .replace("__BEFORE_LABEL__", FAST_LABEL)
        .replace("__AFTER_LABEL__", STUDIO_LABEL)
        .replace("__ACCENT__", ACCENT)
        .replace("__INK__", INK)
        .replace("__ASPECT__", SM.video_aspect(fast_play))
    )