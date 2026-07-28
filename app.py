"""Square Extender 4K — Streamlit entrypoint.

Everything here is once-per-run global setup; the views live in ui/views/.

Order matters: ensure_ffmpeg_on_path() must run before anything imports
pipeline, because the workers shell out with a bare "ffmpeg"/"ffprobe" and
inherit os.environ.
"""

import streamlit as st
from dotenv import load_dotenv

from ui import health

st.set_page_config(
    page_title="Square Extender 4K",
    page_icon="◼",
    layout="wide",
    initial_sidebar_state="expanded",
)

load_dotenv()
health.ensure_ffmpeg_on_path()

from ui import sidebar, theme  # noqa: E402 - must follow the PATH heal
from ui.views import compare_view, image_view, video_view  # noqa: E402

theme.inject_theme()

_ctx = sidebar.render()


def image_page() -> None:
    image_view.render(_ctx)


def video_page() -> None:
    video_view.render(_ctx)


def compare_page() -> None:
    compare_view.render(_ctx)


# Pages, not tabs: st.tabs re-executes every branch on every rerun, which is
# why the old video tab needed such defensive temp-file handling and why the
# compare slider globbed the disk even while viewing images.
_nav = st.navigation(
    [
        st.Page(image_page, title="Image", url_path="image", default=True),
        st.Page(video_page, title="Video", url_path="video"),
        st.Page(compare_page, title="Compare", url_path="compare"),
    ],
    position="sidebar",
)
_nav.run()
