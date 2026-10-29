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
