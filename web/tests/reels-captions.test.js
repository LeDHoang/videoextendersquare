import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const html = readFileSync(join(root, 'ui', 'assets', 'reels.html'), 'utf-8');

function block(name) {
  const match = html.match(new RegExp(`// <${name}>[^\\n]*\\n([\\s\\S]*?)// </${name}>`));
  assert.ok(match, `${name} markers present`);
  return match[1];
}

function fakeButton() {
  const classes = new Set(['action-btn', 'active']);
  const attrs = {};
  return {
    hidden: true,
    listeners: {},
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute: (name) => attrs[name],
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
}

const cue = (text) => ({ getCueAsHTML: () => ({ textContent: text }) });

// Runs the real <auto-captions> block against a fake video, DOM and storage.
function loadCaptions({ stored = null, storageThrows = false } = {}) {
  const layer = { hidden: true, firstElementChild: { textContent: '' } };
  const button = fakeButton();
  const tracks = [];
  const video = {
    children: [],
    appendChild(el) { this.children.push(el); el.parent = this; },
  };
  const store = new Map(stored == null ? [] : [['echo_reels_captions_v1', stored]]);
  const state = { drawerOpen: false };
  const context = {
    video,
    window: {
      localStorage: {
        getItem(key) { if (storageThrows) throw new Error('blocked'); return store.has(key) ? store.get(key) : null; },
        setItem(key, value) { if (storageThrows) throw new Error('blocked'); store.set(key, String(value)); },
      },
    },
    document: {
      getElementById: (id) => ({ reelsCaptions: layer, captionsBtn: button }[id] || null),
      createElement(tag) {
        assert.equal(tag, 'track');
        const el = {
          track: { mode: 'disabled', activeCues: [], listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } },
          remove() { video.children.splice(video.children.indexOf(el), 1); },
        };
        tracks.push(el);
        return el;
      },
    },
    resolveItemUrl: (item) => item.url,
    drawerBlocksPlayer: () => state.drawerOpen,
    Array,
  };
  vm.runInNewContext(
    `${block('auto-captions')}\nthis.api = { setCaptionTrack, currentCaption };`,
    context,
    { filename: 'reels.html#auto-captions' },
  );
  // A cue change on the current track, as the browser fires it.
  const speak = (...texts) => {
    const track = video.children[0].track;
    track.activeCues = texts.map(cue);
    track.listeners.cuechange();
  };
  return { api: context.api, layer, button, video, tracks, store, state, speak };
}

const captioned = { url: 'ok', captions_url: '/media/uploads/talk.vtt' };

test('a reel with captions gets one hidden track, and its cues show as plain text', () => {
  const { api, layer, button, video, speak } = loadCaptions();
  assert.equal(button.hidden, true);
  api.setCaptionTrack(captioned);
  assert.equal(video.children.length, 1);
  const [track] = video.children;
  assert.deepEqual([track.kind, track.label, track.src], ['captions', 'Auto captions', '/media/uploads/talk.vtt']);
  // Hidden: the cues load and change, but the browser draws none of them over the player's own overlays.
  assert.equal(track.track.mode, 'hidden');
  assert.equal(button.hidden, false);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(layer.hidden, true, 'nothing to show before the first cue');

  speak('Fish & chips');
  assert.equal(layer.hidden, false);
  assert.equal(layer.firstElementChild.textContent, 'Fish & chips');
  assert.equal(api.currentCaption(), 'Fish & chips');
  speak('Two cues', 'at once');
  assert.equal(layer.firstElementChild.textContent, 'Two cues\nat once');
  speak();
  assert.equal(layer.hidden, true);
});

test('the next reel replaces the track; a reel without captions, or a still, has none', () => {
  const { api, layer, button, video, speak } = loadCaptions();
  api.setCaptionTrack(captioned);
  speak('Still talking');
  api.setCaptionTrack({ url: 'next', captions_url: '/media/uploads/next.vtt' });
  assert.deepEqual(video.children.map((el) => el.src), ['/media/uploads/next.vtt']);
  assert.equal(layer.hidden, true, 'the old cue goes with its track');
  for (const item of [{ url: 'silent', captions_url: null }, null]) {
    api.setCaptionTrack(item);
    assert.equal(video.children.length, 0);
    assert.equal(button.hidden, true);
    assert.equal(api.currentCaption(), '');
  }
});

test('CC off hides the captions, for VR too, and the choice is remembered', () => {
  const first = loadCaptions();
  first.api.setCaptionTrack(captioned);
  first.speak('Hello');
  first.button.listeners.click();
  assert.equal(first.button.getAttribute('aria-pressed'), 'false');
  assert.equal(first.button.classList.contains('active'), false);
  assert.equal(first.layer.hidden, true);
  assert.equal(first.api.currentCaption(), '', 'VR reads the same switch');
  assert.equal(first.store.get('echo_reels_captions_v1'), 'off');

  const later = loadCaptions({ stored: 'off' });
  later.api.setCaptionTrack(captioned);
  later.speak('Hello');
  assert.equal(later.layer.hidden, true);
  later.button.listeners.click();
  assert.equal(later.layer.firstElementChild.textContent, 'Hello');
  assert.equal(later.store.get('echo_reels_captions_v1'), 'on');
});

test('captions default to on when storage is blocked', () => {
  const { api, layer, button, speak } = loadCaptions({ storageThrows: true });
  api.setCaptionTrack(captioned);
  speak('Private window');
  assert.equal(layer.hidden, false);
  button.listeners.click();
  assert.equal(layer.hidden, true);
});

test('a comments drawer over the player hides the 2D captions but not the VR ones', () => {
  const { api, layer, state, speak } = loadCaptions();
  api.setCaptionTrack(captioned);
  state.drawerOpen = true;
  speak('Behind the drawer');
  assert.equal(layer.hidden, true);
  assert.equal(api.currentCaption(), 'Behind the drawer');
});

test('the player wires captions into each reel, the More menu and VR', () => {
  const body = html.slice(html.indexOf('<body>'));
  for (const id of ['reelsCaptions', 'captionsBtn']) {
    assert.equal((body.match(new RegExp(`\\bid="${id}"`, 'g')) || []).length, 1, `#${id} exists once`);
  }
  const more = body.slice(body.indexOf('id="railMore"'), body.indexOf('id="saveBtn"'));
  assert.ok(more.indexOf('id="modeBtn"') < more.indexOf('id="captionsBtn"'), 'CC sits after AUTO/LOOP in More');
  assert.match(more, /id="captionsBtn"[^>]*\bhidden\b/, 'CC starts hidden, until a reel has captions');
  assert.match(more, /__ICON_CAPTIONS__/);
  assert.ok(existsSync(join(root, 'web', 'src', 'components', 'icons', 'svg', 'captions.svg')));
  assert.match(html, /\.action-btn\[hidden\] \{ display: none; \}/, 'the flex button still hides');

  const load = html.slice(html.indexOf('function loadVideo('), html.indexOf('function updatePlayBtnUI('));
  assert.ok(load.indexOf('setCaptionTrack(null)') > -1, 'the last reel\'s track goes first');
  assert.ok(load.indexOf('setCaptionTrack(null)') < load.indexOf('if (isImageItem(item))'), 'before a still returns early');
  assert.ok(load.indexOf('video.src = itemUrl;') < load.indexOf('setCaptionTrack(item)'), 'then this reel\'s, with its video');
  assert.match(html, /WebXRVR\.init\(video, \{[\s\S]*?getCaption: currentCaption,/);
});
