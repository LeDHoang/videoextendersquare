"""Reels view — 4K Master Video Feed with auto-playback.

Scans all output directories recursively and presents an interactive video player
playing full 4K master video outputs directly with auto-advance, sound controls,
WASD & swipe/keyboard navigation, and loopback HTTP streaming.
"""

import importlib
import json
import random
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

from ui import components as C
from ui import media as M
from ui import mediaserver as MS
from ui.media import scan_output_videos

# Force refresh of media module if running under a persistent Streamlit process
try:
    importlib.reload(M)
except Exception:
    pass

OUTPUT_DIR = Path("output")


def _template() -> str:
    template_path = Path(__file__).parent.parent / "assets" / "reels.html"
    return template_path.read_text(encoding="utf-8")


def render(ctx: dict) -> None:
    nonce = st.session_state.get("sx.reels_nonce", 0)

    C.hero("Reels", "4K MASTER REELS FEED · AUTO PLAYBACK")

    # Scan all 4K master videos inside output directory recursively
    raw_videos = scan_output_videos("output", nonce)

    if not raw_videos:
        C.empty_state(
            "NO VIDEOS FOUND IN OUTPUT",
            "Generate videos using Image or Video pipelines, or place MP4 files inside output/.",
            f"scanned directory: {OUTPUT_DIR.resolve()}",
        )
        if st.button("↻ RESCAN FEED", key="sx.reels.rescan_empty"):
            st.session_state["sx.reels_nonce"] = nonce + 1
            scan_output_videos.clear()
            st.rerun()
        return

    # Filter controls
    folders = sorted(list({v["folder"] for v in raw_videos}))
    folder_options = ["ALL FOLDERS"] + folders

    c1, c2, c3, c4 = st.columns([2, 2, 2, 1])
    with c1:
        selected_folder = st.selectbox(
            "Folder",
            folder_options,
            key="sx.reels.folder",
            label_visibility="collapsed",
        )
    with c2:
        sort_order = st.selectbox(
            "Sort",
            ["NEWEST FIRST", "OLDEST FIRST", "ALPHABETICAL", "SHUFFLE"],
            key="sx.reels.sort",
            label_visibility="collapsed",
        )
    with c3:
        search_query = st.text_input(
            "Search",
            placeholder="Search filename…",
            key="sx.reels.search",
            label_visibility="collapsed",
        )
    with c4:
        if st.button("↻ RESCAN", key="sx.reels.rescan", width="stretch"):
            st.session_state["sx.reels_nonce"] = nonce + 1
            scan_output_videos.clear()
            st.rerun()

    # Apply folder & search filters
    filtered_videos = list(raw_videos)
    if selected_folder != "ALL FOLDERS":
        filtered_videos = [v for v in filtered_videos if v["folder"] == selected_folder]

    if search_query.strip():
        q = search_query.strip().lower()
        filtered_videos = [v for v in filtered_videos if q in v["filename"].lower()]

    # Apply sorting
    if sort_order == "OLDEST FIRST":
        filtered_videos.sort(key=lambda x: x["mtime"])
    elif sort_order == "ALPHABETICAL":
        filtered_videos.sort(key=lambda x: x["filename"].lower())
    elif sort_order == "SHUFFLE":
        seed = st.session_state.get("sx.reels_shuffle_seed", 42)
        r = random.Random(seed)
        r.shuffle(filtered_videos)

    if not filtered_videos:
        st.warning("No videos match the current filters.")
        return

    # Serve 4K master videos directly
    root_dir = str(OUTPUT_DIR.resolve())
    video_payload = []

    for item in filtered_videos:
        src_path = item["path"]
        url = MS.media_url(root_dir, src_path) or MS.media_url(
            str(Path(src_path).parent), src_path
        )
        if url:
            video_payload.append({
                "url": url,
                "filename": item["filename"],
                "folder": item["folder"],
                "size": item["size_human"],
                "path": item["rel_path"],
            })

    if not video_payload:
        C.accent_block(
            "CANNOT SERVE VIDEOS",
            ["Videos could not be served over loopback HTTP media server."],
        )
        return

    # Render HTML5 1:1 Square Reels Component with 4K Master URLs
    html = _template().replace("__VIDEO_DATA_JSON__", json.dumps(video_payload))
    components.html(html, height=750)

    # Info footer / list view
    with st.expander(f"▸ 4K MASTER PLAYLIST METADATA ({len(video_payload)} VIDEOS)"):
        for idx, item in enumerate(video_payload, 1):
            st.text(f"{idx:02d}. [{item['folder']}] {item['filename']} ({item['size']}) [4K MASTER]")
