# UI beta: simplified Reels and Explore for regular users

Branch `ui-beta` (from `vr-rea-playback`). Started 2026-10-29.

## Goal

Invited beta users get a cleaner site. Admins (`role === 'admin'`, set through
`SX_ADMIN_USERS`) keep the full UI. This is one SPA with role-gated controls: no second build,
no new routes, no backend or player change.

## Decisions

- The simplified UI is the default for everyone. Admins see everything.
- **VR:** only the desktop Immersive Preview page (`/reels/immersive-preview`) becomes
  admin-only. The player's VR button and stereo playback in `ui/assets/reels.html` stay.
- **Filters left for regular users:** search, plus tag and location chips/pages.
- **Kept for regular users:** FOR YOU / FOLLOWING, ALL / REELS / PACKS tabs, grid density,
  SHUFFLE.
- **Made admin-only:**
  - Reels: folder, codec, 3D and sort pickers; ↻; Quest & Tools; IMMERSIVE PREVIEW; Proxy;
    Spatialize; the FOLDERS / CODEC / STATUS stats.
  - Explore: folder and codec pickers; ↻; the FOLDERS / CODEC stats.
  - Tag and location pages: RANK and SOURCE.
  - The Image, Video and Compare pages and their nav links.
- **Unchanged:** Earth, Packs, wallet/credits, Upload.
- **Codec default stays HEVC master.** Accepted risk: browsers without HEVC decode show no
  video for mono reels, and regular users can't switch to H.264.
- Default state values are unchanged, so regular users send the same API params as before,
  and deep links (`?folder&codec&sort&play`) keep working.

## Tasks

- [x] **1. Branch and this doc.**
  - Check: `git branch --show-current` is `ui-beta`.
- [x] **2. Admin-only routes.**
  - `web/src/components/auth/RequireAuth.jsx`: add the `adminOnly` prop. Non-admins go to
    `/reels`.
  - `web/src/App.jsx`: use `<RequireAuth adminOnly>` on `/image`, `/video`, `/compare` and
    `/reels/immersive-preview`.
  - Test: new `RequireAuth.test.jsx`.
  - Check: `npx vitest run src/components/auth`.
- [x] **3. Reels page** (`web/src/pages/ReelsPage.jsx`).
  - Row 1: folder, codec, 3D and sort are admin-only. FOR YOU / FOLLOWING and search stay.
  - Row 2 (utilities) is admin-only.
  - Hero: FOLDERS, CODEC and STATUS are admin-only.
  - Empty state: for regular users, plain text and no debug hint.
  - Test: new `ReelsPage.test.jsx`.
  - Check: that vitest file, plus `node --test tests/reels-stereo.test.js tests/reels-docked-column.test.js`.
- [x] **4. Explore page** (`web/src/pages/ExplorePage.jsx`).
  - Folder, codec and ↻ are admin-only, as are the FOLDERS and CODEC stats.
  - Test: new `ExplorePage.test.jsx`.
  - Check: that vitest file, plus `node --test tests/reels-pack-visual.test.js`.
- [x] **5. Tag and location pages** (`TagExplorePage.jsx`, `LocationExplorePage.jsx`).
  - RANK and SOURCE are admin-only.
  - Test: new `TagExplorePage.test.jsx`.
  - Check: that vitest file.
- [x] **6. Navigation** (`HeaderBar.jsx`, `Sidebar.jsx`).
  - The Compare, Image and Video links are admin-only.
  - The header search shortcuts to those pages are skipped for regular users.
  - Tests: extend `HeaderBar.test.jsx` and `Sidebar.test.jsx`.
  - Check: those vitest files.
- [x] **7. Docs.**
  - `docs/to-beta.md`: beta scope and the immersive-preview item.
  - `README.md`: the Reels player and Scene Inspector entries.
  - Check: the diff touches only those lines.
- [~] **8. Full suite.**
  - Check: `make test` and `cd web && npm run build` both pass.
- [ ] **9. Live check** (`make dev`, with `SX_ADMIN_USERS=<admin>`).
  - As a regular user, walk `/reels`, `/explore`, `/explore/tag/<t>` and
    `/explore/location/<k>`.
  - Each admin-only route should redirect to `/reels`.
  - Header search for "compare" should land on an Explore search.
  - The player's VR button should still show on localhost.
  - As the admin, the UI should be unchanged.
  - Check the layout at 375 px and the sidebar grid.
  - Record what was not checked.

## Progress log

- 2026-10-29: Task 1 done. Created branch `ui-beta` from `vr-rea-playback` (`9d638e8`) and this
  doc.
- 2026-10-29: Task 2 done. `RequireAuth` takes `adminOnly`, and `/image`, `/video`, `/compare` and
  `/reels/immersive-preview` use it. New `RequireAuth.test.jsx`: 4/4 pass.
- 2026-10-29: Task 3 done. `ReelsPage.jsx` gates the folder, codec, 3D and sort pickers, the utilities
  row, the FOLDERS / CODEC / STATUS stats and the debug empty state behind `isAdmin`. New
  `ReelsPage.test.jsx`: 3/3 pass, and the two regular-user cases fail on the old page.
  `reels-stereo` and `reels-docked-column`: 42/42 pass.
- 2026-10-29: Task 4 done. `ExplorePage.jsx` gates the folder and codec pickers, the ↻ refresh and
  the FOLDERS / CODEC stats behind `isAdmin`. Pack-error RETRY, CREATE PACK, SHUFFLE, trending,
  search, tabs and density are unchanged. New `ExplorePage.test.jsx`: 2/2 pass, and the
  regular-user case fails on the old page. `reels-pack-visual`: 20/20 pass.
- 2026-10-29: Task 5 done. `TagExplorePage.jsx` and `LocationExplorePage.jsx` read `useAuth` and
  gate RANK and SOURCE behind `isAdmin`. Tabs, density and the header SHUFFLE stay. New
  `TagExplorePage.test.jsx` covers both pages: 4/4 pass, and the regular-user cases fail on the
  old pages. `reels-docked-column`: 25/25 pass.
- 2026-10-29: Task 6 done. HeaderBar shows COMPARE only to admins, and `commandFallback` takes
  `isAdmin`, so for regular users "compare", "video" and "image" fall through to an Explore
  search. Sidebar marks Image, Video and Compare `adminOnly`, leaving 5 cards for regular users.
  `HeaderBar.test.jsx` (+2) and `Sidebar.test.jsx` (+2): 11/11 pass, and both regular-user cases
  fail on the old components. MobileBottomNav has no tool links, so it is unchanged.
- 2026-10-29: Task 7 done. `docs/to-beta.md` gets a beta-UI paragraph under the beta scope and an
  admin-only note on the immersive-preview item. `README.md` notes that folder/codec switching and
  the Scene Inspector are admin-only. The diff is 4 lines across those 2 files. Not changed: the
  README showcase sections for Image, Video and Compare, which still describe those pages without
  saying they are admin-only.
- 2026-10-29: Task 8 partly done.
  - Web suite: `cd web && npm test` passes. node:test 399/399 and vitest 495/495 (44 files).
  - Build: `npm run build` is clean.
  - The first web run failed once in `webxr-earth.test.js`. The cause was a stale local
    `node_modules`: `three` was in the lockfile but not installed. `npm install` fixed it, and
    `package.json` and the lockfile are unchanged.
  - pytest did not run. This host has only Python 3.10, and the repo pins 3.12
    (`.python-version`, `Dockerfile`; Pillow 13 does not install on 3.10). `.venv` was empty: I
    added pip with `ensurepip`, and nothing else installed. `venv2` has no sqlalchemy.
  - Risk to pytest is low. No file under `server/`, `pipeline/`, `core/` or `ui/` changed, and no
    Python test reads a changed file.
  - Still to do: `make test` on a Python 3.12 environment.
- 2026-10-29: Task 9 blocked on this host. There is no Python 3.12 backend environment and no
  browser or Playwright. The uvicorn on :8000 is an older process (started 2026-08-20 from
  `venv2`, no reload), so it does not run this branch's backend, and I left it alone. Still to do:
  the whole live checklist above, on a machine with a 3.12 env and a browser.
