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
    assets = Path(__file__).parent.parent / "assets"
    html = (assets / "reels.html").read_text(encoding="utf-8")
    # Inline the WebXR VR module so it's available inside the Streamlit iframe
    vr_js_path = assets / "webxr_vr.js"
    vr_js = vr_js_path.read_text(encoding="utf-8") if vr_js_path.exists() else ""
    html = html.replace("__WEBXR_VR_JS__", vr_js)
    html = html.replace("__MEDIA_PORT__", str(MS.MEDIA_PORT))
    return html


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

    # Folder Filter Pills & Controls
    folder_counts = {"ALL FOLDERS": len(raw_videos)}
    for v in raw_videos:
        folder_counts[v["folder"]] = folder_counts.get(v["folder"], 0) + 1

    folders = sorted(list({v["folder"] for v in raw_videos}))
    folder_options = ["ALL FOLDERS"] + folders
    folder_labels = [
        f"📂 ALL ({len(raw_videos)})" if f == "ALL FOLDERS" else f"📁 {f} ({folder_counts[f]})"
        for f in folder_options
    ]

    st.caption("FILTER REELS BY OUTPUT FOLDER")
    selected_label = st.pills(
        "Folder Filter",
        options=folder_labels,
        selection_mode="single",
        default=folder_labels[0],
        key="sx.reels.folder_pills",
        label_visibility="collapsed",
    )

    selected_folder = "ALL FOLDERS"
    if selected_label:
        idx = folder_labels.index(selected_label)
        selected_folder = folder_options[idx]

    c1, c2, c3, c4 = st.columns([2, 2, 3, 1])
    with c1:
        codec_mode = st.selectbox(
            "Codec",
            ["HEVC 4K (Raw Master)", "H.264 4K (Web & VR)", "ALL CODECS"],
            key="sx.reels.codec_mode",
            label_visibility="collapsed",
            help="Meta Quest 3 Browser features native 4K HEVC hardware decoding for zero-lag playback.",
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
        if st.button("↻ RESCAN", key="sx.reels.rescan", use_container_width=True):
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

    # Serve video streams based on selected codec mode
    root_dir = str(OUTPUT_DIR.resolve())
    video_payload = []

    media_tunnel_url = st.session_state.get("sx.reels.media_tunnel", "")

    hevc_needs_proxy = []
    for item in filtered_videos:
        src_path = item["path"]
        codec = M.get_video_codec(src_path)

        play_path = src_path
        if codec_mode == "HEVC 4K (Raw Master)":
            play_path = src_path
        else:
            # H.264 (Web & VR) or ALL CODECS
            if codec not in {"h264", "avc1"}:
                preview_p = Path(src_path).with_name(Path(src_path).stem + "-preview.mp4")
                if preview_p.exists() and preview_p.stat().st_size > 0:
                    play_path = str(preview_p)
                elif codec_mode == "H.264 4K (Web & VR)":
                    # Auto-generate H.264 proxy on the fly if H.264 mode is explicitly selected
                    proxy = M.make_web_preview(src_path, height=3840)
                    if proxy:
                        play_path = proxy
                    else:
                        hevc_needs_proxy.append(src_path)

        play_codec = M.get_video_codec(play_path)
        url = MS.media_url(root_dir, play_path) or MS.media_url(
            str(Path(play_path).parent), play_path
        )
        if url:
            is_proxy = play_path != src_path
            video_payload.append({
                "url": url,
                "filename": item["filename"],
                "folder": item["folder"],
                "size": item["size_human"],
                "path": item["rel_path"],
                "codec": play_codec.upper(),
                "is_proxy": is_proxy,
                "stream_tag": "H.264 4K PROXY" if is_proxy else f"{codec.upper()} MASTER",
                "tunnel_url": media_tunnel_url.strip() if media_tunnel_url else "",
            })

    if hevc_needs_proxy:
        st.info("💡 Some videos are HEVC. Click below to generate 4K H.264 Web & VR streams.")
        if st.button("⚡ GENERATE H.264 4K PROXIES", key="sx.reels.gen_proxies"):
            with st.spinner("Generating 4K H.264 streams for browser & VR playback…"):
                for p in hevc_needs_proxy:
                    M.make_web_preview(p, height=3840)
            st.success("4K H.264 streams generated!")
            st.rerun()

    with st.expander("⚙️ ADVANCED PROXY & HTTPS TUNNEL CONTROLS"):
        st.caption("If accessing over HTTPS tunnel (localtunnel / ngrok), paste the port 8502 tunnel URL below and click **SET TUNNEL**.")
        tc1, tc2 = st.columns([3, 1])
        with tc1:
            media_tunnel_val = st.text_input(
                "Media Tunnel URL",
                value=st.session_state.get("sx.reels.media_tunnel", ""),
                placeholder="e.g. https://xxxx.loca.lt",
                key="sx.reels.media_tunnel_input",
                label_visibility="collapsed",
            )
        with tc2:
            if st.button("SET TUNNEL 🔗", key="sx.reels.set_tunnel", use_container_width=True):
                st.session_state["sx.reels.media_tunnel"] = media_tunnel_val.strip()
                st.success(f"Applied Tunnel: {media_tunnel_val.strip()}")
                st.rerun()

        if st.session_state.get("sx.reels.media_tunnel"):
            st.info(f"🔗 Active Media Tunnel: `{st.session_state.get('sx.reels.media_tunnel')}`")

        st.divider()
        st.caption("Re-encode all HEVC 4K master videos into ultra-sharp 3840×3840 H.264 streams for WebXR & browser playback.")
        if st.button("⚡ FORCE RE-TRANSCODE ALL 4K H.264 PROXIES", key="sx.reels.force_retranscode"):
            with st.spinner("Force re-encoding all 4K H.264 streams…"):
                for item in raw_videos:
                    src_p = item["path"]
                    if M.get_video_codec(src_p) not in {"h264", "avc1"}:
                        preview_p = Path(src_p).with_name(Path(src_p).stem + "-preview.mp4")
                        if preview_p.exists():
                            try:
                                preview_p.unlink()
                            except OSError:
                                pass
                        M.make_web_preview(src_p, height=3840)
            st.success("All 4K H.264 proxies re-generated!")
            st.rerun()

    if not video_payload:
        C.accent_block(
            "CANNOT SERVE VIDEOS",
            ["Videos could not be served over loopback HTTP media server."],
        )
        return

    # Render HTML5 1:1 Square Reels Component with 4K Master URLs
    # Stable cache buster: uses webxr_vr.js file modification time.
    # Only changes when the JS file itself is updated → no unnecessary iframe reloads.
    vr_js_path = Path(__file__).parent.parent / "assets" / "webxr_vr.js"
    js_mtime = int(vr_js_path.stat().st_mtime) if vr_js_path.exists() else 0
    html = _template().replace("__VIDEO_DATA_JSON__", json.dumps(video_payload))
    html = html.replace("</head>", f"<script>const _VR_MTIME={js_mtime};</script></head>", 1)
    components.html(html, height=750)

    # Info footer / list view
    with st.expander(f"▸ 4K REELS PLAYLIST METADATA ({len(video_payload)} VIDEOS)"):
        for idx, item in enumerate(video_payload, 1):
            st.text(f"{idx:02d}. [{item['folder']}] {item['filename']} ({item['size']}) [{item['stream_tag']}]")
