import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const threeSource = readFileSync(new URL('../../ui/assets/three.min.js', import.meta.url), 'utf8');
const uiCanvasSource = readFileSync(new URL('../../ui/assets/vr_ui_canvas.js', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../../ui/assets/webxr_vr.js', import.meta.url), 'utf8');

function makeCanvas2dContext() {
  const gradient = { addColorStop() {} };
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'measureText') return (value) => ({ width: String(value || '').length * 8 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
      if (!(prop in target)) target[prop] = () => {};
      return target[prop];
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

function makeMockGl(counters = {}) {
  const objectFactory = () => ({});
  const GL_CONSTANTS = {
    VERSION: 0x1F02,
    RENDERER: 0x1F01,
    VENDOR: 0x1F00,
    SHADING_LANGUAGE_VERSION: 0x8B8C,
    MAX_TEXTURE_IMAGE_UNITS: 0x8B4C,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8869,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8073,
    MAX_TEXTURE_SIZE: 0x0D33,
    MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C,
    MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB,
    MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD,
    MAX_SAMPLES: 0x80AA,
    ACTIVE_UNIFORMS: 0x8B86,
    ACTIVE_ATTRIBUTES: 0x8B89,
    TEXTURE_2D: 0x0DE1,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
  };

  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in GL_CONSTANTS) return GL_CONSTANTS[prop];
      if (prop === 'getContextAttributes') return () => ({ alpha: true, depth: true, stencil: true, antialias: true, premultipliedAlpha: true });
      if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) return 1;
      if (['createShader', 'createProgram', 'createBuffer', 'createTexture', 'createVertexArray', 'createFramebuffer', 'createRenderbuffer'].includes(prop)) return objectFactory;
      if (prop === 'getShaderParameter') return () => true;
      if (prop === 'getProgramParameter') return (p, param) => {
        if (param === 0x8B86 || param === 0x8B89) return 0;
        return true;
      };
      if (prop === 'getAttribLocation') return () => 0;
      if (prop === 'getUniformLocation') return () => ({});
      if (prop === 'getExtension') return () => null;
      if (prop === 'getParameter') return (param) => {
        if (param === 0x1F00 || param === 0x1F01) return 'mock-webgl';
        if (param === 0x1F02) return 'WebGL 1.0 (mock)';
        if (param === 0x8B8C) return 'WebGL GLSL ES 1.0 (mock)';
        if (param === 0x8B4C) return 16;
        if (param === 0x8869) return 16;
        if (param === 0x8073) return 16;
        if (param === 0x0D33) return 4096;
        if (param === 0x851C) return 4096;
        if (param === 0x8DFB) return 8;
        if (param === 0x8DFD) return 8;
        if (param === 0x80AA) return 16;
        return 1;
      };
      if (prop === 'getShaderPrecisionFormat') return () => ({ rangeMin: 1, rangeMax: 1, precision: 1 });
      if (prop === 'texImage2D') {
        return (...args) => {
          counters.textureSources ||= [];
          counters.textureSources.push(args.at(-1));
        };
      }
      if (prop === 'deleteBuffer' || prop === 'deleteTexture' || prop === 'deleteProgram') {
        return () => { counters.deleted = (counters.deleted || 0) + 1; };
      }
      return () => {};
    },
  });
}

function makePreviewCanvas(gl) {
  return {
    width: 0,
    height: 0,
    clientWidth: 960,
    clientHeight: 540,
    style: {},
    parentElement: null,
    ownerDocument: {
      addEventListener() {},
      removeEventListener() {},
      documentElement: { classList: { add() {}, remove() {} } },
      body: { classList: { add() {}, remove() {} } },
    },
    getContext(kind) { return kind === '2d' ? makeCanvas2dContext() : gl; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 540 }; },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    setPointerCapture() {},
    releasePointerCapture() {},
  };
}

function loadRenderer(options = {}) {
  let scheduledFrame = null;
  let nextFrameId = 0;
  class TestCustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const window = {
    QUEST_CONTROLLER_B64: '',
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    matchMedia() { return { matches: false }; },
    requestAnimationFrame(callback) {
      scheduledFrame = callback;
      nextFrameId += 1;
      return nextFrameId;
    },
    cancelAnimationFrame() {},
    devicePixelRatio: 1,
  };
  window.top = window;
  window.parent = window;
  window.self = window;
  const mockDocument = {
    documentElement: { classList: { add() {}, remove() {} } },
    body: { classList: { add() {}, remove() {} } },
    getElementById() { return null; },
    addEventListener() {},
    removeEventListener() {},
    createElement(kind) {
      if (kind === 'canvas') {
        const c = makePreviewCanvas(options.gl || null);
        c.ownerDocument = mockDocument;
        return c;
      }
      return {};
    },
  };
  const context = vm.createContext({
    window,
    self: window,
    document: mockDocument,
    navigator: { userAgent: 'NodeTest' },
    console: { log() {}, warn() {}, error() {} },
    performance: { now: () => 0 },
    fetch: options.fetch || (async () => ({ ok: true, json: async () => ({ locations: [] }) })),
    AbortController,
    CustomEvent: TestCustomEvent,
    Image: class {
      set src(value) { this._src = value; }
    },
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
  window.WebXRVR.__runScheduledFrame = (time) => {
    const callback = scheduledFrame;
    scheduledFrame = null;
    if (callback) callback(time);
  };
  return window.WebXRVR;
}

function closeTo(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be close to ${expected}`);
}

test('projects latitude and longitude onto the shared globe coordinate system', () => {
  const api = loadRenderer().__test;
  const equator = api.locationToUnit(0, 0);
  closeTo(equator.x, 0);
  closeTo(equator.y, 0);
  closeTo(equator.z, 1);
  const northPole = api.locationToUnit(90, 120);
  closeTo(northPole.x, 0);
  closeTo(northPole.y, 1);
  closeTo(northPole.z, 0);
});

test('ray hit testing selects a visible city heat zone', () => {
  const renderer = loadRenderer();
  const api = renderer.__test;
  api.setEarthPose(0, 0, { x: 0, y: 1.12, z: -1.3 });
  api.setLocationActivity([{ slug: 'greenwich-gb', name: 'Greenwich, GB', lat: 0, lon: 0, heat: 1 }]);
  const hit = api.hitTestEarth({ x: 0, y: 1.12, z: 0 }, { x: 0, y: 0, z: -1 });
  assert.equal(hit.hit, true);
  assert.equal(hit.zoneIndex, 0);
  closeTo(hit.dist, 1.3 - (0.676 + 0.05));
});

test('drag rotates the globe; zone tap zooms first, selects at city band (Z1)', () => {
  const renderer = loadRenderer();
  let selected = null;
  renderer.init(null, { onSelectLocation: (location) => { selected = location.slug; return true; } });
  const api = renderer.__test;
  api.setEarthPose(0, 0, { x: 0, y: 1.12, z: -1.3 });
  api.setLocationActivity([{ slug: 'greenwich-gb', name: 'Greenwich, GB', lat: 0, lon: 0, heat: 1 }]);
  const press = { hit: true, zoneIndex: 0, local: { x: 0, y: 0, z: 1 } };

  // Z1: at globe scale a zone tap zooms into the zone instead of selecting.
  api.beginEarthDrag('mouse', press);
  api.endEarthDrag('mouse', press);
  assert.equal(selected, null);
  assert.equal(api.getEarthState().zoomTarget, api.earthZoomConstants().city);
  // getEarthState copies live inside the vm realm — compare fields, not
  // prototypes (cross-realm deepStrictEqual rejects structurally equal
  // objects from a different context).
  const focus = api.getEarthState().focus;
  assert.ok(focus, 'focus set');
  assert.equal(focus.lat, 0);
  assert.equal(focus.lon, 0);

  // At/above the city band the same tap keeps the legacy select flow.
  api.setEarthZoom(api.earthZoomConstants().city, { lat: 0, lon: 0 });
  api.beginEarthDrag('mouse', press);
  api.endEarthDrag('mouse', press);
  assert.equal(selected, 'greenwich-gb');

  // Drag rotation is unchanged, and never dispatches a tap on release.
  api.setEarthZoom(1);
  api.setEarthPose(0, 0, { x: 0, y: 1.12, z: -1.3 });
  api.beginEarthDrag('mouse', press);
  api.updateEarthDrag({ x: 0.2, y: 0.1, z: 0.97 });
  api.endEarthDrag('mouse', { ...press, local: { x: 0.2, y: 0.1, z: 0.97 } });
  assert.notEqual(api.getEarthState().yaw, 0);
  assert.equal(api.getEarthState().pitch, 0);
  assert.equal(api.getEarthState().zoomTarget, 1);
});

test('heat zones scale with activity while pitch remains bounded', () => {
  const renderer = loadRenderer();
  const api = renderer.__test;
  assert.ok(api.earthZoneAngularRadius({ heat: 1 }) > api.earthZoneAngularRadius({ heat: 0.1 }));
  api.setEarthPose(0.4, 0.9, { x: 0, y: 1.12, z: -1.3 });
  api.setLocationActivity([
    { slug: 'low', name: 'Low', lat: 0, lon: 0, heat: 0.1 },
    { slug: 'high', name: 'High', lat: 20, lon: 20, heat: 1 },
  ]);
  const state = api.getEarthState();
  assert.equal(state.pitch, 0.9);
  assert.equal(state.zoneCount, 2);
  assert.equal(state.visualStyle, 'holographic-zones');
});

test('the immersive control dock exposes a prominent Earth map action', () => {
  const button = loadRenderer().__test.getControlButton('earth');
  assert.equal(button.label, 'EARTH MAP');
  assert.ok(button.w >= 100);
  assert.ok(button.h >= 30);
});

test('reduced motion disables idle spin and Earth stays dormant by default', () => {
  const renderer = loadRenderer();
  const api = renderer.__test;
  const initial = api.getEarthState();
  assert.equal(initial.resourcesReady, false);
  assert.equal(initial.renderStats.earthDrawCalls, 0);

  api.setEarthPose(0, 0, { x: 0, y: 1.12, z: -1.3 });
  renderer.setReducedMotion(true);
  api.advanceEarthSpin(1000);
  assert.equal(api.advanceEarthSpin(2000), 0);
  closeTo(api.getEarthState().yaw, 0);

  api.setEarthPose(0, 0, { x: 0, y: 1.12, z: -1.3 });
  renderer.setReducedMotion(false);
  api.advanceEarthSpin(1000);
  closeTo(api.advanceEarthSpin(1100), Math.PI / 600);
});

test('desktop preview starts without navigator.xr and cleans up GPU resources', () => {
  const counters = { deleted: 0, frameCallbacks: 0, cancelledFrameCallbacks: 0 };
  const gl = makeMockGl(counters);
  const renderer = loadRenderer({ gl });
  const canvas = makePreviewCanvas(gl);
  const video = {
    paused: true,
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback() {
      counters.frameCallbacks += 1;
      return counters.frameCallbacks;
    },
    cancelVideoFrameCallback() { counters.cancelledFrameCallbacks += 1; },
  };
  renderer.init(video, {});
  const started = renderer.startPreview(canvas, { showControls: true });

  assert.equal(started.running, true);
  assert.equal(started.sceneMode, 'reels');
  assert.equal(started.renderStats.earthDrawCalls, 0);
  assert.equal(started.__never, undefined);

  renderer.stopPreview();
  assert.equal(renderer.getPreviewState().running, false);
  assert.ok(counters.deleted > 0);
  assert.equal(counters.frameCallbacks, 1);
  assert.equal(counters.cancelledFrameCallbacks, 1);
});

test('Reels frames skip Earth draws and Earth frames pause video texture uploads', () => {
  const counters = { deleted: 0 };
  const gl = makeMockGl(counters);
  const renderer = loadRenderer({ gl });
  const canvas = makePreviewCanvas(gl);
  const video = {
    paused: false,
    readyState: 4,
    currentTime: 1,
    duration: 10,
    muted: true,
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback() { return 1; },
    cancelVideoFrameCallback() {},
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
  renderer.init(video, { getPlaylist: () => [], getCurrentIndex: () => 0 });
  renderer.startPreview(canvas, { showControls: true });
  renderer.__runScheduledFrame(16);
  let state = renderer.getPreviewState();
  assert.equal(state.renderStats.earthDrawCalls, 0);
  assert.equal(state.renderStats.videoUploads, 1);

  renderer.setSceneMode('earth');
  const uploadsBeforeEarthFrame = renderer.getPreviewState().renderStats.videoUploads;
  renderer.__runScheduledFrame(32);
  state = renderer.getPreviewState();
  assert.equal(video.paused, true);
  assert.ok(state.renderStats.earthDrawCalls > 0);
  assert.ok(state.renderStats.starDrawCalls > 0);
  assert.equal(state.renderStats.videoUploads, uploadsBeforeEarthFrame);
  renderer.stopPreview();
});

test('hovering a heat zone loads at most three cancellable location reel previews', async () => {
  const gl = makeMockGl({ deleted: 0 });
  let requestedLocation = null;
  let requestedSignal = null;
  let firstResolve = null;
  let requestCount = 0;
  const previewRows = [
    { url: '/media/one.mp4', title: 'One' },
    { url: '/media/two.mp4', title: 'Two' },
    { url: '/media/three.mp4', title: 'Three' },
    { url: '/media/four.mp4', title: 'Four' },
  ];
  const renderer = loadRenderer({ gl });
  renderer.init(null, {
    onPreviewLocation: async (location, options) => {
      requestCount += 1;
      requestedLocation = location.slug;
      requestedSignal = options.signal;
      if (requestCount === 1) return new Promise((resolve) => { firstResolve = resolve; });
      return previewRows;
    },
  });
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.setSceneMode('earth');
  await new Promise((resolve) => setImmediate(resolve));
  renderer.__test.setLocationActivity([
    { slug: 'tokyo-japan', name: 'Tokyo, Japan', lat: 35.67, lon: 139.65, heat: 0.9 },
  ]);

  const stalePreview = renderer.__test.loadEarthPreviewNow(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(requestedSignal);
  renderer.__test.setEarthHoveredIndex(-1);
  assert.equal(requestedSignal.aborted, true);
  firstResolve(previewRows);
  await stalePreview;
  assert.equal(renderer.__test.getEarthState().previewItemCount, 0);

  await renderer.__test.loadEarthPreviewNow(0);
  let state = renderer.__test.getEarthState();
  assert.equal(requestedLocation, 'tokyo-japan');
  assert.equal(state.previewLocationIndex, 0);
  assert.equal(state.previewItemCount, 3);
  renderer.__runScheduledFrame(48);
  state = renderer.__test.getEarthState();
  assert.ok(state.renderStats.earthPreviewUploads > 0);

  renderer.__test.setEarthHoveredIndex(-1);
  state = renderer.__test.getEarthState();
  assert.equal(state.previewLocationIndex, -1);
  assert.equal(state.previewStatus, 'idle');
  renderer.stopPreview();
});

test('stale Earth activity responses cannot replace the newest request', async () => {
  const requests = [];
  const fetch = () => new Promise((resolve) => requests.push(resolve));
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl, fetch });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));

  renderer.setSceneMode('earth');
  renderer.setSceneMode('reels');
  renderer.setSceneMode('earth');
  assert.equal(requests.length, 2);

  requests[1]({
    ok: true,
    json: async () => ({ locations: [{ slug: 'new', lat: 1, lon: 1, heat: 1 }] }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(renderer.__test.getEarthState().locationSlugs, ['new']);

  requests[0]({
    ok: true,
    json: async () => ({ locations: [{ slug: 'stale', lat: 2, lon: 2, heat: 1 }] }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(renderer.__test.getEarthState().locationSlugs, ['new']);
  renderer.stopPreview();
});

test('credit awards can trigger the immersive controls notification', () => {
  const renderer = loadRenderer();
  assert.equal(typeof renderer.showNotification, 'function');
  renderer.showNotification('+1 ECHO CREDIT');
  const state = renderer.__test.getEarthState();
  assert.equal(state.notificationText, '+1 ECHO CREDIT');
  assert.equal(state.notificationUntil, 5000);
});

test('pack mode exposes distinct pack and reel actions through shared callbacks', () => {
  const calls = [];
  const canvas = { width: 1024, height: 1024 };
  const renderer = loadRenderer();
  renderer.init(null, {
    getVisualSource: () => ({
      kind: 'video',
      element: { readyState: 2 },
      ready: true,
      paused: true,
      muted: true,
      currentTime: 4,
      duration: 12,
      version: 'video-1',
    }),
    isPackMode: () => true,
    getPackContext: () => ({ index: 1, total: 8, saved: false }),
    getCurrentItemState: () => ({ available: true, liked: false, saved: false, following: false }),
    onTogglePackQueue: () => calls.push('queue'),
    onSavePack: () => calls.push('save-pack'),
    onSharePack: () => calls.push('share-pack'),
    onSaveReel: () => calls.push('save-reel'),
  });

  const actions = renderer.__test.getVisibleControlActions();
  assert.ok(actions.includes('save_pack'));
  assert.ok(actions.includes('share_pack'));
  assert.ok(actions.includes('save_reel'));
  renderer.__test.executeControl('earth');
  renderer.__test.executeControl('save_pack');
  renderer.__test.executeControl('share_pack');
  renderer.__test.executeControl('save_reel');
  assert.deepEqual(calls, ['queue', 'save-pack', 'share-pack', 'save-reel']);

  renderer.init(null, {
    getVisualSource: () => ({ kind: 'static-card', element: canvas, ready: true, paused: true, version: 2 }),
    isPackMode: () => true,
    getCurrentItemState: () => ({ available: true }),
  });
  const staticActions = renderer.__test.getVisibleControlActions();
  assert.ok(staticActions.includes('save_pack'));
  assert.ok(!staticActions.includes('save_reel'));
  assert.ok(!staticActions.includes('play'));
});

test('static pack cards upload through the proxy canvas and expose normalized hit coordinates', () => {
  const counters = { deleted: 0, textureSources: [] };
  const gl = makeMockGl(counters);
  const packCanvas = { width: 1024, height: 1024 };
  const renderer = loadRenderer({ gl });
  renderer.init(null, {
    getVisualSource: () => ({
      kind: 'static-card',
      element: packCanvas,
      ready: true,
      paused: true,
      muted: true,
      currentTime: 0,
      duration: 0,
      version: 7,
    }),
    isPackMode: () => true,
  });
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.__runScheduledFrame(16);

  assert.equal(renderer.__test.getVisualSourceState().kind, 'static-card');
  assert.equal(renderer.__test.getLastUploadedSource(), packCanvas);
  const point = renderer.__test.visualPointFromHit({ x: 0, y: 0 });
  closeTo(point.u, 0.5);
  closeTo(point.v, 0.5);
  renderer.stopPreview();
});

test('a pending image source holds the prior reel texture before it becomes ready', () => {
  const counters = { deleted: 0, textureSources: [] };
  const gl = makeMockGl(counters);
  const videoElement = {
    readyState: 4,
    paused: false,
    currentTime: 1,
    duration: 10,
    muted: true,
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback() { return 1; },
    cancelVideoFrameCallback() {},
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
  const imageElement = { complete: false, naturalWidth: 0 };
  let source = {
    kind: 'video',
    element: videoElement,
    ready: true,
    paused: false,
    muted: true,
    currentTime: 1,
    duration: 10,
    version: 'video-1',
  };
  const renderer = loadRenderer({ gl });
  renderer.init(videoElement, {
    getVisualSource: () => source,
    getPlaylist: () => [],
    getCurrentIndex: () => 0,
  });
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.__runScheduledFrame(16);
  assert.equal(renderer.__test.getLastUploadedSource(), videoElement);

  source = {
    kind: 'image',
    element: imageElement,
    ready: false,
    paused: true,
    muted: true,
    currentTime: 0,
    duration: 8,
    version: 'image-1',
  };
  renderer.onVideoChange();
  renderer.__runScheduledFrame(32);
  // Hold-last-frame: the prior video stays up while the image loads (no
  // black flash mid-playlist); clears happen only with nothing displayed.
  assert.equal(renderer.__test.getLastUploadedSource(), videoElement);

  source = { ...source, ready: true };
  renderer.__runScheduledFrame(48);
  assert.equal(renderer.__test.getLastUploadedSource(), imageElement);
  renderer.stopPreview();
});

test('?vrtex=video binds a direct VideoTexture and rebinds the canvas for static sources', () => {
  const counters = { deleted: 0, textureSources: [] };
  const gl = makeMockGl(counters);
  const makeVideo = (tag, w, h, frames) => ({
    readyState: 4,
    paused: false,
    currentTime: 1,
    duration: 10,
    muted: true,
    width: w,
    height: h,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: frames }),
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback() { return 1; },
    cancelVideoFrameCallback() {},
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  });
  const videoA = makeVideo('a', 3840, 3840, 31);
  let source = {
    kind: 'video', element: videoA, ready: true,
    paused: false, currentTime: 1, duration: 10, version: 'video-direct-1',
  };
  const renderer = loadRenderer({ gl });
  renderer.init(videoA, {
    getVisualSource: () => source,
    getPlaylist: () => [],
    getCurrentIndex: () => 0,
  });
  renderer.__test.setDebugFlags({ vrtex: true });
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.__runScheduledFrame(16);
  // Direct texture bound: native video dims, not the 2048 proxy canvas.
  assert.equal(renderer.__test.getSceneInfo().screen.mapSize.join(','), '3840,3840');
  assert.equal(renderer.__test.getLastUploadedSource(), videoA);
  assert.equal(renderer.getPreviewState().renderStats.videoUploads, 1);
  renderer.__runScheduledFrame(32);
  // Same decoded frame: no re-count.
  assert.equal(renderer.getPreviewState().renderStats.videoUploads, 1);

  // A fresh element rebinds a new direct texture once ready.
  const videoB = makeVideo('b', 1920, 1080, 12);
  source = {
    kind: 'video', element: videoB, ready: true,
    paused: false, currentTime: 0.5, duration: 10, version: 'video-direct-2',
  };
  renderer.onVideoChange();
  renderer.__runScheduledFrame(48);
  assert.equal(renderer.__test.getSceneInfo().screen.mapSize.join(','), '1920,1080');
  assert.equal(renderer.__test.getLastUploadedSource(), videoB);

  // Static cards fall back to the canvas proxy (map rebound to 2048 canvas).
  const imageElement = { complete: true, naturalWidth: 64 };
  source = {
    kind: 'image', element: imageElement, ready: true,
    paused: true, currentTime: 0, duration: 8, version: 'image-direct-1',
  };
  renderer.onVideoChange();
  renderer.__runScheduledFrame(64);
  assert.equal(renderer.__test.getSceneInfo().screen.mapSize.join(','), '2048,2048');
  renderer.stopPreview();
});

test('session defaults are minimal with xrfull opt-out (v8.15 flash fix)', () => {
  const renderer = loadRenderer({});
  renderer.init(null, {});
  const flags = renderer.__test.getDebugFlags();
  assert.equal(flags.xrminimal, false);
  assert.equal(flags.xrfull, false);
  assert.equal(renderer.__test.setDebugFlags({ xrfull: true }).xrfull, true);
  assert.equal(renderer.__test.setDebugFlags({ xrfull: false }).xrfull, false);
});

test('startPreview honors caller options and rejects a missing canvas', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  assert.throws(() => renderer.startPreview(null), /canvas/i);

  const started = renderer.startPreview(makePreviewCanvas(gl), {
    cameraMode: 'orbit',
    stereo: true,
    showControls: false,
  });
  assert.equal(started.running, true);
  assert.equal(started.cameraMode, 'orbit');
  assert.equal(started.stereo, true);
  assert.equal(started.controlsVisible, false);
  renderer.stopPreview();
});

test('restarting preview after stop rebuilds textures instead of rendering black', () => {
  const gl = makeMockGl({ deleted: 0 });
  const videoElement = {
    readyState: 4,
    paused: false,
    currentTime: 1,
    duration: 10,
    muted: true,
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback() { return 1; },
    cancelVideoFrameCallback() {},
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
  const renderer = loadRenderer({ gl });
  renderer.init(videoElement, {
    getPlaylist: () => [],
    getCurrentIndex: () => 0,
  });
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.__runScheduledFrame(16);
  assert.equal(renderer.getPreviewState().renderStats.videoUploads, 1);
  assert.equal(renderer.getPreviewState().renderStats.reelDrawCalls, 1);
  renderer.stopPreview();

  // Second session must upload again (disposed textures are rebuilt).
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.__runScheduledFrame(16);
  assert.equal(renderer.getPreviewState().running, true);
  assert.equal(renderer.getPreviewState().renderStats.videoUploads, 1);
  assert.equal(renderer.__test.getLastUploadedSource(), videoElement);
  renderer.stopPreview();
});

test('camera modes, curvature alias, controls toggle, and fullscreen resolve', async () => {  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));

  renderer.setPreviewCameraMode('orbit');
  assert.equal(renderer.getPreviewState().cameraMode, 'orbit');
  renderer.setPreviewCameraMode('headset');
  assert.equal(renderer.getPreviewState().cameraMode, 'headset');

  renderer.setCurvatureMode('curved');
  assert.equal(renderer.getCurvatureMode(), 'sq_curve');
  renderer.setCurvatureMode('dome');
  assert.equal(renderer.getCurvatureMode(), 'dome');

  assert.equal(renderer.getPreviewState().controlsVisible, true);
  renderer.toggleControls();
  assert.equal(renderer.getPreviewState().controlsVisible, false);
  renderer.toggleControls();
  assert.equal(renderer.getPreviewState().controlsVisible, true);

  renderer.resetPreview();
  assert.equal(renderer.getPreviewState().cameraMode, 'headset');

  const fullscreen = await renderer.requestPreviewFullscreen();
  assert.equal(fullscreen, true);
  assert.equal(typeof renderer.version, 'string');
  renderer.stopPreview();
});

test('scene graph exposes a textured curved screen for live inspection', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  const info = renderer.__test.getSceneInfo();
  assert.equal(info.hasRenderer, true);
  assert.equal(info.hasScene, true);
  assert.equal(info.hasCamera, true);
  assert.ok(info.sceneChildren >= 5);
  assert.equal(info.screen.visible, true);
  // 48x48 Path A grid -> 49x49 vertices.
  assert.equal(info.screen.verts, 2401);
  assert.equal(info.screen.hasMap, true);
  assert.equal(info.controls.visible, true);
  assert.equal(info.earth.visible, false);
  renderer.setSceneMode('earth');
  assert.equal(renderer.__test.getSceneInfo().earth.visible, true);
  renderer.stopPreview();
});

test('mode switches gate scene membership from a single source of truth', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));

  let info = renderer.__test.getSceneInfo();
  assert.equal(info.earth.visible, false);
  assert.equal(info.screen.visible, true);
  assert.equal(info.controls.visible, true);

  renderer.setSceneMode('earth');
  info = renderer.__test.getSceneInfo();
  assert.equal(info.earth.visible, true);
  assert.equal(info.screen.visible, false);
  assert.equal(info.controls.visible, true);

  // Restarting the preview resets to the reels baseline (no stale globe).
  renderer.stopPreview();
  renderer.startPreview(makePreviewCanvas(gl));
  info = renderer.__test.getSceneInfo();
  assert.equal(info.earth.visible, false);
  assert.equal(info.screen.visible, true);
  renderer.stopPreview();
});

test('below-screen dock clears the curved screen with margin', () => {
  const renderer = loadRenderer();
  const pose = renderer.__test.computeDockPose({ x: 0, y: 1.6, z: 0 });
  // Dock center hangs below the 4.0 m default screen bottom edge
  // (1.52 − 2.0 − 0.08 = −0.56) at the default 2.24 m station.
  closeTo(pose.pos.y, -0.56);
  assert.equal(pose.pos.z, -2.24);
  // Dock center sits below the screen bottom edge (y = −0.48).
  assert.ok(pose.pos.y < -0.48);
  // Faces a centered viewer: zero yaw, upward pitch, no roll component.
  closeTo(pose.yaw, 0);
  assert.ok(pose.pitch < -0.5 && pose.pitch > -1.0);
});

test('locked mode keeps UI room-fixed at the default screen spot', () => {
  const renderer = loadRenderer();
  const api = renderer.__test;
  // Legacy-exact: move the screen while locked — dock + panels stay at the
  // default spot, sized at DEFAULT_SCALE.
  api.setScreenState({ locked: true, pos: { x: 1, y: 1.5, z: -3 }, distance: 3.0 });
  const dock = api.computeDockPose({ x: 0, y: 1.6, z: 0 });
  closeTo(dock.pos.x, 0);
  closeTo(dock.pos.y, 1.52 - 2.0 - 0.08);
  closeTo(dock.pos.z, -2.24);
  const comments = api.getCommentsPanelLayout();
  const guide = api.getGuidePanelLayout();
  assert.ok(comments.center.x < 0, `comments LEFT of default spot: ${comments.center.x}`);
  assert.ok(guide.center.x > 0, `guide RIGHT of default spot: ${guide.center.x}`);
  closeTo(comments.center.x, -(2 + comments.w / 2 + 0.384));
  closeTo(guide.center.x, 2 + guide.w / 2 + 0.384);
  closeTo(comments.center.z, -2.39);
  // Unlocked at the moved pose: UI follows the screen instead.
  api.setScreenState({ locked: false });
  const dock2 = api.computeDockPose({ x: 1, y: 1.6, z: -2 });
  closeTo(dock2.pos.x, 1);
  closeTo(dock2.pos.y, 1.5 - 2.0 - 0.08);
  closeTo(dock2.pos.z, -3);
});

test('bisection flags gate lock, overlay, guide, and glow', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  const api = renderer.__test;
  // NOTE: cross-realm objects fail deepStrictEqual on prototypes — compare
  // fields explicitly.
  const flagsOf = () => {
    const f = api.getDebugFlags();
    return [f.lock, f.overlay, f.guide, f.glow, f.dockfreeze, f.glowprobe, f.domoverlay];
  };
  assert.deepEqual(flagsOf(), [true, true, true, true, false, true, true]);
  api.setDebugFlags({ lock: false, overlay: false, guide: false, glow: false });
  assert.deepEqual(flagsOf(), [false, false, false, false, false, true, true]);
  api.setDebugFlags({ dockfreeze: true, glowprobe: false });
  assert.deepEqual(flagsOf(), [false, false, false, false, true, false, true]);
  // ?lock=0: the lock flag no longer applies face-following.
  api.setScreenState({ locked: true });
  assert.equal(api.lockApplies(), false);
  api.setScreenState({ locked: false });
  renderer.startPreview(makePreviewCanvas(gl));
  const info = renderer.__test.getSceneInfo();
  // Bisected-off subsystems never build meshes.
  assert.equal(info.overlay, undefined);
  assert.equal(info.guide, undefined);
  assert.equal(info.glow.visible, false);
  // Overlay refresh is a no-op with the flag off.
  assert.equal(api.refreshOverlayTexture(1000, true), false);
  renderer.stopPreview();
  api.setDebugFlags({ lock: true, overlay: true, guide: true, glow: true, dockfreeze: false, glowprobe: true, domoverlay: true });
  assert.deepEqual(flagsOf(), [true, true, true, true, false, true, true]);
  api.setScreenState({ locked: true });
  assert.equal(api.lockApplies(), true);
});

test('dockfreeze stops dock texture re-uploads after the first paint', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  const uploadsOf = () => renderer.getPreviewState().renderStats.dockUploads;
  renderer.__runScheduledFrame(0);
  assert.ok(uploadsOf() >= 1, 'first paint uploads');
  const painted = uploadsOf();
  api.setDebugFlags({ dockfreeze: true });
  renderer.__runScheduledFrame(200);
  renderer.__runScheduledFrame(400);
  assert.equal(uploadsOf(), painted, 'frozen: no further dock uploads');
  api.setDebugFlags({ dockfreeze: false });
  renderer.__runScheduledFrame(600);
  assert.ok(uploadsOf() > painted, 'unfrozen: uploads resume');
  renderer.stopPreview();
});

test('transition counters attribute source changes, clears, and buffering', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  const video = {
    paused: true, readyState: 1, currentTime: 0, duration: 10, muted: true,
    addEventListener() {}, removeEventListener() {},
  };
  renderer.init(video, {});
  const statsOf = () => renderer.getPreviewState().renderStats;
  renderer.onVideoChange();
  assert.equal(statsOf().transChanges, 1);
  assert.equal(statsOf().transClears, 1);
  // Not-ready video element: preview frames count buffering, not uploads.
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.__runScheduledFrame(0);
  renderer.__runScheduledFrame(200);
  const stats = statsOf();
  assert.ok(stats.transNotReady >= 2, `buffering frames counted: ${stats.transNotReady}`);
  assert.equal(stats.videoUploads, 0);
  // Ready element uploads instead of waiting.
  video.readyState = 4;
  video.paused = false;
  renderer.__runScheduledFrame(400);
  assert.ok(statsOf().videoUploads >= 1, 'ready video uploads');
  renderer.stopPreview();
});

test('shared laser prefers the right hand', () => {
  const api = loadRenderer().__test;
  const left = { handedness: 'left' };
  const right = { handedness: 'right' };
  assert.equal(api.pickPointerSource([]), null);
  assert.equal(api.pickPointerSource([left]), left);
  assert.equal(api.pickPointerSource([left, right]), right);
  assert.equal(api.pickPointerSource([right, left]), right);
  assert.equal(api.pickPointerSource([right]), right);
});

function makeIdentityController(THREE) {
  return { matrixWorld: new THREE.Matrix4() };
}

function makeVideoMock(time = 1) {
  return {
    paused: false, readyState: 4, currentTime: time, duration: 10, muted: true,
    addEventListener() {}, removeEventListener() {},
  };
}

test('trigger clicks reuse the laser ray of the same hand', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  const toggles = [];
  renderer.init(makeVideoMock(), { onTogglePlay: () => toggles.push('play') });
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  const THREE = renderer.getThree();
  assert.equal(api.getScreenState().controlsVisible, true);
  // Stored sky ray on the right hand: a right trigger acts on empty space
  // (toggles UI only) even though a fresh ray would hit the screen.
  api.setActiveRay({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 }, 'right');
  api.fireVRSelect({ target: makeIdentityController(THREE), data: { handedness: 'right' } });
  assert.deepEqual(toggles, []);
  assert.equal(api.getScreenState().controlsVisible, false);
  // The other hand raycasts fresh from its own pose: identity controller at
  // the origin faces the screen center → toggles playback.
  api.fireVRSelect({ target: makeIdentityController(THREE), data: { handedness: 'left' } });
  assert.deepEqual(toggles, ['play']);
  assert.equal(api.getScreenState().controlsVisible, true);
  renderer.stopPreview();
});

test('laser beam ends at the surface, reticle floats just off it', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(makeVideoMock(), {});
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  // Gaze-parallel ray into the screen center.
  const ret = api.updateLaserPointer({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: -1 });
  assert.equal(ret, -1); // screen hover, no dock button
  const info = api.getSceneInfo();
  const beam = info.pointer.beam;
  const rpos = info.reticle.pos;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = (v) => Math.hypot(v[0], v[1], v[2]);
  const beamLen = len(sub(beam.end, beam.start));
  const retLen = len(sub(rpos, beam.start));
  assert.ok(beamLen > 1.5 && beamLen < 3.5, `beam reaches the screen: ${beamLen}`);
  // Reticle sits 0.02 m back along the ray — never buried in the surface.
  closeTo(beamLen - retLen, 0.02, 1e-4);
  // Collinear with the ray.
  const dir = sub(rpos, beam.start).map((c) => c / retLen);
  closeTo(Math.abs(dir[0]), 0, 1e-6);
  closeTo(Math.abs(dir[1]), 0, 1e-6);
  closeTo(dir[2], -1, 1e-6);
  // Always-on-top flags (legacy drew the laser last with depth off).
  assert.equal(info.pointer.depthTest, false);
  assert.equal(info.pointer.renderOrder, 999);
  assert.equal(info.reticle.depthTest, false);
  assert.equal(info.reticle.renderOrder, 1000);
  renderer.stopPreview();
});

test('laser is built and visible while preview runs', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.__runScheduledFrame(16);
  assert.equal(renderer.__test.getSceneInfo().laser.visible, true);
  renderer.stopPreview();
});

test('earth carries a texture map, rim, label, and heat pins', () => {  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));

  // Equirect UV spot checks, standard convention (upstream verbatim):
  // Greenwich/lon 0 centers at u=0.5, dateline at the seam.
  const eq = renderer.__test.earthZoneUV(0, 0, 2048, 1024);
  closeTo(eq.x, 1024);
  closeTo(eq.y, 512);
  const pole = renderer.__test.earthZoneUV(90, -180, 2048, 1024);
  closeTo(pole.x, 0);
  closeTo(pole.y, 0);
  const tokyo = renderer.__test.earthZoneUV(35.67, 139.65, 2048, 1024);
  closeTo(tokyo.x, (139.65 + 180) / 360 * 2048);
  closeTo(tokyo.y, (90 - 35.67) / 180 * 1024);
  let info = renderer.__test.getSceneInfo();
  assert.equal(info.earthMap.hasTexture, true);
  // Seam compensation: texture shifted +0.25 so standard-equirect texels
  // (photo, painted zones) land on the matching geographic directions.
  assert.equal(info.earthMap.mapOffset, 0.25);
  // No deck cone: it read as a hemisphere-slicing panel in-headset.
  assert.equal(info.earthMap.hasRim, undefined);
  assert.equal(info.earthMap.hasLabel, true);
  assert.equal(info.earthMap.pinCount, 0);

  renderer.__test.setLocationActivity([
    { slug: 'hot', name: 'Hot', lat: 10, lon: 20, heat: 1 },
    { slug: 'warm', name: 'Warm', lat: -20, lon: -40, heat: 0.2 },
  ]);
  info = renderer.__test.getSceneInfo();
  assert.equal(info.earthMap.pinCount, 2);

  renderer.setSceneMode('earth');
  renderer.__runScheduledFrame(32);
  assert.ok(renderer.getPreviewState().renderStats.earthDrawCalls > 0);
  renderer.stopPreview();
});

test('selecting a zone with reels switches to the location playlist', async () => {
  const gl = makeMockGl({ deleted: 0 });
  const selected = [];
  const renderer = loadRenderer({ gl });
  renderer.init(null, {
    onSelectLocation: (loc) => { selected.push(loc.slug); return true; },
  });
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.__test.setLocationActivity([
    { slug: 'tokyo-japan', name: 'Tokyo, Japan', lat: 35.67, lon: 139.65, heat: 0.9 },
  ]);
  renderer.setSceneMode('earth');
  await renderer.__test.selectEarthLocation(0);
  assert.deepEqual(selected, ['tokyo-japan']);
  // Accept returns to reels mode so the new playlist plays in-VR.
  assert.equal(renderer.getPreviewState().sceneMode, 'reels');
  assert.equal(renderer.__test.getSceneInfo().earth.visible, false);
  renderer.stopPreview();
});

test('selecting a zone without reels stays on the globe', async () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {
    onSelectLocation: () => false,
  });
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.__test.setLocationActivity([
    { slug: 'nowhere', name: 'Nowhere', lat: 0, lon: 0, heat: 0.1 },
  ]);
  renderer.setSceneMode('earth');
  await renderer.__test.selectEarthLocation(0);
  assert.equal(renderer.getPreviewState().sceneMode, 'earth');
  assert.equal(renderer.__test.getSceneInfo().earth.visible, true);
  renderer.stopPreview();
});

test('dock UV hits resolve to the expected transport action', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {
    getVisualSource: () => ({
      kind: 'video',
      element: { readyState: 4 },
      ready: true,
      paused: false,
      muted: true,
      currentTime: 1,
      duration: 10,
      version: 'v1',
    }),
    isPackMode: () => false,
    getCurrentItemState: () => ({ available: true }),
  });
  renderer.startPreview(makePreviewCanvas(gl));
  // Play button center on the 1024x384 dock canvas (x 360-440, y 76-156).
  const play = renderer.__test.controlIndexFromUV({ x: 400 / 1024, y: 1 - 116 / 384 });
  assert.ok(play >= 0);
  renderer.__test.executeControl('play');
  renderer.stopPreview();
});

test('pointer taps on the video screen toggle playback via raycast', () => {  const gl = makeMockGl({ deleted: 0 });
  const calls = [];
  const renderer = loadRenderer({ gl });
  const video = {
    paused: false,
    readyState: 4,
    currentTime: 1,
    duration: 10,
    muted: true,
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback() { return 1; },
    cancelVideoFrameCallback() {},
  };
  renderer.init(video, {
    onTogglePlay: () => calls.push('toggle'),
    getPlaylist: () => [],
    getCurrentIndex: () => 0,
  });
  const canvas = makePreviewCanvas(gl);
  renderer.startPreview(canvas);
  renderer.__runScheduledFrame(16);

  // Hover the screen center: caches the head-ray, no crash.
  assert.equal(
    renderer.__test.firePreviewPointer('pointermove', { clientX: 480, clientY: 270, pointerId: 1, button: 0 }),
    true
  );
  // Tap (down + up, no drag) on the screen center toggles playback.
  assert.equal(
    renderer.__test.firePreviewPointer('pointerdown', { clientX: 480, clientY: 270, pointerId: 1, button: 0 }),
    true
  );
  assert.equal(
    renderer.__test.firePreviewPointer('pointerup', { clientX: 480, clientY: 270, pointerId: 1, button: 0 }),
    true
  );
  assert.deepEqual(calls, ['toggle']);
  // Wheel zoom path runs cleanly too.
  assert.equal(
    renderer.__test.firePreviewPointer('wheel', { deltaX: 0, deltaY: 120, preventDefault() {} }),
    true
  );
  renderer.stopPreview();
});

test('stopPreview resets to the reels baseline for the next route', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl), { cameraMode: 'orbit', stereo: true });
  renderer.setSceneMode('earth');
  assert.equal(renderer.getPreviewState().sceneMode, 'earth');
  renderer.stopPreview();
  const state = renderer.getPreviewState();
  assert.equal(state.running, false);
  assert.equal(state.sceneMode, 'reels');
  assert.equal(state.cameraMode, 'headset');
  assert.equal(state.stereo, false);
  assert.equal(state.controlsVisible, true);
});

test('enterVR without WebXR reports webxr-unavailable', async () => {
  const gl = makeMockGl({ deleted: 0 });
  const errors = [];
  const renderer = loadRenderer({ gl });
  renderer.init(null, { onVRError: (reason) => errors.push(reason) });
  const session = await renderer.enterVR();
  assert.equal(session, null);
  assert.deepEqual(errors, ['webxr-unavailable']);
});

test('enterVR maps session rejection to a reason code', async () => {
  const gl = makeMockGl({ deleted: 0 });
  const errors = [];
  const renderer = loadRenderer({ gl });
  renderer.init(null, { onVRError: (reason) => errors.push(reason) });
  const xr = {
    async requestSession() { throw new Error('no headset'); },
  };
  const session = await renderer.enterVR({ xr });
  assert.equal(session, null);
  assert.deepEqual(errors, ['session-rejected']);
  assert.equal(renderer.isPresenting(), false);
});

test('enterVR maps bind failure to a reason code and ends the session', async () => {  const gl = makeMockGl({ deleted: 0 });
  const errors = [];
  let ended = false;
  const renderer = loadRenderer({ gl });
  renderer.init(null, { onVRError: (reason) => errors.push(reason) });
  const xr = {
    async requestSession() {
      return { addEventListener() {}, end() { ended = true; } };
    },
  };
  const session = await renderer.enterVR({ xr });
  assert.equal(session, null);
  assert.deepEqual(errors, ['bind-failed']);
  assert.equal(ended, true);
  assert.equal(renderer.isPresenting(), false);
});

test('holographic classifier and heat style match upstream constants', () => {  const api = loadRenderer().__test;
  // Land: warm/continental tones; ocean: deep blue; bright ice counts land.
  assert.equal(api.classifyEarthPixel(120, 100, 40), 1);
  assert.equal(api.classifyEarthPixel(10, 30, 80), 0);
  assert.equal(api.classifyEarthPixel(250, 250, 250), 1);
  // Heat style: 4-stop fill + ring counts by threshold.
  const cold = api.earthHeatStyle(0.1, 0);
  assert.equal(cold.ringCount, 1);
  assert.equal(cold.stops.length, 5);
  const mid = api.earthHeatStyle(0.5, 1);
  assert.equal(mid.ringCount, 2);
  assert.equal(mid.ringColor, '#9CF4FF');
  const hot = api.earthHeatStyle(0.9, 2);
  assert.equal(hot.ringCount, 3);
  assert.equal(hot.ringColor, '#FFFFFF');
});

test('vertical drag pitches the globe, horizontal drag yaws with reduced gain', () => {
  const renderer = loadRenderer();
  const api = renderer.__test;
  api.setEarthPose(0, 0, { x: 0, y: 1.12, z: -1.3 });

  // Mostly-vertical flick: pitch engages, yaw stays locked near zero.
  api.beginEarthDrag('mouse', { hit: true, zoneIndex: -1, local: { x: 0, y: 0, z: 1 } });
  api.updateEarthDrag({ x: 0.02, y: 0.3, z: 0.95 });
  api.endEarthDrag('mouse', { hit: true, zoneIndex: -1, local: { x: 0.02, y: 0.3, z: 0.95 } });
  let state = api.getEarthState();
  assert.ok(state.pitch > 0.2);
  assert.ok(Math.abs(state.yaw) < 0.05);

  // Mostly-horizontal flick: yaw engages with reduced gain (1.7 vs 2.8).
  api.setEarthPose(0, 0, { x: 0, y: 1.12, z: -1.3 });
  api.beginEarthDrag('mouse', { hit: true, zoneIndex: -1, local: { x: 0, y: 0, z: 1 } });
  api.updateEarthDrag({ x: 0.3, y: 0.02, z: 0.95 });
  api.endEarthDrag('mouse', { hit: true, zoneIndex: -1, local: { x: 0.3, y: 0.02, z: 0.95 } });
  state = api.getEarthState();
  assert.ok(state.yaw > 0.2 && state.yaw < 0.9);
  assert.ok(Math.abs(state.pitch) < 0.05);

  // Pitch clamps at +/-1.2 no matter how far the drag travels.
  api.setEarthPose(0, 0, { x: 0, y: 1.12, z: -1.3 });
  api.beginEarthDrag('mouse', { hit: true, zoneIndex: -1, local: { x: 0, y: 0, z: 1 } });
  for (let i = 1; i <= 10; i++) {
    api.updateEarthDrag({ x: 0, y: i * 0.09, z: 1 - i * 0.04 });
  }
  api.endEarthDrag('mouse', { hit: false, zoneIndex: -1, local: null });
  state = api.getEarthState();
  assert.ok(state.pitch <= 1.2);
});

test('earth entry pauses playback and return resumes via handshake', () => {
  const gl = makeMockGl({ deleted: 0 });
  const calls = [];
  const video = {
    paused: false,
    readyState: 4,
    currentTime: 2,
    duration: 12,
    muted: true,
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback() { return 1; },
    cancelVideoFrameCallback() {},
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
  const renderer = loadRenderer({ gl });
  renderer.init(video, {
    onEarthOpen: (wasPlaying) => calls.push(['open', wasPlaying]),
    onEarthClose: (resume) => calls.push(['close', resume]),
    getPlaylist: () => [],
    getCurrentIndex: () => 0,
  });
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.setSceneMode('earth');
  assert.equal(video.paused, true);
  assert.deepEqual(calls, [['open', true]]);
  renderer.setSceneMode('reels');
  assert.deepEqual(calls, [['open', true], ['close', true]]);
  renderer.stopPreview();
});

test('pack mode refuses earth scene', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, { isPackMode: () => true });
  renderer.startPreview(makePreviewCanvas(gl));
  assert.equal(renderer.setSceneMode('earth'), 'reels');
  assert.equal(renderer.getPreviewState().sceneMode, 'reels');
  renderer.stopPreview();
});

test('earth-station dock floats before and below the globe', () => {
  const renderer = loadRenderer();
  const api = renderer.__test;
  const head = { x: 0, y: 1.6, z: 0 };
  const pose = api.computeDockPose(head, 'earth');
  assert.deepEqual([pose.pos.x, pose.pos.y, pose.pos.z], [0, 0.20, -0.85]);
  // Below the globe bottom edge (1.12 - 0.676 = 0.444).
  assert.ok(pose.pos.y < 0.444);
  // Tilt-aware clearance: the tilted top-edge center must clear the
  // sphere with margin (regression: the old station clipped there).
  const topY = pose.pos.y + 0.3 * Math.cos(pose.pitch);
  const topZ = pose.pos.z + 0.3 * Math.sin(pose.pitch);
  const topDist = Math.hypot(topY - 1.12, topZ - (-1.3));
  assert.ok(topDist > 0.726, `tilted top edge clears globe by ${topDist}`);
  // Sightlines from the head to all four dock corners clear the globe.
  const center = { x: 0, y: 1.12, z: -1.3 };
  const corners = [
    { x: -0.8, y: -0.1, z: -0.85 },
    { x: 0.8, y: -0.1, z: -0.85 },
    { x: -0.8, y: 0.5, z: -0.85 },
    { x: 0.8, y: 0.5, z: -0.85 },
  ];
  for (const c of corners) {
    const dx = c.x - head.x, dy = c.y - head.y, dz = c.z - head.z;
    const ex = center.x - head.x, ey = center.y - head.y, ez = center.z - head.z;
    const segLen2 = dx * dx + dy * dy + dz * dz;
    const t = Math.max(0, Math.min(1, (ex * dx + ey * dy + ez * dz) / segLen2));
    const dist = Math.hypot(ex - t * dx, ey - t * dy, ez - t * dz);
    assert.ok(dist > 0.676, `corner (${c.x},${c.y}) clears globe by ${dist}`);
  }
});

test('engine reports a parseable version stamp for stale-client checks', () => {
  const renderer = loadRenderer();
  assert.ok(/^v\d+\.\d+-/.test(renderer.version), `version: ${renderer.version}`);
});

test('shouldAttemptXR gates emulator attempts without blocking localhost', () => {
  const api = loadRenderer().__test;
  assert.equal(api.shouldAttemptXR({ isSupported: true, hostname: 'example.com' }), true);
  assert.equal(api.shouldAttemptXR({ isSupported: false, hostname: 'localhost' }), true);
  assert.equal(api.shouldAttemptXR({ isSupported: false, hostname: '127.0.0.1' }), true);
  assert.equal(api.shouldAttemptXR({ isSupported: false, hostname: 'example.com' }), false);
  assert.equal(api.shouldAttemptXR({ isSupported: false, hostname: 'example.com', forceXR: true }), true);
  assert.equal(api.shouldAttemptXR({}), false);
});

test('session rejection leaves a running preview untouched (fail-fast)', async () => {
  const gl = makeMockGl({ deleted: 0 });
  const errors = [];
  const renderer = loadRenderer({ gl });
  renderer.init(null, { onVRError: (reason) => errors.push(reason) });
  const canvas = makePreviewCanvas(gl);
  renderer.startPreview(canvas);
  assert.equal(renderer.isPreviewRunning(), true);
  const xr = {
    async requestSession() { throw new Error('no headset'); },
  };
  const session = await renderer.enterVR({ xr });
  assert.equal(session, null);
  assert.deepEqual(errors, ['session-rejected']);
  assert.equal(renderer.isPreviewRunning(), true);
  assert.equal(renderer.getPreviewState().sceneMode, 'reels');
  assert.equal(renderer.__test.hasPreviewResume(), false);
  renderer.stopPreview();
});

test('bind failure tears down then restores the preview', async () => {
  const gl = makeMockGl({ deleted: 0 });
  const errors = [];
  let ended = false;
  const renderer = loadRenderer({ gl });
  renderer.init(null, { onVRError: (reason) => errors.push(reason) });
  const canvas = makePreviewCanvas(gl);
  renderer.startPreview(canvas);
  const xr = {
    async requestSession() {
      return { addEventListener() {}, end() { ended = true; } };
    },
  };
  const session = await renderer.enterVR({ xr });
  assert.equal(session, null);
  assert.deepEqual(errors, ['bind-failed']);
  assert.equal(ended, true);
  assert.equal(renderer.isPresenting(), false);
  // Preview was torn down for the attempt, then restored from snapshot.
  assert.equal(renderer.isPreviewRunning(), true);
  assert.equal(renderer.getPreviewState().sceneMode, 'reels');
  assert.equal(renderer.__test.hasPreviewResume(), false);
  renderer.stopPreview();
});

test('xrCompatible outcome is recorded for diagnostics', async () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  assert.equal(renderer.__test.getXrCompatStatus(), 'unknown');
  const xr = {
    async requestSession() {
      return { addEventListener() {}, end() {} };
    },
  };
  await renderer.enterVR({ xr });
  // Mock GL's proxy answers every prop with a noop, so makeXRCompatible
  // "exists" and resolves: recorded as made-compatible. Real browsers
  // without the API record compatible; failures record failed:*.
  const compat = renderer.__test.getXrCompatStatus();
  assert.ok(compat === 'compatible' || compat === 'made-compatible', `compat: ${compat}`);
  const info = renderer.__test.getSceneInfo();
  assert.equal(info.xr.presenting, false);
  assert.equal(info.xr.compat, compat);
  assert.equal(renderer.getPreviewState().xrCompat, compat);
});

test('reels.html localhost gate attempts instead of blocking', () => {  const html = readFileSync(new URL('../../ui/assets/reels.html', import.meta.url), 'utf8');
  assert.ok(html.includes('TRYING EMULATED SESSION'), 'emulator attempt flash present');
  assert.ok(html.includes('forceXR=1'), '?forceXR=1 override present');
  assert.ok(html.includes('attemptXR'), 'attempt flag gates the session call');
  assert.ok(!html.includes("showFlash('INSTALL WEBXR EMULATOR"), 'old localhost block removed');
});

test('preview ray seam hits the globe and misses the sky', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  const canvas = makePreviewCanvas(gl);
  renderer.startPreview(canvas);
  renderer.__runScheduledFrame(16);
  // Canvas center ray fires forward into the scene.
  const center = renderer.__test.previewRayFor(480, 270);
  assert.ok(center, 'center ray exists');
  const hit = renderer.__test.hitTestEarth(center.origin, center.direction);
  assert.equal(hit.hit, true);
  // Top-left corner ray escapes into the starfield.
  const corner = renderer.__test.previewRayFor(10, 10);
  assert.ok(corner, 'corner ray exists');
  assert.equal(renderer.__test.hitTestEarth(corner.origin, corner.direction).hit, false);
  renderer.stopPreview();
});

test('pointer cycle leaves no captured error and reports hover state', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {
    getVisualSource: () => ({
      kind: 'video', element: { readyState: 4 }, ready: true,
      paused: false, muted: true, currentTime: 1, duration: 10, version: 'v1',
    }),
    isPackMode: () => false,
    getCurrentItemState: () => ({ available: true }),
  });
  renderer.startPreview(makePreviewCanvas(gl));
  assert.equal(renderer.__test.getLastPointerError(), '');
  const state = renderer.getPreviewState();
  assert.equal(state.hoveredButton, -1);
  assert.equal(state.pressedButton, -1);
  assert.equal(state.presenting, false);
  // Full down/move/up at canvas center runs cleanly end to end.
  assert.equal(renderer.__test.firePreviewPointer('pointerdown', { clientX: 480, clientY: 270, pointerId: 1, button: 0 }), true);
  assert.equal(renderer.__test.firePreviewPointer('pointermove', { clientX: 480, clientY: 260, pointerId: 1, button: 0 }), true);
  assert.equal(renderer.__test.firePreviewPointer('pointerup', { clientX: 480, clientY: 260, pointerId: 1, button: 0 }), true);
  assert.equal(renderer.__test.getLastPointerError(), '');
  renderer.stopPreview();
});

// ─── v8.3 lock-to-viewer + PlayVR scale/distance + panel/guide parity ──

function mockGamepad(axes, pressed) {
  return {
    axes: axes.slice(),
    buttons: pressed.map((p) => ({ pressed: !!p })),
    hapticActuators: [],
  };
}

function mockXRSession(sources) {
  return { inputSources: sources };
}

function rightSource(gamepad) {
  return { handedness: 'right', gamepad, targetRaySpace: null };
}

function loadUICanvasStandalone() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(uiCanvasSource, sandbox, { filename: 'vr_ui_canvas.js' });
  return sandbox.VRUICanvas;
}

function makeRecordingCtx() {
  const texts = [];
  const ctx = makeCanvas2dContext();
  ctx.fillText = (...args) => { texts.push(args.map(String).join(' ')); };
  return { ctx, texts };
}

function dockRenderOptions(overrides = {}) {
  return {
    source: { paused: true, muted: false, currentTime: 0, duration: 10 },
    itemState: { available: true },
    packMode: false,
    playlist: [],
    idx: 0,
    comments: [],
    hoveredButton: -1,
    pressedButton: -1,
    isCurved: true,
    curvatureMode: 1,
    lockToViewer: true,
    autoNext: true,
    sceneMode: 'reels',
    ...overrides,
  };
}

test('lock pose math centers the screen on the head forward axis', () => {
  const api = loadRenderer().__test;
  const forward = api.computeLockedPose({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: -1 }, 2.24);
  closeTo(forward.x, 0);
  closeTo(forward.y, 1.6);
  closeTo(forward.z, -2.24);
  // Looking 90° right parks the screen on +X.
  const right = api.computeLockedPose({ x: 1, y: 1.6, z: 2 }, { x: 1, y: 0, z: 0 }, 2.24);
  closeTo(right.x, 3.24);
  closeTo(right.y, 1.6);
  closeTo(right.z, 2);
  // Default distance falls back to the live screenDistance.
  const api2 = loadRenderer().__test;
  api2.setScreenState({ distance: 3 });
  const def = api2.computeLockedPose({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: -1 });
  closeTo(def.z, -3);
});

test('screen scale and distance clamp to the PlayVR travel limits', () => {
  const api = loadRenderer().__test;
  assert.equal(api.clampScreenScale(0.5), 1.0);
  assert.equal(api.clampScreenScale(4.0), 4.0);
  assert.equal(api.clampScreenScale(20), 10.0);
  assert.equal(api.clampScreenDistance(0.5), 1.2);
  assert.equal(api.clampScreenDistance(2.24), 2.24);
  assert.equal(api.clampScreenDistance(9), 6.0);
  assert.equal(api.dockTargetSize(4).w, 3.28);
});

test('head lock poses the live screen perpendicular and centered', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  api.setScreenState({ locked: true });
  api.applyLockToViewer();
  api.commitScreenTransform();
  const info = api.getSceneInfo();
  closeTo(info.screen.pos[0], 0);
  closeTo(info.screen.pos[1], 1.6);
  closeTo(info.screen.pos[2], -2.24);
  const state = api.getScreenState();
  assert.equal(state.locked, true);
  assert.equal(state.scale, 4.0);
  assert.equal(state.distance, 2.24);
  renderer.stopPreview();
});

test('grip plus stick Y scales the screen up and down', () => {
  const renderer = loadRenderer();
  renderer.init(null, {});
  const api = renderer.__test;
  assert.equal(api.getScreenState().scale, 4.0);
  // Grip held + stick pushed up (axes[3] = −1) grows the screen.
  const gripUp = mockXRSession([rightSource(mockGamepad([0, 0, 0, -1], [false, true, false, false, false, false]))]);
  api.processXRInput(null, gripUp);
  closeTo(api.getScreenState().scale, 4.04);
  // Grip held + stick pulled down shrinks it back.
  const gripDown = mockXRSession([rightSource(mockGamepad([0, 0, 0, 1], [false, true, false, false, false, false]))]);
  api.processXRInput(null, gripDown);
  closeTo(api.getScreenState().scale, 4.0);
  // No grip: stick Y alone never touches the scale.
  const bare = mockXRSession([rightSource(mockGamepad([0, 0, 0, -1], [false, false, false, false, false, false]))]);
  api.processXRInput(null, bare);
  closeTo(api.getScreenState().scale, 4.0);
});

test('grip plus stick X moves the screen further and closer', () => {
  const renderer = loadRenderer();
  renderer.init(null, {});
  const api = renderer.__test;
  api.setScreenState({ locked: false });
  // Unlocked: the screen translates along its head-facing axis.
  const gripRight = mockXRSession([rightSource(mockGamepad([0, 0, 1, 0], [false, true, false, false, false, false]))]);
  api.processXRInput(null, gripRight);
  const moved = api.getScreenState();
  assert.ok(moved.pos.z < -2.24, `screen moved further: ${moved.pos.z}`);
  // Locked: the distance state itself changes (lock pose consumes it).
  api.setScreenState({ locked: true });
  const before = api.getScreenState().distance;
  api.processXRInput(null, gripRight);
  closeTo(api.getScreenState().distance, before + 0.03);
  const gripLeft = mockXRSession([rightSource(mockGamepad([0, 0, -1, 0], [false, true, false, false, false, false]))]);
  api.processXRInput(null, gripLeft);
  closeTo(api.getScreenState().distance, before);
});

test('A and B buttons toggle playback and the control panels', () => {
  const toggles = [];
  const renderer = loadRenderer();
  renderer.init(null, { onTogglePlay: () => toggles.push('play') });
  const api = renderer.__test;
  assert.equal(api.getScreenState().controlsVisible, true);
  // A button edge-triggers play/pause exactly once per press.
  const aDown = mockXRSession([rightSource(mockGamepad([0, 0, 0, 0], [false, false, false, false, true, false]))]);
  api.processXRInput(null, aDown);
  assert.deepEqual(toggles, ['play']);
  api.processXRInput(null, aDown);
  assert.deepEqual(toggles, ['play']);
  const released = mockXRSession([rightSource(mockGamepad([0, 0, 0, 0], [false, false, false, false, false, false]))]);
  api.processXRInput(null, released);
  api.processXRInput(null, aDown);
  assert.deepEqual(toggles, ['play', 'play']);
  // B button toggles the dock + guide visibility.
  const bDown = mockXRSession([rightSource(mockGamepad([0, 0, 0, 0], [false, false, false, false, false, true]))]);
  api.processXRInput(null, bDown);
  assert.equal(api.getScreenState().controlsVisible, false);
  api.processXRInput(null, released);
  api.processXRInput(null, bDown);
  assert.equal(api.getScreenState().controlsVisible, true);
});

test('bare stick flicks navigate and seek with latch and reset', () => {
  const calls = [];
  const renderer = loadRenderer();
  renderer.init(null, {
    onNext: () => calls.push('next'),
    onPrev: () => calls.push('prev'),
    onSeek: (d) => calls.push('seek:' + d),
  });
  const api = renderer.__test;
  const flickDown = mockXRSession([rightSource(mockGamepad([0, 0, 0, 1], [false, false, false, false, false, false]))]);
  api.processXRInput(null, flickDown);
  assert.deepEqual(calls, ['next']);
  // Held deflection does not repeat (flick latch).
  api.processXRInput(null, flickDown);
  assert.deepEqual(calls, ['next']);
  // Returning to neutral resets the latch.
  const neutral = mockXRSession([rightSource(mockGamepad([0, 0, 0, 0], [false, false, false, false, false, false]))]);
  api.processXRInput(null, neutral);
  api.processXRInput(null, flickDown);
  assert.deepEqual(calls, ['next', 'next']);
  // Stick X flicks seek ±5 s.
  const flickRight = mockXRSession([rightSource(mockGamepad([0, 0, 1, 0], [false, false, false, false, false, false]))]);
  api.processXRInput(null, flickRight);
  assert.deepEqual(calls, ['next', 'next', 'seek:5']);
});

test('comments panel sits LEFT and guide sits RIGHT of the player', () => {
  const api = loadRenderer().__test;
  const comments = api.getCommentsPanelLayout();
  const guide = api.getGuidePanelLayout();
  assert.ok(comments.center.x < 0, `comments LEFT: ${comments.center.x}`);
  assert.ok(guide.center.x > 0, `guide RIGHT: ${guide.center.x}`);
  closeTo(comments.center.x, -(2 + comments.w / 2 + 0.384));
  closeTo(guide.center.x, 2 + guide.w / 2 + 0.384);
  // Legacy-exact: locked mode anchors both to the room spot tracking the
  // default screen (NOT the live screenDistance).
  api.setScreenState({ locked: true, distance: 3.0 });
  const lockedComments = api.getCommentsPanelLayout();
  const lockedGuide = api.getGuidePanelLayout();
  assert.ok(lockedComments.center.x < 0);
  assert.ok(lockedGuide.center.x > 0);
  closeTo(lockedComments.center.z, -2.39);
  closeTo(lockedGuide.center.z, -2.39);
});

test('comment panel actions drive tabs, scroll, like, seek, and close', () => {
  const liked = [];
  const sought = [];
  const renderer = loadRenderer();
  const comments = [
    { id: 'c1', author_name: 'ann', text: 'first', timestamp: 1 },
    { id: 'c2', author_name: 'bob', text: 'second', timestamp: 2 },
    { id: 'c3', author_name: 'cat', text: 'third', timestamp: null },
    { id: 'c4', author_name: 'dan', text: 'fourth', timestamp: 4 },
    { id: 'c5', author_name: 'eve', text: 'fifth', timestamp: null },
  ];
  renderer.init(null, {
    getComments: () => comments,
    onLikeComment: (id) => liked.push(id),
    onSeekTo: (t) => sought.push(t),
  });
  const api = renderer.__test;
  api.toggleCommentsPanel();
  assert.equal(api.getScreenState().commentsPanelVisible, true);
  // Tabs switch the filter and reset the scroll.
  assert.equal(api.executeCommentAction('tab:sync'), true);
  assert.equal(api.getScreenState().cPanelTab, 'sync');
  // Scroll bounds follow the filtered list (3 sync × 112 − 520 = −184 → 0).
  api.refreshPanelScrollBounds(comments.filter((c) => c.timestamp !== null && c.timestamp !== undefined));
  assert.equal(api.executeCommentAction('scrolldown'), true);
  assert.equal(api.getScreenState().cPanelScrollY, 0);
  // All tab: 5 × 112 − 520 = 40 max scroll.
  assert.equal(api.executeCommentAction('tab:all'), true);
  api.refreshPanelScrollBounds(comments);
  assert.equal(api.getScreenState().cPanelMaxScroll, 40);
  assert.equal(api.executeCommentAction('scrolldown'), true);
  assert.equal(api.getScreenState().cPanelScrollY, 40);
  assert.equal(api.executeCommentAction('scrollup'), true);
  assert.equal(api.getScreenState().cPanelScrollY, 0);
  // Item actions route to host callbacks.
  assert.equal(api.executeCommentAction('like:c2'), true);
  assert.deepEqual(liked, ['c2']);
  assert.equal(api.executeCommentAction('seek:c4'), true);
  assert.deepEqual(sought, [4]);
  assert.equal(api.executeCommentAction('panel'), true);
  assert.equal(api.executeCommentAction('bogus'), false);
  // Close hides the panel.
  assert.equal(api.executeCommentAction('close'), true);
  assert.equal(api.getScreenState().commentsPanelVisible, false);
});

test('popup overlay regions resolve to the clicked comment', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  const video = {
    paused: false, readyState: 4, currentTime: 2, duration: 10, muted: true,
    addEventListener() {}, removeEventListener() {},
  };
  renderer.init(video, {
    getComments: () => ([
      { id: 'c1', author_name: 'ann', text: 'hello world', timestamp: 1, avatar_color: '#fff' },
    ]),
  });
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  assert.equal(api.refreshOverlayTexture(1000), true);
  assert.equal(api.getScreenState().overlayPopups, 1);
  // Middle-left popup hit (canvas ~200,512 of the 1024² overlay).
  assert.equal(api.overlayCommentFromUV({ x: 200 / 1024, y: 0.5 }), 'c1');
  assert.equal(api.overlayCommentFromUV({ x: 0.95, y: 0.5 }), null);
  // Opening the panel at the comment shows and highlights it.
  api.openCommentsPanelToComment('c1');
  const state = api.getScreenState();
  assert.equal(state.commentsPanelVisible, true);
  renderer.stopPreview();
});

test('dock AUTO/LOOP and LOCK/FREE labels follow live state', () => {
  const ui = loadUICanvasStandalone();
  assert.equal(ui.GUIDE_H, 760);
  // Recording ctx captures fillText(text, x, y) joined with spaces.
  const firstToken = (texts, label) => texts.some((t) => t.split(' ')[0] === label);
  const loop = makeRecordingCtx();
  ui.renderControlsCanvas(loop.ctx, dockRenderOptions({ autoNext: false }));
  assert.ok(firstToken(loop.texts, 'LOOP'), `has LOOP label: ${loop.texts.join('|')}`);
  const auto = makeRecordingCtx();
  ui.renderControlsCanvas(auto.ctx, dockRenderOptions({ autoNext: true }));
  assert.ok(firstToken(auto.texts, 'AUTO'), `has AUTO label: ${auto.texts.join('|')}`);
  const locked = makeRecordingCtx();
  ui.renderControlsCanvas(locked.ctx, dockRenderOptions({ lockToViewer: true }));
  assert.ok(firstToken(locked.texts, 'LOCK'), `has LOCK label: ${locked.texts.join('|')}`);
  const free = makeRecordingCtx();
  ui.renderControlsCanvas(free.ctx, dockRenderOptions({ lockToViewer: false }));
  assert.ok(firstToken(free.texts, 'FREE'), `has FREE label: ${free.texts.join('|')}`);
});

test('guide panel renders the controller artwork without errors', () => {
  const ui = loadUICanvasStandalone();
  const { ctx, texts } = makeRecordingCtx();
  ui.renderGuideCanvas(ctx);
  const joined = texts.join('\n');
  assert.ok(joined.includes('CONTROLLER GUIDE'), 'guide header drawn');
  assert.ok(joined.includes('GRIP + STICK'), 'grip+stick card drawn');
  assert.ok(joined.includes('THUMBSTICK'), 'thumbstick card drawn');
});

test('UI meshes paint over the video screen in legacy order', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  const info = renderer.__test.getSceneInfo();
  // Opaque screen first with depth testing on ...
  assert.equal(info.screen.paint.renderOrder, 0);
  assert.equal(info.screen.paint.depthTest, true);
  // ... then the UI ladder, all depth-test-free like the legacy
  // DEPTH_TEST-off painter's order.
  assert.equal(info.overlay.renderOrder, 2);
  assert.equal(info.overlay.depthTest, false);
  assert.equal(info.controls.renderOrder, 3);
  assert.equal(info.controls.depthTest, false);
  assert.equal(info.comments.renderOrder, 4);
  assert.equal(info.comments.depthTest, false);
  assert.equal(info.guide.renderOrder, 4);
  assert.equal(info.guide.depthTest, false);
  renderer.stopPreview();
});

test('guide artwork falls back to vector without the photo asset', () => {
  const ui = loadUICanvasStandalone();
  // No window.QUEST_CONTROLLER_B64 in the sandbox → vector path, no crash,
  // and no phantom dirty flag that would spam texture re-uploads.
  const { ctx, texts } = makeRecordingCtx();
  ui.renderGuideCanvas(ctx);
  assert.ok(texts.join('\n').includes('CONTROLLER GUIDE'));
  assert.equal(ui.isGuideArtworkDirty(), false);
  ui.clearGuideArtworkDirty();
});

test('overlay re-renders only when the popup set is dirty', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  const video = {
    paused: false, readyState: 4, currentTime: 2, duration: 10, muted: true,
    addEventListener() {}, removeEventListener() {},
  };
  renderer.init(video, { getComments: () => [] });
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  // No comments: advancing time never re-renders or re-uploads after the
  // first (empty) paint — the v8.3 10 Hz churn is gone.
  assert.equal(api.refreshOverlayTexture(1000), false);
  assert.equal(api.getScreenState().overlayUploads, 1);
  assert.equal(api.refreshOverlayTexture(2000), false);
  assert.equal(api.refreshOverlayTexture(10000), false);
  assert.equal(api.getScreenState().overlayUploads, 1);
  renderer.stopPreview();
});

test('overlay fade repaints while visible, bounded at the UI interval', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  const video = {
    paused: false, readyState: 4, currentTime: 2, duration: 10, muted: true,
    addEventListener() {}, removeEventListener() {},
  };
  renderer.init(video, {
    getComments: () => ([
      { id: 'c1', author_name: 'ann', text: 'hi', timestamp: 1 },
    ]),
  });
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  assert.equal(api.refreshOverlayTexture(1000), true);
  assert.equal(api.getScreenState().overlayUploads, 1);
  // Same set 50 ms later: no repaint (fade ticks at ≤10 Hz).
  assert.equal(api.refreshOverlayTexture(1050), true);
  assert.equal(api.getScreenState().overlayUploads, 1);
  // Same set past the interval: fade repaint.
  assert.equal(api.refreshOverlayTexture(1200), true);
  assert.equal(api.getScreenState().overlayUploads, 2);
  renderer.stopPreview();
});

test('canvas textures use legacy linear sampling without mipmaps', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  const THREE = renderer.getThree();
  const filters = renderer.__test.getTextureFilterInfo();
  for (const [name, f] of Object.entries(filters)) {
    assert.ok(f, `${name} texture exists`);
    assert.equal(f.minFilter, THREE.LinearFilter, `${name} minFilter`);
    assert.equal(f.generateMipmaps, false, `${name} no mipmaps`);
  }
  renderer.stopPreview();
});

test('domoverlay flag omits the overlay layer from session options', async () => {
  const renderer = loadRenderer();
  renderer.init(null, {});
  const api = renderer.__test;
  api.setDebugFlags({ domoverlay: false });
  let captured = null;
  const xr = {
    // NOTE: enterVR retries with a minimal no-opts call after rejection —
    // only capture the full-options call.
    async requestSession(mode, opts) { if (opts) captured = opts; throw new Error('no headset'); },
  };
  await renderer.enterVR({ xr });
  assert.ok(captured, 'session requested');
  assert.equal(captured.domOverlay, undefined);
  assert.ok(!(captured.optionalFeatures || []).includes('dom-overlay'), 'no dom-overlay feature');
  // v8.15: minimal session is the default — dom-overlay is only requested in
  // full-session mode (?xrfull=1), even with the domoverlay flag on.
  api.setDebugFlags({ domoverlay: true });
  captured = null;
  await renderer.enterVR({ xr });
  assert.ok(!(captured.optionalFeatures || []).includes('dom-overlay'), 'minimal session omits dom-overlay');
  assert.equal([...(captured.optionalFeatures || [])].sort().join(','), 'local,local-floor');
  // Legacy full session (?xrfull=1) restores the overlay layer request.
  api.setDebugFlags({ xrfull: true });
  captured = null;
  await renderer.enterVR({ xr });
  assert.ok((captured.optionalFeatures || []).includes('dom-overlay'), 'dom-overlay feature requested');
});

test('default session request is minimal, xrfull restores legacy (v8.15+)', async () => {
  const renderer = loadRenderer();
  renderer.init(null, {});
  let captured = null;
  const xr = {
    async requestSession(mode, opts) { if (opts) captured = opts; throw new Error('no headset'); },
  };
  await renderer.enterVR({ xr });
  assert.ok(captured, 'session requested');
  assert.equal([...(captured.optionalFeatures || [])].sort().join(','), 'local,local-floor');
  renderer.__test.setDebugFlags({ xrfull: true });
  captured = null;
  await renderer.enterVR({ xr });
  assert.ok((captured.optionalFeatures || []).includes('bounded-floor'), 'legacy bounded-floor restored');
  assert.ok((captured.optionalFeatures || []).includes('hand-tracking'), 'legacy hand-tracking restored');
});

test('default renderer opts are minimal AA-off (v8.17 flash fix)', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  const T = renderer.getThree();
  const seen = [];
  const Orig = T.WebGLRenderer;
  T.WebGLRenderer = function (opts) {
    seen.push({ alpha: !!opts.alpha, antialias: !!opts.antialias });
    return new Orig(opts);
  };
  try {
    renderer.startPreview(makePreviewCanvas(gl));
  } finally {
    T.WebGLRenderer = Orig;
  }
  assert.ok(seen.length > 0, 'renderer created');
  assert.deepEqual(seen[0], { alpha: false, antialias: false });
  renderer.stopPreview();
});

test('reel switches hold the last frame instead of flashing black', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  const video = {
    paused: true, readyState: 1, currentTime: 0, duration: 10, muted: true,
    src: 'a', currentSrc: 'a', addEventListener() {}, removeEventListener() {},
  };
  renderer.init(video, {});
  // Session start with nothing displayed: pending source clears to black.
  renderer.onVideoChange();
  assert.equal(renderer.__test.getLastUploadedSource(), '__cleared__');
  // First frames arrive → displayed.
  video.readyState = 4;
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.__runScheduledFrame(0);
  assert.equal(renderer.__test.getLastUploadedSource(), video);
  // Switch while the new source buffers: the old frame is held, no re-clear.
  video.currentSrc = 'b';
  video.readyState = 1;
  renderer.onVideoChange();
  assert.equal(renderer.__test.getLastUploadedSource(), video);
  const stats = renderer.getPreviewState().renderStats;
  assert.equal(stats.transChanges, 2);
  assert.equal(stats.transClears, 1);
  renderer.stopPreview();
});

test('video uploads gate on decoded frames, not wall-clock time', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  let decoded = 10;
  const video = {
    paused: false, readyState: 4, currentTime: 1.0, duration: 10, muted: true,
    addEventListener() {}, removeEventListener() {},
    getVideoPlaybackQuality: () => ({ totalVideoFrames: decoded }),
  };
  renderer.init(video, {});
  renderer.startPreview(makePreviewCanvas(gl));
  const uploadsOf = () => renderer.getPreviewState().renderStats.videoUploads;
  renderer.__runScheduledFrame(0);
  assert.equal(uploadsOf(), 1);
  // Same decoded frame, clock creeping (normal 90 Hz playback): no re-upload.
  video.currentTime = 1.1;
  renderer.__runScheduledFrame(200);
  assert.equal(uploadsOf(), 1);
  // New decoded frame: upload.
  decoded = 11;
  renderer.__runScheduledFrame(400);
  assert.equal(uploadsOf(), 2);
  // Paused seek jump lands without new decodes: upload (no stale frame).
  video.currentTime = 5.0;
  renderer.__runScheduledFrame(600);
  assert.equal(uploadsOf(), 3);
  renderer.stopPreview();
});

test('fresh visuals wait for forward-buffered data, steady visuals do not', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  const video = {
    paused: false, readyState: 2, currentTime: 0, duration: 10, muted: true,
    src: 'a', currentSrc: 'a', addEventListener() {}, removeEventListener() {},
  };
  renderer.init(video, {});
  renderer.startPreview(makePreviewCanvas(gl));
  const uploadsOf = () => renderer.getPreviewState().renderStats.videoUploads;
  renderer.__runScheduledFrame(0);
  // Fresh visual at HAVE_CURRENT_DATA only: held, nothing uploaded (the
  // decoder-resync garbage window is skipped, not shown).
  assert.equal(uploadsOf(), 0);
  // Forward-buffered: uploads.
  video.readyState = 3;
  renderer.__runScheduledFrame(200);
  assert.equal(uploadsOf(), 1);
  // Steady visual back at HAVE_CURRENT_DATA: uploads (no regression).
  video.readyState = 2;
  video.currentTime = 0.5;
  renderer.__runScheduledFrame(400);
  assert.equal(uploadsOf(), 2);
  renderer.stopPreview();
});

test('video upload path A/B switch is honored', () => {
  const renderer = loadRenderer();
  renderer.init(null, {});
  const api = renderer.__test;
  assert.equal(api.getScreenState().uploadMode, 'subimage');
  assert.equal(renderer.setVideoUploadMode('respec'), 'respec');
  assert.equal(api.getScreenState().uploadMode, 'respec');
  assert.equal(renderer.setVideoUploadMode('bogus'), 'subimage');
});


// ─── Z1: Earth zoom map (docs/earth-zoom-map-plan.md) ─────────────────

test('Z1 unitToLatLon round-trips locationToUnit across the globe', () => {
  const api = loadRenderer().__test;
  const spots = [[0, 0], [35.67, 139.65], [-33.86, 151.2], [51.5, -0.12], [90, 0], [-90, 45], [21.02, 105.85]];
  for (const [lat, lon] of spots) {
    const back = api.unitToLatLon(api.locationToUnit(lat, lon));
    closeTo(back.lat, lat, 1e-6);
    closeTo(back.lon, ((lon + 540) % 360) - 180, 1e-6);
  }
});

test('Z1 focus rotation solver faces the target direction', () => {
  const api = loadRenderer().__test;
  const norm = (v) => {
    const l = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / l, y: v.y / l, z: v.z / l };
  };
  const DEG = Math.PI / 180; // (kept for future spot tuning in degrees)
  // Reachability mirror (same closed form as the solver, unclamped): a
  // facing is exactly achievable iff some pitch branch lands inside ±1.2.
  // locationToUnit: x = sinθcosφ, y = sinφ, z = cosθcosφ.
  const reachable = (lat, lon, t) => {
    const v = api.locationToUnit(lat, lon);
    const r = Math.hypot(v.y, v.z);
    if (r < 1e-6) return false;
    const ratio = t.y / r;
    if (Math.abs(ratio) > 1 + 1e-9) return false; // beyond any pitch (acos would clamp)
    const phi0 = Math.atan2(v.z, v.y);
    const a = Math.acos(Math.max(-1, Math.min(1, ratio)));
    return [a - phi0, -a - phi0].some((p) => Math.abs(p) <= 1.2 + 1e-9);
  };
  // View axes: gentle tilts, some deliberately beyond the ±1.2 pitch clamp.
  const targets = [norm({ x: 0, y: -0.3, z: -1 }), norm({ x: 0.4, y: 0.2, z: -0.9 }), norm({ x: -0.2, y: 0.6, z: -0.7 })];
  const spots = [[0, 0], [35.67, 139.65], [-33.86, 151.2], [21.02, 105.85], [60, -60]];
  let exactCases = 0;
  let clampedCases = 0;
  let saturatingCases = 0;
  for (const [lat, lon] of spots) {
    for (const t of targets) {
      const solved = api.solveEarthFocusRotation(lat, lon, t);
      const dir = api.rotateEarthDir(api.locationToUnit(lat, lon), solved.yaw, solved.pitch);
      assert.ok(Math.abs(solved.pitch) <= 1.2 + 1e-9, 'pitch stays inside the drag clamp');
      if (reachable(lat, lon, t)) {
        exactCases += 1;
        closeTo(dir.x, t.x, 1e-6);
        closeTo(dir.y, t.y, 1e-6);
        closeTo(dir.z, t.z, 1e-6);
      } else {
        // Clamp- or geometry-limited (target y beyond pitch reach): stays
        // finite inside the clamp; some cases saturate at exactly ±1.2.
        clampedCases += 1;
        assert.ok(Number.isFinite(solved.pitch), 'clamped branch stays finite');
        if (Math.abs(solved.pitch) === 1.2) saturatingCases += 1;
      }
    }
  }
  assert.ok(exactCases >= 8, `exact facing covers the reachable set (${exactCases})`);
  assert.ok(clampedCases >= 3, `clamp behavior is exercised (${clampedCases})`);
  assert.ok(saturatingCases >= 2, `clamp saturation is exercised (${saturatingCases})`);
});

test('Z1 zoom clamps and maps onto slippy tile zoom bands', () => {
  const api = loadRenderer().__test;
  const C = api.earthZoomConstants();
  assert.equal(C.max, 16384);
  assert.equal(api.clampEarthZoom(0.5), 1);
  assert.equal(api.clampEarthZoom(100), 100);
  assert.equal(api.clampEarthZoom(999999), C.max);
  assert.equal(api.clampEarthZoom('junk'), 1);
  // tileZ mapping (log2(S)+3.3): constant ~4.6 tiles across the FOV.
  api.setEarthZoom(1); assert.equal(api.earthTileZoom(), 3);
  api.setEarthZoom(4); assert.equal(api.earthTileZoom(), 5);
  api.setEarthZoom(8); assert.equal(api.earthTileZoom(), 6);
  api.setEarthZoom(512); assert.equal(api.earthTileZoom(), 12);
  api.setEarthZoom(16384); assert.equal(api.earthTileZoom(), 17);
});

test('Z1 continuous zoom locks a facing focus and releases it back at globe', () => {
  const renderer = loadRenderer();
  renderer.init(null, {});
  const api = renderer.__test;
  api.setEarthPose(0, 0, { x: 0, y: 1.12, z: -1.3 });
  assert.equal(api.getEarthState().focus, null);
  api.adjustEarthZoom(2);
  let state = api.getEarthState();
  assert.equal(state.zoomTarget, 2);
  assert.ok(state.focus && typeof state.focus.lat === 'number', 'focus = facing lat/lon');
  assert.ok(state.anchor, 'comfort anchor locked');
  // Harness head defaults to (0, 1.6, 0): anchor sits 1.15 m toward the globe.
  const d = Math.hypot(state.anchor.x - 0, state.anchor.y - 1.6, state.anchor.z - 0);
  closeTo(d, api.earthZoomConstants().surfaceDist, 1e-6);
  api.adjustEarthZoom(0.5);
  state = api.getEarthState();
  assert.equal(state.zoomTarget, 1);
  assert.equal(state.focus, null);
  assert.equal(state.anchor, null);
});

test('Z1 tap on open globe zooms one step toward the tapped point', () => {
  const renderer = loadRenderer();
  renderer.init(null, {});
  const api = renderer.__test;
  api.setEarthPose(0, 0, { x: 0, y: 1.12, z: -1.3 });
  const action = api.handleEarthTap(-1, { hit: true, zoneIndex: -1, local: { x: 0, y: 0, z: 1 } });
  assert.equal(action, 'zoom-point');
  const state = api.getEarthState();
  closeTo(state.zoomTarget, api.earthZoomConstants().step);
  // Field-wise compare: focus lives in the vm realm (prototype differs).
  assert.ok(state.focus, 'focus set');
  assert.equal(state.focus.lat, 0);
  assert.equal(state.focus.lon, 0);
  assert.equal(api.handleEarthTap(-1, null), 'none');
});



test('Z1 tap animation lands the focus on the view axis at comfort distance', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.setSceneMode('earth');
  const api = renderer.__test;
  const C = api.earthZoomConstants();
  api.zoomEarthTo(35.67, 139.65, C.city);
  api.advanceEarthZoom(100000); // way past the 450 ms ease → settles
  const state = api.getEarthState();
  assert.equal(state.zoom, C.city);
  assert.equal(state.animating, false);
  // Focus surface point = groupPos + R·S·rotatedDir(focus).
  const dir = api.rotateEarthDir(api.locationToUnit(35.67, 139.65), state.yaw, state.pitch);
  const R = 0.676 * state.zoom;
  const surf = {
    x: state.liveCenter.x + dir.x * R,
    y: state.liveCenter.y + dir.y * R,
    z: state.liveCenter.z + dir.z * R,
  };
  const dist = Math.hypot(surf.x - 0, surf.y - 1.6, surf.z - 0);
  closeTo(dist, C.surfaceDist, 1e-6);
  // Outside view: the center is farther than one radius (in front of the
  // viewer), and the outward normal at the surface points at the head.
  const headDist = Math.hypot(state.liveCenter.x - 0, state.liveCenter.y - 1.6, state.liveCenter.z - 0);
  assert.ok(headDist > R, `center outside the globe (dist ${headDist} > R ${R})`);
  const toHead = { x: 0 - surf.x, y: 1.6 - surf.y, z: 0 - surf.z };
  const facing = dir.x * toHead.x + dir.y * toHead.y + dir.z * toHead.z;
  assert.ok(facing > 0, 'surface normal points at the head');
  renderer.stopPreview();
});

test('Z1 pins counter-scale with zoom: constant world size, surface hug', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.setReducedMotion(true); // freeze the pulse so scales are deterministic
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  api.setLocationActivity([{ slug: 'tokyo-japan', name: 'Tokyo, Japan', lat: 35.67, lon: 139.65, heat: 0.9 }]);
  renderer.setSceneMode('earth');
  renderer.__runScheduledFrame(16);
  let info = api.getSceneInfo();
  assert.equal(info.earthMap.pinCount, 1);
  const baseWorld = info.earthMap.pinScale * info.earthMap.groupScale;
  closeTo(info.earthMap.pinRadius, 0.676 + 0.035, 1e-9);
  api.setEarthZoom(8, { lat: 35.67, lon: 139.65 });
  renderer.__runScheduledFrame(32);
  info = api.getSceneInfo();
  assert.equal(info.earthMap.groupScale, 8);
  closeTo(info.earthMap.pinScale * info.earthMap.groupScale, baseWorld, 1e-9);
  closeTo(info.earthMap.pinRadius, 0.676 + 0.035 / 8, 1e-9);
  renderer.stopPreview();
});

test('Z1 label and preview billboards stay world-sized while zoomed', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  renderer.setSceneMode('earth');
  renderer.__runScheduledFrame(16);
  // Globe scale: legacy label spot, verbatim (0, 1.12 + 0.676 + 0.28, −1.3).
  let info = api.getSceneInfo();
  closeTo(info.earthMap.labelWorldPos.x, 0);
  closeTo(info.earthMap.labelWorldPos.y, 2.076, 1e-9);
  closeTo(info.earthMap.labelWorldPos.z, -1.3);
  // Zoomed: label anchors at the surface point facing the head (+0.3 up),
  // NOT 8× further out (the reparent + re-station regression guard).
  api.setEarthZoom(8, { lat: 0, lon: 0 });
  renderer.__runScheduledFrame(32);
  info = api.getSceneInfo();
  const headDist = Math.hypot(
    info.earthMap.labelWorldPos.x - 0,
    info.earthMap.labelWorldPos.y - 1.6,
    info.earthMap.labelWorldPos.z - 0
  );
  assert.ok(headDist < 2.0, `label stays near the head at zoom 8 (dist ${headDist})`);
  renderer.stopPreview();
});

test('Z2 mercator row math round-trips and matches the slippy scheme', () => {
  const api = loadRenderer().__test;
  // y fraction at the equator / top edge of the Mercator square.
  closeTo(api.earthMercatorYFrac(0), 0.5);
  closeTo(api.earthMercatorYToLat(0.5), 0, 1e-9);
  closeTo(api.earthMercatorYToLat(api.earthMercatorYFrac(35.67)), 35.67, 1e-9);
  closeTo(api.earthMercatorYToLat(api.earthMercatorYFrac(-33.86)), -33.86, 1e-9);
  closeTo(api.earthMercatorYToLat(0), 85.05112878, 1e-6);
  // Equator/prime-meridian at z1 lands inside tile (1,1).
  const a = api.earthTileXY(0, 0, 1);
  assert.equal(Math.floor(a.x), 1);
  assert.equal(Math.floor(a.y), 1);
  // Known address: Da Nang (16.0544, 108.2022) at z10 → x=819, y=465.
  const dn = api.earthTileXY(16.0544, 108.2022, 10);
  assert.equal(Math.floor(dn.x), 819);
  assert.equal(Math.floor(dn.y), 465);
  assert.equal(api.earthTileKey(3, 6, 5), '3/6/5');
});

test('Z2 visible set stays bounded and center-led at every band', () => {
  const api = loadRenderer().__test;
  for (const z of [0, 1, 5, 8, 12, 17]) {
    const set = api.earthTileVisibleSet(z, 21.02, 105.85, 3);
    assert.ok(set.length > 0 && set.length <= 49, `z${z}: ${set.length} tiles`);
    // Center tile is first after the distance sort.
    const n = 1 << z;
    const c = api.earthTileXY(21.02, 105.85, z);
    const cx = Math.max(0, Math.min(n - 1, Math.floor(c.x)));
    const cy = Math.max(0, Math.min(n - 1, Math.floor(c.y)));
    assert.equal(set[0].key, api.earthTileKey(z, cx, cy));
    // All keys in range; distances sorted ascending.
    for (let i = 0; i < set.length; i++) {
      const t = set[i];
      assert.ok(t.x >= 0 && t.x < n && t.y >= 0 && t.y < n, `tile ${t.key} in range`);
      assert.ok(t.dist >= 0 && t.dist <= 6, `tile ${t.key} dist in ring`);
      if (i > 0) assert.ok(set[i - 1].dist <= t.dist, 'sorted by ring distance');
    }
  }
  // z1 globe corner: (0,0) is inside tile (1,1) — first in the set.
  const corner = api.earthTileVisibleSet(1, 0, 0, 3);
  assert.equal(corner[0].key, '1/1/1');
  // Pole edges: no out-of-range tiles leak through the clamp.
  const polar = api.earthTileVisibleSet(2, 85, 0, 3);
  assert.ok(polar.length > 0 && polar.length <= 49);
  for (const t of polar) assert.ok(t.y >= 0 && t.y < 4, `polar tile ${t.key} in range`);
});

test('Z2 crossfade weight follows the S ∈ [4, 8] smoothstep band', () => {
  const renderer = loadRenderer();
  renderer.init(null, {});
  const api = renderer.__test;
  api.setEarthZoom(1);
  assert.equal(api.earthTileFade(), 0);
  api.setEarthZoom(4);
  assert.equal(api.earthTileFade(), 0);
  api.setEarthZoom(8);
  assert.equal(api.earthTileFade(), 1);
  api.setEarthZoom(6);
  closeTo(api.earthTileFade(), 0.5);
  api.setEarthZoom(48);
  assert.equal(api.earthTileFade(), 1);
  // ?earthmap=0 kills the fade outright (offline hologram stays).
  api.setDebugFlags({ earthmap: false });
  assert.equal(api.earthTileFade(), 0);
  api.setDebugFlags({ earthmap: true });
  assert.equal(api.getEarthState().tiles.available, true);
});

test('Z2 tile geometry drapes one slippy tile on the sphere', () => {
  const api = loadRenderer().__test;
  // Tile (z=2, x=3, y=2) spans lon 90°→180°, lat 0°→−66.5133° (Mercator row
  // 1/2 → 3/4 of the square). Verify vertices sit on the sphere and both
  // grid corners coincide with locationToUnit's own mapping (lat, lon).
  const R = 0.676 + 0.005 / 8;
  const geo = api.buildEarthTileGeometry(2, 3, 2, R);
  const pos = geo.attributes.position;
  assert.equal(pos.count, 81);
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
    closeTo(r, R, 1e-6); // float32 attribute precision
  }
  // NW grid corner (i=0, j=0) = lon 90°, lat 0° → locationToUnit(0, 90).
  const nw = api.locationToUnit(0, 90);
  const dNW = Math.hypot(pos.getX(0) - nw.x * R, pos.getY(0) - nw.y * R, pos.getZ(0) - nw.z * R);
  assert.ok(dNW < 1e-3, `NW corner coincides (err ${dNW})`);
  // SE grid corner (i=8, j=8) = lon 180°, lat −66.5133 → locationToUnit(−66.5133, 180).
  const se = api.locationToUnit(-66.5133, 180);
  const last = pos.count - 1;
  const dSE = Math.hypot(pos.getX(last) - se.x * R, pos.getY(last) - se.y * R, pos.getZ(last) - se.z * R);
  assert.ok(dSE < 1e-3, `SE corner coincides (err ${dSE})`);
  assert.ok(pos.getY(0) > pos.getY(last), 'grid descends north → south');
  // Tri winding is consistent: every index triple is finite, UVs in [0, 1].
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    assert.ok(uv.getX(i) >= 0 && uv.getX(i) <= 1, 'u in range');
    assert.ok(uv.getY(i) >= 0 && uv.getY(i) <= 1, 'v in range');
  }
  assert.ok(Array.isArray(geo.index.array) || geo.index.count === 8 * 8 * 6);
});

test('Z2 zooming past the band materializes tiles through the stub loader', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  renderer.setSceneMode('earth');
  renderer.__runScheduledFrame(16);
  // Stub the image pipeline: tile bytes arrive synchronously.
  let loadedUrls = [];
  api.setEarthTileImageLoader((url, onLoad) => { loadedUrls.push(url); onLoad({ width: 256, height: 256 }); });
  // Zoom to S=8 → tileZ 6 (band 5–7 → fade 1). Run frames past the 150 ms gate.
  api.setEarthZoom(8, { lat: 21.02, lon: 105.85 });
  renderer.__runScheduledFrame(200);
  renderer.__runScheduledFrame(400);
  const stats = api.earthTileStats();
  assert.equal(stats.band, 6);
  assert.ok(stats.tracked > 0 && stats.tracked <= 49, `tracked ${stats.tracked} ≤ 49`);
  assert.equal(stats.ready, stats.tracked);
  assert.ok(loadedUrls.every((u) => u.startsWith('/api/reels/map-tiles/')), `same-origin proxy: ${loadedUrls[0]}`);
  const band6 = loadedUrls.filter((u) => u.startsWith('/api/reels/map-tiles/6/'));
  assert.equal(band6.length, stats.tracked); // every visible tile fetched exactly once
  // Z4 idle prefetch warms at most the 4 center children one band down.
  const band7 = loadedUrls.filter((u) => u.startsWith('/api/reels/map-tiles/7/'));
  assert.ok(band7.length <= 4, `prefetch warms ≤4 children (${band7.length})`);
  // Fade fully in: base gone, every tile at opacity 1.
  closeTo(api.earthTileFade(), 1);
  // Zoom out: the layer retires completely.
  api.setEarthZoom(1);
  renderer.__runScheduledFrame(600);
  assert.equal(api.earthTileStats().tracked, 0);
  assert.equal(api.earthTileStats().band, -1);
  renderer.stopPreview();
});

test('Z2 tile failures degrade to the hologram with the offline label', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  renderer.setSceneMode('earth');
  // Every fetch errors — after 4 consecutive failures the layer degrades.
  let errors = 0;
  api.setEarthTileImageLoader((url, onLoad, onError) => { errors += 1; onError(new Error('boom')); });
  api.setEarthZoom(8, { lat: 21.02, lon: 105.85 });
  for (let t = 200; t < 1200; t += 200) renderer.__runScheduledFrame(t);
  const stats = api.earthTileStats();
  assert.ok(errors >= 4, `retried through the queue (${errors} errors)`);
  assert.equal(stats.available, false);
  assert.equal(stats.tracked, 0);
  assert.equal(api.earthTileFade(), 0);
  // Z1 hologram behavior survives: zoom + focus intact, label shows offline.
  assert.equal(api.getEarthState().zoom, 8);
  assert.ok(api.getEarthLabelDetail().includes('MAP OFFLINE'), `label: ${api.getEarthLabelDetail()}`);
  // Recovery: the degraded layer re-probes on the slow cadence (5 s of frame
  // clock) and re-attaches once fetches succeed again.
  api.setEarthTileImageLoader((url, onLoad) => onLoad({ width: 256, height: 256 }));
  for (let t = 1400; t < 9400; t += 400) renderer.__runScheduledFrame(t);
  assert.equal(api.earthTileStats().ready > 0, true);
  assert.ok(api.getEarthLabelDetail().includes('OPENSTREETMAP'), `label: ${api.getEarthLabelDetail()}`);
  renderer.stopPreview();
});

// ─── Z3: Zoom-aware heat clustering (docs/earth-zoom-map-plan.md §8) ───

function z3ClusterRow(overrides = {}) {
  return {
    kind: 'cluster',
    geohash: 'xn7m',
    name: 'Tokyo',
    slug: 'tokyo--japan',
    lat: 35.6,
    lon: 139.7,
    heat: 0.9,
    score: 9,
    active_reel_count: 5,
    new_reel_count: 1,
    location_count: 3,
    sample_names: ['Tokyo', 'Yokohama', 'Chiba'],
    ...overrides,
  };
}

function z3CityRow(overrides = {}) {
  return {
    slug: 'seattle--usa',
    name: 'Seattle',
    lat: 47.6,
    lon: -122.3,
    heat: 0.4,
    score: 1,
    active_reel_count: 1,
    new_reel_count: 0,
    ...overrides,
  };
}

function z3Harness(fetchImpl) {
  const gl = makeMockGl({ deleted: 0 });
  const requests = [];
  const fetch = fetchImpl || (async (url) => {
    requests.push(String(url));
    return { ok: true, json: async () => ({ locations: [] }) };
  });
  const renderer = loadRenderer({ gl, fetch });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  return { gl, requests, renderer, api: renderer.__test };
}

test('Z3 activity request follows the zoom band: globe omits zoom, slippy band sends it', () => {
  const { requests, renderer, api } = z3Harness();
  renderer.setSceneMode('earth');
  assert.equal(requests.length, 1);
  assert.ok(!requests[0].includes('zoom='), `globe request: ${requests[0]}`);
  assert.equal(api.earthActivityRequestZoom(), null);
  assert.ok(!api.earthActivityUrl(null).includes('zoom='), api.earthActivityUrl(null));
  api.setEarthZoom(8, { lat: 21.02, lon: 105.85 });
  // S=8 → tileZ round(log2(8)+3.3) = 6 (region band).
  assert.equal(api.earthActivityRequestZoom(), 6);
  assert.equal(api.getEarthState().tileZoom, 6);
  assert.ok(api.earthActivityUrl(6).includes('&zoom=6'), api.earthActivityUrl(6));
  renderer.stopPreview();
});

test('Z3 crossing a zoom band refetches cluster heat once after the debounce', async () => {
  const { requests, renderer, api } = z3Harness();
  renderer.setSceneMode('earth');
  assert.equal(requests.length, 1);
  api.setEarthZoom(8, { lat: 21.02, lon: 105.85 });
  api.scheduleEarthActivityRefetch();
  assert.equal(api.earthActivityFetchState().pending, true);
  api.scheduleEarthActivityRefetch(); // repeat schedules are no-ops: one countdown
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(requests.length, 2);
  assert.ok(requests[1].includes('&zoom=6'), `band request: ${requests[1]}`);
  // earthActivityFetchState crosses the vm realm — compare fields, not objects.
  assert.equal(api.earthActivityFetchState().zoom, 6);
  assert.equal(api.earthActivityFetchState().pending, false);
  renderer.stopPreview();
});

test('Z3 per-frame scheduling still fires the band fetch (no re-arm starvation)', async () => {
  // updateEarthTiles calls scheduleEarthActivityRefetch() every frame: the
  // countdown must survive repeat scheduling and fire once with the live
  // band (re-arming every frame would starve the fetch while frames run).
  const { requests, renderer, api } = z3Harness();
  renderer.setSceneMode('earth');
  api.setEarthZoom(8, { lat: 21.02, lon: 105.85 });
  api.scheduleEarthActivityRefetch();
  await new Promise((resolve) => setTimeout(resolve, 200));
  api.scheduleEarthActivityRefetch();
  await new Promise((resolve) => setTimeout(resolve, 200));
  api.scheduleEarthActivityRefetch();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(requests.length, 2);
  assert.ok(requests[1].includes('&zoom=6'), `band request: ${requests[1]}`);
  renderer.stopPreview();
});

test('Z3 zooming back before the window skips the band fetch', async () => {
  const { requests, renderer, api } = z3Harness();
  renderer.setSceneMode('earth');
  api.setEarthZoom(8, { lat: 21.02, lon: 105.85 });
  api.scheduleEarthActivityRefetch();
  assert.equal(api.earthActivityFetchState().pending, true);
  api.setEarthZoom(1); // back to globe before the window elapses
  await new Promise((resolve) => setTimeout(resolve, 350));
  // Fire-time band matches the landed band: nothing to fetch.
  assert.equal(requests.length, 1);
  assert.equal(api.earthActivityFetchState().pending, false);
  renderer.stopPreview();
});

test('Z3 settling inside the same band triggers no activity refetch', async () => {
  const { requests, renderer, api } = z3Harness();
  renderer.setSceneMode('earth');
  api.setEarthZoom(8, { lat: 21.02, lon: 105.85 });
  api.scheduleEarthActivityRefetch();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(requests.length, 2);
  // S=6 → tileZ round(log2(6)+3.3) = 6: same band, no new request.
  api.setEarthZoom(6, { lat: 21.02, lon: 105.85 });
  api.scheduleEarthActivityRefetch();
  assert.equal(api.earthActivityFetchState().pending, false);
  assert.equal(api.earthActivityFetchState().zoom, 6);
  assert.equal(requests.length, 2);
  renderer.stopPreview();
});

test('Z3 stale activity responses lose to the newest generation', async () => {
  const resolvers = [];
  const signals = [];
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({
    gl,
    fetch: (_url, opts = {}) => new Promise((resolve) => {
      signals.push(opts.signal || null);
      resolvers.push(resolve);
    }),
  });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  renderer.setSceneMode('earth');
  api.loadEarthActivity();
  assert.equal(resolvers.length, 2);
  // The superseded request is aborted outright, not just ignored on arrival.
  assert.equal(signals[0] && signals[0].aborted, true);
  resolvers[1]({
    ok: true,
    json: async () => ({ locations: [{ slug: 'new', lat: 1, lon: 1, heat: 1 }] }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(api.getEarthState().locationSlugs, ['new']);
  resolvers[0]({
    ok: true,
    json: async () => ({ locations: [{ slug: 'stale', lat: 2, lon: 2, heat: 1 }] }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(api.getEarthState().locationSlugs, ['new']);
  renderer.stopPreview();
});

test('Z3 activity resolving after leaving earth mode never lands', async () => {
  const resolvers = [];
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl, fetch: () => new Promise((resolve) => resolvers.push(resolve)) });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  renderer.setSceneMode('earth');
  renderer.setSceneMode('reels');
  resolvers[0]({
    ok: true,
    json: async () => ({ locations: [{ slug: 'ghost', lat: 1, lon: 1, heat: 1 }] }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  // Length, not deepEqual: untouched module state is a vm-realm array and
  // strict deep-equal rejects cross-realm prototypes (see the Z1 note above).
  assert.equal(api.getEarthState().locationSlugs.length, 0);
  // Re-entry refetches and lands normally.
  renderer.setSceneMode('earth');
  assert.equal(resolvers.length, 2);
  resolvers[1]({
    ok: true,
    json: async () => ({ locations: [{ slug: 'back', lat: 1, lon: 1, heat: 1 }] }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(api.getEarthState().locationSlugs, ['back']);
  renderer.stopPreview();
});

test('Z3 heat sprites rebuild from cluster rows and hide below the tile band', () => {
  const { renderer, api } = z3Harness();
  renderer.setSceneMode('earth');
  api.setLocationActivity([
    z3ClusterRow(),
    z3ClusterRow({ geohash: 'ww8p', name: 'Shanghai', slug: 'shanghai--china', lat: 31.2, lon: 121.5, heat: 0.5, location_count: 2 }),
    z3CityRow(),
  ]);
  assert.equal(api.earthHeatStats().count, 3);
  assert.equal(api.earthHeatStats().visible, false);
  api.updateEarthHeatSprites(0);
  assert.equal(api.earthHeatStats().visible, false);
  api.updateEarthHeatSprites(1);
  assert.equal(api.earthHeatStats().visible, true);
  // Unhovered base opacity is the tile fade times the sprite alpha.
  closeTo(api.earthHeatStats().opacity, 0.85);
  renderer.stopPreview();
});

test('Z3 hovered clusters brighten and grow their heat sprite', () => {
  const { renderer, api } = z3Harness();
  renderer.setSceneMode('earth');
  api.setLocationActivity([z3ClusterRow(), z3CityRow()]);
  api.updateEarthHeatSprites(1);
  const baseScale = api.earthHeatStats().scale;
  api.setEarthHoveredIndex(0);
  api.updateEarthHeatSprites(1);
  // Sprite[0] is the hottest row; the hover boost is 1.18x size, 1.15x alpha.
  closeTo(api.earthHeatStats().scale, baseScale * 1.18);
  closeTo(api.earthHeatStats().opacity, 0.85 * 1.15);
  api.setEarthHoveredIndex(-1);
  api.updateEarthHeatSprites(1);
  closeTo(api.earthHeatStats().scale, baseScale);
  closeTo(api.earthHeatStats().opacity, 0.85);
  renderer.stopPreview();
});

test('Z3 cluster taps always drill deeper; city taps keep the select flow', () => {
  const selected = [];
  const renderer = loadRenderer();
  renderer.init(null, { onSelectLocation: (location) => { selected.push(location.slug); return true; } });
  const api = renderer.__test;
  const C = api.earthZoomConstants();
  api.setLocationActivity([
    z3ClusterRow(),
    z3CityRow(),
    z3ClusterRow({ geohash: 'u4pr', name: 'Solo City', slug: 'solo--usa', lat: 40, lon: -100, location_count: 1 }),
  ]);
  const hit = { hit: true, local: { x: 0, y: 0, z: 1 } };
  // Below the city band a cluster tap zooms to the city band, centered on the cell.
  assert.equal(api.handleEarthTap(0, hit), 'zoom-cluster');
  assert.equal(api.getEarthState().zoomTarget, C.city);
  const focus = api.getEarthState().focus;
  assert.equal(focus.lat, 35.6);
  assert.equal(focus.lon, 139.7);
  assert.deepEqual(selected, []);
  // At/above the band clusters keep drilling instead of selecting.
  api.setEarthZoom(C.city, { lat: 0, lon: 0 });
  assert.equal(api.handleEarthTap(0, hit), 'zoom-cluster');
  assert.equal(api.getEarthState().zoomTarget, Math.min(C.max, C.city * C.step));
  assert.deepEqual(selected, []);
  // A lone city row below the band zooms; at the band it selects.
  api.setEarthZoom(1);
  assert.equal(api.handleEarthTap(1, hit), 'zoom-zone');
  assert.deepEqual(selected, []);
  api.setEarthZoom(C.city, { lat: 47.6, lon: -122.3 });
  assert.equal(api.handleEarthTap(1, hit), 'select');
  assert.deepEqual(selected, ['seattle--usa']);
  // A single-city "cluster" behaves like a city row: selectable at the band.
  assert.equal(api.handleEarthTap(2, hit), 'select');
  assert.deepEqual(selected, ['seattle--usa', 'solo--usa']);
});

test('Z3 OPEN FEED drills into clusters and opens city feeds', async () => {
  const selected = [];
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  // Reject the feed swap so the globe stays up for the rest of the test.
  renderer.init(null, { onSelectLocation: (location) => { selected.push(location.slug); return false; } });
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  renderer.setSceneMode('earth');
  api.setLocationActivity([z3ClusterRow(), z3CityRow()]);
  const C = api.earthZoomConstants();
  api.setEarthHoveredIndex(0);
  api.executeControl('earth_open_feed');
  // Clusters have no feed of their own — the dock drills into the cell.
  assert.deepEqual(selected, []);
  assert.equal(api.getEarthState().zoomTarget, C.city);
  api.setEarthHoveredIndex(1);
  api.executeControl('earth_open_feed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(selected, ['seattle--usa']);
  // Nothing under the cursor → the dock asks the user to point at a zone.
  api.setEarthHoveredIndex(-1);
  api.executeControl('earth_open_feed');
  assert.equal(api.getEarthState().notificationText, 'POINT AT A ZONE FIRST');
  renderer.stopPreview();
});

test('Z3 label reads clusters as city counts with heat', () => {
  const { renderer, api } = z3Harness();
  renderer.setSceneMode('earth');
  api.setLocationActivity([
    z3ClusterRow({ heat: 0.8 }),
    z3ClusterRow({ geohash: 'ww8p', name: 'Shanghai', slug: 'shanghai--china', lat: 31.2, lon: 121.5, heat: 0.4, location_count: 2 }),
  ]);
  renderer.__runScheduledFrame(32);
  assert.ok(api.getEarthLabelDetail().includes('2 CLUSTERS'), `label: ${api.getEarthLabelDetail()}`);
  api.setEarthHoveredIndex(0);
  renderer.__runScheduledFrame(64);
  assert.ok(api.getEarthLabelDetail().includes('3 CITIES'), `label: ${api.getEarthLabelDetail()}`);
  assert.ok(api.getEarthLabelDetail().includes('80% HEAT'), `label: ${api.getEarthLabelDetail()}`);
  renderer.stopPreview();
});

test('Z3 hovering a cluster loads previews for its slug', async () => {  // Regression: server cluster rows must carry a usable slug end to end —
  // the host resolves previews (and feeds) by slug, so a slug-less row
  // silently shows no preview on hover.
  const gl = makeMockGl({ deleted: 0 });
  let requestedLocation = null;
  const renderer = loadRenderer({ gl });
  renderer.init(null, {
    onPreviewLocation: async (location) => {
      requestedLocation = location.slug;
      return [{ url: '/media/one.mp4', title: 'One' }];
    },
  });
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.setSceneMode('earth');
  await new Promise((resolve) => setImmediate(resolve));
  renderer.__test.setLocationActivity([
    z3ClusterRow({ slug: 'tokyo--japan', primary_slug: 'tokyo--japan' }),
  ]);
  await renderer.__test.loadEarthPreviewNow(0);
  assert.equal(requestedLocation, 'tokyo--japan');
  assert.equal(renderer.__test.getEarthState().previewItemCount, 1);
  renderer.stopPreview();
});

test('Z3 cleanup resets the zoom-tracked fetch and heat overlay', async () => {
  const { requests, renderer, api } = z3Harness();
  renderer.setSceneMode('earth');
  api.setLocationActivity([z3ClusterRow()]);
  api.setEarthZoom(8, { lat: 21.02, lon: 105.85 });
  api.scheduleEarthActivityRefetch();
  assert.equal(api.earthActivityFetchState().pending, true);
  assert.equal(api.earthHeatStats().count, 1);
  api.cleanup();
  assert.equal(api.getEarthState().zoom, 1);
  assert.equal(api.earthActivityFetchState().zoom, null);
  assert.equal(api.earthActivityFetchState().pending, false);
  assert.equal(api.earthHeatStats().count, 0);
  // The cleared debounce timer never fires its band fetch.
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(requests.length, 1);
  renderer.stopPreview();
});

test('Z3 geohash cells decode to bounds containing the encoded point', () => {
  const api = loadRenderer().__test;
  // Reference vector shared with the server suite: (42.6, -5.6) → 'ezs42'.
  const cell = api.earthGeohashCellBounds('ezs42');
  assert.ok(cell, 'decodable');
  assert.ok(cell.latLo < 42.6 && 42.6 < cell.latHi, JSON.stringify(cell));
  assert.ok(cell.lonLo < -5.6 && -5.6 < cell.lonHi, JSON.stringify(cell));
  // Finer prefixes nest: the angular half-extent strictly shrinks.
  const r2 = api.earthGeohashCellAngularRadius('ez');
  const r3 = api.earthGeohashCellAngularRadius('ezs');
  const r4 = api.earthGeohashCellAngularRadius('ezs4');
  const r5 = api.earthGeohashCellAngularRadius('ezs42');
  assert.ok(r2 > r3 && r3 > r4 && r4 > r5 && r5 > 0, `${r2} > ${r3} > ${r4} > ${r5}`);
  // A precision-5 cell is sub-kilometer-scale: well under a hundredth of a radian.
  assert.ok(r5 < 0.01, `p5 extent ${r5}`);
  // Undecodable input degrades to null / zero, never throws.
  assert.equal(api.earthGeohashCellBounds(''), null);
  assert.equal(api.earthGeohashCellBounds('ezs42!'), null);
  assert.equal(api.earthGeohashCellBounds('ezs42ezs42ezs'), null);
  assert.equal(api.earthGeohashCellBounds(null), null);
  assert.equal(api.earthGeohashCellAngularRadius('!'), 0);
});

test('Z3 cluster radius covers the cell but never drops below the heat floor', () => {
  const api = loadRenderer().__test;
  // Continent cell (p2 ≈ 0.11 rad) at zero heat: the floor holds exactly.
  assert.equal(api.earthZoneAngularRadius({ kind: 'cluster', geohash: 'ez', heat: 0 }), 0.11);
  // City cell (p5, sub-milliradian): the heat base dominates, unchanged.
  closeTo(api.earthZoneAngularRadius({ kind: 'cluster', geohash: 'ezs42', heat: 0.9 }), 0.11 + 0.9 * 0.12);
  // City rows and geohash-less clusters keep the legacy heat ramp verbatim.
  closeTo(api.earthZoneAngularRadius({ heat: 0.5 }), 0.11 + 0.5 * 0.12);
  closeTo(api.earthZoneAngularRadius({ kind: 'cluster', heat: 0.5 }), 0.11 + 0.5 * 0.12);
  closeTo(api.earthZoneAngularRadius({ kind: 'cluster', geohash: 123, heat: 0.5 }), 0.11 + 0.5 * 0.12);
});

test('Z3 visible bbox tracks the zoomed patch and feeds the activity URL', () => {
  const { renderer, api } = z3Harness();
  renderer.setSceneMode('earth');
  assert.equal(api.earthVisibleBbox(), null);
  assert.ok(!api.earthActivityUrl(null).includes('bbox='));
  api.setEarthZoom(8, { lat: 21.02, lon: 105.85 });
  const bbox = api.earthVisibleBbox();
  assert.ok(bbox, 'bbox inside the tile band');
  assert.ok(bbox.west < 105.85 && 105.85 < bbox.east, JSON.stringify(bbox));
  assert.ok(bbox.south < 21.02 && 21.02 < bbox.north, JSON.stringify(bbox));
  assert.ok(bbox.west >= -180 && bbox.east <= 180 && bbox.south >= -90 && bbox.north <= 90);
  assert.ok(bbox.east - bbox.west < 100, `tile-ring span: ${bbox.east - bbox.west}`);
  const url = api.earthActivityUrl(6);
  const match = url.match(/&bbox=([^&]+)/);
  assert.ok(match, url);
  const parts = match[1].split(',').map(Number);
  assert.equal(parts.length, 4);
  assert.ok(parts.every(Number.isFinite), match[1]);
  assert.equal(parts[0], bbox.west);
  assert.equal(parts[3], bbox.north);
  // Dateline clip: the tile set stops at x=n-1, so the box stays a small
  // valid sliver instead of wrapping.
  api.setEarthZoom(16384, { lat: 0, lon: 179.999 });
  const edge = api.earthVisibleBbox();
  assert.ok(edge && edge.west > 179.9 && edge.east <= 180, JSON.stringify(edge));
  renderer.stopPreview();
});

// ─── Z4: Polish — breadcrumb + idle prefetch (docs/earth-zoom-map-plan.md §9) ──

test('Z4 zoom percent maps the exponential range onto 0–100', () => {
  const api = loadRenderer().__test;
  api.setEarthZoom(1);
  assert.equal(api.earthZoomPercent(), 0);
  api.setEarthZoom(8);
  assert.equal(api.earthZoomPercent(), 21); // round(100·3/14)
  api.setEarthZoom(16384);
  assert.equal(api.earthZoomPercent(), 100);
});

test('Z4 breadcrumb titles the zoomed globe; globe scale keeps the legacy title', () => {
  const { renderer, api } = z3Harness();
  renderer.setSceneMode('earth');
  api.setLocationActivity([z3CityRow()]);
  api.setEarthHoveredIndex(0);
  renderer.__runScheduledFrame(32);
  assert.equal(api.getEarthLabelTitle(), 'Seattle');
  // The detail line is untouched by the breadcrumb (license suffix safe).
  assert.ok(!api.getEarthLabelDetail().includes('WORLD'));
  api.setEarthZoom(8, { lat: 47.6, lon: -122.3 });
  renderer.__runScheduledFrame(64);
  assert.equal(api.getEarthLabelTitle(), 'WORLD › Seattle · 21%');
  api.setEarthHoveredIndex(-1);
  renderer.__runScheduledFrame(96);
  assert.equal(api.getEarthLabelTitle(), 'WORLD · 21%');
  renderer.stopPreview();
});

test('Z4 idle prefetch warms the next band so zoom-in starts textured', () => {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  const api = renderer.__test;
  const loadedUrls = [];
  api.setEarthTileImageLoader((url, onLoad) => { loadedUrls.push(url); onLoad({ width: 256, height: 256 }); });
  renderer.setSceneMode('earth');
  api.setEarthZoom(8, { lat: 21.02, lon: 105.85 });
  for (let t = 200; t <= 1200; t += 200) renderer.__runScheduledFrame(t);
  assert.equal(api.earthTileStats().band, 6);
  // The side cache never counts toward the visible-set bound.
  assert.ok(api.earthTileStats().tracked <= 49);
  const pre = api.earthTilePrefetchStats();
  assert.equal(pre.size, 4);
  assert.equal(pre.ready, 4);
  // The 4 warmed children of the z6 center tile…
  const c = api.earthTileXY(21.02, 105.85, 6);
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  const warmed = [];
  for (let oy = 0; oy <= 1; oy++) {
    for (let ox = 0; ox <= 1; ox++) {
      warmed.push(`/api/reels/map-tiles/7/${2 * cx + ox}/${2 * cy + oy}.png`);
    }
  }
  const countOf = (u) => loadedUrls.filter((v) => v === u).length;
  assert.ok(warmed.every((u) => countOf(u) === 1), 'each warmed child fetched exactly once');
  // …materialize with zero new fetches on zoom-in.
  api.setEarthZoom(16, { lat: 21.02, lon: 105.85 });
  for (let t = 1400; t <= 2400; t += 200) renderer.__runScheduledFrame(t);
  assert.equal(api.earthTileStats().band, 7);
  assert.ok(warmed.every((u) => countOf(u) === 1), 'no refetch of warmed children');
  assert.ok(api.earthTileStats().ready >= 4, `warmed children ready (${api.earthTileStats().ready})`);
  api.cleanup(); // clear the band-change refetch timer before teardown
  renderer.stopPreview();
});

// ─── Holo tile restyle: OSM raster graded into the globe palette ───

test('holo tile class separates water, land, ink, and paper', () => {
  const api = loadRenderer().__test;
  assert.equal(api.earthHoloTileClass(170, 211, 223), 0); // OSM water #aad3df
  assert.equal(api.earthHoloTileClass(242, 239, 233), 1); // OSM land beige
  assert.equal(api.earthHoloTileClass(200, 250, 204), 1); // park green
  assert.equal(api.earthHoloTileClass(0, 0, 0), 2); // label black
  assert.equal(api.earthHoloTileClass(0, 120, 168), 2); // water-label blue
  assert.equal(api.earthHoloTileClass(255, 255, 255), 3); // road white
  assert.equal(api.earthHoloTileClass(232, 232, 232), 3); // urban gray glows (city blocks lit)
  assert.equal(api.earthHoloTileClass(78, 155, 71), 2); // trunk green reads as feature-dark
  assert.equal(api.earthHoloTileClass(118, 120, 188), 0); // motorway blue reads as water-dark
  assert.equal(api.earthHoloTileClass(119, 119, 119), 2); // rail gray joins ink (fringe-swallow)
  assert.equal(api.earthHoloTileClass(140, 140, 140), 1); // light gray stays land
});

test('holo tile pixel matches the globe ramp per class', () => {
  const api = loadRenderer().__test;
  // Pixel fn returns vm-realm arrays: spread into host arrays first (see Z1 note).
  assert.deepEqual([...api.earthHoloTilePixel(170, 211, 223)], [4, 18, 43]); // ocean formula
  assert.deepEqual([...api.earthHoloTilePixel(242, 239, 233)], [20, 117, 180]); // land formula
  assert.deepEqual([...api.earthHoloTilePixel(0, 0, 0)], [200, 240, 255]); // full glow
  assert.deepEqual([...api.earthHoloTilePixel(255, 255, 255)], [245, 252, 255]); // ice road
  // Ink is uniformly bright by design (legibility over gradient continuity):
  // fringe grays render as bold glyph, not hollow ringing.
  assert.deepEqual([...api.earthHoloTilePixel(114, 114, 114)], [200, 240, 255]);
  assert.deepEqual([...api.earthHoloTilePixel(51, 51, 51)], [200, 240, 255]);
});

test('holo tile composer paints interiors, edges, glow, and paper', () => {
  const api = loadRenderer().__test;
  const W = 6, H = 2;
  const buf = new Uint8Array(W * H * 4);
  const paint = (x, y, r, g, b, a = 255) => {
    const o = (y * W + x) * 4;
    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a;
  };
  for (let y = 0; y < H; y++) {
    paint(0, y, 170, 211, 223); // water interior
    paint(1, y, 170, 211, 223); // water at the coast
    paint(2, y, 242, 239, 233); // land at the coast
    paint(3, y, 242, 239, 233); // land interior
    paint(4, y, 51, 51, 51, 128); // dark label, half alpha
    paint(5, y, 255, 255, 255); // paper road
  }
  const out = api.styleEarthTilePixels(buf, W, H);
  assert.equal(out.length, buf.length);
  const px = (x, y) => [out[(y * W + x) * 4], out[(y * W + x) * 4 + 1], out[(y * W + x) * 4 + 2], out[(y * W + x) * 4 + 3]];
  assert.deepEqual(px(0, 0).slice(0, 3), [4, 18, 43]); // water interior: ocean ramp
  assert.deepEqual(px(1, 0).slice(0, 3), [42, 222, 255]); // coastline glows cyan
  assert.deepEqual(px(2, 1).slice(0, 3), [42, 222, 255]); // both sides of the coast
  assert.deepEqual(px(3, 0).slice(0, 3), [20, 117, 180]); // land interior: land ramp
  const ink = px(4, 0);
  assert.deepEqual(ink.slice(0, 3), [200, 240, 255]); // label glows bright, no cyan box
  assert.equal(ink[3], 128); // alpha preserved
  assert.deepEqual(px(5, 1).slice(0, 3), [245, 252, 255]); // road glows ice
});

test('holo tile style falls back to raw without pixel access, mode switchable', () => {
  const api = loadRenderer().__test;
  assert.equal(api.earthTileStyleMode(), 'holo');
  // Stub images (no canvas pixels, like the tile-loader stubs) degrade to raw.
  assert.equal(api.styleEarthTileImage({ width: 256, height: 256 }), null);
  assert.equal(api.styleEarthTileImage(null), null);
  api.setDebugFlags({ earthstyle: 'raw' });
  assert.equal(api.earthTileStyleMode(), 'raw');
  api.setDebugFlags({ earthstyle: 'holo' });
  assert.equal(api.earthTileStyleMode(), 'holo');
});

// ─── Top-down street experiment (?topdown=1) ───

function topdownHarness() {
  const gl = makeMockGl({ deleted: 0 });
  const renderer = loadRenderer({ gl });
  renderer.init(null, {});
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.setSceneMode('earth');
  return { renderer, api: renderer.__test };
}

test('topdown engages only with the flag at city zoom and deeper', () => {
  const { renderer, api } = topdownHarness();
  api.setEarthZoom(64, { lat: 35.67, lon: 139.65 });
  assert.equal(api.earthTopdownActive(), false); // flag off: legacy rotate everywhere
  api.setDebugFlags({ topdown: true });
  assert.equal(api.earthTopdownActive(), true);
  api.setEarthZoom(4, { lat: 0, lon: 0 });
  assert.equal(api.earthTopdownActive(), false); // below the city band: tilted globe intact
  api.setEarthZoom(8, { lat: 0, lon: 0 });
  assert.equal(api.earthTopdownActive(), true); // city band is the threshold
  api.cleanup();
  renderer.stopPreview();
});

test('topdown relaxed clamp faces high-latitude foci exactly', () => {
  const api = loadRenderer().__test;
  const norm = (v) => {
    const l = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / l, y: v.y / l, z: v.z / l };
  };
  // Negated view axis (surface->head): the outside-view solve target.
  const t = norm({ x: 0, y: 0.281, z: 0.960 });
  for (const [lat, lon] of [[70, 0], [80, 10], [-75, -60]]) {
    const v = api.locationToUnit(lat, lon);
    const legacy = api.solveEarthFocusRotation(lat, lon, t); // ±1.2 clamp
    const dl = api.rotateEarthDir(v, legacy.yaw, legacy.pitch);
    const legacyRes = 1 - (dl.x * t.x + dl.y * t.y + dl.z * t.z);
    const wide = api.solveEarthFocusRotation(lat, lon, t, 2.9);
    const dw = api.rotateEarthDir(v, wide.yaw, wide.pitch);
    const wideRes = 1 - (dw.x * t.x + dw.y * t.y + dw.z * t.z);
    assert.ok(Math.abs(wide.pitch) <= 2.9 + 1e-9, `relaxed clamp holds at (${lat},${lon})`);
    closeTo(wideRes, 0, 1e-6); // exact facing with the relaxed clamp
    assert.ok(legacyRes >= wideRes, `legacy never beats relaxed at (${lat},${lon})`);
  }
  // The legacy clamp binds near the pole (documents why the param exists).
  const polar = api.solveEarthFocusRotation(87, 0, t);
  assert.equal(Math.abs(polar.pitch), 1.2);
});

test('topdown zoom lands perpendicular even near the pole', () => {
  const { renderer, api } = topdownHarness();
  api.setDebugFlags({ topdown: true });
  api.zoomEarthTo(80, 10, 512);
  api.advanceEarthZoom(100000); // settle the animation
  const st = api.getEarthState();
  assert.equal(st.zoom, 512);
  // View dir from the live anchor (head defaults to (0,1.6,0) headless).
  const A = st.anchor;
  const l = Math.hypot(A.x - 0, A.y - 1.6, A.z - 0) || 1;
  const vd = { x: (0 - A.x) / l, y: (1.6 - A.y) / l, z: (0 - A.z) / l };
  const dir = api.rotateEarthDir(api.locationToUnit(80, 10), st.yaw, st.pitch);
  closeTo(dir.x * vd.x + dir.y * vd.y + dir.z * vd.z, 1, 1e-3);
  renderer.stopPreview();
});

test('topdown drag pans the focus and stays perpendicular', () => {
  const { renderer, api } = topdownHarness();
  api.setDebugFlags({ topdown: true });
  api.setEarthZoom(64, { lat: 35.67, lon: 139.65 });
  const press = { hit: true, zoneIndex: -1, local: { x: 0, y: 0, z: 1 } };
  api.beginEarthDrag('mouse', press);
  // First engaged update only establishes the grab point (no motion).
  api.updateEarthDrag({ x: 0.2, y: 0.1, z: 0.97 });
  assert.equal(api.getEarthState().focus.lon, 139.65);
  // Second update pans: cursor moved east, so the focus moves west (grab).
  api.updateEarthDrag({ x: 0.3, y: 0.15, z: 0.94 });
  const focus = api.getEarthState().focus;
  assert.ok(focus.lon < 139.65, `focus panned west: ${focus.lon}`);
  closeTo(focus.lon, 133.6, 0.15);
  assert.equal(focus.lat, 35.67); // yaw axis lock: longitude only
  // Perpendicular through the pan: solved normal matches the live view dir.
  const A = api.getEarthState().anchor;
  const l = Math.hypot(A.x - 0, A.y - 1.6, A.z - 0) || 1;
  const vd = { x: (0 - A.x) / l, y: (1.6 - A.y) / l, z: (0 - A.z) / l };
  const dir = api.rotateEarthDir(api.locationToUnit(focus.lat, focus.lon), api.getEarthState().yaw, api.getEarthState().pitch);
  closeTo(dir.x * vd.x + dir.y * vd.y + dir.z * vd.z, 1, 1e-6);
  // Release after a real move: drag release, never a tap.
  assert.equal(api.endEarthDrag('mouse', { hit: true, zoneIndex: -1, local: { x: 0.3, y: 0.15, z: 0.94 } }), false);
  renderer.stopPreview();
});

test('topdown tap still zooms on open globe', () => {
  const { renderer, api } = topdownHarness();
  api.setDebugFlags({ topdown: true });
  api.setEarthZoom(64, { lat: 0, lon: 0 });
  const press = { hit: true, zoneIndex: -1, local: { x: 0, y: 0, z: 1 } };
  api.beginEarthDrag('mouse', press);
  assert.equal(api.endEarthDrag('mouse', press), true); // zoom-point dispatched
  assert.ok(api.getEarthState().zoomTarget > 64);
  renderer.stopPreview();
});

// ─── Hover at every zoom: laser/mouse choke point + street precision ───

test('hover choke point resolves zones and fires previews on any ray', async () => {
  // The XR laser path previously collapsed every hit to "globe" without a
  // zone, so hover highlight + previews never fired on Quest. Both input
  // paths now share updateEarthHoverFromRay.
  const gl = makeMockGl({ deleted: 0 });
  let requestedLocation = null;
  const renderer = loadRenderer({ gl });
  renderer.init(null, {
    onPreviewLocation: async (location) => {
      requestedLocation = location.slug;
      return [{ url: '/media/one.mp4', title: 'One' }];
    },
  });
  renderer.startPreview(makePreviewCanvas(gl));
  renderer.setSceneMode('earth');
  await new Promise((resolve) => setImmediate(resolve));
  const api = renderer.__test;
  api.setLocationActivity([
    { slug: 'zone-a', name: 'Zone A', lat: 20, lon: 10, heat: 1 },
  ]);
  // Enter through the production zoom flow so facing/anchor/center are
  // consistent, then read every vector back from live state (no defaults
  // assumed). Ray starts outside the globe along the zone normal.
  api.zoomEarthTo(20, 10, 1);
  api.advanceEarthZoom(100000);
  const st = api.getEarthState();
  const R = 0.676 * st.zoom;
  const u = api.locationToUnit(20, 10);
  const n = api.rotateEarthDir(u, st.yaw, st.pitch);
  const surf = { x: st.liveCenter.x + n.x * R, y: st.liveCenter.y + n.y * R, z: st.liveCenter.z + n.z * R };
  const origin = { x: surf.x + n.x * 2, y: surf.y + n.y * 2, z: surf.z + n.z * 2 };
  const ray = { x: -n.x, y: -n.y, z: -n.z };
  assert.equal(api.updateEarthHoverFromRay(origin, ray), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestedLocation, 'zone-a');
  renderer.__runScheduledFrame(48); // label repaints in the frame loop
  assert.ok(api.getEarthLabelDetail().length > 0);
  // Sky ray (radially outward from outside the globe): guaranteed miss.
  requestedLocation = null;
  assert.equal(api.updateEarthHoverFromRay(origin, { x: n.x, y: n.y, z: n.z }), -1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestedLocation, null);
  assert.equal(api.getEarthState().previewLocationIndex, -1);
  renderer.stopPreview();
});

test('street zoom attenuates zone radii so hover stays precise', () => {
  const { renderer, api } = topdownHarness();
  const city = { heat: 0.9 };
  api.setEarthZoom(1);
  const globe = api.earthZoneAngularRadius(city);
  closeTo(globe, 0.11 + 0.9 * 0.12);
  api.setEarthZoom(256);
  closeTo(api.earthZoneAngularRadius(city), globe); // factor kicks in above 256
  api.setEarthZoom(16384);
  closeTo(api.earthZoneAngularRadius(city), globe / 64); // 16384/256
  // At street scale a between-cities hover misses (empty globe stays
  // tappable) while a direct hover still hits.
  api.setLocationActivity([
    { slug: 'tokyo--japan', name: 'Tokyo', lat: 35.67, lon: 139.65, heat: 0.9 },
    { slug: 'osaka--japan', name: 'Osaka', lat: 34.69, lon: 135.5, heat: 0.7 },
  ]);
  // Enter through the production zoom flow so facing/anchor/center are
  // consistent, then read every vector back from live state.
  api.zoomEarthTo(35.67, 139.65, 16384);
  api.advanceEarthZoom(100000);
  const center = api.getEarthState().liveCenter;
  const R = 0.676 * 16384;
  const st = api.getEarthState();
  const aim = (lat, lon) => {
    // Outward normal at the target, then a ray from 2 m outside straight in.
    const u = api.locationToUnit(lat, lon);
    const n = api.rotateEarthDir(u, st.yaw, st.pitch);
    const s = { x: center.x + n.x * R, y: center.y + n.y * R, z: center.z + n.z * R };
    return { origin: { x: s.x + n.x * 2, y: s.y + n.y * 2, z: s.z + n.z * 2 }, dir: { x: -n.x, y: -n.y, z: -n.z } };
  };
  const direct = aim(35.67, 139.65);
  assert.equal(api.hitTestEarth(direct.origin, direct.dir).zoneIndex, 0);
  const gap = aim(35.67, 137.5);
  const gapHit = api.hitTestEarth(gap.origin, gap.dir);
  assert.equal(gapHit.hit, true);
  assert.equal(gapHit.zoneIndex, -1); // ~0.03 rad from both cities, radius ~0.003
  renderer.stopPreview();
});

