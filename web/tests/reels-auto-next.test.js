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

// A video whose currentTime setter fires 'seeking', as a real element does.
function fakeVideo() {
  const listeners = {};
  let time = 0;
  return {
    plays: 0,
    get currentTime() { return time; },
    set currentTime(t) { time = t; (listeners.seeking || []).forEach((fn) => fn()); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    play() { this.plays += 1; return Promise.resolve(); },
  };
}

// Runs the real play-twice rule from reels.html with a VR or 2D WebXRVR fake.
function loadAutoNext({ presenting = false, previewRunning = false, pack = false } = {}) {
  const context = {
    video: fakeVideo(),
    isPackMode: pack,
    autoPlaysDone: 0,
    autoLoopRestart: false,
    WebXRVR: {
      isPresenting: () => presenting,
      getPreviewState: () => ({ running: previewRunning }),
    },
  };
  vm.createContext(context);
  vm.runInContext(`${block('reels-auto-next')}\nthis.api = { replayBeforeAutoNext };`, context);
  // An 'ended' with AUTO on: true means it replayed, false means it advances.
  const end = () => {
    context.video.currentTime = 10;
    return context.api.replayBeforeAutoNext();
  };
  return { context, end };
}

test('in a headset a reel replays once, then advances', () => {
  const { context, end } = loadAutoNext({ presenting: true });
  assert.equal(end(), true);
  assert.equal(context.video.currentTime, 0);
  assert.equal(context.video.plays, 1);
  assert.equal(end(), false);
  assert.equal(context.video.plays, 1);
});

test('the desktop immersive preview counts as VR', () => {
  const { end } = loadAutoNext({ previewRunning: true });
  assert.equal(end(), true);
  assert.equal(end(), false);
});

test('2D playback advances after one play', () => {
  const { context, end } = loadAutoNext();
  assert.equal(end(), false);
  assert.equal(context.video.plays, 0);
});

test('Reel Packs keep their authored pacing in VR', () => {
  const { end } = loadAutoNext({ presenting: true, pack: true });
  assert.equal(end(), false);
});

test('the replay restart is not mistaken for a manual seek to the start', () => {
  const { context, end } = loadAutoNext({ presenting: true });
  end();
  assert.equal(context.autoPlaysDone, 1);
  assert.equal(context.autoLoopRestart, false);
});

test('a manual seek back to the start during the replay earns two more plays', () => {
  const { context, end } = loadAutoNext({ presenting: true });
  end();
  context.video.currentTime = 0;
  assert.equal(context.autoPlaysDone, 0);
  assert.equal(end(), true);
  assert.equal(end(), false);
});

test('a seek elsewhere in the reel keeps the count', () => {
  const { context, end } = loadAutoNext({ presenting: true });
  end();
  context.video.currentTime = 4;
  assert.equal(context.autoPlaysDone, 1);
  assert.equal(end(), false);
});

test('a reel change resets the count and the ended handler uses the rule only under AUTO', () => {
  assert.match(html, /idx = index;\n\s+autoPlaysDone = 0;/);
  assert.match(html, /if \(isAutoNext\) \{\n\s+if \(replayBeforeAutoNext\(\)\) return;\n\s+nextVideo\('autoplay'\);/);
});
