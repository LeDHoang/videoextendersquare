"""Sidebar: API key, SYSTEM health panel, model endpoint overrides."""

import os

import streamlit as st

from ui import components as C
from ui import health as H


def _glyph_class(p: H.Probe) -> str:
    if p.ok:
        return "sx-ok"
    return "sx-block" if p.severity == "block" else "sx-degrade"


def render() -> dict:
    """Render the sidebar. Returns {"probes", "fal_key", "fal"}."""
    with st.sidebar:
        C.eyebrow("SQUARE EXTENDER")
        C.rule("accent")

        # --- API key -------------------------------------------------------
        C.eyebrow("FAL.AI KEY")
        env_key = os.environ.get("FAL_KEY", "")
        fal_key = st.text_input(
            "fal.ai API key",
            type="password",
            value=env_key,
            label_visibility="collapsed",
            placeholder="fal_…",
            help="Read from .env if left blank. Needed only for outpainting.",
            key="sx.w.fal_key",
        )
        if fal_key:
            os.environ["FAL_KEY"] = fal_key
        fal = H.fal_key_probe()
        st.markdown(
            C.health_row(_glyph_class(fal), "KEY", fal.detail),
            unsafe_allow_html=True,
        )

        # --- SYSTEM --------------------------------------------------------
        st.markdown("")
        C.eyebrow("SYSTEM")
        nonce = st.session_state.get("sx.probe_nonce", 0)
        probes = H.probe_environment(nonce)

        rows = "".join(
            C.health_row(_glyph_class(p), p.label, p.detail)
            for p in probes.values()
        )
        st.markdown(rows, unsafe_allow_html=True)

        # Every non-ok probe explains itself and how to fix it.
        degraded = [p for p in probes.values() if not p.ok]
        if degraded:
            with st.expander(f"▸ {len(degraded)} ISSUE(S)"):
                for p in degraded:
                    st.markdown(f"**{p.label}** — {p.detail}")
                    C.body(p.fix, secondary=True)
                    st.markdown("")

        if st.button("↻ RECHECK", key="sx.w.recheck", width="stretch"):
            st.session_state["sx.probe_nonce"] = nonce + 1
            st.cache_resource.clear()
            st.rerun()

        # --- Model endpoints ----------------------------------------------
        st.markdown("")
        with st.expander("▸ MODEL ENDPOINTS"):
            models = {
                "outpaint_img": st.text_input(
                    "Image outpaint", value="fal-ai/flux/outpaint",
                    key="sx.w.m_outpaint_img"),
                "upscale_img": st.text_input(
                    "Image upscale", value="fal-ai/clarity-upscaler",
                    key="sx.w.m_upscale_img"),
                "outpaint_vid": st.text_input(
                    "Video outpaint", value="fal-ai/ltx-2.3-quality/outpaint",
                    key="sx.w.m_outpaint_vid"),
                "upscale_vid": st.text_input(
                    "Video upscale", value="fal-ai/seedvr/upscale/video",
                    key="sx.w.m_upscale_vid"),
            }

        if os.environ.get("SX_DEBUG"):
            with st.expander("▸ STATE"):
                st.json({k: str(v)[:200] for k, v in st.session_state.items()})

    return {"probes": probes, "fal_key": fal_key, "fal": fal, "models": models}
