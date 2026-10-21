# Accessibility pass

Date: 2026-10-21. Covers the beta checklist item "Verify keyboard navigation, focus visibility, reduced-motion behavior, readable contrast ... and responsive layouts" in `docs/to-beta.md`. Captions are out of scope for the beta (decided 2026-10-21).

The automated part is `scripts/verify_a11y.cjs`. It drives headless Chrome 155 over the DevTools protocol against the local staging stack (`docs/local-staging.md`), signs in as `alice@example.com`, and checks 11 pages at 1440 px. It does not replace a screen reader pass or a run on a phone.

```
node scripts/verify_a11y.cjs
```

## What the script checks

| Check | Result is |
| --- | --- |
| Interactive element without an accessible name (label, `aria-label`, `aria-labelledby`, text, image `alt`, SVG title, `title`) | failure |
| Tab order: thirty Tab presses from the top of the page; a repeat inside the first eight stops means a focus trap | failure |
| Image without `alt` | reported |
| Text below WCAG AA contrast (4.5, or 3 for large text), with translucent backgrounds blended | reported |
| Focus moved off screen, `<html lang>` missing, not exactly one `<h1>`, viewport that blocks pinch zoom | reported |
| Visible focus style on links, buttons and `[role]` elements | reported |

Text fields are not checked for focus style. They show focus through a border or box-shadow on themselves or on a wrapper (`.sx-input:focus`, `.sx-command-box:focus-within`, `.comment-input-wrap:focus-within` in `global.css` and `reels.html`), which the script cannot diff. A global `:focus-visible` outline covers everything else (`global.css:722`).

## Result

Pages: login, sign up, reels, explore, profile, settings, wallet, upload, messages, support, privacy.

- No focus traps. Every page reaches 17 to 30 distinct tab stops in order, starting with the skip link.
- No images without `alt`, no missing `lang`, no page that blocks zoom.
- No text below AA contrast once translucent backgrounds are blended. The first run flagged the `IMAGE` badge on Explore tiles (dark text on a 90% red); that was the script ignoring the alpha, not a defect.
- Two unnamed controls on `/reels`, both text inputs that relied on a placeholder:
  - the reels search field (`web/src/pages/ReelsPage.jsx`), now `aria-label="Search reels"`;
  - the comment field in the legacy player (`ui/assets/reels.html`, `#commentInput`), now `aria-label="Add a comment"`.

The staging stack must be rebuilt for those two labels to show up in a re-run.

## Not covered

- Screen readers (VoiceOver, TalkBack, NVDA). The names above come from the accessibility inputs, not from how a reader announces them.
- The immersive (WebXR) player. It draws to a canvas, so none of these checks apply; it is part of the Quest matrix in `docs/browser-matrix.md`.
- Mobile layout at 375 px and reduced-motion behavior on every page. Explore tiles skip video preloading under `prefers-reduced-motion` (`ExploreTile.jsx`); other animations were not audited.
- Contrast of text over video, where it depends on the frame shown.
- Captions and transcripts.
