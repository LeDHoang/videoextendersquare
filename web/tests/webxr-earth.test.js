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
  closeTo(hit.dist, 1.3 - (0.676 * 1.08));
});

test('drag rotates the globe while a click selects the heat zone', () => {
  const renderer = loadRenderer();
  let selected = null;
  renderer.init(null, { onSelectLocation: (location) => { selected = location.slug; return true; } });
  const api = renderer.__test;
  api.setEarthPose(0, 0, { x: 0, y: 1.12, z: -1.3 });
  api.setLocationActivity([{ slug: 'greenwich-gb', name: 'Greenwich, GB', lat: 0, lon: 0, heat: 1 }]);
  const press = { hit: true, zoneIndex: 0, local: { x: 0, y: 0, z: 1 } };
  api.beginEarthDrag('mouse', press);
  api.endEarthDrag('mouse', press);
  assert.equal(selected, 'greenwich-gb');

  api.setEarthPose(0, 0, { x: 0, y: 1.12, z: -1.3 });
  api.beginEarthDrag('mouse', press);
  api.updateEarthDrag({ x: 0.2, y: 0.1, z: 0.97 });
  api.endEarthDrag('mouse', { ...press, local: { x: 0.2, y: 0.1, z: 0.97 } });
  assert.notEqual(api.getEarthState().yaw, 0);
  assert.equal(api.getEarthState().pitch, 0);
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
    readyState: 2,
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

test('a pending image source clears the prior reel texture before it becomes ready', () => {
  const counters = { deleted: 0, textureSources: [] };
  const gl = makeMockGl(counters);
  const videoElement = {
    readyState: 2,
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
  assert.equal(renderer.__test.getLastUploadedSource(), '__cleared__');

  source = { ...source, ready: true };
  renderer.__runScheduledFrame(48);
  assert.equal(renderer.__test.getLastUploadedSource(), imageElement);
  renderer.stopPreview();
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
    readyState: 2,
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
  // Dock center sits below the 2.4 m screen bottom edge (y = 0.4).
  closeTo(pose.pos.y, 0.02);
  assert.equal(pose.pos.z, -1.9);
  // Dock top edge (0.6 m tall) stays below the screen bottom edge.
  assert.ok(pose.pos.y + 0.3 < 0.4);
  // Faces a centered viewer: zero yaw, upward pitch, no roll component.
  closeTo(pose.yaw, 0);
  assert.ok(pose.pitch < -0.5 && pose.pitch > -1.0);
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
