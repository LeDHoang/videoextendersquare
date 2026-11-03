# Paper & Ink Light/Dark Theme Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the original dark look of the 2D web app with Paper & Ink, in a light and a dark version that the viewer picks with a switch in the sidebar.

**Architecture:** The Red branch already converts the app to Paper & Ink in light colours. This plan adds dark mode as one more token block, `:root[data-theme='dark']`, which redeclares only the colours that differ, copied from the Dark red variant. A small theme module owns the `data-theme` attribute on `<html>` and the saved choice. An inline script sets the attribute before first paint, and the sidebar shows a LIGHT / DARK switch bound to it.

**Tech Stack:** React 18 and Vite, plain CSS custom properties, Vitest with Testing Library (jsdom), `node --test`, Stylelint.

**Spec:** The request was: "turn the original UI into the paper&ink both light and dark mode version theme based on a switch inside the sidebar, it shouldnt touch BE or functional just reworking UI". The reference variants are reviewed in `docs/paper-ink/index.html` on `palette-test`:
- Light mode is the Red variant (`c93e508`).
- Dark mode is the Dark red variant (`5ab914c`).

## Where things stand

| Piece | State |
|---|---|
| P&I conversion in light colours | Done on `redesign/editorial-ink-red` (`c93e508`), 6 files, +1008 / −296 against `3861f7b` (details below the table). |
| Dark colours | Exist only as a separate variant, `redesign/editorial-ink-dark` (`5ab914c`). It differs from Red in 3 files only (details below the table). |
| Switch, saved choice, first-paint script | Nothing yet. |

The conversion on `c93e508` touched:
- `index.html`: fonts and meta tags.
- `main.jsx`: imports `editorial.css`.
- `editorial.css`: new, 579 lines.
- `global.css`: literal colours replaced with tokens.
- `tokens.css`: the `:root:root` block and `#sxReelsRoot`.
- The guardrail baseline.

The Dark red variant differs from Red in:
- 40 colour tokens plus `color-scheme`.
- The two meta tags.
- Five icon re-ink rules, which it removes.

So the work is mostly additive. Red becomes light mode, and Dark red's colour block becomes dark mode.

## Global Constraints

- Frontend only. Change nothing under `server/`, `ui/`, the Streamlit app or the VR assets. Add no API calls, routes or behaviour beyond colours and the switch.
- Keep the first `:root {` block of `web/src/styles/tokens.css` byte-identical. `ui/tokens.py` and `web/tests/echo-token-parity.test.js` parse it as the contract with `ui/assets/reels.html` and the VR canvas.
- Copy light values exactly from `c93e508` and dark values exactly from `5ab914c`. Add no new colour values beyond the four status tokens Task 5 copies from `5ab914c`.
- Theme values are `'light'` and `'dark'`. Save them in localStorage under `sx.theme`, which matches the existing `sx.explore.density`. Wrap every storage read and write in try/catch.
- `<html data-theme>` is the only switch. CSS reads it; nothing else does.
- Hex and `rgb()` values belong only in `tokens.css`, which Stylelint enforces. When a literal goes from `global.css`, lower its count in `web/tests/css-guardrails.test.js`.
- Keep the reels player (`#sxReelsRoot`) carbon in both modes.
- Add no npm dependencies.
- Write commit messages in plain prose, with no Co-Authored-By or "Generated with" lines.

## Review Focus

1. **Hard reload with dark saved.** No paper should flash before dark appears. Task 2 pins this with the bootstrap test, and Task 6 has a reload check.
2. **Storage blocked** (Safari private mode, blocked site data). The switch should still change the page for the session, and nothing should throw. Task 2 pins this.
3. **No saved choice, and the OS flips light/dark while the app is open.** The app should follow until the viewer picks, then ignore OS changes. Task 2 pins this.
4. **Hard-coded dark panels in light mode** (mobile bottom nav, studio banner, tuning output, studio flags). Their text should stay readable. Task 5 makes the edits and Task 6 checks them.
5. **Cloudflare Turnstile on `/signup`.** The widget should match the page theme when it mounts. Task 5 makes the change and Task 6 checks it.

---

### Task 1: Dark token block

**Files:**
- Branch: `redesign/paper-ink-theme`, from `redesign/editorial-ink-red` (`c93e508`)
- Modify: `web/src/styles/tokens.css`. Insert after line 246, the end of the second 640px media block, and before the reels comment at line 248.
- Create: `web/tests/paper-ink-theme.test.js`

**Interfaces:**
- Produces: the CSS selector `:root[data-theme='dark']`. A missing attribute, or `light`, means light mode.

- [ ] **Step 1: Branch**

```bash
git switch -c redesign/paper-ink-theme c93e508
```

- [ ] **Step 2: Write the failing test.** Use `node --test`, in the style of `tests/echo-token-parity.test.js`.

  Test `dark block redeclares every light colour except the shared ones`:
  - Parse the first `:root:root {…}` block and the `:root[data-theme='dark'] {…}` block of `tokens.css` into name → value maps.
  - The light colour names are the declarations whose value contains `#` or `rgba(`.
  - Define `SHARED = ['--sx-spot', '--sx-spot-soft', '--sx-on-spot', '--sx-on-media', '--sx-media-scrim']`.
  - Assert that every light colour name not in `SHARED` is in the dark map. That is 40 names.
  - Assert that the dark map has `color-scheme` set to `dark`.
  - Assert that the dark map declares nothing else. Fonts, sizes and the radius stay shared.

- [ ] **Step 3: Run the test and expect it to fail**

Run: `cd web && node --test tests/paper-ink-theme.test.js`
Expected: FAIL, because the dark block is not found.

- [ ] **Step 4: Insert the block.** Add a comment, then the selector. Copy the body verbatim from Dark red:

```bash
git show 5ab914c:web/src/styles/tokens.css | sed -n '150,176p;186,205p;229,232p'
```

The ranges cover three groups:
- Lines 150–176: `color-scheme`, surfaces, rules, ink and accent.
- Lines 186–205: status colours.
- Lines 229–232: shadows.

The comment should say two things:
- Dark mode is the magazine printed in reverse, and only colours change.
- The block has the same specificity as `:root:root`, so it has to stay after it.

- [ ] **Step 5: Run the test and the token contracts, and expect them to pass**

```bash
cd web && node --test tests/paper-ink-theme.test.js tests/echo-token-parity.test.js
```

```bash
../../../.venv/bin/python -m pytest -q tests/test_ui_tokens.py
```

Expected: everything passes. Run the second command from the worktree root.

- [ ] **Step 6: Commit**

```bash
git add web/src/styles/tokens.css web/tests/paper-ink-theme.test.js
git commit -m "Paper & Ink: dark mode token block"
```

### Task 2: Theme module and first-paint script

**Files:**
- Create: `web/src/theme.js`
- Create: `web/src/theme.test.js`
- Modify: `web/index.html`. Change the meta tags at lines 6–7 and add the script right after them.

**Interfaces:**
- Produces, from `web/src/theme.js`:
  - `THEME_KEY = 'sx.theme'`
  - `THEME_COLOR = { light: '#f2ede3', dark: '#0c0b09' }`
  - `currentTheme(): 'light' | 'dark'`. It reads `document.documentElement.dataset.theme`. Anything other than `'dark'` counts as `'light'`.
  - `applyTheme(theme: 'light' | 'dark'): void`. It sets `data-theme` on `<html>` and sets the content of `meta[name="theme-color"]`.
  - `useTheme(): [theme, setTheme]`:
    - The state starts at `currentTheme()`.
    - `setTheme(next)` applies the theme, updates the state and saves it under `THEME_KEY`.
    - While no valid choice is saved, the hook follows `matchMedia('(prefers-color-scheme: dark)')` change events.
    - The hook stops following once `setTheme` runs.
- No React context. Only the Sidebar uses the hook, and Turnstile reads `currentTheme()` once.

- [ ] **Step 1: Write the failing tests** in `src/theme.test.js`, with Vitest.
  - Use `renderHook` and `act` from Testing Library, as `src/hooks/useCreditQuotes.test.jsx` does.
  - In `afterEach`, clear localStorage, `data-theme` and the stubs.

  The tests:
  - `applyTheme sets the attribute and the browser colour`:
    - Add `<meta name="theme-color">` to the head.
    - After `applyTheme('dark')`, `dataset.theme === 'dark'` and the meta content is `'#0c0b09'`.
    - After `applyTheme('light')`, the meta content is `'#f2ede3'`.
  - `useTheme starts from the attribute the script set`: with `dataset.theme = 'dark'`, `result.current[0] === 'dark'`.
  - `setTheme applies and remembers`: after `setTheme('dark')`, all of these hold:
    - `dataset.theme === 'dark'`
    - `localStorage.getItem('sx.theme') === 'dark'`
    - `result.current[0] === 'dark'`
  - `setTheme works when storage throws`:
    - Mock storage with `vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); })`.
    - `setTheme('dark')` does not throw, and `dataset.theme === 'dark'`.
  - `follows the OS until the viewer picks`:
    - Stub `window.matchMedia` with an object whose `addEventListener('change', fn)` captures `fn`.
    - `fn({ matches: true })` makes the theme `'dark'`.
    - Call `setTheme('light')`. Calling `fn({ matches: true })` again leaves the theme `'light'`.
  - `works without matchMedia`: jsdom has no matchMedia, so with no stub, `renderHook(useTheme)` does not throw.
  - `index.html script uses the same key and colours`: read `../index.html` with `fs`. It contains:
    - `` `getItem('${THEME_KEY}')` ``
    - `THEME_COLOR.light` and `THEME_COLOR.dark`
    - `<meta name="color-scheme" content="light dark" />`

- [ ] **Step 2: Run the tests and expect them to fail**

Run: `cd web && npx vitest run src/theme.test.js`
Expected: FAIL, because `./theme.js` is not found.

- [ ] **Step 3: Implement `web/src/theme.js`** as the Interfaces block says.
  - Guard `window.matchMedia?.(…)`, as `components/layout/AppShell.jsx:25` does.
  - Use the storage try/catch from `components/explore/ExploreChrome.jsx:13-30`.

- [ ] **Step 4: Edit `web/index.html`**
  - Change `<meta name="color-scheme" content="light" />` to `content="light dark"`.
  - Keep `theme-color` at `#f2ede3`, the default without JavaScript.
  - Right after the two tags, add this exact script. It is classic and inline, so it runs before the CSS paints:

```html
    <script>
      (function () {
        var theme;
        try { theme = localStorage.getItem('sx.theme'); } catch (e) {}
        if (theme !== 'light' && theme !== 'dark') {
          theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        document.documentElement.dataset.theme = theme;
        document.querySelector('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#0c0b09' : '#f2ede3');
      })();
    </script>
```

  The server needs no change. `nonce_html` in `server/security_headers.py` stamps the per-request CSP nonce on every `<script` in the SPA HTML, and this script is included. CSP is off in dev.

- [ ] **Step 5: Run the tests and expect them to pass**

Run: `npx vitest run src/theme.test.js`
Expected: PASS.

- [ ] **Step 6: Check that the built page gets its nonce**

```bash
npx vite build
```

Then, from the worktree root:

```bash
../../../.venv/bin/python -c "from server.security_headers import nonce_html; import re; html = nonce_html(open('web/dist/index.html').read(), 'n0'); print(len(re.findall(r'<script nonce=\"n0\"', html)), html.count('<script'))"
```

Expected: the two numbers are equal and at least 2. That covers the theme script and the module entry.

- [ ] **Step 7: Commit**

```bash
git add web/src/theme.js web/src/theme.test.js web/index.html
git commit -m "Paper & Ink: theme module and first-paint script"
```

### Task 3: Icon re-ink in light mode only

The icon art is drawn for dark surfaces. On paper, five rules re-ink it. On carbon, the original strokes are already right, which is why `5ab914c` removed those rules.

**Files:**
- Modify: `web/src/styles/editorial.css:139-156`
- Test: `web/tests/paper-ink-theme.test.js`

- [ ] **Step 1: Write the failing test** `icon re-ink rules apply in light mode only`. Every selector in `editorial.css` that contains `svg:not(.sx-echo-mark` must start with `:root:not([data-theme='dark']) `. There are 5 such rules.

- [ ] **Step 2: Run the test and expect it to fail**

Run: `cd web && node --test tests/paper-ink-theme.test.js`
Expected: FAIL, with 0 of 5 rules scoped.

- [ ] **Step 3: Prefix the five selectors** with `:root:not([data-theme='dark']) `. Add one sentence to the comment at line 139: on carbon, the art's own colours already fit.

- [ ] **Step 4: Run the test and the linter, and expect both to pass**

```bash
node --test tests/paper-ink-theme.test.js
```

```bash
/opt/homebrew/bin/node node_modules/.bin/stylelint src/styles/editorial.css
```

Expected: the test passes and Stylelint reports no findings.

- [ ] **Step 5: Commit**

```bash
git add web/src/styles/editorial.css web/tests/paper-ink-theme.test.js
git commit -m "Paper & Ink: re-ink icons in light mode only"
```

### Task 4: Sidebar switch

**Files:**
- Modify: `web/src/components/layout/Sidebar.jsx`. Change the imports at lines 1–9 and add the switch after `</nav>` at line 195, before the billing card.
- Modify: `web/src/styles/global.css`. Add a `.sx-sidebar-theme` rule after `.sx-sidebar-card-title` at line 1070.
- Test: `web/src/components/layout/Sidebar.test.jsx`

**Interfaces:**
- Consumes:
  - `useTheme()` from `../../theme.js`.
  - `Segmented({ options, value, onChange, ariaLabel })` from `../ui/controls.jsx`. It is a radiogroup with roving focus.

- [ ] **Step 1: Write the failing tests** in a new `describe('Sidebar colour theme switch')`.
  - Use the file's existing mocks: `mockUseAuth` returns `{ user: null }`, and `mockUseWallet` returns the guest wallet from the first test.
  - In `afterEach`, run `localStorage.clear()` and `delete document.documentElement.dataset.theme`.

  The tests:
  - `shows LIGHT checked by default`:
    - `getByRole('radiogroup', { name: 'Colour theme' })` exists.
    - `getByRole('radio', { name: 'LIGHT' })` has `aria-checked="true"`.
  - `DARK applies and remembers the theme`. Clicking the `DARK` radio gives:
    - `document.documentElement.dataset.theme === 'dark'`
    - `localStorage.getItem('sx.theme') === 'dark'`
    - `DARK` has `aria-checked="true"`.

- [ ] **Step 2: Run the tests and expect them to fail**

Run: `cd web && npx vitest run src/components/layout/Sidebar.test.jsx`
Expected: FAIL, because there is no radiogroup named "Colour theme".

- [ ] **Step 3: Implement.** Import `Segmented` with the existing `Button, Field` import, and import `useTheme`. Call `const [theme, setTheme] = useTheme();` in the component body. Add this markup after the nav. The copy is fixed:

```jsx
      {/* ─── Colour Theme ─────────────────────────────────── */}
      <div className="sx-sidebar-theme">
        <span className="sx-sidebar-card-title">APPEARANCE</span>
        <Segmented
          options={['LIGHT', 'DARK']}
          value={theme.toUpperCase()}
          onChange={(opt) => setTheme(opt.toLowerCase())}
          ariaLabel="Colour theme"
        />
      </div>
```

  Add the rule to `global.css`:

```css
.sx-sidebar-theme {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sx-3);
  flex-shrink: 0;
}
```

- [ ] **Step 4: Run the tests and expect them to pass**

Run: `npx vitest run src/components/layout/Sidebar.test.jsx`
Expected: PASS, including the existing billing tests.

- [ ] **Step 5: Check it in the browser.** Look at the 1280 sidebar and the mobile drawer at 375, in both modes. Check four things:
  - The row sits under the nav grid without wrapping. The sidebar is 320px wide.
  - Tab reaches the switch and shows a focus ring.
  - The arrow keys move between the two options.
  - The page changes instantly.

  If the row wraps, change only `.sx-sidebar-theme` to `flex-direction: column; align-items: stretch`.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/layout/Sidebar.jsx web/src/components/layout/Sidebar.test.jsx web/src/styles/global.css
git commit -m "Paper & Ink: light/dark switch in the sidebar"
```

### Task 5: Light-mode fixes for hard-coded dark panels, and Turnstile

These panels hard-code near-black backgrounds but take their text colour from tokens. On paper, that text goes dark on dark. The Red variant has the same bugs today. They sit on signed-in and mobile pages that the variant screenshots never reached.

**Files:**
- Modify: `web/src/styles/global.css`, the lines in the table below.
- Modify: `web/src/styles/tokens.css:248-274`, the reels island.
- Modify: `web/src/components/auth/Turnstile.jsx:44`
- Modify: `web/tests/css-guardrails.test.js:11-12`

**Interfaces:**
- Consumes: `currentTheme()` from Task 2.

| `global.css` line | Selector | Now | Change to |
|---|---|---|---|
| 1103–1104 | `.sx-dot-warning` | `#f59e0b`, glow `rgba(245, 158, 11, 0.6)` | `var(--sx-warn)`, glow `var(--sx-warn-border)` |
| 7610 | `.sx-immersive-tuning-out pre` | `#050608` | `var(--sx-surface-2)` |
| 10808, 10811 | `.sx-bottom-nav` | `rgba(13, 14, 16, 0.96)`, border `#24282e` | `var(--sx-surface-glass)`, `var(--sx-rule)` |
| 10827 | `.sx-bottom-nav-item:focus-visible` | `outline: 2px solid #fff` | `outline: var(--sx-focus-ring)` |
| 10941 | `.sx-studio-banner` | `#0d0e10` | `var(--sx-surface-2)` |
| 11639 | `.sx-studio-badge.sx-ok` | `rgba(5, 46, 22, 0.4)` | `var(--sx-success-dim)` |

**Studio stage flags.** `.sx-studio-flag` renders inside `.sx-studio-stage` (`StudioStage.jsx:256-317`) over black video, so it stays dark in both modes. Make the stage a carbon island like the reels player:
- In `tokens.css`, change `#sxReelsRoot {` to `#sxReelsRoot,\n.sx-studio-stage {`.
- Add the dark status values that the flags use, copied from `5ab914c`:
  - `--sx-success-hi: #4ade80;`
  - `--sx-success-border: rgba(34, 197, 94, 0.35);`
  - `--sx-warn-hi: #fde047;`
  - `--sx-warn-border: rgba(242, 199, 68, 0.35);`
- Add one sentence to the comment saying the studio stage is a screening room too.

**Turnstile.** In `Turnstile.jsx:44`, change `theme: 'dark'` to `theme: currentTheme()`, imported from `'../../theme.js'`. The widget takes the theme when it mounts. If the viewer switches while `/signup` is open, the widget follows on the next visit.

**Leave these alone.** They are media, or fixed on purpose:
- `#000` video wells, and scrims over photos and video.
- `.sx-share-qr img` `#fff`, because scanners need the white quiet zone.
- The VR preview stages: `.sx-immersive-preview-stage`, `.sx-vr-workbench-stage` and `.sx-vr-workbench-canvas--overlay`.
- `.sx-studio-stage` `#030405`.
- The inline `#000` panes and the chip over video in `ComparePage.jsx`.
- `VRPanelWorkbench.jsx`, which is VR.

- [ ] **Step 1: Make the edits** in the table, the island and Turnstile.

- [ ] **Step 2: Run the guardrail and expect it to fail**

Run: `cd web && node --test tests/css-guardrails.test.js`
Expected: FAIL with "color-no-hex went down to 21" and "function-disallowed-list went down to 31".

- [ ] **Step 3: Lower the baseline** in `tests/css-guardrails.test.js` to the numbers the failure reports. Expect 21 and 31.

- [ ] **Step 4: Run the guardrail, Stylelint and Vitest, and expect them to pass**

```bash
node --test tests/css-guardrails.test.js
```

```bash
/opt/homebrew/bin/node node_modules/.bin/stylelint "src/**/*.css"
```

```bash
npx vitest run
```

Expected: everything passes. Stylelint reports only baseline findings.

- [ ] **Step 5: Commit**

```bash
git add web/src/styles/global.css web/src/styles/tokens.css web/src/components/auth/Turnstile.jsx web/tests/css-guardrails.test.js
git commit -m "Paper & Ink: readable dark panels on paper; Turnstile follows the theme"
```

### Task 6: QA matrix

**Files:** none in the repo. Screenshots go to scratch space. The capture script is `scripts/capture_redesigns.cjs`, untracked on `palette-test`.

- [ ] **Step 1: Run the full suite and build**

```bash
cd web && PATH=/opt/homebrew/bin:$PATH npm test
```

```bash
npx vite build
```

```bash
../../../.venv/bin/python -m pytest -q tests/test_ui_tokens.py
```

Expected: all pass. The first command runs 544 existing tests plus the new ones. Run the last command from the worktree root.

- [ ] **Step 2: Start the app**
  - API: `.venv/bin/uvicorn server.app:app --port 8000`
  - Vite: `npx vite --port 5186 --strictPort`

- [ ] **Step 3: Capture the matrix.** The redesign must reach every page of the 2D site. Cover all 28 routes in `src/App.jsx:41-68` in both themes, at 1280×800 and 375×812. Set the theme before load with `page.addInitScript(() => localStorage.setItem('sx.theme', 'dark'))`, or `'light'`.

| Access | Routes |
|---|---|
| Public | `/explore`, `/explore/tag/<seeded tag>`, `/explore/location/<key>`, `/reels`, `/packs/<id>`, `/profile/<seeded user>` |
| Public, auth | `/login`, `/signup`, `/verify-email`, `/forgot-password`, `/reset-password` |
| Public, legal | `/terms`, `/privacy`, `/rules`, `/support` |
| Public, fallback | `/nope`, the 404 page |
| Signed in | `/upload`, `/messages`, `/messages/<id>`, `/wallet`, `/settings/profile`, `/packs/new`, `/packs/<id>/edit` |
| Admin | `/image`, `/video`, `/compare`, `/reels/immersive-preview` (page chrome only), `/moderation` |

  Keep the screenshot list in the capture script in sync with `App.jsx`. A route added later without a screenshot counts as uncovered.

- [ ] **Step 3b: Capture the surfaces that no route shows on load.** Open each one in both themes at 1280 and 375:
  - The mobile sidebar drawer and the bottom nav.
  - Every modal and dialog: report, share and QR, delete confirmation, and the pack picker.
  - Menus, dropdowns, tooltips and toasts.
  - The empty, loading and error states of `/explore`, `/messages` and `/wallet`.
  - Form validation errors on `/signup` and `/settings/profile`.
  - The moderation overview charts (`OverviewDashboard.jsx` draws SVG).

- [ ] **Step 4: Review each shot** for these problems:
  - Dark text on dark, or light text on light.
  - Icons that vanish.
  - An unreadable mobile bottom nav.
  - A reels player that is not carbon.
  - Turnstile in the wrong theme on `/signup`, when a site key is set.
  - Missing focus rings. Tab through the sidebar and the switch.

- [ ] **Step 5: Check first paint and the OS default**
  - Save dark, then hard-reload `/explore` with the Performance panel recording. No paper-coloured frame should appear.
  - Clear `sx.theme` and flip the OS appearance. The open app should follow.

- [ ] **Step 6: Check contrast.** In each mode, check each text token on `bg`, `surface` and `surface-2`. The text tokens are `ink`, `ink-2`, `ink-3`, `ink-muted`, `accent`, `success`, `warn`, `danger` and `info`. Each pair must reach at least 4.5:1. Fix any miss in that mode's token block only.

- [ ] **Step 7: Stop both servers.**

### Task 7: Ship

- [ ] Merge `redesign/paper-ink-theme` into `palette-test`. Do not target `main` yet. The merge commit message lists:
  - The two modes and their source variants.
  - The Task 5 fixes.
  - The QA matrix results.
  - The out-of-scope items below.
- [ ] After the merge, retire `redesign/editorial-ink-dark`, because its values now live in the dark block.

---

## Out of scope

- VR UI. It comes in a later plan. This covers the immersive preview stage, the VR workbench, `VRPanelWorkbench.jsx`, `ui/assets/reels.html` and the VR canvas. The 2D page chrome around them is in scope.
- Backend work:
  - A theme saved to the account, which would need an API and a DB field.
  - A server-rendered `data-theme`.
- `ui/` tokens, `reels.html`, the VR canvas and Streamlit.
- New colours, or layout changes beyond Task 5.
- Removing the original dark tokens. The first `:root` block is the VR and reels contract, so it stays.

## Open decisions

1. **First-visit default.** Follow the OS, as this plan does, or always start light?
2. **Dev palette preview.** In dev, its `data-palette` rules load later and override both modes. Keep it as is?

## Size

About 11 files and roughly +300 / −20 lines on top of `c93e508`. Most of the additions are the 47 copied token lines and the tests. Stylesheet changes outside the token block are under 30 lines.
