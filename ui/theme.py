"""Theme injection for Square Extender 4K.

Loads the editorial CSS and injects it into the Streamlit page.
Called once from app.py before any view renders.
"""

import streamlit as st
from pathlib import Path


@st.cache_data(show_spinner=False)
def _load_css() -> str:
    """Load the editorial CSS file. Cached per session."""
    css_path = Path(__file__).parent / "assets" / "app.css"
    return css_path.read_text(encoding="utf-8")


def inject_theme() -> None:
    """Inject the editorial theme CSS into the page.

    Call this once from app.py, before any view renders.

    Note: web fonts are NOT loaded here. Streamlit strips <link> tags out of
    st.markdown and relocates injected <style> blocks, so neither a <link> nor
    an @import ever triggers the fetch. Fonts are declared as
    [[theme.fontFaces]] in .streamlit/config.toml instead.
    """
    css = _load_css()
    st.markdown(f"<style>{css}</style>", unsafe_allow_html=True)
