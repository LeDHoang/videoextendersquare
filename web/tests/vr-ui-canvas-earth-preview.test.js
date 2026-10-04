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

function record(api, options) {
  const images = [];
  const texts = [];
  const rects = [];
  const ctx = new Proxy({
    drawImage(...args) { images.push(args); },
    fillText(text, x, y) { texts.push({ text, x, y }); },
    roundRect(x, y, w, h) { rects.push({ x, y, w, h }); },
    measureText(text) { return { width: String(text).length * 8 }; },
  }, { get(target, property) { return target[property] ?? (() => {}); } });
  api.renderEarthPreviewCanvas(ctx, options);
  return { images, texts, rects };
}

const poster = () => ({ complete: true, naturalWidth: 640, naturalHeight: 960 });
const items = [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }];
const base = {
  location: { name: 'Miami, USA', heat: 0.9, active_reel_count: 5 },
  earthPreviewStatus: 'ready',
  earthPreviewItems: items,
  earthPreviewPosters: [poster(), poster(), poster()],
  reducedMotion: true,
};

test('preview card is one main window: only the active reel is drawn, no thumbnail strip', () => {
  const api = loadCanvas();
  const { images, texts } = record(api, { ...base, earthPreviewIndex: 1 });
  assert.equal(images.length, 1, 'exactly one poster/video is painted');
  assert.ok(texts.some((t) => t.text === '2 / 3'), 'counter shows the active reel');
  assert.ok(texts.some((t) => t.text === 'Two'), 'caption is the active reel title');
});

test('the hero window fills the space the thumbnails used to occupy', () => {
  const api = loadCanvas();
  const { rects, texts } = record(api, { ...base, earthPreviewIndex: 0 });
  const hero = rects.find((r) => r.x === 28 && r.y === 144 && r.h > 400);
  assert.ok(hero, 'hero rect is taller than the old 388px window');
  assert.ok(hero.y + hero.h <= api.EARTH_PREVIEW_H - 40, 'leaves room for the call-to-action');
  const cta = texts.find((t) => /OPEN LOCATION FEED/.test(t.text));
  assert.ok(cta && cta.y > hero.y + hero.h, 'call-to-action sits below the hero');
});

test('story progress shows one segment per reel and fills finished reels', () => {
  const api = loadCanvas();
  const { rects } = record(api, { ...base, earthPreviewIndex: 2 });
  const segments = rects.filter((r) => r.h === 4);
  // 3 tracks + 2 finished fills + (active fill only when a clip is decoding)
  assert.equal(segments.filter((r) => r.y === 158).length >= 5, true, `segments: ${JSON.stringify(segments)}`);
});
