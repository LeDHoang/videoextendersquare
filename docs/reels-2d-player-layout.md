# Reels 2D player: layout and maintenance notes

The 2D player is **not React**. `ui/assets/reels.html` (markup + CSS + JS in one file) is assembled by
`server/routers/reels.py` (`GET /api/reels/player-inline`) and injected by
`web/src/components/ui/ReelsPlayer.jsx` into `#sxReelsRoot > #sxReelsHost`. The same file also serves the
standalone page at `/api/reels/player`.

## Layout

- **Square player** (`#reelsFrame`) with the action bar (`#reelsActions`, primary + MORE groups) inside it, the
  bottom-left comment pop-up ticker (`#twitchCommentTicker`) and the scrubber.
- **Docked details column** (desktop SPA embed only): `#reelsSide` (creator, title, caption, tags, location, real
  QUEUE/SIZE/RES/DUR chips, stats) with the comments drawer inside it, and `#reelsGutter` holding PREV/NEXT.
  `applyDock()` MOVES `#commentsDrawer` and `#edgeNav` between the frame and the column (never clones them, so ids and
  handlers stay unique). Below the breakpoint, in fullscreen and in VR, they go back into the frame and the old bottom
  sheet and fixed page-edge chevrons apply.
- **Breakpoint** `(min-width:1100px) and (min-height:560px)` lives in three places that must match:
  `DOCK_QUERY` in `reels.html`, the `.sx-reels-mount` media query and the `.sx-skel-player` media query in
  `web/src/styles/global.css` (a node test pins this).
- **Fullscreen** (2D only) docks the same column when the screen is at least `(min-width:1000px) and (min-height:520px)`
  (`FS_DOCK_QUERY`, JS only, so no CSS copy to keep in sync). `applyDock()` adds `sx-fs-docked` to the host: it becomes a
  grid of a screen-high square, the gutter and the column, and the frame stops being a full-bleed fixed layer (the
  `#sxReelsHost.sx-fs-docked ...` rules carry two ids so they beat the full-bleed fullscreen rules). Below that size (phones,
  small tablets) nothing changes: full-bleed fullscreen, fixed chevrons and the slide-up comments sheet. Standalone
  `/api/reels/player` never docks.
- **VR is untouched.** `dockMode()` returns '' while a WebXR session is presenting (and for the hidden preview source), and
  `webxr_vr.js` is not modified. Do not gate on the `sx-vr-active` class: the app also sets it in plain fullscreen.
- The frame uses `overflow: clip` (not `hidden`) so nothing can scroll the picture inside it (the ambient glow overflows by 20px).
- On phones (`max-width:700px`) the PREV/NEXT chevrons sit on the left edge (the right edge is the action bar) and the
  comments sheet uses the whole frame.

## Things that bite

- `server/routers/reels.py::_scope_css` is a naive `}` splitter that prefixes every rule with `#sxReelsRoot`. Keep new CSS
  flat (one level of `@media` is fine, `@keyframes` is passed through). Avoid commas and braces inside CSS comments.
  `tests/test_recommendations.py` fails if any selector escapes the scope.
- `reels.py` still string-patches the init script (`loadVideo(0);` literal, which must appear exactly once, and the
  cleanup wrapper). The keyboard handler is attached by `reels.html` itself (`window.addEventListener('keydown', onKeydown)`).
- The key filter (`reelsKeyFilter`) is a pure function between `<reels-key-filter>` markers and is unit tested by
  extraction. It ignores typing contexts, modifier combos, Space/Enter on focused controls and any foreign modal.
- Anything that used to test `commentsDrawer.classList.contains('open')` must call `drawerBlocksPlayer()` instead,
  otherwise the ticker and gestures stop working while the column is docked.
- `AppShell` keys its providers on the user id, so a sign-in/out remounts the whole page.

## Tests

`web/tests/reels-docked-column.test.js` (structure, ids, a11y, breakpoint parity), `web/tests/reels-keyboard.test.js`
(key filter + listener wiring), `tests/test_recommendations.py` (scoping, keyframes, payload fields, init-script shape),
`tests/test_reel_packs.py` (pack items carry duration/width/height), `web/src/components/ui/Skeleton.test.jsx`.
Run everything with `make test`.
