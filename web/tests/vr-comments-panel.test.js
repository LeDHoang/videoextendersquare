import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const canvasSource = readFileSync(new URL('../../ui/assets/vr_ui_canvas.js', import.meta.url), 'utf8');

function loadCanvas() {
  const window = {};
  vm.runInNewContext(canvasSource, { window }, { filename: 'vr_ui_canvas.js' });
  return window.VRUICanvas;
}

// Text drawn by the comments panel renderer.
function panelText(api, options) {
  const labels = [];
  const ctx = new Proxy({
    fillText(text) { labels.push(String(text)); },
    measureText(text) { return { width: String(text).length * 7 }; },
  }, {
    get(target, property) { return target[property] ?? (() => {}); },
  });
  api.renderCommentsPanelCanvas(ctx, options);
  return labels;
}

const item = {
  title: 'Night set',
  caption: 'Front row',
  creator: { username: 'echo_archive', display_name: 'echo_archive' },
  created_at: new Date(Date.now() - 3 * 86400 * 1000).toISOString(),
  tags: ['concert'],
  location: { city: 'Miami', country: 'USA' },
  duration_ms: 15000,
  likes: 1800,
  views: 42200,
};
const comments = [
  { id: 'c1', author_name: 'ann', text: 'synced', timestamp: 3, likes: 2 },
  { id: 'c2', author_name: 'bob', text: 'general', timestamp: null, likes: 0 },
];

test('comments panel shows the reel creator block like the 2D column', () => {
  const labels = panelText(loadCanvas(), { comments, item, itemState: {} });
  for (const text of ['echo_archive', '@echo_archive · 3D AGO', 'FOLLOW', 'NIGHT SET', 'Front row',
    '#concert', 'Miami, USA', 'DUR', '0:15', 'LIKES', '1.8K', 'COMMENTS', 'VIEWS', '42.2K']) {
    assert.ok(labels.includes(text), `drew ${text}`);
  }
  assert.ok(!labels.includes('ALL') && !labels.includes('SYNC'), 'no filter tabs');
  assert.ok(labels.includes('0:03') && !labels.includes('GENERAL'), 'general comments get no pill');
  assert.ok(panelText(loadCanvas(), { comments, item, itemState: { following: true } }).includes('FOLLOWING'));
  assert.ok(!panelText(loadCanvas(), { comments, item, itemState: { canFollow: false } }).includes('FOLLOW'));
});

test('one time-sync toggle flips between all comments and general only', () => {
  const api = loadCanvas();
  const sync = { x: 520, y: 284 };
  assert.equal(api.resolveCommentsPanelRegion(sync.x, sync.y, { comments, item }), 'tab:general');
  assert.equal(api.resolveCommentsPanelRegion(sync.x, sync.y, { comments, item, cPanelTab: 'general' }), 'tab:all');
  // Close sits top-right, next to FOLLOW.
  assert.equal(api.resolveCommentsPanelRegion(520, 44, { comments, item }), 'close');
  assert.equal(api.resolveCommentsPanelRegion(470, 44, { comments, item }), 'follow');
  assert.equal(api.resolveCommentsPanelRegion(470, 44, { comments, item, itemState: { canFollow: false } }), 'panel');
  assert.equal(api.resolveCommentsPanelRegion(120, 34, { comments, item }), 'creator');
  // The time pill follows the name; a general comment has no seek target there.
  assert.equal(api.resolveCommentsPanelRegion(120, 330, { comments, item }), 'seek:c1');
  assert.equal(api.resolveCommentsPanelRegion(470, 330, { comments, item }), 'like:c1');
  assert.equal(api.resolveCommentsPanelRegion(120, 414, { comments, item }), 'list');
  // General only: the synced comment drops out of the list.
  const all = panelText(api, { comments, item });
  const general = panelText(api, { comments, item, cPanelTab: 'general' });
  assert.ok(all.includes('synced') && all.includes('general'));
  assert.ok(!general.includes('synced') && general.includes('general'));
});
