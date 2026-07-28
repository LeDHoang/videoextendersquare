"""Design tokens for Square Extender 4K — bold editorial theme.

These are the single source of truth for colors, sizes, and spacing.
Keep in sync with:
  - .streamlit/config.toml (theme keys)
  - ui/assets/app.css (CSS custom properties)
  - Any st.markdown(..., unsafe_allow_html=True) that interpolates these values
"""

# Color palette
COLOR_BG = "#08090A"
COLOR_SURFACE = "#101214"
COLOR_SURFACE_2 = "#16191C"
COLOR_RULE = "#24282D"
COLOR_RULE_STRONG = "#3A4047"
COLOR_INK = "#F2F3F5"
COLOR_INK_2 = "#9BA1A8"
COLOR_INK_3 = "#5F666D"
COLOR_ACCENT = "#FF3B1F"
COLOR_ACCENT_HI = "#FF5C42"
COLOR_ACCENT_DIM = "rgba(255,59,31,0.12)"
COLOR_ON_ACCENT = "#0A0A0A"
COLOR_WARN = "#F2C744"

# Type scale (with baseFontSize=15, 1rem=15px)
TYPE_HERO = "clamp(2.75rem, 7vw, 5.25rem)"  # Archivo Black
TYPE_DISPLAY = "3rem"  # Archivo Black
TYPE_NUMERAL = "4.5rem"  # Archivo Black
TYPE_STAT = "2.25rem"  # 800 weight
TYPE_H2 = "1.4rem"  # 800 weight
TYPE_BODY = "0.9375rem"  # 400 weight
TYPE_EYEBROW = "0.6875rem"  # 700 mono
TYPE_MONO = "0.8125rem"  # 400 mono

# Spacing scale (4px base)
SP_1 = "4px"
SP_2 = "8px"
SP_3 = "12px"
SP_4 = "16px"
SP_5 = "24px"
SP_6 = "32px"
SP_7 = "48px"
SP_8 = "64px"
SP_9 = "96px"

# Rule weights
RULE_HAIRLINE = "1px"
RULE_HEAVY = "3px"
RULE_ACCENT = "6px"

# Fonts
FONT_DISPLAY = "'Archivo Black', Archivo, 'Arial Black', system-ui, sans-serif"
FONT_UI = "Archivo, ui-sans-serif, system-ui, sans-serif"
FONT_MONO = "'JetBrains Mono', ui-monospace, monospace"
