import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(root, rel), 'utf-8');

// Everywhere a published reel's name is shown: the 2D player, VR, Explore, packs and /reels.
const FILES = [
  'ui/assets/reels.html',
  'ui/assets/vr_ui_canvas.js',
  'ui/assets/webxr_vr.js',
  'web/src/components/explore/ExploreTile.jsx',
  'web/src/pages/PackPage.jsx',
  'web/src/pages/ReelsPage.jsx',
];

test('a reel shows its post title; the file name is only the fallback when the post has none', () => {
  let uses = 0;
  for (const rel of FILES) {
    const src = read(rel);
    for (const m of src.matchAll(/([\w$]+(?:\[[\w$]+\])?)\??\.filename\b/g)) {
      const owner = m[1].replace(/[[\]$]/g, '\\$&');
      const before = src.slice(Math.max(0, m.index - 80), m.index);
      assert.match(before, new RegExp(owner + '\\??\\.title \\|\\| $'), `${rel}: ${src.slice(m.index - 40, m.index + 20)}`);
      uses += 1;
    }
  }
  assert.ok(uses >= 12, 'found the title rows');
});

test("the player's title tooltip repeats the title, and a removed reel drops the old one", () => {
  const html = read('ui/assets/reels.html');
  assert.match(html, /metaTitle\.textContent = item\.title \|\| item\.filename;\s*try \{\s*metaTitle\.title = item\.title \|\| item\.filename;/);
  assert.match(html, /metaTitle\.textContent = 'Reel unavailable';\s*metaTitle\.removeAttribute\('title'\);/);
});
