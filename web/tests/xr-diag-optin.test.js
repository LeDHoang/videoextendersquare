import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const threeSource = readFileSync(new URL('../../ui/assets/three.min.js', import.meta.url), 'utf8');
const uiCanvasSource = readFileSync(new URL('../../ui/assets/vr_ui_canvas.js', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../../ui/assets/webxr_vr.js', import.meta.url), 'utf8');

// Loads the real engine with a recording fetch and the given query string.
function loadEngine(search = '', video = {}) {
  const posts = [];
  const clock = { now: 0 };
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
    location: { search, hostname: 'example.test', pathname: '/reels' },
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
    performance: { now: () => clock.now },
    fetch: async (url, init) => {
      if (String(url).includes('/api/reels/diag')) posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({}) };
    },
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
  engine.init(video, {});
  return { engine, posts, clock };
}

function runFrames(engine) {
  for (const t of [0, 16, 32, 1100, 2200, 3300]) engine.__test.postXRDiag(t);
}

test('XR diagnostics never POST by default', () => {
  const { engine, posts } = loadEngine('');
  assert.equal(engine.__test.getDebugFlags().xrdiag, false);
  runFrames(engine);
  assert.deepEqual(posts, []);
});

test('other debug flags alone do not enable XR diagnostics', () => {
  const { engine, posts } = loadEngine('?xrfull=1&lock=0&xrdiag=0');
  assert.equal(engine.__test.getDebugFlags().xrdiag, false);
  runFrames(engine);
  assert.deepEqual(posts, []);
});

test('?xrdiag=1 opts in to the ~1 Hz diagnostics POST', () => {
  const { engine, posts } = loadEngine('?xrdiag=1');
  assert.equal(engine.__test.getDebugFlags().xrdiag, true);
  runFrames(engine);
  assert.ok(posts.length >= 2, `expected diag posts, got ${posts.length}`);
  assert.equal(posts[0].url, '/api/reels/diag');
  assert.equal(posts[0].body.flags.xrdiag, true);
});

test('setDebugFlags can toggle the opt-in for tests and probes', () => {
  const { engine, posts } = loadEngine('');
  engine.__test.setDebugFlags({ xrdiag: true });
  runFrames(engine);
  assert.ok(posts.length >= 1);
});

test('diag payload carries the last reel switch timing', () => {
  const { engine, posts } = loadEngine('?xrdiag=1');
  runFrames(engine);
  assert.equal(posts[0].body.switchMs, null);
  engine.noteSwitchTiming(412.6, 'http://localhost:8000/media/out/reel-a.mp4?x=1', true);
  for (const t of [4400, 5500]) engine.__test.postXRDiag(t);
  const last = posts[posts.length - 1].body;
  assert.equal(last.switchMs, 413);
  assert.equal(last.switchSrc, 'reel-a.mp4');
  assert.equal(last.switchFromCache, true);
  assert.equal(typeof last.flags.vrtex, 'boolean');
});

test('diag payload counts mid-play stalls of the active video', () => {
  const listeners = {};
  const video = {
    currentTime: 0, seeking: false, readyState: 4, paused: false,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
  };
  const fire = (type) => (listeners[type] || []).forEach((fn) => fn());
  const { engine, posts, clock } = loadEngine('?xrdiag=1', video);
  engine.__test.postXRDiag(0);
  fire('waiting'); // startup wait: currentTime 0, not a stall
  video.currentTime = 3;
  video.seeking = true;
  fire('waiting'); // seek wait: not a stall
  video.seeking = false;
  clock.now = 100;
  fire('waiting');
  clock.now = 400;
  fire('playing');
  engine.__test.postXRDiag(1100);
  let last = posts.at(-1).body;
  assert.equal(last.stalls, 1);
  assert.equal(last.stallMs, 300);
  assert.equal(last.stalling, false);
  // An ongoing stall reports its time so far, then the rest on the next post.
  clock.now = 1000;
  fire('waiting');
  clock.now = 1500;
  engine.__test.postXRDiag(2200);
  last = posts.at(-1).body;
  assert.deepEqual([last.stalls, last.stallMs, last.stalling], [1, 500, true]);
  clock.now = 1700;
  fire('emptied');
  engine.__test.postXRDiag(3300);
  last = posts.at(-1).body;
  assert.deepEqual([last.stalls, last.stallMs, last.stalling], [0, 200, false]);
});
