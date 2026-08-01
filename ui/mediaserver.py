"""Loopback HTTP media server for the compare slider and VR reels.

Replaces the old `http.server` on a hardcoded port 8080 that the user had to
start by hand and which failed silently (videos simply never loaded).

Binds 0.0.0.0 on a fixed port (default 8502, configurable via SX_MEDIA_PORT),
serves only from one root directory, and supports range requests so the compare
slider can seek.  The non-loopback bind allows Meta Quest browsers and HTTPS
tunnels to reach the media server.
"""

import os
import socket
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

import streamlit as st

MEDIA_PORT = int(os.environ.get("SX_MEDIA_PORT", 8502))


def _detect_lan_ip() -> str:
    """Best-effort detection of this machine's LAN IP address."""
    try:
        # Connect to a public DNS to determine the outbound interface IP.
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.1)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        pass
    try:
        return socket.gethostbyname(socket.gethostname())
    except Exception:
        return "127.0.0.1"


class _JailedHandler(SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler with root jail, CORS, Range requests (HTTP 206), and no console spam."""

    def log_message(self, fmt, *args):  # noqa: A003 - silence console spam
        pass

    def copyfile(self, source, outputfile):
        try:
            super().copyfile(source, outputfile)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        """Override do_GET to support HTTP 206 Partial Content (Range requests) for video playback."""
        range_header = self.headers.get("Range")
        if not range_header or not range_header.startswith("bytes="):
            return super().do_GET()

        path = self.translate_path(self.path)
        p = Path(path)
        if not p.is_file():
            return super().do_GET()

        file_size = p.stat().st_size
        try:
            range_val = range_header.split("=")[1].strip()
            if "-" in range_val:
                start_str, end_str = range_val.split("-", 1)
                start = int(start_str) if start_str else 0
                end = int(end_str) if end_str else file_size - 1
            else:
                start = int(range_val)
                end = file_size - 1
        except ValueError:
            return super().do_GET()

        start = max(0, min(start, file_size - 1))
        end = max(start, min(end, file_size - 1))
        length = end - start + 1

        try:
            f = open(path, "rb")
            f.seek(start)
        except OSError:
            self.send_error(404, "File not found")
            return

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()

        try:
            buffer_size = 64 * 1024
            remaining = length
            while remaining > 0:
                chunk_size = min(buffer_size, remaining)
                data = f.read(chunk_size)
                if not data:
                    break
                self.wfile.write(data)
                remaining -= len(data)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            f.close()

    def translate_path(self, path):
        resolved = Path(super().translate_path(path)).resolve()
        root = Path(self.directory).resolve()
        if not resolved.is_relative_to(root):
            return str(root / "__forbidden__")
        return str(resolved)


class _ReusableServer(ThreadingHTTPServer):
    allow_reuse_address = True


@st.cache_resource(show_spinner=False)
def local_media_server(root: str) -> tuple[str, int]:
    """Start (once per process) a loopback server rooted at `root`."""
    Path(root).mkdir(parents=True, exist_ok=True)
    handler = partial(_JailedHandler, directory=str(Path(root).resolve()))
    # Fixed port on all interfaces so VR headsets / tunnels can reach us.
    try:
        httpd = _ReusableServer(("0.0.0.0", MEDIA_PORT), handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        _host, port = httpd.socket.getsockname()[:2]
        return _host, port
    except OSError:
        # Already running on port MEDIA_PORT
        return "0.0.0.0", MEDIA_PORT


def media_url(root: str, path: str | Path, host: str | None = None) -> str | None:
    """URL for a file under `root`, or None if it escapes the jail.

    If *host* is given (e.g. the LAN IP or tunnel hostname), the URL will
    point to that host so external devices (VR headsets) can reach it.
    """
    root_p = Path(root).resolve()
    target = Path(path).resolve()
    if not target.is_relative_to(root_p):
        return None
    _bind_host, port = local_media_server(str(root_p))
    serve_host = host or _detect_lan_ip()
    rel = target.relative_to(root_p).as_posix()
    return f"http://{serve_host}:{port}/{quote(rel)}"
