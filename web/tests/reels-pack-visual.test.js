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

test('PackTile is a labeled group with explicit open and pressed save', () => {
  const src = read('web/src/components/packs/PackTile.jsx');
  assert.match(src, /role="group"/);
  assert.match(src, /OPEN PACK/);
  assert.match(src, /aria-pressed/);
  assert.match(src, /role="status"/);
  assert.match(src, /role="alert"/);
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
