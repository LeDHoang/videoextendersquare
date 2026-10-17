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
