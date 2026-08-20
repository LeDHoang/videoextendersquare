"""Environment health probing and PATH self-heal (Streamlit fallback).

Thin wrapper over `core.probes`/`core.tooling`, which are the single source
of truth shared with the FastAPI server. The only Streamlit-specific thing
here is the `@st.cache_resource` cache layer around probe_environment.

Call ensure_ffmpeg_on_path() from app.py BEFORE anything imports pipeline.
"""

import os
import subprocess

import streamlit as st

from core import probes as _probes
from core import tooling as _tooling

# Re-export the shared, single-source-of-truth symbols so existing callers
# keep working unchanged.
HEVC_CANDIDATES = _tooling.HEVC_CANDIDATES
Probe = _probes.Probe
fal_key_probe = _probes.fal_key_probe
studio_available = _probes.studio_available
blockers = _probes.blockers
smoke_encode = _tooling.smoke_encode
ensure_ffmpeg_on_path = _tooling.ensure_ffmpeg_on_path

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


@st.cache_resource(show_spinner=False)
def probe_environment(nonce: int = 0) -> dict[str, Probe]:
    """Probe the environment once per process. Bump nonce to invalidate.

    Excludes FAL_KEY, which is read live by fal_key_probe() since the user can
    type it into the sidebar mid-session.
    """
    return _probes.build_probes()
