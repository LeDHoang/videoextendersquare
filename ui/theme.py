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
    """
    css = _load_css()
    st.markdown(f"<style>{css}</style>", unsafe_allow_html=True)
