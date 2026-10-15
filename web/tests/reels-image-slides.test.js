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

function fakeElement() {
  const element = {
    hidden: false,
    style: {},
    children: [],
    attributes: {},
    classList: {
      values: new Set(),
      add(name) { this.values.add(name); },
      remove(name) { this.values.delete(name); },
      toggle(name, on) { if (on) this.values.add(name); else this.values.delete(name); },
      contains(name) { return this.values.has(name); },
    },
    get childElementCount() { return this.children.length; },
    get firstChild() { return this.children[0]; },
    set innerHTML(_value) { this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
  };
  return element;
}

// Runs the real slideshow engine from reels.html against a manual clock.
function loadPlayer(items, { autoNext = true } = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const calls = { next: [], finished: [], started: 0 };
  const image = fakeElement();
  Object.defineProperty(image, 'src', {
    get() { return this.getAttribute('src') || ''; },
    set(value) { this.setAttribute('src', value); },
  });
  image.getBoundingClientRect = () => ({ left: 0, right: 300 });
  const wrap = fakeElement();
  wrap.getBoundingClientRect = () => ({ left: 0, right: 300 });
  const elements = { slideBar: fakeElement(), slidePrevBtn: fakeElement(), slideNextBtn: fakeElement() };
  const context = {
    console,
    Math,
    Number,
    Array,
    String,
    performance: { now: () => now },
    setTimeout(fn, ms) { timerId += 1; timers.set(timerId, { fn, at: now + ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    Image: function Image() {},
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: () => fakeElement(),
    },
    window: {},
    videoData: items,
    idx: 0,
    isAutoNext: autoNext,
    blobUrlMap: {},
    blobSourceMap: {},
    reelsImage: image,
    videoWrap: wrap,
    isImageItem: (item) => !!item && item.media_type === 'image',
    resolveItemUrl: (item) => item.url,
    formatTime: (seconds) => String(Math.floor(seconds)),
    updatePlayBtnUI: () => {},
    finishViewTracking: (reason) => calls.finished.push(reason),
    startViewTracking: () => { calls.started += 1; },
    nextVideo: (reason) => calls.next.push(reason),
  };
  vm.createContext(context);
  vm.runInContext(`${block('reels-stereo')}\n${block('reels-image-state')}\n${block('reels-image-slides')}
    this.player = {
      start(item) { resetImagePost(item); showImageSlide(0); armImageTimer(); },
      pause: clearImageTimer,
      resume: armImageTimer,
      step: stepImageSlide,
      tap: handleSlideTap,
      slide: () => imageSlideIndex,
      elapsed: imageElapsedNow,
      running: () => !!imageTimer,
    };`, context);

  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { player: context.player, advance, calls, image };
}

const post = (count, extra = {}) => ({
  media_type: 'image',
  title: 'City',
  url: '/media/a0.png',
  images: Array.from({ length: count }, (_, i) => ({ url: `/media/a${i}.png` })),
  ...extra,
});

test('a 3-image post splits the 15s dwell evenly, then auto-advances', () => {
  const { player, advance, calls, image } = loadPlayer([post(3)]);
  player.start(post(3));
  assert.equal(player.slide(), 0);
  assert.equal(image.src, '/media/a0.png');
  advance(4999);
  assert.equal(player.slide(), 0);
  advance(1);
  assert.equal(player.slide(), 1);
  assert.equal(image.src, '/media/a1.png');
  advance(5000);
  assert.equal(player.slide(), 2);
  assert.deepEqual(calls.next, []);
  advance(5000);
  assert.deepEqual(calls.next, ['autoplay']);
  assert.deepEqual(calls.finished, ['complete']);
});

test('a single-image post holds 15s and has no slides to step', () => {
  const { player, advance, calls } = loadPlayer([post(1)]);
  player.start(post(1));
  assert.equal(player.step(1), false);
  advance(14999);
  assert.deepEqual(calls.next, []);
  advance(1);
  assert.deepEqual(calls.next, ['autoplay']);
});

test('pausing keeps the post where it was; resuming continues the dwell', () => {
  const { player, advance, calls } = loadPlayer([post(3)]);
  player.start(post(3));
  advance(7000);
  player.pause();
  assert.equal(player.running(), false);
  advance(60000);
  assert.equal(player.slide(), 1);
  assert.deepEqual(calls.next, []);
  player.resume();
  advance(7999);
  assert.deepEqual(calls.next, []);
  advance(1);
  assert.deepEqual(calls.next, ['autoplay']);
});

test('manual steps jump to that image\'s share of the dwell and wrap around', () => {
  const { player, advance, calls } = loadPlayer([post(3)]);
  player.start(post(3));
  advance(1000);
  assert.equal(player.step(1), true);
  assert.equal(player.slide(), 1);
  assert.equal(player.elapsed(), 5000);
  player.step(1);
  player.step(1);
  assert.equal(player.slide(), 0, 'right on the last image cycles to the first');
  player.step(-1);
  assert.equal(player.slide(), 2, 'left on the first image cycles to the last');
  advance(5000);
  assert.deepEqual(calls.next, ['autoplay'], 'the post still ends once the last image had its time');
});

test('tapping the left/right third of the image steps; the middle falls through to play/pause', () => {
  const { player } = loadPlayer([post(4)]);
  player.start(post(4));
  assert.equal(player.tap(250), true);
  assert.equal(player.slide(), 1);
  assert.equal(player.tap(20), true);
  assert.equal(player.slide(), 0);
  assert.equal(player.tap(150), false);
  assert.equal(player.slide(), 0);
});

test('a post\'s own dwell_ms overrides the 15s default; LOOP replays from the first image', () => {
  const { player, advance, calls } = loadPlayer([post(2, { dwell_ms: 6000 })], { autoNext: false });
  player.start(post(2, { dwell_ms: 6000 }));
  advance(3000);
  assert.equal(player.slide(), 1);
  advance(3000);
  assert.deepEqual(calls.next, []);
  assert.equal(calls.started, 1);
  assert.equal(player.slide(), 0);
  assert.equal(player.running(), true);
});
