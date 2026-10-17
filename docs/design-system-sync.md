# Design-system sync log

Changes made in this repo (`UI-consistent` branch) that the ECHO design system artifact
(https://claude.ai/artifact/TUMS2mP8Mtk8zjMXipwooT) does not have yet. Sync the artifact
**after** the branch merges, not before. Source of truth for values: `web/src/styles/tokens.css`.

## Token value changes

None so far. No existing token value was changed.

## New tokens (additions only)

| Token | Value | Why |
|---|---|---|
| `--sx-font-display` | `'Archivo Black', Archivo, sans-serif` | Replaces 11 reads of the undefined `--sx-display` and repeated literal stacks |
| `--sx-font-sans` | `Archivo, ui-sans-serif, system-ui, -apple-system, sans-serif` | Body stack |
| `--sx-font-mono` | `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace` | Replaces reads of the undefined `--sx-mono` |
| `--sx-font-brand` | `Orbitron, 'Archivo Black', sans-serif` | Wordmark only (owner decision) |
| `--sx-header-h` | `64px`, `58px` at 640px and below | App header height used by shell, docks and fullscreen |
| `--sx-opacity-disabled` | `0.4` | ECHO README: disabled = 0.4 |
| `--sx-accent-border` | `rgba(255, 59, 31, 0.45)` | Accent counterpart of the status `-border` tokens |
| `--sx-z-header` | `30` | Z scale slot for the app header |
| `--sx-z-tabbar` | `35` | Z scale slot for the mobile bottom nav |
| `--sx-z-dock` | `80` | Z scale slot for the reels dock |
| `--sx-z-fullscreen` | `90` | Z scale slot for fullscreen players (pinned `91` collect dialog sits above it) |
| `--sx-z-xr-overlay` | `200` | Z scale slot for XR DOM overlays |

## WCAG AA findings and how they were resolved

Contrast ratios computed against ECHO surfaces (`bg #08090a` ... `surface-3 #1d2126`).

| Pair | Ratio | Resolution |
|---|---|---|
| `--sx-ink-muted` `#646b74` as text | 3.0 to 3.7:1 (fails 4.5:1) | Value kept. It is now **non-text only** (borders, dividers, 3:1 UI boundaries). All 22 text uses repointed to `--sx-ink-3` (`#8e959e`, 5.35 to 6.59:1) |
| White (`#fff`) on `--sx-accent` | 3.4:1 | Replaced by `--sx-on-accent` `#0a0a0a` (5.56:1) in 6 rules |
| White on `--sx-danger` `#ef4444` (BlockingBanner README) | 3.76:1 | To be replaced by `--sx-on-accent` (5.26:1) in WS6; README rule to change in the artifact |
| `--sx-danger` `#ef4444` as text on `surface-3` | 4.30:1 | Use `--sx-danger-hi` for text (`#f87171`, 5.85 to 7.20:1). `#fca5a5` literals replaced by it |

## ECHO artifact updates to apply after merge

- Add the tokens above to the Tokens page.
- State that `--sx-ink-muted` is for non-text only; use `--sx-ink-3` for muted text.
- BlockingBanner README: dark `--sx-on-accent` text on `--sx-danger`, no tinted shadow (WS6).

## Scales documented, not changed (WS9)

- Breakpoints in use: 640px (phone), 700px (reels dock, paired CSS and JS in `AppShell.jsx` and `reels.html`; do not change one side), 900px and 1100px (layout). ECHO defines none; the artifact should document this scale rather than adopt a new one.
- z-index: tokenised slots are base 1, sticky 10, header 30, tabbar 35, drawer-backdrop 40, drawer 45, dropdown 50, dock 80, fullscreen 90, modal 100, xr-overlay 200, skip-link 999. `.reels-collect-dialog` stays at 91 (test-pinned). Many legacy literals in `global.css` (25, 26, 900, 1000-1300, 99999, 100000) were left alone: remapping changes stacking order and needs a visual pass per surface.
- Runtime custom properties (`--sx-fs-safe-bottom`, `--sx-bottom-nav`, `--sx-dock-head`, `--sx-studio-top`) are set from JS or component CSS, so they are intentionally absent from `tokens.css`.
- Forced-colors, coarse-pointer 44px targets, 16px mobile inputs and reduced-motion rules added at the end of `global.css`.
- Legacy Streamlit tokens (`ui/assets/app.css`, `ui/tokens.py`): `--sx-ink-2` `#9BA1A8` to `#A4ABB3`, `--sx-ink-3` `#5F666D` to `#8E959E`, matching ECHO and AA on `--sx-bg`.
