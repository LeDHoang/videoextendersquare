"""Editorial typographic primitives.

The bold-editorial look is a handful of repeated gestures. Centralizing them
here is what keeps three views visually identical instead of ad-hoc.

All emitted classes are .sx-* prefixed, styled in ui/assets/app.css, so none
of this depends on Streamlit's internal DOM.
"""

import html
from typing import Iterable

import streamlit as st


def _esc(s) -> str:
    return html.escape(str(s))


def hero(title: str, kicker: str = "") -> None:
    """The wordmark. Once per page. Solid ink with a 6px accent rule beneath."""
    st.markdown(
        f'<div class="sx-hero">{_esc(title)}</div>'
        + (f'<div class="sx-eyebrow">{_esc(kicker)}</div>' if kicker else ""),
        unsafe_allow_html=True,
    )


def eyebrow(text: str) -> None:
    st.markdown(f'<div class="sx-eyebrow">{_esc(text)}</div>',
                unsafe_allow_html=True)


def rule(weight: str = "hair") -> None:
    cls = {"hair": "sx-rule", "heavy": "sx-rule sx-heavy",
           "accent": "sx-rule sx-accent"}[weight]
    st.markdown(f'<hr class="{cls}">', unsafe_allow_html=True)


def body(text: str, secondary: bool = False) -> None:
    cls = "sx-body sx-body-secondary" if secondary else "sx-body"
    st.markdown(f'<div class="{cls}">{_esc(text)}</div>', unsafe_allow_html=True)


def mono(text: str) -> None:
    st.markdown(f'<div class="sx-mono">{_esc(text)}</div>',
                unsafe_allow_html=True)


def step_header(n: int, title: str, active: bool, note: str = "") -> None:
    """Step number in the left gutter + display title.

    Steps are never hidden — editorial layout wants the whole spread visible,
    so state controls emphasis, not visibility.
    """
    state_cls = "sx-active" if active else "sx-inactive"
    st.markdown(
        f'<div class="sx-step-head">'
        f'<span class="sx-step-numeral {state_cls}">{n:02d}</span>'
        f'<span class="sx-display {state_cls}">{_esc(title)}</span>'
        + (f'<span class="sx-eyebrow sx-step-note">{_esc(note)}</span>'
           if note else "")
        + "</div>",
        unsafe_allow_html=True,
    )


def spec_row(cells: Iterable[tuple[str, str, str]]) -> None:
    """Stat cells: (label, value, sub). Hairline-separated, tabular numerals."""
    inner = "".join(
        f'<div class="sx-stat-cell">'
        f'<div class="sx-stat-label">{_esc(label)}</div>'
        f'<div class="sx-stat-value">{_esc(value)}</div>'
        + (f'<div class="sx-eyebrow">{_esc(sub)}</div>' if sub else "")
        + "</div>"
        for label, value, sub in cells
    )
    st.markdown(f'<div class="sx-stat-row">{inner}</div>', unsafe_allow_html=True)


def accent_block(title: str, lines: Iterable[str], tone: str = "accent",
                 code: Iterable[str] = ()) -> None:
    """Explanation block with a heavy left rule. tone: "accent" | "warn"."""
    cls = "sx-accent-block" + (" sx-warn" if tone == "warn" else "")
    paras = "".join(f"<p>{_esc(x)}</p>" for x in lines)
    codes = "".join(f'<div class="sx-mono">{_esc(c)}</div>' for c in code)
    st.markdown(
        f'<div class="{cls}">'
        f'<div class="sx-accent-block-title">{_esc(title)}</div>'
        f'<div class="sx-accent-block-body">{paras}{codes}</div>'
        f"</div>",
        unsafe_allow_html=True,
    )


def empty_state(title: str, text: str, hint: str = "") -> None:
    st.markdown(
        f'<div class="sx-empty-state">'
        f'<div class="sx-empty-state-title">{_esc(title)}</div>'
        f'<p class="sx-empty-state-body">{_esc(text)}</p>'
        + (f'<div class="sx-mono">{_esc(hint)}</div>' if hint else "")
        + "</div>",
        unsafe_allow_html=True,
    )


def blocking_banner(title: str, lines: Iterable[str]) -> None:
    """Full-bleed solid accent bar. The loudest thing on the page, by design —
    the only place the accent goes edge to edge."""
    paras = "".join(f"<p>{_esc(x)}</p>" for x in lines)
    st.markdown(
        f'<div class="sx-blocking-banner">'
        f'<div class="sx-blocking-banner-title">{_esc(title)}</div>'
        f'<div class="sx-blocking-banner-body">{paras}</div>'
        f"</div>",
        unsafe_allow_html=True,
    )


def result_header(title: str, meta: str) -> None:
    st.markdown(
        f'<div class="sx-result-hero-header">'
        f'<span class="sx-result-hero-title">{_esc(title)}</span>'
        f'<span class="sx-result-hero-meta">{_esc(meta)}</span>'
        f"</div>"
        f'<hr class="sx-rule sx-accent">',
        unsafe_allow_html=True,
    )


def gated_reason(text: str) -> None:
    """The reason a control is disabled, rendered adjacent to it.

    Rule for this app: never disable a control without an adjacent reason.
    """
    st.markdown(
        f'<div class="sx-gated-reason">{_esc(text)}</div>',
        unsafe_allow_html=True,
    )


def health_row(glyph_class: str, label: str, detail: str) -> str:
    glyph = {"sx-ok": "■", "sx-degrade": "▲", "sx-block": "●"}[glyph_class]
    return (
        f'<div class="sx-health-row">'
        f'<span class="sx-health-glyph {glyph_class}">{glyph}</span>'
        f'<span class="sx-health-label">{_esc(label)}</span>'
        f'<span class="sx-health-detail">{_esc(detail)}</span>'
        f"</div>"
    )
