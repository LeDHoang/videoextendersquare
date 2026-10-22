import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', '..', 'ui', 'assets', 'reels.html'), 'utf-8');

function block(name) {
  const match = html.match(new RegExp(`// <${name}>\\n([\\s\\S]*?)// </${name}>`));
  assert.ok(match, `${name} markers present`);
  return match[1];
}

function classList() {
  const values = new Set();
  return {
    values,
    add(name) { values.add(name); },
    remove(name) { values.delete(name); },
    toggle(name, on) { if (on) values.add(name); else values.delete(name); },
    contains(name) { return values.has(name); },
  };
}

function fakeVideo() {
  const listeners = {};
  const video = {
    attributes: {},
    currentTime: 0,
    duration: 30,
    paused: true,
    muted: false,
    plays: 0,
    pauses: 0,
    get src() { return this.attributes.src || ''; },
    set src(value) { this.attributes.src = String(value); },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type) { (listeners[type] || []).splice(0).forEach((fn) => fn()); },
    play() { this.paused = false; this.plays += 1; return Promise.resolve(); },
    pause() { this.paused = true; this.pauses += 1; },
  };
  return video;
}

// Runs the real stereo helpers + VR swap from reels.html.
function loadStereo(items, { presenting = false } = {}) {
  const engine = {
    presenting,
    previewSplit: false,
    layouts: [],
    isPresenting() { return this.presenting; },
    getPreviewState() { return { running: this.previewSplit, stereo: this.previewSplit }; },
    setSourceStereo(layout) { this.layouts.push(layout); },
  };
  const calls = { preload: 0, notify: 0, slides: [], viewTracking: 0, flashes: [], timers: [] };
  const context = {
    console,
    WebXRVR: engine,
    videoWrap: { classList: classList() },
    video: fakeVideo(),
    videoData: items,
    idx: 0,
    isMuted: false,
    blobUrlMap: {},
    blobSourceMap: {},
    imagePostSlides: [],
    imageSlideIndex: 0,
    isImageItem: (item) => !!item && item.media_type === 'image',
    resolveItemUrl: (item) => (item.tunnel_url ? item.tunnel_url + item.url : item.url),
    showImageSlide: (index) => calls.slides.push(index),
    preloadNext: () => { calls.preload += 1; },
    notifyVisualSourceChange: () => { calls.notify += 1; },
    updateSoundBtnUI: () => {},
    updatePlayBtnUI: () => {},
    startViewTracking: () => { calls.viewTracking += 1; },
    showFlash: (text) => calls.flashes.push(text),
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
  };
  vm.createContext(context);
  vm.runInContext(`${block('reels-stereo')}\n${block('reels-stereo-sync')}
    this.api = {
      playbackFor, playbackUrlFor, blobFor, applyEntryStereo, syncStereoSource,
      handleStereoFailure, clearStereoFailure,
      layout: () => activeVisualLayout,
      crop: () => activeCropLayout,
    };`, context);
  return { ...context.api, context, engine, calls };
}

const sbsPost = {
  media_type: 'video',
  url: '/media/uploads/clip-mono.mp4',
  stereo_url: '/media/uploads/clip.mp4',
  stereo_layout: 'sbs',
  stereo_crop: false,
};

test('mono posts always load their url', () => {
  const { playbackFor, engine } = loadStereo([], { presenting: true });
  const mono = { url: '/media/a.mp4', stereo_layout: 'mono', stereo_url: null };
  assert.deepEqual({ ...playbackFor(mono, mono) }, { url: '/media/a.mp4', layout: 'mono', crop: '' });
  // Older payloads without the field are mono too.
  assert.equal(playbackFor({ url: '/media/b.mp4' }, {}).layout, 'mono');
  engine.presenting = false;
});

test('3D posts load the 2D rendition in 2D and the stereo file only in VR', () => {
  const { playbackFor, engine } = loadStereo([]);
  assert.deepEqual({ ...playbackFor(sbsPost, sbsPost) }, { url: sbsPost.url, layout: 'mono', crop: '' });
  engine.presenting = true;
  assert.deepEqual({ ...playbackFor(sbsPost, sbsPost) }, { url: sbsPost.stereo_url, layout: 'sbs', crop: '' });
  const tb = { ...sbsPost, stereo_layout: 'tb' };
  assert.equal(playbackFor(tb, tb).layout, 'tb');
  // A stereo file that failed once falls back to the 2D view (mono-flat).
  assert.equal(playbackFor(sbsPost, { stereoFailed: true }).url, sbsPost.url);
});

test('the desktop split-screen VR preview loads the stereo file like a headset', () => {
  const { playbackFor, engine } = loadStereo([]);
  engine.previewSplit = true;
  assert.equal(playbackFor(sbsPost, sbsPost).url, sbsPost.stereo_url);
  engine.previewSplit = false;
  assert.equal(playbackFor(sbsPost, sbsPost).url, sbsPost.url);
});

test('legacy stereo files without a rendition are cropped to the left eye in 2D', () => {
  const { playbackFor, applyEntryStereo, context, engine, layout, crop } = loadStereo([]);
  const legacy = { url: '/media/3d/a.mp4', stereo_url: '/media/3d/a.mp4', stereo_layout: 'sbs', stereo_crop: true };
  const flat = playbackFor(legacy, legacy);
  assert.deepEqual({ ...flat }, { url: legacy.url, layout: 'sbs', crop: 'sbs' });
  applyEntryStereo(flat);
  assert.ok(context.videoWrap.classList.contains('stereo-crop-sbs'));
  assert.equal(crop(), 'sbs');
  assert.equal(layout(), 'sbs');
  assert.deepEqual(engine.layouts, ['sbs']);

  const tb = { ...legacy, stereo_layout: 'tb' };
  applyEntryStereo(playbackFor(tb, tb));
  assert.ok(context.videoWrap.classList.contains('stereo-crop-tb'));
  assert.ok(!context.videoWrap.classList.contains('stereo-crop-sbs'));

  // In VR the raw file is split per eye, never cropped.
  engine.presenting = true;
  applyEntryStereo(playbackFor(legacy, legacy));
  assert.equal(crop(), '');
  assert.equal(context.videoWrap.classList.values.size, 0);
});

test('cached blobs are only reused for the URL they were fetched from', () => {
  const { blobFor, context } = loadStereo([]);
  context.blobUrlMap[1] = 'blob:mono';
  context.blobSourceMap[1] = '/media/uploads/clip-mono.mp4';
  assert.equal(blobFor(1, '/media/uploads/clip-mono.mp4'), 'blob:mono');
  assert.equal(blobFor(1, '/media/uploads/clip.mp4'), '');
  assert.equal(blobFor(2, '/media/uploads/clip-mono.mp4'), '');
});

test('entering and leaving VR swaps the source in place and keeps the playhead', async () => {
  const post = { ...sbsPost, tunnel_url: '' };
  const { syncStereoSource, context, engine, calls, layout } = loadStereo([post]);
  const { video } = context;
  video.src = post.url;
  video.currentTime = 12.5;
  video.paused = false;

  engine.presenting = true;
  syncStereoSource();
  assert.equal(video.src, post.stereo_url);
  assert.equal(layout(), 'sbs');
  assert.equal(engine.layouts.at(-1), 'sbs');
  assert.equal(video.plays, 1, 'keeps playing');
  assert.equal(video.pauses, 0, 'a playing reel is not paused by the swap');
  video.currentTime = 0; // a new src starts at 0 ...
  video.fire('loadedmetadata'); // ... until metadata restores the playhead
  assert.equal(video.currentTime, 12.5);
  assert.equal(calls.viewTracking, 0, 'no new view is recorded');

  video.currentTime = 20;
  video.paused = true;
  engine.presenting = false;
  syncStereoSource();
  assert.equal(video.src, post.url);
  assert.equal(layout(), 'mono');
  assert.equal(video.plays, 1, 'stays paused');
  // The real element autoplays on a new src; pause() after the swap stops it.
  assert.equal(video.pauses, 1, 'a paused reel is re-paused so autoplay cannot restart it');
  video.fire('loadedmetadata');
  assert.equal(video.currentTime, 20);

  // Nothing to swap: same source, no reload.
  const before = calls.preload;
  syncStereoSource();
  assert.equal(calls.preload, before);
});

test('a swipe during the swap does not seek the next reel to the old playhead', () => {
  const post = { ...sbsPost, tunnel_url: '' };
  const { syncStereoSource, context, engine } = loadStereo([post]);
  const { video } = context;
  video.src = post.url;
  video.currentTime = 12.5;
  video.paused = false;

  engine.presenting = true;
  syncStereoSource();
  assert.equal(video.src, post.stereo_url);
  // The user swipes before the stereo file's metadata arrives.
  video.src = '/media/uploads/next-reel.mp4';
  video.currentTime = 0;
  video.fire('loadedmetadata');
  assert.equal(video.currentTime, 0, 'the next reel starts at its own beginning');
});

test('image posts re-show the current slide on a VR switch', () => {
  const post = { media_type: 'image', url: '/m/a-mono.png', stereo_url: '/m/a.png', stereo_layout: 'sbs' };
  const { syncStereoSource, context, calls } = loadStereo([post]);
  context.imagePostSlides = [post, post];
  context.imageSlideIndex = 1;
  vm.runInContext('imagePostSlides = this.imagePostSlides; imageSlideIndex = 1;', context);
  syncStereoSource();
  assert.deepEqual(calls.slides, [1]);
  assert.equal(calls.notify, 1);
});

test('the filename/folder SBS heuristic is gone from the player', () => {
  assert.ok(!/\(sbs\|3d\)/.test(html), 'no filename regex');
  assert.ok(!html.includes('WebXRVR.setStereo(isSbs)'));
});

test('an image-post VR switch re-warms the next item for the new state', () => {
  const post = { media_type: 'image', url: '/m/a-mono.png', stereo_url: '/m/a.png', stereo_layout: 'sbs' };
  const { syncStereoSource, calls } = loadStereo([post, sbsPost]);
  syncStereoSource();
  assert.equal(calls.preload, 1);
});

test('VR entry swaps the source once, from the onEnterVR callback only', () => {
  const entry = html.slice(html.indexOf("showFlash('ENTERING IMMERSIVE VR')") - 400, html.indexOf("showFlash('ENTERING IMMERSIVE VR')") + 200);
  assert.ok(!entry.includes('syncStereoSource()'), 'no second swap after enterVR resolves');
  assert.match(html, /onEnterVR: \(\) => syncStereoSource\(\),/);
});

test('a stereo failure retries once, then stays on 2D with a notice', () => {
  const item = { ...sbsPost };
  const { syncStereoSource, handleStereoFailure, layout, context, calls } = loadStereo([item], { presenting: true });
  context.video.currentTime = 7;
  syncStereoSource();
  assert.equal(context.video.getAttribute('src'), '/media/uploads/clip.mp4');
  assert.equal(layout(), 'sbs');

  // First failure (say a transient 404): 2D now, stereo again after 5 s.
  // The failed element reports currentTime 0; the fallback keeps the playhead.
  context.video.currentTime = 0;
  assert.equal(handleStereoFailure(item), true);
  assert.equal(context.video.getAttribute('src'), '/media/uploads/clip-mono.mp4');
  context.video.duration = 30;
  context.video.fire('loadedmetadata');
  assert.equal(context.video.currentTime, 7);
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].ms, 5000);
  assert.deepEqual(calls.flashes, []);
  calls.timers[0].fn();
  assert.equal(context.video.getAttribute('src'), '/media/uploads/clip.mp4', 'retry loads stereo');

  // Second failure: stays 2D, no further retry, user is told.
  assert.equal(handleStereoFailure(item), true);
  assert.equal(context.video.getAttribute('src'), '/media/uploads/clip-mono.mp4');
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.flashes.length, 1);
  assert.match(calls.flashes[0], /3D UNAVAILABLE/);
  // A 2D error is a real error, not another stereo fallback.
  assert.equal(handleStereoFailure(item), false);
});

test('the stereo retry is dropped once the user has left the post', () => {
  const item = { ...sbsPost };
  const other = { ...sbsPost, url: '/m/b-mono.mp4', stereo_url: '/m/b.mp4' };
  const { syncStereoSource, handleStereoFailure, clearStereoFailure, context, calls } = loadStereo([item, other], { presenting: true });
  syncStereoSource();
  handleStereoFailure(item);
  vm.runInContext('idx = 1;', context);
  clearStereoFailure(item);
  calls.timers[0].fn();
  assert.equal(item.stereoFailed, false);
  assert.equal(item.stereoFailures, 0);
  assert.notEqual(context.video.getAttribute('src'), '/media/uploads/clip.mp4');
});

test('leaving a post clears its 3D failure in loadVideo', () => {
  const load = html.slice(html.indexOf('function loadVideo('), html.indexOf('pruneBlobCache(idx);', html.indexOf('function loadVideo(')));
  assert.match(load, /clearStereoFailure\(videoData\[idx\]\)/);
});

test('entering VR keeps a paused reel paused', () => {
  const xr = readFileSync(join(here, '..', '..', 'ui', 'assets', 'webxr_vr.js'), 'utf-8');
  const entry = xr.slice(xr.indexOf("if (sceneMode === 'reels') {", xr.indexOf('Entered immersive session')), xr.indexOf('callbacks.onEnterVR()'));
  assert.ok(entry.includes('videoElement.muted = false'));
  assert.ok(!/videoElement\.play\(/.test(entry), 'no play() on entry');
});

test('reels page 3D testing filter sends media=stereo to the list and the player', () => {
  const page = readFileSync(join(here, '..', 'src', 'pages', 'ReelsPage.jsx'), 'utf-8');
  assert.match(page, /useState\(searchParams\.get\('media'\) === 'stereo'\)/);
  assert.match(page, /media: only3d \? 'stereo' : undefined/);
  assert.match(page, /\.\.\.\(only3d \? \{ media: 'stereo' \} : \{\}\)/);
  assert.match(page, /nextParams\.set\('media', 'stereo'\)/);
  assert.match(page, /primary=\{only3d\}[\s\S]{0,120}aria-pressed=\{only3d\}/);
});
