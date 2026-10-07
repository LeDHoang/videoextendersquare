import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (rel) => readFileSync(join(root, rel), 'utf-8');

test('PackCover uses a persistent REEL PACK label and never raw video urls', () => {
  const src = read('web/src/components/packs/PackCover.jsx');
  assert.match(src, /REEL PACK/);
  assert.doesNotMatch(src, /<span className="sx-pack-cover-label">PACK<\/span>/);
  assert.match(src, /poster_url \|\| post\.preview_url/);
});

test('PackTile is an autoplaying labeled tile with creator, share, and owner affordances', () => {
  const src = read('web/src/components/packs/PackTile.jsx');
  assert.match(src, /role="button"/);
  assert.match(src, /REEL PACK/);
  assert.match(src, /sx-explore-stats/);
  assert.match(src, /sx-explore-creator/);
  assert.match(src, /sx-explore-share/);
  assert.match(src, /sx-explore-owner-actions/);
  assert.match(src, /preview_url/);
  assert.doesNotMatch(src, /OPEN PACK/);
  assert.doesNotMatch(src, /SAVE PACK/);
});

test('Pack tile open button and share preview have dedicated styles', () => {
  const css = read('web/src/styles/global.css');
  assert.match(css, /\.sx-pack-tile-open/);
  assert.match(css, /\.sx-share-pack-preview/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('Message pack card avoids overflow and tiny targets', () => {
  const css = read('web/src/styles/global.css');
  assert.match(css, /\.sx-message-pack-card \{[^}]*max-width: 100%/s);
  assert.match(css, /\.sx-message-pack-open \{[^}]*min-height: 40px/s);
  assert.match(css, /\.sx-message-pack-meta strong \{[^}]*overflow-wrap: anywhere/s);
});

test('Explore packs surface is labeled, retryable, and URL-synced', () => {
  const src = read('web/src/pages/ExplorePage.jsx');
  assert.match(src, /ariaLabel="Content type"/);
  assert.match(src, /aria-label="Search titles, creators, places, or tags"/);
  assert.match(src, /role="alert"/);
  assert.match(src, /RETRY/);
  assert.match(src, /requestedType/);
});

test('Player pack overlays are dialogs with focus and escape handling', () => {
  const html = read('ui/assets/reels.html');
  assert.match(html, /id="packStageCard"[^>]*role="dialog"/);
  assert.match(html, /id="packQueuePanel"[^>]*role="dialog"/);
  assert.match(html, /packStagePrimary\.focus/);
  assert.match(html, /packQueueClose\.focus/);
  assert.match(html, /isPackMode && packQueueOpen/);
  assert.match(html, /min-height:44px/);
  assert.match(html, /max-height:calc\(100% - 88px\)/);
});

test('XR pack experience keeps cards stable and transport gated', () => {
  const src = read('ui/assets/webxr_vr.js');
  assert.match(src, /isPresenting\(\)/);
  assert.match(src, /static-card/);
  assert.match(src, /!isPackExperience\(\)/);
});

test('Collection pipeline: save opens the collect overlay and there is no duplicate rail button', () => {
  const html = read('ui/assets/reels.html');
  assert.doesNotMatch(html, /id="collectBtn"/);
  assert.match(html, /id="saveBtn"/);
  assert.match(html, /saveBtn\.addEventListener\('click', \(\) => openCollectOverlay\(\)\)/);
  assert.match(html, /id="collectMenuPanel"/);
  assert.match(html, /reels-collect-dialog/);
  assert.match(html, /reels-collect-backdrop/);
  assert.match(html, /\+ NEW COLLECTION/);
  assert.match(html, /collectNewName/);
  assert.match(html, /ALL SAVED ITEMS/);
  assert.match(html, /ensureGeneralSaved/);
  assert.match(html, /handleCardSelect/);
  assert.match(html, /collection_add/);
  assert.match(html, /reels-collect-dialog \{ position:absolute;[^}]*z-index:91/);
  assert.match(html, /sx-collect-open/);
  const xr = read('ui/assets/webxr_vr.js');
  assert.match(xr, /'collect'/);
  assert.match(xr, /onCollectReel/);
});

test('Owner can publish a draft collection from the pack page and XR cards', () => {
  const page = read('web/src/pages/PackPage.jsx');
  assert.match(page, /PUBLISH COLLECTION/);
  assert.match(page, /publishPack/);
  const html = read('ui/assets/reels.html');
  assert.match(html, /publishPackFromPlayer/);
  assert.match(html, /'publish-pack'/);
});

test('PackTile creator chip links to the curator profile', () => {
  const tile = read('web/src/components/packs/PackTile.jsx');
  assert.match(tile, /sx-explore-creator/);
  assert.match(tile, /pack\.creator\.username/);
  const page = read('web/src/pages/PackPage.jsx');
  assert.match(page, /CURATED BY/);
  const messages = read('web/src/components/messaging/MessagingPanel.jsx');
  assert.match(messages, /CURATED BY @/);
  const html = read('ui/assets/reels.html');
  assert.match(html, /CURATED BY ' \+ packCreatorLabel/);
});

test('Collections open straight into playback with no intro gate', () => {
  const state = read('ui/assets/reels_pack_state.js');
  assert.doesNotMatch(state, /phase = restart \? 'intro'/);
  const html = read('ui/assets/reels.html');
  assert.doesNotMatch(html, /packState\.phase === 'intro'/);
  assert.match(html, /startPackPlayback\(true\)/);
  const page = read('web/src/pages/PackPage.jsx');
  assert.doesNotMatch(page, /START PACK/);
  assert.doesNotMatch(page, /RESUME \{resumeIndex/);
  const explore = read('web/src/pages/ExplorePage.jsx');
  assert.match(explore, /\?play=1/);
});

test('Pack editor browses public reels with 3–30 limits', () => {
  const src = read('web/src/pages/PackEditorPage.jsx');
  assert.match(src, /PACK_MIN_PUBLISHED_ITEMS = 3/);
  assert.match(src, /PACK_MAX_ITEMS = 30/);
  assert.match(src, /FIND PUBLIC REELS/);
  assert.match(src, /librarySearch/);
  const page = read('web/src/pages/PackPage.jsx');
  assert.match(page, /PACKS tab|EDIT PACK/);
});

test('Pack-complete card, top bar and queue use the industrial pack chrome', () => {
  const html = read('ui/assets/reels.html');
  // complete card: head with live dot + position chip, hierarchy of actions. Nothing that grows with pack size.
  assert.match(html, /id="packStageCount"/);
  assert.doesNotMatch(html, /packStageManifest|reels-pack-cell|packSegments|reels-pack-seg/);
  assert.match(html, /class="reels-pack-btn primary" id="packStagePrimary"/);
  assert.match(html, /packStagePrimaryLabel\.textContent = 'REPLAY PACK'/);
  assert.match(html, /packStageCard\.classList\.toggle\('is-unavailable'/);
  // top bar: saved state exposed to assistive tech
  assert.match(html, /packSaveBtn\.setAttribute\('aria-pressed'/);
  // queue panel shrinks to its content and clears the right-hand rail
  assert.match(html, /\.reels-pack-queue \{[^}]*inset:54px 76px auto 54px/);
  assert.match(html, /reels-pack-queue-eyebrow/);
});

test('Pack card CSS is flat enough for the SPA scoper (no comments or nested rules between pack rules)', () => {
  const html = read('ui/assets/reels.html');
  const start = html.indexOf('.reels-pack-bar {');
  const end = html.indexOf('.reels-collect-backdrop');
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /\/\*/);
  assert.doesNotMatch(block, /:is\(|:where\(|@supports|@container/);
  // keyframes must carry the sx-pack- prefix: they are global once scoped
  assert.match(html, /@keyframes sx-pack-rise/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
});

test('VR canvas for packs shares one obsidian frame with the collect canvas', () => {
  const html = read('ui/assets/reels.html');
  assert.match(html, /function drawPackCanvasFrame\(/);
  assert.match(html, /drawPackCanvasFrame\(ctx, 'SAVE TO COLLECTION'/);
  assert.match(html, /drawPackCanvasFrame\(ctx, label, accent, chip\)/);
  // hit regions the controllers rely on are unchanged
  for (const action of ['replay', 'return', 'explore', 'skip', 'save', 'share', 'close', 'publish-pack']) {
    assert.match(html, new RegExp(`'${action}'`));
  }
});

test('Full-bleed fullscreen puts the action bar bottom-right and drops PREV/NEXT (swipe navigates)', () => {
  const html = read('ui/assets/reels.html');
  const rule = html.match(/\.reels-phone-frame\.sx-fs-active \.reels-actions \{([^}]*)\}/);
  assert.ok(rule, 'fullscreen rail rule');
  assert.match(rule[1], /bottom: max\(36px/);
  assert.match(rule[1], /top: auto !important/);
  assert.match(rule[1], /transform: scale\(1\.2\) !important/);
  assert.match(rule[1], /transform-origin: 100% 100% !important/);
  // desktop docked fullscreen (details column beside the square) keeps the centred rail
  assert.match(html, /#sxReelsHost\.sx-fs-docked \.reels-actions \{[^}]*top: 50% !important/);
  // PREV/NEXT are hidden whenever fullscreen is active and not docked
  assert.match(html, /if \(isCurrentFullscreen\(\)\) \{\s*edgeNav\.hidden = true;/);
  // swipe gestures still drive navigation
  assert.match(html, /nextVideo\(\); \/\/ Swipe Up -> Next/);
  // the end card clears the right-hand rail in fullscreen
  assert.match(html, /\.sx-fs-active \.reels-pack-card[^{]*\{ padding:[^}]*76px/);
  // ...and is centred horizontally in the space above the bar whenever it fits there
  assert.match(html, /function layoutPackStage\(\)/);
  assert.match(html, /set\('--pk-l', '14px'\)/);
  assert.match(html, /set\('--pk-m', 'auto auto 0'\)/);
});

test('Phones open the 2D player full-bleed unless the reader opted out, and leaving restores the site chrome', () => {
  const html = read('ui/assets/reels.html');
  assert.match(html, /!window\.__sxFsOptOut[^]*max-width: 700px[^]*togglePseudoFullscreen\(true\)/);
  assert.match(html, /sx-immersive-preview-source'\)\) && !vrPresenting\(\)/);
  assert.match(html, /window\.__sxFsOptOut = true;\s*togglePseudoFullscreen\(false\)/);
  // cleanup leaves pseudo-fullscreen so the header is restored when the player unmounts
  assert.match(html, /window\.removeEventListener\('resize', layoutPackStage\);[^]*togglePseudoFullscreen\(false\)/);
  const jsx = read('web/src/components/ui/ReelsPlayer.jsx');
  assert.match(jsx, /window\.__sxFsOptOut = false/);
});

test('Fullscreen timeline runs edge to edge and the frame leaves room for the phone tab bar', () => {
  const html = read('ui/assets/reels.html');
  const css = read('web/src/styles/global.css');
  const rule = html.match(/\.reels-phone-frame\.sx-pseudo-fullscreen \.reels-progress-wrap \{([^}]*)\}/);
  assert.ok(rule, 'fullscreen progress rule');
  assert.match(rule[1], /padding: 0 0 var\(--sx-fs-safe-bottom/);
  assert.doesNotMatch(rule[1], /padding-(left|right)/);
  const hostRule = css.match(/#sxReelsHost\.sx-pseudo-fullscreen \.reels-progress-wrap \{([^}]*)\}/);
  assert.ok(hostRule && !/padding-(left|right)/.test(hostRule[1]));
  assert.match(html, /\.reels-phone-frame\.sx-pseudo-fullscreen \{\s*height: calc\(100dvh - var\(--sx-bottom-nav, 0px\)\) !important/);
  assert.match(css, /\.reels-phone-frame \{[^}]*height: calc\(100dvh - var\(--sx-bottom-nav, 0px\)\) !important/);
  const shell = read('web/src/components/layout/AppShell.jsx');
  assert.match(shell, /showBottomNav = isPlayerRoute && isFsActive && isPhone && !isVrActive && !isRealFs/);
});

test('Phone tab bar marks the active tab by colour only (no strip that collides with the timeline)', () => {
  const css = read('web/src/styles/global.css');
  const rule = css.match(/\.sx-bottom-nav-item\.sx-active \{([^}]*)\}/);
  assert.ok(rule);
  assert.doesNotMatch(rule[1], /box-shadow/);
});

test('Phone tab bar icons share one resting colour and recolour red when active', () => {
  const css = read('web/src/styles/global.css');
  assert.match(css, /\.sx-bottom-nav-item \{[^}]*color: #f2f3f5/);
  assert.match(css, /\.sx-bottom-nav-item\.sx-active \.sx-bottom-nav-svg \[stroke='#f2f3f5'\] \{\s*stroke: var\(--sx-accent/);
  assert.match(css, /\.sx-bottom-nav-item\.sx-active \.sx-bottom-nav-svg \[fill='#f2f3f5'\] \{\s*fill: var\(--sx-accent/);
});
