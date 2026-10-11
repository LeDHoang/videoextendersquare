import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const canvasSource = readFileSync(new URL('../../ui/assets/vr_ui_canvas.js', import.meta.url), 'utf8');
const webxrSource = readFileSync(new URL('../../ui/assets/webxr_vr.js', import.meta.url), 'utf8');

function loadCanvas() {
  const window = {};
  vm.runInNewContext(canvasSource, { window }, { filename: 'vr_ui_canvas.js' });
  return window.VRUICanvas;
}

// Text drawn in the dock header row, right of the "4K VR REELS" label.
function dockTitle(api, options) {
  const labels = [];
  const ctx = new Proxy({
    fillText(text, x, y) { labels.push({ text, x, y }); },
    measureText(text) { return { width: String(text).length * 8 }; },
  }, {
    get(target, property) { return target[property] ?? (() => {}); },
  });
  api.renderControlsCanvas(ctx, options);
  const title = labels.find(({ x, y }) => x === 144 && y === 24);
  return title ? title.text : null;
}

test('dock header shows the current reel title, not a placeholder', () => {
  const api = loadCanvas();
  const playlist = [{ title: 'First reel' }, { title: 'Auckland in 3 frames', filename: 'cap-0.png' }];
  assert.equal(dockTitle(api, { playlist, idx: 1, item: playlist[1] }), 'Auckland in 3 frames');
});

test('dock header falls back to filename, then path basename, and truncates long titles', () => {
  const api = loadCanvas();
  assert.equal(dockTitle(api, { item: { filename: 'clip.mp4' } }), 'clip.mp4');
  assert.equal(dockTitle(api, { item: { path: 'uploads/city/shot.png' } }), 'shot.png');
  assert.equal(dockTitle(api, { item: {} }), 'UNTITLED REEL');
  assert.equal(dockTitle(api, { item: { title: 'A very long reel title that overflows the dock' } }), 'A very long reel title t…');
  assert.equal(dockTitle(api, {}), '');
  assert.equal(dockTitle(api, { packMode: true, packContext: { title: 'City pack' }, item: { title: 'Reel' } }), 'City pack');
});

test('webxr passes the playlist item at the current index to the dock renderer', () => {
  const call = webxrSource.match(/ui\.renderControlsCanvas\(controlsCtx, \{([\s\S]*?)\}\);/);
  assert.ok(call, 'renderControlsCanvas call present');
  assert.match(call[1], /\bitem: playlist\[idx\] \|\| null,/);
  assert.doesNotMatch(canvasSource, /SYS_RENDER_004/);
});

test('controller guide explains Left/Right for both reels and image posts', () => {
  const api = loadCanvas();
  const labels = [];
  const ctx = new Proxy({
    fillText(text, x, y) { labels.push({ text, x, y }); },
    measureText(text) { return { width: String(text).length * 8 }; },
  }, {
    get(target, property) { return target[property] ?? (() => {}); },
  });
  api.renderGuideCanvas(ctx);
  const title = labels.find(({ text }) => text === 'THUMBSTICK');
  assert.ok(title, 'thumbstick card drawn');
  const lines = labels.filter(({ x, y }) => x === title.x && y > title.y && y < title.y + 78).map(({ text }) => text);
  assert.deepEqual(lines, ['Up/Down → Next/Prev Reel', 'Reels: Left/Right → Seek ±5s', 'Images: Left/Right → Prev/Next']);
});
