"""Compare view — FAST vs STUDIO A/B.

Scans output/pairs/ rather than the old input/1:1/, because "1:1" is an illegal
directory name on Windows (the colon is the ADS separator) — native Python
raises NotADirectoryError [WinError 267], so that glob branch could never match.
"""

from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

from ui import components as C
from ui import health as H
from ui import media as M
from ui import mediaserver as MS
from ui import tokens as T

PAIRS_DIR = Path("output/pairs")
FAST_SUFFIX = "_fast.mp4"
STUDIO_SUFFIX = "_studio.mp4"


@st.cache_data(show_spinner=False)
def scan_pairs(root: str, nonce: int = 0) -> list[dict]:
    """Find *_fast.mp4 files and note whether the _studio sibling exists."""
    base = Path(root)
    if not base.is_dir():
        return []
    out = []
    for fast in sorted(base.glob(f"*{FAST_SUFFIX}")):
        stem = fast.name[: -len(FAST_SUFFIX)]
        studio = base / f"{stem}{STUDIO_SUFFIX}"
        out.append({
            "name": stem,
            "fast": str(fast),
            "studio": str(studio),
            "complete": studio.is_file(),
        })
    return out


def _template() -> str:
    return (Path(__file__).parent.parent / "assets" / "compare.html").read_text(
        encoding="utf-8"
    )


def _aspect(path: str) -> str:
    try:
        from pipeline.utils import get_video_dimensions_and_duration

        w, h, _ = get_video_dimensions_and_duration(path)
        if w and h:
            return f"{w}/{h}"
    except Exception:  # noqa: BLE001
        pass
    return "1/1"


def render(ctx: dict) -> None:
    probes = ctx["probes"]
    nonce = st.session_state.get("sx.pairs_nonce", 0)

    C.hero("Compare", "FAST vs STUDIO · PIXEL-LEVEL A/B")

    pairs = scan_pairs(str(PAIRS_DIR), nonce)
    complete = [p for p in pairs if p["complete"]]
    partial = [p for p in pairs if not p["complete"]]

    if not complete:
        if not pairs:
            C.empty_state(
                "NO PAIRS FOUND",
                f"Comparison needs a FAST and a STUDIO render of the same "
                f"source, named <stem>{FAST_SUFFIX} and <stem>{STUDIO_SUFFIX}.",
                f"scanned  {PAIRS_DIR}{'  (does not exist)' if not PAIRS_DIR.is_dir() else ''}",
            )
        for p in partial:
            C.accent_block(
                f"INCOMPLETE PAIR — {p['name']}",
                [f"Found the FAST render but not its STUDIO sibling."],
                code=[Path(p["studio"]).name],
            )

        # Be honest about why pairs cannot be produced here, rather than the old
        # "check back in a few minutes", which was never going to come true.
        if not H.studio_available(probes):
            missing = []
            if not probes["vapoursynth"].ok:
                missing.append("VapourSynth + vspipe")
            if not probes["znedi3"].ok:
                missing.append("the znedi3 plugin")
            C.accent_block(
                "STUDIO RENDERS CANNOT BE PRODUCED ON THIS MACHINE",
                [f"Missing {' and '.join(missing)}. Pairs must be generated "
                 "elsewhere and copied in."],
                code=["pip install vapoursynth  + vsznedi3 plugin",
                      f"venv\\Scripts\\python.exe batch_upscale.py"],
            )

        if st.button("↻  RESCAN", key="sx.cmp.rescan"):
            st.session_state["sx.pairs_nonce"] = nonce + 1
            scan_pairs.clear()
            st.rerun()
        return

    names = [p["name"] for p in complete]
    picked = st.selectbox("Pair", names, label_visibility="collapsed",
                          key="sx.cmp.pick")
    pair = next(p for p in complete if p["name"] == picked)

    mode = st.segmented_control(
        "View", ["SLIDER", "SIDE BY SIDE"], default="SLIDER",
        label_visibility="collapsed", key="sx.cmp.mode",
    ) or "SLIDER"

    # HEVC will not decode in the iframe either, so both modes want H.264.
    fast_play, studio_play = pair["fast"], pair["studio"]
    if probes["libx264"].ok:
        with st.spinner("Preparing playable proxies…"):
            fast_play = M.make_web_preview(pair["fast"], height=720) or pair["fast"]
            studio_play = M.make_web_preview(pair["studio"], height=720) or pair["studio"]

    if mode == "SIDE BY SIDE":
        a, b = st.columns(2)
        with a:
            C.eyebrow("FAST · LANCZOS4 + CAS")
            st.video(fast_play)
        with b:
            C.eyebrow("STUDIO · ZNEDI3")
            st.video(studio_play)
    else:
        root = Path(fast_play).resolve().parent
        before = MS.media_url(str(root), fast_play)
        after = MS.media_url(str(root), studio_play)
        if not before or not after:
            C.accent_block("CANNOT SERVE THESE FILES",
                           ["The proxies fell outside the served directory."])
            return
        html = (_template()
                .replace("__BEFORE_URL__", before)
                .replace("__AFTER_URL__", after)
                .replace("__BEFORE_LABEL__", "FAST · LANCZOS4 + CAS")
                .replace("__AFTER_LABEL__", "STUDIO · ZNEDI3")
                .replace("__ACCENT__", T.COLOR_ACCENT)
                .replace("__INK__", T.COLOR_INK)
                .replace("__ASPECT__", _aspect(fast_play)))
        components.html(html, height=780)

    C.mono(f"{pair['fast']}\n{pair['studio']}")

    if st.button("↻  RESCAN", key="sx.cmp.rescan2"):
        st.session_state["sx.pairs_nonce"] = nonce + 1
        scan_pairs.clear()
        st.rerun()
