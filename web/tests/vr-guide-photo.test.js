import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const canvasSource = readFileSync(new URL('../../ui/assets/vr_ui_canvas.js', import.meta.url), 'utf8');

// Images "load" only when the test calls finish().
function loadCanvas() {
  const window = {};
  const images = [];
  class Image {
    set src(value) { this._src = value; images.push(this); }
    get src() { return this._src; }
  }
  vm.runInNewContext(canvasSource, { window, Image }, { filename: 'vr_ui_canvas.js' });
  const finish = () => images.forEach((img) => img.onload && img.onload());
  return { api: window.VRUICanvas, window, images, finish };
}

const ctx = new Proxy({ measureText: (text) => ({ width: String(text).length * 8 }) }, {
  get(target, property) { return target[property] ?? (() => {}); },
});

test('guide photo that arrives after the first render asks for one redraw', () => {
  const { api, window, images, finish } = loadCanvas();
  api.renderGuideCanvas(ctx);
  assert.equal(images.length, 0);
  assert.equal(api.isGuideArtworkDirty(), false);

  window.QUEST_CONTROLLER_B64 = 'data:image/jpeg;base64,AAAA';
  assert.equal(api.isGuideArtworkDirty(), true);

  api.renderGuideCanvas(ctx);
  assert.equal(images.length, 1);
  assert.equal(api.isGuideArtworkDirty(), false);

  finish();
  assert.equal(api.isGuideArtworkDirty(), true);
  api.renderGuideCanvas(ctx);
  api.clearGuideArtworkDirty();
  assert.equal(api.isGuideArtworkDirty(), false);
  assert.equal(images.length, 1);
});
