import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../ui/assets/vr_shell_canvas.js', import.meta.url), 'utf8');

function loadCanvas() {
  const window = {};
  vm.runInNewContext(source, { window });
  return window.VRShellCanvas;
}

function recordingCtx() {
  const texts = [];
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop === 'fillText') return (text) => texts.push(String(text));
      if (prop === 'measureText') return (value) => ({ width: String(value).length * 8 });
      if (!(prop in target)) target[prop] = () => {};
      return target[prop];
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  return { ctx, texts };
}

test('nav rects tile the bar without overlap and resolve back to their item', () => {
  const sc = loadCanvas();
  const rects = sc.navRects();
  assert.deepEqual([...rects.map((r) => r.id)], ['back', 'reels', 'explore', 'messages', 'wallet', 'profile']);
  for (let i = 1; i < rects.length; i++) assert.ok(rects[i].x >= rects[i - 1].x + rects[i - 1].w);
  assert.ok(rects[rects.length - 1].x + rects[rects.length - 1].w <= sc.NAV_W);
  for (const r of rects) {
    assert.deepEqual({ ...sc.resolveNavHit(r.x + r.w / 2, r.y + r.h / 2) }, { action: 'nav', arg: r.id });
  }
  assert.equal(sc.resolveNavHit(2, 2), null, 'padding is not a hit');
});

test('main panel: close button always hits, handoff buttons only on the card', () => {
  const sc = loadCanvas();
  assert.equal(sc.resolveMainHit({}, sc.MAIN_W - 90, 60).action, 'close');
  const handoff = { handoff: { path: '/upload' } };
  assert.equal(sc.resolveMainHit(handoff, sc.MAIN_W / 2 - 270, 820).action, 'handoff-confirm');
  assert.equal(sc.resolveMainHit(handoff, sc.MAIN_W / 2 + 270, 820).action, 'handoff-cancel');
  assert.equal(sc.resolveMainHit({ route: { section: 'explore' } }, sc.MAIN_W / 2 - 270, 820), null);
});

test('renderers draw the section title, handoff copy and nav labels', () => {
  const sc = loadCanvas();
  let rec = recordingCtx();
  sc.renderMainPanel(rec.ctx, { route: { section: 'profile', path: '/profile/bob', arg: 'bob' } }, '');
  assert.ok(rec.texts.includes('PROFILE'));
  assert.ok(rec.texts.includes('bob'));
  rec = recordingCtx();
  sc.renderMainPanel(rec.ctx, { handoff: { title: 'FINISH ON 2D', message: 'm', path: '/upload' } }, 'handoff-confirm');
  assert.ok(rec.texts.includes('EXIT VR & OPEN'));
  assert.ok(rec.texts.includes('/upload'));
  rec = recordingCtx();
  sc.renderNavBar(rec.ctx, { open: false }, 'explore');
  assert.ok(rec.texts.includes('CREDITS'));
});

test('hoverKey matches the renderers hover argument', () => {
  const sc = loadCanvas();
  assert.equal(sc.hoverKey(null), '');
  assert.equal(sc.hoverKey({ action: 'nav', arg: 'explore' }), 'explore');
  assert.equal(sc.hoverKey({ action: 'close' }), 'close');
});

test('grid: search bar, scroll buttons and cards resolve with the scroll offset', () => {
  const sc = loadCanvas();
  const items = Array.from({ length: 12 }, (_, i) => ({ title: 't' + i }));
  const route = { section: 'explore', items, scroll: 1, status: 'ready' };
  assert.equal(sc.resolveMainHit({ route }, 200, 200).action, 'search-focus');
  const c = sc.cardRect(0);
  assert.deepEqual({ ...sc.resolveMainHit({ route }, c.x + 10, c.y + 10) }, { action: 'play', arg: 5 });
  const last = sc.cardRect(9);
  assert.equal(sc.resolveMainHit({ route }, last.x + 10, last.y + 10), null, 'past the end');
  assert.deepEqual({ ...sc.resolveMainHit({ route }, sc.MAIN_W - 96, 900) }, { action: 'scroll', arg: 1 });
  const right = sc.cardRect(4);
  assert.ok(right.x + right.w < sc.MAIN_W - 144, 'cards clear the scroll column');
  const tag = { section: 'tag', items: [], related: [{ label: '#a', path: '/explore/tag/a' }] };
  assert.deepEqual({ ...sc.resolveMainHit({ route: tag }, 100, 200) }, { action: 'chip', arg: '/explore/tag/a' });
  assert.equal(sc.resolveMainHit({ route: { section: 'profile' } }, c.x + 10, c.y + 10), null);
});

test('grid renders titles, statuses and uses the image getter', () => {
  const sc = loadCanvas();
  const asked = [];
  let rec = recordingCtx();
  sc.renderMainPanel(rec.ctx, { route: { section: 'search', arg: 'cats', status: 'ready',
    items: [{ title: 'Hello', author_name: 'bob', poster_url: '/p.jpg', media_type: 'video' }] } }, '', (u) => { asked.push(u); return null; });
  assert.ok(rec.texts.includes('Hello'));
  assert.ok(rec.texts.includes('@bob'));
  assert.ok(rec.texts.includes('cats'));
  assert.deepEqual(asked, ['/p.jpg']);
  rec = recordingCtx();
  sc.renderMainPanel(rec.ctx, { route: { section: 'tag', status: 'loading', label: '#x' } }, '');
  assert.ok(rec.texts.includes('Loading…'));
  assert.ok(rec.texts.includes('#x'));
  assert.equal(sc.thumbUrl({ media_type: 'image', url: '/i.jpg' }), '/i.jpg');
  assert.equal(sc.thumbUrl({ media_type: 'video', url: '/v.mp4' }), '');
});

test('keyboard keys tile the canvas and resolve to their id', () => {
  const sc = loadCanvas();
  const keys = sc.keyboardRects();
  assert.equal(keys.length, 26 + 4);
  for (const k of keys) {
    assert.ok(k.x >= 0 && k.y >= 0 && k.x + k.w <= sc.KB_W + 0.01 && k.y + k.h <= sc.KB_H + 0.01, k.id);
    assert.deepEqual({ ...sc.resolveKeyboardHit(k.x + k.w / 2, k.y + k.h / 2) }, { action: 'key', arg: k.id });
  }
  assert.equal(sc.hoverKey({ action: 'key', arg: 'q' }), 'key:q');
  const rec = recordingCtx();
  sc.renderKeyboard(rec.ctx, 'key:q');
  assert.ok(rec.texts.includes('Q') && rec.texts.includes('ENTER'));
});
