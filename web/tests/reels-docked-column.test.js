import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (rel) => readFileSync(join(root, rel), 'utf-8');
const html = read('ui/assets/reels.html');
const globalCss = read('web/src/styles/global.css');
const body = html.slice(html.indexOf('<body>'), html.indexOf('<script>__QUEST_CONTROLLER_IMG_JS__'));
const idCount = (id) => (body.match(new RegExp('\\bid="' + id + '"', 'g')) || []).length;
const normalizeQuery = (query) => query.replace(/\s+/g, '').toLowerCase();

// Ids the player script wires up. Each must exist exactly once or init breaks / double binds.
const LEGACY_IDS = [
  'reelsFrame', 'reelsVideo', 'videoWrap', 'soundBtn', 'modeBtn', 'likeBtn', 'likeCount', 'commentBtn', 'commentBadge',
  'shareBtn', 'fullBtn', 'vrBtn', 'vrBtnWrap', 'moreBtn', 'railPrimary', 'railMore', 'railBackBtn', 'saveBtn', 'reportBtn',
  'notInterestedBtn', 'hideCreatorBtn', 'preloadBtn', 'preloadLabel', 'edgeNav', 'edgePrevBtn', 'edgeNextBtn', 'reelsMeta',
  'metaFolder', 'metaCreator', 'followPill', 'followPillLabel', 'metaTitle', 'metaSize', 'metaViews', 'progressWrap',
  'progressBar', 'progressFill', 'timeDisplay', 'commentMarkers', 'commentsDrawer', 'drawerTitle', 'closeDrawerBtn',
  'commentsList', 'tabAll', 'tabSync', 'tabGeneral', 'accountBtn', 'accountAvatar', 'accountName', 'syncTimeToggle',
  'syncTimeDisplay', 'commentForm', 'commentInput', 'commentSubmitBtn', 'twitchCommentTicker', 'centerFlash', 'errorOverlay',
  'errorText', 'skipErrorBtn', 'timesyncIconTpl', 'reelsActions', 'reelsAmbientGlow', 'packModeBar', 'packQueuePanel',
  'packStageCard', 'collectMenuPanel', 'saveBtn',
];
const NEW_IDS = [
  'reelsGutter', 'reelsSide', 'sideCommentsSlot', 'sideAvatar', 'sideCreator', 'sideAge', 'sideFollow', 'sideFollowLabel',
  'sideTitle', 'sideCaption', 'sideCaptionToggle', 'sideTags', 'sideSpecs', 'sideLikes', 'sideComms', 'sideViews',
];

test('every id the player script depends on still exists exactly once', () => {
  for (const id of new Set(LEGACY_IDS)) assert.equal(idCount(id), 1, id);
});

test('the details column has all of its hooks, and the comments UI was not duplicated', () => {
  for (const id of NEW_IDS) assert.equal(idCount(id), 1, id);
  // the drawer is MOVED into the column, never cloned (duplicate ids would break the composer)
  assert.equal(idCount('commentsList'), 1);
  assert.equal(idCount('commentInput'), 1);
  assert.equal(idCount('commentForm'), 1);
});

test('the column is hidden until the dock logic shows it, and is labelled', () => {
  assert.match(body, /<aside class="reels-side" id="reelsSide" aria-label="[^"]+" hidden>/);
  assert.match(body, /<div class="reels-gutter" id="reelsGutter" hidden><\/div>/);
});

test('only real data is shown: none of the mockup-only telemetry made it in', () => {
  for (const fake of ['REC_STATION', 'FOVO', 'COLOR_LOG', 'TOKYO-JP', 'ACEScg', 'verified', 'SHARES']) {
    assert.ok(!html.includes(fake), fake + ' must not appear in the player');
  }
});

test('there is no play/pause button on the rail (clicking the video does that)', () => {
  assert.ok(!/<button[^>]*id="playBtn"/.test(body));
  assert.match(html, /e\.target\.tagName === 'VIDEO'[\s\S]{0,400}togglePlay\(\)/);
});

test('the dock breakpoint is identical in the player script, the mount and the skeleton', () => {
  const script = html.match(/const DOCK_QUERY = '([^']+)'/);
  assert.ok(script, 'DOCK_QUERY defined');
  const wanted = normalizeQuery(script[1]);
  const mediaQueries = [...globalCss.matchAll(/@media\s*(\([^{]*\))\s*\{\s*\n\s*\.(sx-reels-mount|sx-skel-player)\b/g)];
  const byTarget = Object.fromEntries(mediaQueries.map((m) => [m[2], normalizeQuery(m[1])]));
  assert.equal(byTarget['sx-reels-mount'], wanted, 'mount media query');
  assert.equal(byTarget['sx-skel-player'], wanted, 'skeleton media query');
});

test('docking only happens in the SPA embed and never while a VR session is presenting', () => {
  const fn = html.slice(html.indexOf('function vrPresenting()'), html.indexOf('function drawerBlocksPlayer()'));
  assert.match(fn, /!dockHost/);
  assert.match(fn, /isCurrentFullscreen\(\)/);
  assert.match(fn, /WebXRVR\.isPresenting/);
  assert.match(fn, /sx-immersive-preview-source/);
  // The app adds sx-vr-active in plain fullscreen too (to hide the site header), so it must NOT gate the dock.
  assert.doesNotMatch(fn, /sx-vr-active/);
});

test('fullscreen gets its own, smaller breakpoint and a class the layout hangs off', () => {
  const query = html.match(/const FS_DOCK_QUERY = '([^']+)'/);
  assert.ok(query, 'FS_DOCK_QUERY defined');
  assert.match(html, /window\.matchMedia\(FS_DOCK_QUERY\)/);
  const mode = html.slice(html.indexOf('function dockMode()'), html.indexOf('function wantsDock()'));
  assert.match(mode, /isCurrentFullscreen\(\)\) return \(fsDockMQ && fsDockMQ\.matches\) \? 'fullscreen' : ''/);
  assert.match(mode, /dockMQ\.matches \? 'inline' : ''/);
  // VR (a live WebXR session) is checked before any 2D layout is chosen
  assert.ok(mode.indexOf("if (vrPresenting()) return ''") > 0, 'VR gate present');
  assert.ok(mode.indexOf("if (vrPresenting()) return ''") < mode.indexOf("isCurrentFullscreen()"), 'VR gate comes first');
  const apply = html.slice(html.indexOf('function applyDock()'), html.indexOf('function teardownDock()'));
  assert.match(apply, /dockHost\.classList\.toggle\('sx-fs-docked', mode === 'fullscreen'\)/);
  assert.match(apply, /dockRoot\.classList\.toggle\('sx-fs-docked', mode === 'fullscreen'\)/);
  const teardown = html.slice(html.indexOf('function teardownDock()'), html.indexOf('function relativeAge'));
  assert.match(teardown, /fsDockMQ\.removeEventListener\('change', applyDock\)/);
  assert.match(teardown, /sx-fs-docked/);
});

test('the fullscreen-docked layout overrides the full-bleed fullscreen rules', () => {
  const rule = (selector) => {
    const start = html.indexOf(selector + ' {');
    assert.ok(start > 0, selector);
    return html.slice(start, html.indexOf('}', start));
  };
  assert.match(rule('#sxReelsHost.sx-fs-docked'), /display: grid !important;/);
  assert.match(rule('#sxReelsHost.sx-fs-docked'), /grid-template-columns: minmax\(0, min\(100dvh,/);
  const frame = rule('#sxReelsHost.sx-fs-docked .reels-phone-frame');
  for (const decl of ['position: relative !important', 'inset: auto !important', 'width: 100% !important', 'height: auto !important', 'aspect-ratio: 1 / 1 !important']) {
    assert.ok(frame.includes(decl), decl);
  }
  // the action bar must not keep the 64px page-edge offset that made room for the old fixed chevrons
  assert.match(rule('#sxReelsHost.sx-fs-docked .reels-actions'), /right: 14px !important;/);
  assert.match(rule('#sxReelsHost.sx-fs-docked .reels-reticle'), /display: block;/);
});

test('plain fullscreen on a phone is left alone: no class, so the old full-bleed layout and sheet apply', () => {
  // every fullscreen-docked rule hangs off .sx-fs-docked, which only applyDock() sets when FS_DOCK_QUERY matches
  assert.equal((html.match(/classList\.(add|toggle)\('sx-fs-docked'/g) || []).length, 2);
  assert.match(html, /FS_DOCK_QUERY = '\(min-width:1000px\) and \(min-height:520px\)'/);
});

test('every place that used to treat an open sheet as blocking now asks drawerBlocksPlayer()', () => {
  // Docked, the comments are always "open"; the ticker, wheel, touch and click handlers must still work.
  assert.equal((html.match(/commentsDrawer\.classList\.contains\('open'\)/g) || []).length, 2,
    'only drawerBlocksPlayer() and toggleDrawer() may read the raw open class');
  assert.ok((html.match(/drawerBlocksPlayer\(\)/g) || []).length >= 8);
  const ticker = html.slice(html.indexOf('function updateTwitchTicker()'), html.indexOf('function updateTwitchTicker()') + 400);
  assert.match(ticker, /drawerBlocksPlayer\(\)/);
});

test('the rail keeps its structure and every icon, and gains accessible names', () => {
  const rail = body.slice(body.indexOf('id="reelsActions"'), body.indexOf('id="edgeNav"'));
  for (const token of ['SOUND_MUTE', 'BACK', 'LIKE', 'COMMENT', 'SHARE', 'FULLSCREEN', 'VR', 'MORE', 'SAVE', 'REPORT', 'PRELOAD']) {
    assert.ok(rail.includes('__ICON_' + token + '__'), token + ' icon kept');
  }
  assert.ok(rail.includes('thumb_down') && rail.includes('person_off'));
  const buttons = [...rail.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
  assert.ok(buttons.length >= 13);
  for (const tag of buttons) assert.match(tag, /aria-label="[^"]+"/, tag);
  assert.match(rail, /id="likeBtn"[^>]*aria-pressed/);
  assert.match(rail, /id="moreBtn"[^>]*aria-expanded/);
  assert.match(rail, /role="toolbar"/);
});

test('prev/next are labelled and live in a group', () => {
  const nav = body.slice(body.indexOf('id="edgeNav"'), body.indexOf('id="timesyncIconTpl"'));
  assert.match(nav, /role="group"/);
  assert.match(nav, /id="edgePrevBtn"[^>]*aria-label="Previous reel"/);
  assert.match(nav, /id="edgeNextBtn"[^>]*aria-label="Next reel"/);
});

test('the scrubber is a keyboard-operable slider', () => {
  assert.match(body, /id="progressBar" role="slider" tabindex="0"[^>]*aria-valuemin="0"[^>]*aria-valuemax="100"/);
  assert.match(html, /progressBar\.setAttribute\('aria-valuenow'/);
  assert.match(html, /progressBar\.addEventListener\('keydown'/);
});

test('the action bar is restyled: glass panel, rounded keys, accents, reticle and handle', () => {
  assert.match(html, /\.reels-cluster \{[^}]*border-radius: 12px;/);
  assert.match(html, /\.reels-cluster \{[^}]*backdrop-filter: blur\(12px\);/);
  assert.match(html, /\.action-btn \{[^}]*border-radius: 8px;/);
  assert.match(html, /#modeBtn\.active \{[^}]*background: #FF3B1F;/);
  assert.match(html, /#vrBtn \{[^}]*#A855F7/);
  assert.match(html, /\.reels-reticle\.tl/);
  assert.match(html, /\.reels-progress-fill::after/);
  // regression: an active button must not paint a dark label on its dark background
  assert.doesNotMatch(html, /\.action-btn\.active \.action-btn-label \{\s*color: #0A0A0A;/);
});

test('reduced motion and focus rings are handled', () => {
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /\.action-btn:focus-visible/);
});

test('VR callbacks no longer overwrite the sound button markup', () => {
  assert.doesNotMatch(html, /soundBtn\.textContent = /);
});

test('image reels never pop time-synced comments', () => {
  const ticker = html.slice(html.indexOf('function updateTwitchTicker()'), html.indexOf('function openDrawerToComment'));
  assert.match(ticker, /isImageItem\(videoData\[idx\]\)/);
});

test('ticker pills are keyboard reachable', () => {
  assert.match(html, /pill\.setAttribute\('role', 'button'\)/);
  assert.match(html, /pill\.tabIndex = 0/);
});

test('the keyframes the ticker and highlight need are still defined for the server to pass through', () => {
  assert.match(html, /@keyframes slideUpTicker/);
  assert.match(html, /@keyframes commentPulse/);
});

test('the player still ends with the literal the server rewrites for deep links (exactly once)', () => {
  assert.equal((html.match(/loadVideo\(0\);/g) || []).length, 1);
});

test('the Reels page has no Video Playlist section and lifts the 1440px content cap', () => {
  const page = read('web/src/pages/ReelsPage.jsx');
  assert.doesNotMatch(page, /Video Playlist|MATCHING PLAYLIST/);
  assert.match(page, /<div className="sx-reels-page">/);
  assert.match(globalCss, /\.sx-main:has\(> \.sx-reels-page\) \{\s*max-width: min\(100%, 2560px\);/);
  // the player grid (page script, skeleton) grows with the screen instead of stopping at 860px and 400px
  assert.equal((html.match(/min\(84dvh, 1100px\)\) 64px clamp\(320px, 30vw, 600px\)/g) || []).length, 1);
  assert.match(globalCss, /min\(84dvh, 1100px\)\) 64px clamp\(320px, 30vw, 600px\)/);
});

test('the Reels page scrolls the square into view once on load, and other pages are not affected', () => {
  const page = read('web/src/pages/ReelsPage.jsx');
  assert.match(page, /<ReelsPlayer params=\{playerParams\} initialIndex=\{initialIndex\} revealOnLoad \/>/);
  const player = read('web/src/components/ui/ReelsPlayer.jsx');
  assert.match(player, /revealOnLoad = false/);
  assert.match(player, /revealOnLoad && !previewMode && !revealedRef\.current/);
  assert.match(player, /if \(userScrolledRef\.current\) return;/);
  assert.match(player, /window\.scrollTo\(\{ top: target, behavior: 'auto' \}\)/);
  // a hidden or background tab never fires requestAnimationFrame, so the wait must be a timer
  const wait = player.slice(player.indexOf('const tryReveal'), player.indexOf('let previewFrame'));
  assert.doesNotMatch(wait, /requestAnimationFrame/);
  for (const other of ['PackPage.jsx', 'ImmersivePreviewPage.jsx']) {
    let source = '';
    try { source = read('web/src/pages/' + other); } catch { continue; }
    assert.doesNotMatch(source, /revealOnLoad/, other + ' must not auto-scroll');
  }
});
