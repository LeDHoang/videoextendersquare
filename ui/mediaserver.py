"""Loopback HTTP media server for the compare slider.

Replaces the old `http.server` on a hardcoded port 8080 that the user had to
start by hand and which failed silently (videos simply never loaded).

Binds 127.0.0.1 on an ephemeral port, serves only from one root directory, and
supports range requests so the compare slider can seek.
"""

import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

import streamlit as st


class _JailedHandler(SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler with a hard root jail and no request logging."""

    def log_message(self, fmt, *args):  # noqa: A003 - silence console spam
        pass

    def translate_path(self, path):
        resolved = Path(super().translate_path(path)).resolve()
        root = Path(self.directory).resolve()
        if not resolved.is_relative_to(root):
            return str(root / "__forbidden__")
        return str(resolved)


@st.cache_resource(show_spinner=False)
def local_media_server(root: str) -> tuple[str, int]:
    """Start (once per process) a loopback server rooted at `root`."""
    Path(root).mkdir(parents=True, exist_ok=True)
    handler = partial(_JailedHandler, directory=str(Path(root).resolve()))
    # Port 0 → OS picks a free port; never bind 0.0.0.0.
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host, port = httpd.socket.getsockname()[:2]
    return host, port


def media_url(root: str, path: str | Path) -> str | None:
    """URL for a file under `root`, or None if it escapes the jail."""
    root_p = Path(root).resolve()
    target = Path(path).resolve()
    if not target.is_relative_to(root_p):
        return None
    host, port = local_media_server(str(root_p))
    rel = target.relative_to(root_p).as_posix()
    return f"http://{host}:{port}/{quote(rel)}"
