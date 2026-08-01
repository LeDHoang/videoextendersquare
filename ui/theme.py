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
    st.markdown("""
    <script>
    (function() {
        if (window._xrIframePatchDone) return;
        window._xrIframePatchDone = true;

        const ALLOW_FLAGS = 'xr-spatial-tracking; fullscreen; autoplay; accelerometer; gyroscope';

        // Patch document.createElement so iframes get WebXR permissions before window initialization
        const origCreateElement = document.createElement;
        document.createElement = function(tagName, options) {
            const el = origCreateElement.call(document, tagName, options);
            if (tagName && String(tagName).toLowerCase() === 'iframe') {
                el.setAttribute('allow', ALLOW_FLAGS);
            }
            return el;
        };

        function patchIframe(el) {
            if (!el || el.tagName !== 'IFRAME') return;
            const cur = el.getAttribute('allow') || '';
            if (!cur.includes('xr-spatial-tracking')) {
                el.setAttribute('allow', cur ? cur + '; ' + ALLOW_FLAGS : ALLOW_FLAGS);
            }
        }

        document.querySelectorAll('iframe').forEach(patchIframe);

        try {
            const obs = new MutationObserver(function(mutations) {
                mutations.forEach(function(m) {
                    m.addedNodes.forEach(function(node) {
                        if (node.nodeType === 1) {
                            if (node.tagName === 'IFRAME') patchIframe(node);
                            else if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(patchIframe);
                        }
                    });
                });
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
        } catch(e) {}
    })();
    </script>
    """, unsafe_allow_html=True)
