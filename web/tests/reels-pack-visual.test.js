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
