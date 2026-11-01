"""Design tokens for Square Extender 4K, read from web/src/styles/tokens.css.

tokens.css is the single source of truth. This module parses its :root block at
import, so the names below always hold the web app's current values; add a name
here by pointing it at a token, never by copying a value.

Still hand-kept, because they cannot read CSS: .streamlit/config.toml (theme keys)
and the :root block of ui/assets/app.css.
"""

import re
from pathlib import Path

_CSS = Path(__file__).resolve().parent.parent / "web" / "src" / "styles" / "tokens.css"
_ROOT = re.search(r":root\s*\{(.*?)\n\}", _CSS.read_text(encoding="utf-8"), re.S).group(1)

# Every --sx-* custom property in :root, e.g. TOKENS["--sx-accent"] == "#ff3b1f".
TOKENS = {
    name: re.sub(r"/\*.*?\*/", "", value).strip()
    for name, value in re.findall(r"(--sx-[a-z0-9-]+)\s*:\s*([^;]+);", _ROOT)
}

# Color palette
COLOR_BG = TOKENS["--sx-bg"]
COLOR_SURFACE = TOKENS["--sx-surface"]
COLOR_SURFACE_2 = TOKENS["--sx-surface-2"]
COLOR_RULE = TOKENS["--sx-rule"]
COLOR_RULE_STRONG = TOKENS["--sx-rule-strong"]
COLOR_INK = TOKENS["--sx-ink"]
COLOR_INK_2 = TOKENS["--sx-ink-2"]
COLOR_INK_3 = TOKENS["--sx-ink-3"]
COLOR_ACCENT = TOKENS["--sx-accent"]
COLOR_ACCENT_HI = TOKENS["--sx-accent-hi"]
COLOR_ACCENT_DIM = TOKENS["--sx-accent-dim"]
COLOR_ON_ACCENT = TOKENS["--sx-on-accent"]
COLOR_WARN = TOKENS["--sx-warn"]

# Type scale (root font size is 15px, so 1rem = 15px)
TYPE_HERO = TOKENS["--sx-t-hero"]
TYPE_DISPLAY = TOKENS["--sx-t-display"]
TYPE_NUMERAL = TOKENS["--sx-t-numeral"]
TYPE_STAT = TOKENS["--sx-t-stat"]
TYPE_H2 = TOKENS["--sx-t-h2"]
TYPE_BODY = TOKENS["--sx-t-body"]
TYPE_EYEBROW = TOKENS["--sx-t-eyebrow"]
TYPE_MONO = TOKENS["--sx-t-mono"]

# Spacing scale (4px base)
SP_1 = TOKENS["--sx-1"]
SP_2 = TOKENS["--sx-2"]
SP_3 = TOKENS["--sx-3"]
SP_4 = TOKENS["--sx-4"]
SP_5 = TOKENS["--sx-5"]
SP_6 = TOKENS["--sx-6"]
SP_7 = TOKENS["--sx-7"]
SP_8 = TOKENS["--sx-8"]
SP_9 = TOKENS["--sx-9"]

# Rule weights: the width part of each rule shorthand ("1px solid var(--sx-rule)" -> "1px")
RULE_HAIRLINE = TOKENS["--sx-rule-hairline"].split()[0]
RULE_HEAVY = TOKENS["--sx-rule-heavy"].split()[0]
RULE_ACCENT = TOKENS["--sx-rule-accent"].split()[0]

# Fonts
FONT_DISPLAY = TOKENS["--sx-font-display"]
FONT_UI = TOKENS["--sx-font-sans"]
FONT_MONO = TOKENS["--sx-font-mono"]
