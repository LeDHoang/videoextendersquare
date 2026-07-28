"""Namespaced session_state keys and step-flow helpers.

Replaces the old scheme of deriving keys from filenames
(f"prev_img_{name}_{size}"), which grew session_state monotonically — 40
uploads left 80 dead keys behind. Here the upload signature is stored as a
*value* under a fixed key, so the key set is bounded.

Widget keys share the namespace (wkey(IMG, "prompt") -> "sx.img.w.prompt")
so a widget can never shadow a state key.
"""

from typing import Any

import streamlit as st

IMG = "sx.img"
VID = "sx.vid"

# Leaves: step sig bytes src_path meta result log error running

STEP_UPLOAD = 1
STEP_CONFIGURE = 2
STEP_RESULT = 3


def k(ns: str, leaf: str) -> str:
    return f"{ns}.{leaf}"


def wkey(ns: str, leaf: str) -> str:
    """Widget key — separate sub-namespace so widgets can't collide with state."""
    return f"{ns}.w.{leaf}"


def get(ns: str, leaf: str, default: Any = None) -> Any:
    return st.session_state.get(k(ns, leaf), default)


def set_(ns: str, leaf: str, value: Any) -> None:
    st.session_state[k(ns, leaf)] = value


def clear(ns: str, leaf: str) -> None:
    st.session_state.pop(k(ns, leaf), None)


def step(ns: str) -> int:
    return int(get(ns, "step", STEP_UPLOAD))


def advance(ns: str, n: int) -> None:
    """Move the furthest-reached step forward only."""
    if n > step(ns):
        set_(ns, "step", n)


def upload_sig(uploaded) -> str | None:
    """Stable identity for an uploaded file. None if nothing staged."""
    if uploaded is None:
        return None
    return f"{uploaded.name}|{uploaded.size}"


def reset_from(ns: str, n: int) -> None:
    """Invalidate everything from step n onward.

    Called when a new upload arrives. Deletes staged/result files so %TEMP%
    doesn't accumulate, then clears the dependent state in one place.
    """
    from ui import media  # local import avoids a cycle

    if n <= STEP_CONFIGURE:
        media.discard_result(get(ns, "result"))
        for leaf in ("result", "log", "error", "running"):
            clear(ns, leaf)
    if n <= STEP_UPLOAD:
        media.discard_staged(get(ns, "src_path"))
        for leaf in ("sig", "bytes", "src_path", "meta"):
            clear(ns, leaf)
        set_(ns, "step", STEP_UPLOAD)
    else:
        set_(ns, "step", min(step(ns), n))
