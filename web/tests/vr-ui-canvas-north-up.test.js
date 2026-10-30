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

function recordRender(api, options) {
  const labels = [];
  const rectangles = [];
  const ctx = new Proxy({
    fillText(text, x, y) { labels.push({ text, x, y }); },
    roundRect(x, y, w, h) { rectangles.push({ x, y, w, h }); },
    measureText(text) { return { width: String(text).length * 8 }; },
  }, {
    get(target, property) { return target[property] ?? (() => {}); },
  });
  api.renderControlsCanvas(ctx, options);
  return { labels, rectangles };
}

function hitAction(api, x, y, options) {
  const index = api.resolveControlsHit(x, y, options);
  return index === -1 ? null : api.CTRL_BUTTONS[index].action;
}

function center(button) {
  return [button.x + button.w / 2, button.y + button.h / 2];
}

const earthActions = ['earth_open_feed', 'earth_zoom_out', 'earth_reset', 'earth_north_up'];
const reelActions = ['like', 'save_reel', 'share_reel', 'follow', 'profile', 'report'];

test('loaded canvas exposes one North Up control at the dedicated dock rectangle', () => {
  const api = loadCanvas();
  const buttons = api.CTRL_BUTTONS.filter((button) => button.action === 'earth_north_up');
  assert.equal(buttons.length, 1);
  const { label, x, y, w, h } = buttons[0];
  assert.deepEqual({ label, x, y, w, h }, { label: 'NORTH UP', x: 602, y: 238, w: 174, h: 42 });
  assert.ok(x >= 0 && y >= 0 && x + w <= api.CONTROLS_W && y + h <= api.CONTROLS_H);
});

test('North Up visibility and drawing are Earth-only across feed, pack, and source states', () => {
  const api = loadCanvas();
  for (const sceneMode of ['earth', 'reels', undefined]) {
    for (const packMode of [false, true]) {
      for (const kind of ['video', 'image', 'static-card']) {
        for (const available of [true, false]) {
          const options = { sceneMode, packMode, source: { kind }, itemState: { available } };
          const expected = sceneMode === 'earth';
          const context = JSON.stringify(options);
          assert.equal(api.isControlVisible('earth_north_up', options.source, options.itemState, packMode, sceneMode), expected, context);
          const { labels, rectangles } = recordRender(api, options);
          const northLabels = labels.filter(({ text }) => text === 'NORTH UP');
          assert.equal(northLabels.length, expected ? 1 : 0, context);
          if (expected) assert.deepEqual(northLabels[0], { text: 'NORTH UP', x: 689, y: 259 });
          assert.equal(rectangles.some(({ x, y, w, h }) => x === 602 && y === 238 && w === 174 && h === 42), expected, context);
          assert.equal(hitAction(api, 689, 259, options), expected ? 'earth_north_up' : null, context);
        }
      }
    }
  }
});

test('Earth hit resolution routes North Up center and inclusive edges to its action, not neighboring controls', () => {
  const api = loadCanvas();
  const options = { sceneMode: 'earth' };
  for (const x of [602, 689, 776]) {
    for (const y of [238, 259, 280]) {
      assert.equal(hitAction(api, x, y, options), 'earth_north_up', `${x}, ${y}`);
    }
  }
  for (const [x, y] of [[601, 259], [777, 259], [689, 237], [689, 281], [592, 259]]) {
    assert.equal(hitAction(api, x, y, options), null, `${x}, ${y}`);
  }
  for (const action of [...earthActions, 'exit']) {
    const button = api.CTRL_BUTTONS.find((entry) => entry.action === action);
    assert.equal(hitAction(api, ...center(button), options), action);
  }
  // The way back to reels is the shell nav's REELS tab, not a dock pill.
  assert.equal(api.isControlVisible('earth', null, null, false, 'earth'), false);
  for (const button of api.CTRL_BUTTONS.filter((entry) => ![...earthActions, 'exit'].includes(entry.action))) {
    // Earth actions intentionally reuse collect/pack slots, but must never dispatch their old actions.
    assert.notEqual(hitAction(api, ...center(button), options), button.action);
  }
});

test('North Up does not overlap any existing control or the other Earth dock targets', () => {
  const api = loadCanvas();
  const north = api.CTRL_BUTTONS.find((button) => button.action === 'earth_north_up');
  for (const button of api.CTRL_BUTTONS.filter((entry) => entry !== north)) {
    // Hit rectangles have inclusive edges, so even touching edges would be ambiguous.
    const separated = north.x + north.w < button.x || button.x + button.w < north.x ||
      north.y + north.h < button.y || button.y + button.h < north.y;
    assert.ok(separated, `North Up overlaps ${button.action}`);
  }
});

test('reels and pack playback preserve reel actions, transport, and their original dock dispatch', () => {
  const api = loadCanvas();
  for (const packMode of [false, true]) {
    const options = { sceneMode: 'reels', packMode, source: { kind: 'video' }, itemState: { available: true } };
    const { labels } = recordRender(api, options);
    for (const action of [...reelActions, 'rew', 'prev', 'play', 'next', 'fwd', 'seek', 'exit']) {
      const button = api.CTRL_BUTTONS.find((entry) => entry.action === action);
      assert.equal(hitAction(api, ...center(button), options), action);
      assert.equal(api.isControlVisible(action, options.source, options.itemState, packMode, 'reels'), true);
      if (reelActions.includes(action)) assert.ok(labels.some(({ text }) => text === button.label));
    }
    // The earth slot is the pack QUEUE toggle; Earth itself lives on the shell nav.
    const queue = api.CTRL_BUTTONS.find((entry) => entry.action === 'earth');
    assert.equal(hitAction(api, ...center(queue), options), packMode ? 'earth' : null);
    assert.equal(api.isControlVisible('earth', options.source, options.itemState, packMode, 'reels'), packMode);
    assert.equal(labels.some(({ text }) => text === 'QUEUE'), packMode);
    // COLLECT spans both pack slots on the action row.
    assert.equal(hitAction(api, 637, 212, options), packMode ? 'save_pack' : 'collect');
    assert.equal(hitAction(api, 732, 212, options), packMode ? 'share_pack' : 'collect');
    assert.equal(hitAction(api, 689, 259, options), null);
    for (const action of earthActions) {
      assert.equal(api.isControlVisible(action, options.source, options.itemState, packMode, 'reels'), false);
      const button = api.CTRL_BUTTONS.find((entry) => entry.action === action);
      assert.ok(!labels.some(({ text }) => text === button.label));
    }
  }
});

test('North Up does not bypass existing unavailable-reel and static-card action gating', () => {
  const api = loadCanvas();
  for (const options of [
    { sceneMode: 'reels', source: { kind: 'video' }, itemState: { available: false } },
    { sceneMode: 'reels', packMode: true, source: { kind: 'static-card' } },
  ]) {
    const { labels } = recordRender(api, options);
    for (const action of reelActions) {
      const button = api.CTRL_BUTTONS.find((entry) => entry.action === action);
      assert.equal(hitAction(api, ...center(button), options), null);
      assert.ok(!labels.some(({ text }) => text === button.label));
    }
    assert.equal(hitAction(api, 689, 259, options), null);
  }
});

test('dock canvas size fits the live controls per mode', () => {
  const api = loadCanvas();
  const video = { kind: 'video' };
  const size = (options) => ({ ...api.controlsCanvasSize(options) });
  assert.deepEqual(size({ source: video, itemState: { available: true } }), { w: 800, h: 260 });
  assert.deepEqual(size({ source: video, packMode: true }), { w: 800, h: 260 });
  assert.deepEqual(size({ source: { kind: 'image' } }), { w: 800, h: 260 });
  assert.deepEqual(size({ source: { kind: 'static-card' } }), { w: 800, h: 260 });
  assert.deepEqual(size({ source: video, sceneMode: 'earth' }), { w: 800, h: 304 });
  for (const options of [
    { source: video },
    { source: { kind: 'image' } },
    { source: video, sceneMode: 'earth', earth: {} },
  ]) {
    const { w, h } = api.controlsCanvasSize(options);
    const { rectangles } = recordRender(api, options);
    assert.deepEqual({ ...rectangles[0] }, { x: 0, y: 0, w, h }, 'container drawn at the fitted size');
  }
});

test('Earth dock MAP tile shrinks a long status to fit its tile', () => {
  const api = loadCanvas();
  const drawn = [];
  const ctx = new Proxy({
    font: '',
    fillText(text, x) { drawn.push({ text, x, font: this.font }); },
    // ~0.62 em per glyph, as the 800-weight sans renders on Quest.
    measureText(text) { return { width: String(text).length * 0.62 * (parseFloat(/(\d+)px/.exec(this.font)?.[1]) || 10) }; },
  }, {
    get(target, property) { return property in target ? target[property] : () => {}; },
    set(target, property, value) { target[property] = value; return true; },
  });
  api.renderControlsCanvas(ctx, { sceneMode: 'earth', source: { kind: 'video' }, earth: { mapStatus: 'STREAMING 100%' } });
  const label = drawn.find(({ text }) => text === 'STREAMING 100%');
  assert.ok(label, 'status drawn');
  const size = parseFloat(/(\d+)px/.exec(label.font)[1]);
  assert.ok(size < 30, `font shrank (${size}px)`);
  assert.ok(14 * 0.62 * size <= 236 - 36, 'text fits the tile');
});
