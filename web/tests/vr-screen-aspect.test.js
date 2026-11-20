import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const threeSource = readFileSync(new URL('../../ui/assets/three.min.js', import.meta.url), 'utf8');
const uiCanvasSource = readFileSync(new URL('../../ui/assets/vr_ui_canvas.js', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../../ui/assets/webxr_vr.js', import.meta.url), 'utf8');

// Loads the real engine with no network and no GL.
function loadEngine() {
  const window = {
    QUEST_CONTROLLER_B64: '',
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    matchMedia() { return { matches: false }; },
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    devicePixelRatio: 1,
  };
  window.top = window;
  window.parent = window;
  window.self = window;
  const classList = { add() {}, remove() {} };
  const context = vm.createContext({
    window,
    self: window,
    location: { search: '', hostname: 'example.test', pathname: '/reels' },
    document: {
      documentElement: { classList },
      body: { classList },
      getElementById() { return null; },
      addEventListener() {},
      removeEventListener() {},
      createElement() { return {}; },
    },
    navigator: { userAgent: 'NodeTest' },
    console: { log() {}, warn() {}, error() {}, info() {} },
    performance: { now: () => 0 },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    AbortController,
    setTimeout,
    clearTimeout,
    Uint8Array,
    Float32Array,
    Uint16Array,
    Uint32Array,
    Math,
  });
  vm.runInContext(threeSource, context, { filename: 'three.min.js' });
  vm.runInContext(uiCanvasSource, context, { filename: 'vr_ui_canvas.js' });
  vm.runInContext(rendererSource, context, { filename: 'webxr_vr.js' });
  const engine = window.WebXRVR;
  engine.init({}, {});
  return engine;
}

function hashGeometry(geo) {
  const h = createHash('sha256');
  for (const name of ['position', 'uv', 'normal']) {
    const arr = geo.attributes[name].array;
    h.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  }
  if (geo.index) {
    const idx = geo.index.array;
    h.update(Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength));
  }
  return h.digest('hex');
}

// Hashed from the square-only createScreenGeometry (format-all 9ac3b1d), before the aspect work:
// positions, uvs, normals and indices of the 2.4 m screen (48x48) and the 1.34x glow (24x24).
const SQUARE_HASHES = {
  screen0: '01f879539377aff1d0847e448673a7968cd70245564ebc3c219ed0d822f138a2',
  glow0: 'bd0d6efb5a2485458998d5427aee0e1a5cf3c9ab573360e642b6fab9af9696ae',
  screen1: 'd771f1866e049a12c6a2f79aae9059b3b2e7794d57c80a5223010c5556b055c2',
  glow1: '13a6e86a9ebe177fcb11aa48f1c959fb792947dfc76de2938b9323221a5860d4',
  screen2: '16562467561d1cce8080adf2fe8ed4d1166eb4f7707a6ded40b8c1d2db0d9008',
  glow2: 'd41d1fb97a40bb9ff2017334602975edf2f1537345e2c0c47756d777c9e361d7',
};

test('a 1:1 screen keeps the square geometry vertex for vertex', () => {
  const api = loadEngine().__test;
  const got = {};
  for (const mode of [0, 1, 2]) {
    got[`screen${mode}`] = hashGeometry(api.createScreenGeometry(mode));
    got[`glow${mode}`] = hashGeometry(api.createScreenGeometry(mode, 1, 2.4 * 1.34, 24, 24));
  }
  assert.deepEqual(got, SQUARE_HASHES);
});

function bounds(geo) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  return { w: b.max.x - b.min.x, h: b.max.y - b.min.y };
}

function closeTo(actual, expected, eps = 1e-6, msg) {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg || ''} expected ${expected}, got ${actual}`);
}

// Polyline length of the centre row (y = 0) or centre column (x = 0) of a 48x48 grid.
function centreLine(geo, axis) {
  const pos = geo.attributes.position;
  const n = 49;
  let len = 0;
  for (let k = 1; k < n; k++) {
    const i0 = axis === 'x' ? 24 * n + k - 1 : (k - 1) * n + 24;
    const i1 = axis === 'x' ? 24 * n + k : k * n + 24;
    len += Math.hypot(pos.getX(i1) - pos.getX(i0), pos.getY(i1) - pos.getY(i0), pos.getZ(i1) - pos.getZ(i0));
  }
  return len;
}

test('flat screens keep the short side and grow the long side up to the 16:9 span', () => {
  const api = loadEngine().__test;
  const s169 = bounds(api.createScreenGeometry(0, 16 / 9));
  closeTo(s169.w, 2.4 * 16 / 9, 1e-5, '16:9 width');
  closeTo(s169.h, 2.4, 1e-5, '16:9 height');
  const s916 = bounds(api.createScreenGeometry(0, 9 / 16));
  closeTo(s916.w, 2.4, 1e-5, '9:16 width');
  closeTo(s916.h, 2.4 * 16 / 9, 1e-5, '9:16 height');
  const s219 = bounds(api.createScreenGeometry(0, 21 / 9));
  closeTo(s219.w, 2.4 * 16 / 9, 1e-5, '21:9 keeps the 16:9 long span');
  closeTo(s219.h, 2.4 * (16 / 9) / (21 / 9), 1e-5, '21:9 short side shrinks');
});

test('curved screens keep the arc per short-side unit and clamp the long edge', () => {
  const api = loadEngine().__test;
  const D = 2.24 / (4 / 2.4);
  for (const mode of [1, 2]) {
    const sq = api.createScreenGeometry(mode, 1);
    closeTo(centreLine(sq, 'x'), 2, 2e-3, `mode ${mode} 1:1 arc`);
    const wide = api.createScreenGeometry(mode, 16 / 9);
    closeTo(centreLine(wide, 'x'), 2 * 16 / 9, 2e-3, `mode ${mode} 16:9 long arc`);
    closeTo(centreLine(wide, 'y'), 2, 2e-3, `mode ${mode} 16:9 short arc`);
    const ultra = api.createScreenGeometry(mode, 21 / 9);
    closeTo(centreLine(ultra, 'x'), 2 * 16 / 9, 2e-3, `mode ${mode} 21:9 long arc`);
    closeTo(centreLine(ultra, 'y'), 2 * (16 / 9) / (21 / 9), 2e-3, `mode ${mode} 21:9 short arc`);
    // Long edge midpoint seen from the eye at the default size and distance.
    const pos = wide.attributes.position;
    const edge = 24 * 49 + 48;
    const deg = Math.atan2(pos.getX(edge), D - pos.getZ(edge)) * 180 / Math.PI;
    assert.ok(deg <= 60 + 1e-4 && deg > 59, `mode ${mode} 16:9 long edge at ${deg} deg`);
    const sqPos = sq.attributes.position;
    const sqDeg = Math.atan2(sqPos.getX(edge), D - sqPos.getZ(edge)) * 180 / Math.PI;
    assert.ok(sqDeg < 43 && sqDeg > 41, `mode ${mode} 1:1 edge unchanged at ${sqDeg} deg`);
  }
});

test('a 9:16 screen is the 16:9 screen with x and y swapped', () => {
  const api = loadEngine().__test;
  for (const mode of [0, 1, 2]) {
    const wide = api.createScreenGeometry(mode, 16 / 9).attributes.position;
    const tall = api.createScreenGeometry(mode, 9 / 16).attributes.position;
    // Sorted (x, y, z) sets match once x and y are swapped.
    const key = (x, y, z) => `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    const a = [];
    const b = [];
    for (let i = 0; i < wide.count; i++) {
      a.push(key(wide.getX(i), wide.getY(i), wide.getZ(i)));
      b.push(key(tall.getY(i), tall.getX(i), tall.getZ(i)));
    }
    assert.deepEqual(a.sort(), b.sort(), `mode ${mode}`);
  }
});

test('no curved vertex bends past a quarter turn on any shape', () => {
  const api = loadEngine().__test;
  for (const aspect of [1, 4 / 3, 16 / 9, 9 / 16, 21 / 9, 9 / 21]) {
    for (const mode of [1, 2]) {
      const pos = api.createScreenGeometry(mode, aspect).attributes.position;
      for (let i = 0; i < pos.count; i++) {
        assert.ok(Number.isFinite(pos.getZ(i)) && pos.getZ(i) >= -1e-9, `mode ${mode} aspect ${aspect} z ${pos.getZ(i)}`);
      }
      // Each row stays monotonic in x: no vertex passes phi = pi/2.
      for (let row = 0; row < 49; row++) {
        for (let k = 1; k < 49; k++) {
          assert.ok(pos.getX(row * 49 + k) > pos.getX(row * 49 + k - 1), `mode ${mode} aspect ${aspect} row ${row}`);
        }
      }
    }
  }
});
