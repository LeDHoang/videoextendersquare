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

function fakeVideo() {
  const listeners = {};
  return {
    paused: true,
    readyState: 0,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    fire(type) { (listeners[type] || []).slice().forEach((fn) => fn()); },
    count(type) { return (listeners[type] || []).length; },
  };
}

// Runs the real preload scheduler from reels.html against fakes.
function loadPreload(items) {
  const timers = new Map();
  let nextTimer = 1;
  const preloadVideo = { src: '', loads: 0, load() { this.loads += 1; } };
  const calls = { clears: 0, warmedImages: [] };
  const context = {
    console,
    video: fakeVideo(),
    videoData: items,
    idx: 0,
    preloadVideo,
    clearPreloadVideo: () => { calls.clears += 1; preloadVideo.src = ''; },
    isImageItem: (item) => !!item && item.media_type === 'image',
    playbackUrlFor: (item) => item.url,
    blobFor: () => null,
    Image: function Image() { calls.warmedImages.push(this); },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  vm.createContext(context);
  vm.runInContext(`${block('reels-preload')}\nthis.api = { preloadNext };`, context);
  const runTimers = () => {
    const due = [...timers.values()];
    timers.clear();
    due.forEach((t) => t.fn());
  };
  return { ...context.api, context, preloadVideo, calls, timers, runTimers };
}

const items = [
  { media_type: 'video', url: '/media/a.mp4' },
  { media_type: 'video', url: '/media/b.mp4' },
  { media_type: 'video', url: '/media/c.mp4' },
];

test('the next reel is warmed once the active reel starts playing', () => {
  const { preloadNext, context, preloadVideo, timers } = loadPreload(items);
  preloadNext(0);
  assert.equal(preloadVideo.src, '', 'nothing starts while the active reel is still loading');
  context.video.paused = false;
  context.video.readyState = 4;
  context.video.fire('playing');
  assert.equal(preloadVideo.src, '/media/b.mp4');
  assert.equal(preloadVideo.loads, 1);
  assert.equal(timers.size, 0, 'the fallback timer is cancelled');
  assert.equal(context.video.count('playing'), 0, 'the playing listener is removed');
});

test('the next reel is warmed after the fallback delay when playback never starts', () => {
  const { preloadNext, preloadVideo, timers, runTimers } = loadPreload(items);
  preloadNext(0);
  assert.equal([...timers.values()][0].ms, 1500);
  runTimers();
  assert.equal(preloadVideo.src, '/media/b.mp4');
});

test('a reel that is already playing warms the next one immediately', () => {
  const { preloadNext, context, preloadVideo } = loadPreload(items);
  context.video.paused = false;
  context.video.readyState = 4;
  preloadNext(0);
  assert.equal(preloadVideo.src, '/media/b.mp4');
});

test('a rapid second switch cancels the pending warm-up and clears the preloader', () => {
  const { preloadNext, context, preloadVideo, calls, timers, runTimers } = loadPreload(items);
  preloadNext(0);
  context.idx = 1;
  preloadNext(1);
  assert.equal(calls.clears, 2, 'each switch clears the preloader');
  assert.equal(timers.size, 1, 'only the latest warm-up is pending');
  assert.equal(context.video.count('playing'), 1);
  runTimers();
  assert.equal(preloadVideo.src, '/media/c.mp4');
  assert.equal(preloadVideo.loads, 1, 'the cancelled warm-up never loaded');
});

test('a warm-up scheduled for a reel the user already left does nothing', () => {
  const { preloadNext, context, preloadVideo, runTimers } = loadPreload(items);
  preloadNext(0);
  context.idx = 2;
  runTimers();
  assert.equal(preloadVideo.src, '');
  assert.equal(preloadVideo.loads, 0);
});

test('an image next item warms the browser cache instead of the video preloader', () => {
  const withImage = [items[0], { media_type: 'image', url: '/media/still.jpg' }];
  const { preloadNext, preloadVideo, calls, runTimers } = loadPreload(withImage);
  preloadNext(0);
  runTimers();
  assert.equal(preloadVideo.src, '');
  assert.equal(calls.warmedImages.length, 1);
  assert.equal(calls.warmedImages[0].src, '/media/still.jpg');
});
