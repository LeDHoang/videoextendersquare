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
// Dome (1) is re-hashed for the eye-centred sphere at the default size and distance.
const SQUARE_HASHES = {
  screen0: '01f879539377aff1d0847e448673a7968cd70245564ebc3c219ed0d822f138a2',
  glow0: 'bd0d6efb5a2485458998d5427aee0e1a5cf3c9ab573360e642b6fab9af9696ae',
  screen1: 'd6532ac06ae892b11340c42486a0b57a56e8d5b602e602b2a3724e646556c24e',
  glow1: 'f234090a4c877a401f3883f00979f853144d2b4494b7714bba5791b3bba67894',
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
    // Short-side arc: SQ CURVE keeps 2; the dome is D × the flat edge angle each side.
    const arc = mode === 1 ? 2 * D * Math.atan(1.2 / D) : 2;
    const sq = api.createScreenGeometry(mode, 1);
    closeTo(centreLine(sq, 'x'), arc, 2e-3, `mode ${mode} 1:1 arc`);
    const wide = api.createScreenGeometry(mode, 16 / 9);
    closeTo(centreLine(wide, 'x'), arc * 16 / 9, 2e-3, `mode ${mode} 16:9 long arc`);
    closeTo(centreLine(wide, 'y'), arc, 2e-3, `mode ${mode} 16:9 short arc`);
    const ultra = api.createScreenGeometry(mode, 21 / 9);
    closeTo(centreLine(ultra, 'x'), arc * 16 / 9, 2e-3, `mode ${mode} 21:9 long arc`);
    closeTo(centreLine(ultra, 'y'), arc * (16 / 9) / (21 / 9), 2e-3, `mode ${mode} 21:9 short arc`);
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

test('the dome is a sphere centred on the eye, at the flat screen\'s edge angle', () => {
  const api = loadEngine().__test;
  const def = api.domeEye();
  closeTo(def, 2.24 / (4 / 2.4), 1e-9, 'default eye distance');
  // Eye distances (local units) from 6 m at scale 1 down to the cap's edge.
  for (const D of [14.4, 2.24 / (4 / 2.4), 1.1, 1.2 / Math.tan(50 * Math.PI / 180) + 1e-6]) {
    api.domeEye(D);
    const geo = api.createScreenGeometry(1, 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i) - D);
      closeTo(r, D, 1e-5, `D ${D} vertex ${i} distance from the eye`);
    }
    const edge = 24 * 49 + 48;
    const deg = Math.atan2(pos.getX(edge), D - pos.getZ(edge));
    closeTo(deg, Math.atan(1.2 / D), 1e-6, `D ${D} edge angle`);
    // UVs are the 48x48 plane's (SQ CURVE leaves them untouched): no seam or remap.
    const plane = api.createScreenGeometry(2, 1).attributes.uv.array;
    assert.deepEqual([...geo.attributes.uv.array], [...plane], `D ${D} uv`);
  }
  api.domeEye(def);
});

test('past the cap the dome holds 50 degrees and the edge keeps the flat angle', () => {
  const api = loadEngine().__test;
  const def = api.domeEye();
  // Scale 10 at 1.2 m and scale 8 at 2.24 m.
  for (const D of [1.2 / (10 / 2.4), 2.24 / (8 / 2.4)]) {
    const sph = api.domeSphere(D);
    closeTo(sph.alpha, 50 * Math.PI / 180, 1e-12, `D ${D} alpha`);
    assert.ok(sph.R > D, `D ${D} centre moves behind the eye`);
    api.domeEye(D);
    const pos = api.createScreenGeometry(1, 1).attributes.position;
    const edge = 24 * 49 + 48;
    closeTo(Math.atan2(pos.getX(edge), D - pos.getZ(edge)), Math.atan(1.2 / D), 1e-6, `D ${D} edge angle`);
  }
  api.domeEye(def);
});

test('no dome vertex bends past a quarter turn at any size or distance', () => {
  const api = loadEngine().__test;
  const def = api.domeEye();
  for (const D of [1.2 / (10 / 2.4), 1.2 / (4 / 2.4), 2.24 / (8 / 2.4), 6 / (1 / 2.4)]) {
    api.domeEye(D);
    for (const aspect of [1, 16 / 9, 9 / 16, 21 / 9]) {
      const pos = api.createScreenGeometry(1, aspect).attributes.position;
      for (let row = 0; row < 49; row++) {
        for (let k = 1; k < 49; k++) {
          assert.ok(pos.getX(row * 49 + k) > pos.getX(row * 49 + k - 1), `D ${D} aspect ${aspect} row ${row}`);
          // Grid rows run top to bottom.
          assert.ok(pos.getY(k * 49 + row) < pos.getY((k - 1) * 49 + row), `D ${D} aspect ${aspect} col ${row}`);
        }
      }
    }
  }
  api.domeEye(def);
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

test('the square overlay maps to the central short-side square of any screen', () => {
  const api = loadEngine().__test;
  const uv = (u, v, a) => [...api.overlayUV(u, v, a)].map((x) => Number(x.toFixed(9)));
  // 1:1 is the identity.
  assert.deepEqual(uv(0.2, 0.7, 1), [0.2, 0.7]);
  // 16:9: the centre column keeps v; the square's side edges land on u = 0 and 1.
  assert.deepEqual(uv(0.5, 0.3, 16 / 9), [0.5, 0.3]);
  assert.deepEqual(uv(0.5 - 0.5 * 9 / 16, 0.3, 16 / 9), [0, 0.3]);
  assert.deepEqual(uv(0.5 + 0.5 * 9 / 16, 0.3, 16 / 9), [1, 0.3]);
  // Outside the square is beyond [0, 1]: a miss for overlay hits.
  assert.ok(api.overlayUV(0.05, 0.5, 16 / 9)[0] < 0);
  // 9:16: the square spans the full width, centred vertically.
  assert.deepEqual(uv(0.3, 0.5 + 0.5 * 9 / 16, 9 / 16), [0.3, 1]);
  assert.deepEqual(uv(0.3, 0.5 - 0.5 * 9 / 16, 9 / 16), [0.3, 0]);
  assert.ok(api.overlayUV(0.3, 0.95, 9 / 16)[1] > 1);
});

test('lazy follow moves each axis only by the overshoot past the half-extent', () => {
  const api = loadEngine().__test;
  const f = (...args) => { const r = api.lazyFollowAngles(...args); return { yaw: r.yaw, pitch: r.pitch }; };
  // Inside the screen: nothing moves.
  assert.deepEqual(f(0.1, -0.2, 0.3, 0.1, 0.5, 0.4), { yaw: 0.1, pitch: -0.2 });
  // Past an edge: the screen is dragged so the gaze sits on that edge.
  const out = f(0, 0, 0.7, -0.6, 0.5, 0.4);
  closeTo(out.yaw, 0.2, 1e-12, 'yaw');
  closeTo(out.pitch, -0.2, 1e-12, 'pitch');
  // Yaw takes the short way across ±π.
  const wrap = f(3.0, 0, -3.0, 0, 0.1, 0.4);
  closeTo(wrap.yaw, 3.0 + (2 * Math.PI - 6.0) - 0.1, 1e-12, 'wrap');
});

test('a 1:1 lock keeps the screen at the set distance', () => {
  const api = loadEngine().__test;
  assert.equal(api.lockDistance(), api.getScreenState().distance);
});
