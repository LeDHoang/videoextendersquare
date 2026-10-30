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
  assert.deepEqual([...rects.map((r) => r.id)], ['reels', 'earth', 'explore', 'messages', 'wallet', 'profile']);
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
  sc.renderMainPanel(rec.ctx, { route: { section: 'rewards', path: '/rewards', arg: '' } }, '');
  assert.ok(rec.texts.includes('REWARDS'));
  assert.ok(rec.texts.includes('/rewards'));
  rec = recordingCtx();
  sc.renderMainPanel(rec.ctx, { handoff: { title: 'FINISH ON 2D', message: 'm', path: '/upload' } }, 'handoff-confirm');
  assert.ok(rec.texts.includes('EXIT VR & OPEN'));
  assert.ok(rec.texts.includes('/upload'));
  rec = recordingCtx();
  sc.renderNavBar(rec.ctx, { open: false }, 'explore');
  assert.ok(rec.texts.includes('CREDITS'));
  assert.ok(rec.texts.includes('EARTH'));
});

test('hoverKey matches the renderers hover argument', () => {
  const sc = loadCanvas();
  assert.equal(sc.hoverKey(null), '');
  assert.equal(sc.hoverKey({ action: 'nav', arg: 'explore' }), 'explore');
  assert.equal(sc.hoverKey({ action: 'close' }), 'close');
});

test('grid: search bar, scroll buttons and tiles resolve with the scroll offset', () => {
  const sc = loadCanvas();
  const items = Array.from({ length: 10 }, (_, i) => ({ title: 't' + i }));
  const route = { section: 'explore', items, scroll: 1, status: 'ready' };
  const L = sc.gridLayout(route);
  assert.equal(L.cols, sc.GRID_COLS);
  assert.equal(sc.resolveMainHit({ route }, 200, 200).action, 'search-focus');
  const c = sc.tileRect(L, 0);
  assert.ok(c.w > 400 && c.h > 400, `tiles are big (${c.w}x${c.h})`);
  assert.deepEqual({ ...sc.resolveMainHit({ route }, c.x + 10, c.y + 10) }, { action: 'play', arg: 4 });
  const last = sc.tileRect(L, 6);
  assert.equal(sc.resolveMainHit({ route }, last.x + 10, last.y + 10), null, 'past the end');
  assert.deepEqual({ ...sc.resolveMainHit({ route }, sc.MAIN_W - 96, 900) }, { action: 'scroll', arg: 1 });
  const right = sc.tileRect(L, L.cols - 1);
  assert.ok(right.x + right.w < sc.MAIN_W - 144, 'tiles clear the scroll column');
  const bottom = sc.tileRect(L, L.cols * L.rows - 1);
  assert.ok(bottom.y + bottom.h <= sc.MAIN_H - 40, 'tiles stay on the panel');
  const tag = { section: 'tag', items: [], related: [{ label: '#a', path: '/explore/tag/a' }] };
  assert.deepEqual({ ...sc.resolveMainHit({ route: tag }, 100, 200) }, { action: 'chip', arg: '/explore/tag/a' });
  assert.equal(sc.resolveMainHit({ route: { section: 'wallet' } }, c.x + 10, c.y + 10), null);
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
  assert.ok(rec.texts.includes('LOADING…'));
  assert.ok(rec.texts.includes('#x'));
  assert.equal(sc.thumbUrl({ media_type: 'image', url: '/i.jpg' }), '/i.jpg');
  assert.equal(sc.thumbUrl({ media_type: 'video', url: '/v.mp4' }), '');
});

test('tiles: creator and place pills open their pages, the rest plays', () => {
  const sc = loadCanvas();
  const item = { title: 'Night walk', creator: { username: 'amy' }, location: { city: 'Paris', country: 'France' },
    likes: 1500, views: 20, comments_count: 2, liked_by_me: true, media_type: 'image', images: [{}, {}, {}], stereo_layout: 'sbs' };
  const route = { section: 'explore', status: 'ready', items: [item] };
  const r = sc.tileRect(sc.gridLayout(route), 0);
  const creator = sc.resolveMainHit({ route }, r.x + 20, r.y + 20);
  assert.deepEqual({ ...creator }, { action: 'chip', arg: '/profile/amy', hover: 'creator:0' });
  assert.equal(sc.hoverKey(creator), 'creator:0');
  const loc = sc.resolveMainHit({ route }, r.x + 20, r.y + 12 + 56 + 20);
  assert.deepEqual({ ...loc }, { action: 'chip', arg: '/explore/location/paris--france', hover: 'loc:0' });
  assert.deepEqual({ ...sc.resolveMainHit({ route }, r.x + r.w / 2, r.y + r.h / 2) }, { action: 'play', arg: 0 });
  const rec = recordingCtx();
  sc.renderMainPanel(rec.ctx, { route }, 'creator:0');
  for (const text of ['@amy', 'Paris, France', 'IMAGES · 3 · 3D', 'Night walk', '1.5K', '20', '2']) {
    assert.ok(rec.texts.includes(text), text);
  }
});

test('keyboard keys tile the canvas and resolve to their id', () => {
  const sc = loadCanvas();
  for (const layout of ['alpha', 'symbols', 'emoji']) {
    const field = { layout };
    const keys = sc.keyboardRects(field);
    assert.equal(keys.length, 33, layout);
    assert.equal(new Set(keys.map((k) => k.id)).size, keys.length, layout + ' ids unique');
    for (const k of keys) {
      assert.ok(k.x >= 0 && k.y >= 0 && k.x + k.w <= sc.KB_W + 0.01 && k.y + k.h <= sc.KB_H + 0.01, k.id);
      assert.deepEqual({ ...sc.resolveKeyboardHit(k.x + k.w / 2, k.y + k.h / 2, field) }, { action: 'key', arg: k.id });
    }
  }
  const ids = (f) => sc.keyboardRects(f).map((k) => k.id);
  assert.ok(ids({ layout: 'alpha' }).includes('layout:symbols') && ids({ layout: 'alpha' }).includes('layout:emoji'));
  assert.ok(ids({ layout: 'symbols' }).includes('layout:alpha') && ids({ layout: 'symbols' }).includes('@'));
  assert.ok(ids({ layout: 'emoji' }).includes('👍'));
  assert.equal(sc.hoverKey({ action: 'key', arg: 'q' }), 'key:q');
  let rec = recordingCtx();
  sc.renderKeyboard(rec.ctx, 'key:q');
  assert.ok(rec.texts.includes('q') && rec.texts.includes('ENTER') && !rec.texts.includes('Q'));
  rec = recordingCtx();
  sc.renderKeyboard(rec.ctx, '', { layout: 'alpha', shift: true });
  assert.ok(rec.texts.includes('Q'));
});

test('keyboard strip echoes the field above the keys', () => {
  const sc = loadCanvas();
  const top = Math.min(...sc.keyboardRects({ layout: 'alpha' }).map((k) => k.y));
  assert.ok(top >= 96, `keys start below the strip (${top})`);
  assert.equal(sc.resolveKeyboardHit(sc.KB_W / 2, 40, { layout: 'alpha' }), null, 'strip is not a key');
  const rec = recordingCtx();
  sc.renderKeyboard(rec.ctx, '', { id: 'compose', text: 'hello there', layout: 'alpha' });
  assert.ok(rec.texts.includes('hello there'));

  // A keystroke repaints only the strip: its text, no keys, nothing below the strip.
  const strip = recordingCtx();
  const bottoms = [];
  ['clearRect', 'fillRect'].forEach((name) => { strip.ctx[name] = (x, y, w, h) => bottoms.push(y + h); });
  sc.renderKeyboardField(strip.ctx, { id: 'compose', text: 'hello there!', layout: 'alpha' });
  assert.ok(strip.texts.includes('hello there!') && !strip.texts.includes('q'));
  assert.ok(bottoms.length && bottoms.every((b) => b <= top), `strip stays above the keys (${bottoms})`);
});

test('profile and pack detail rows resolve their buttons and draw counts', () => {
  const sc = loadCanvas();
  const profile = { section: 'profile', items: [], detail: { username: 'bob', is_following: false, follower_count: 1200, post_count: 3 } };
  const [follow] = sc.detailButtons(profile);
  assert.deepEqual({ ...sc.resolveMainHit({ route: profile }, follow.x + 10, follow.y + 10) }, { action: 'follow' });
  assert.equal(sc.detailButtons({ ...profile, detail: { is_me: true } }).length, 0, 'no follow on your own profile');
  let rec = recordingCtx();
  sc.renderMainPanel(rec.ctx, { route: profile }, '');
  assert.ok(rec.texts.includes('FOLLOW'));
  assert.ok(rec.texts.includes('1.2K') && rec.texts.includes('FOLLOWERS'));

  const pack = { section: 'pack', items: [{}], related: [{ label: '@amy', path: '/profile/amy' }],
    detail: { likes: 2, saves: 0, liked_by_me: true, playable_count: 1 } };
  const btns = sc.detailButtons(pack);
  assert.deepEqual([...btns.map((b) => b.action)], ['play', 'pack-like', 'pack-save']);
  assert.deepEqual({ ...sc.resolveMainHit({ route: pack }, btns[0].x + 10, btns[0].y + 10) }, { action: 'play', arg: 0 });
  assert.deepEqual({ ...sc.resolveMainHit({ route: pack }, 100, 200) }, { action: 'chip', arg: '/profile/amy' });
  assert.equal(sc.resolveMainHit({ route: { ...pack, items: [] } }, btns[0].x + 10, btns[0].y + 10), null, 'empty pack: play disabled');
  rec = recordingCtx();
  sc.renderMainPanel(rec.ctx, { route: pack }, '');
  assert.ok(rec.texts.includes('♥ 2') && rec.texts.includes('☆ 0'));
});

test('profile: hero column with bio, tags and counts beside highlights over a narrower grid', () => {
  const sc = loadCanvas();
  const detail = { username: 'bob', display_name: 'Bob', bio: 'Shooting cities at night', created_at: '2025-03-02T00:00:00Z',
    top_tags: [{ name: 'Night', slug: 'night' }], follower_count: 10, following_count: 4, like_count: 2500, post_count: 3 };
  const profile = { section: 'profile', status: 'ready', detail, items: Array.from({ length: 7 }, (_, i) => ({ title: 't' + i })) };
  const plain = sc.gridLayout(profile);
  assert.equal(plain.cols, 3);
  assert.ok(plain.x > 568, 'grid sits right of the hero column');
  const withHl = { ...profile, highlights: [{ id: 'p 1', title: 'Tokyo', reel_count: 4 }] };
  const L = sc.gridLayout(withHl);
  assert.ok(L.y > plain.y, 'highlights push the grid down');
  const t = sc.tileRect(L, 0);
  assert.deepEqual({ ...sc.resolveMainHit({ route: withHl }, t.x + t.w / 2, t.y + t.h / 2) }, { action: 'play', arg: 0 });
  assert.deepEqual({ ...sc.resolveMainHit({ route: withHl }, plain.x + 20, 260) }, { action: 'chip', arg: '/packs/p%201' });
  const [follow] = sc.detailButtons(withHl);
  assert.ok(follow.x + follow.w <= plain.x, 'follow sits in the hero column');
  assert.deepEqual({ ...sc.resolveMainHit({ route: withHl }, follow.x + 10, follow.y + 10) }, { action: 'follow' });
  // Tag chips sit above the counts; find one by scanning the column.
  let tag = null;
  for (let y = 300; y < follow.y && !tag; y += 4) {
    const hit = sc.resolveMainHit({ route: withHl }, 100, y);
    if (hit && hit.action === 'chip') tag = hit;
  }
  assert.deepEqual({ ...tag }, { action: 'chip', arg: '/explore/tag/night' });
  const rec = recordingCtx();
  sc.renderMainPanel(rec.ctx, { route: withHl }, '');
  for (const text of ['Bob', '@bob', 'JOINED MAR 2025', 'Shooting cities at night', '#Night', '2.5K', 'LIKES', 'HIGHLIGHTED PACKS', 'Tokyo', '4']) {
    assert.ok(rec.texts.includes(text), text);
  }
});

test('inbox rows open threads, tabs switch boxes, share rows send', () => {
  const sc = loadCanvas();
  const conv = (id, extra) => ({ id, participant: { id: 'u' + id, username: 'amy' + id, display_name: 'Amy' }, ...extra });
  const items = Array.from({ length: 8 }, (_, i) => conv('c' + i, { last_message: { kind: 'text', text: 'hi', sender_id: 'uc' + i } }));
  items[0].unread_count = 3;
  const route = { section: 'messages', box: 'inbox', status: 'ready', items, scroll: 1 };
  const r0 = sc.listRowRect(0);
  assert.deepEqual({ ...sc.resolveMainHit({ route }, r0.x + 10, r0.y + 10) }, { action: 'chip', arg: '/messages/c1' });
  assert.deepEqual({ ...sc.resolveMainHit({ route }, 300, 200) }, { action: 'box', arg: 'inbox' });
  const last = sc.listRowRect(sc.LIST_ROWS - 1);
  assert.equal(sc.resolveMainHit({ route: { ...route, scroll: 3 } }, last.x + 10, last.y + 10), null, 'past the end');
  let rec = recordingCtx();
  sc.renderMainPanel(rec.ctx, { route: { ...route, scroll: 0 }, unreadBox: { inbox: 3, requests: 1 } }, '');
  assert.ok(rec.texts.includes('3 NEW'));
  assert.ok(rec.texts.includes('INBOX') && rec.texts.includes('3'));
  assert.ok(rec.texts.includes('hi'));

  const share = { section: 'share', status: 'ready', items: items.slice(0, 2), sent: { c1: 'sent' }, share: { kind: 'reel' } };
  assert.deepEqual({ ...sc.resolveMainHit({ route: share }, r0.x + 10, r0.y + 10) }, { action: 'share-to', arg: 0 });
  rec = recordingCtx();
  sc.renderMainPanel(rec.ctx, { route: share }, '');
  assert.ok(rec.texts.includes('SEND') && rec.texts.includes('SENT ✓'));
  assert.ok(rec.texts.includes('Send this reel to a chat'));
});

test('thread: bubbles, quick replies, compose and request buttons', () => {
  const sc = loadCanvas();
  const detail = { participant: { id: 'u2', username: 'bob' }, can_message: true };
  const route = { section: 'thread', status: 'ready', label: '@bob', detail,
    items: [{ id: 1, kind: 'text', text: 'yo', mine: false }, { id: 2, kind: 'reel', post: { title: 'Clip' }, mine: true }] };
  const q = sc.quickRect(0);
  assert.deepEqual({ ...sc.resolveMainHit({ route }, q.x + 5, q.y + 5) }, { action: 'quick-reply', arg: sc.QUICK_REPLIES[0] });
  const cb = sc.COMPOSE_BAR;
  assert.equal(sc.resolveMainHit({ route }, cb.x + 10, cb.y + 10).action, 'compose-focus');
  assert.equal(sc.resolveMainHit({ route }, sc.SEND_BTN.x + 10, sc.SEND_BTN.y + 10).action, 'compose-send');
  const closed = { ...route, detail: { ...detail, can_message: false } };
  assert.equal(sc.resolveMainHit({ route: closed }, cb.x + 10, cb.y + 10), null, 'no compose without can_message');
  let rec = recordingCtx();
  sc.renderMainPanel(rec.ctx, { route, field: { id: 'compose', focused: true, text: 'hel' } }, '');
  assert.ok(rec.texts.includes('yo') && rec.texts.includes('▶ Clip') && rec.texts.includes('hel'));

  const req = { ...route, detail: { ...detail, can_accept: true, can_decline: true, is_request: true } };
  const [accept, decline] = sc.detailButtons(req);
  assert.equal(sc.resolveMainHit({ route: req }, accept.x + 5, accept.y + 5).action, 'accept');
  assert.equal(sc.resolveMainHit({ route: req }, decline.x + 5, decline.y + 5).action, 'decline');
});

test('nav badge shows the unread count on messages', () => {
  const sc = loadCanvas();
  const rec = recordingCtx();
  sc.renderNavBar(rec.ctx, { open: true, unread: 120 }, '');
  assert.ok(rec.texts.includes('99+'));
});

test('wallet: balance, reward progress, ledger rows and BUY', () => {
  const sc = loadCanvas();
  const items = Array.from({ length: 8 }, (_, i) => ({
    source: 'reel_reward', delta_available: i ? 1 : -35, delta_reserved: 0, balance_available: 100 + i, created_at: '2026-10-30T01:00:00',
  }));
  items[1] = { type: 'reserve', delta_available: 0, delta_reserved: 20, balance_available: 90, created_at: '2026-10-29T01:00:00' };
  const route = {
    section: 'wallet', path: '/wallet', items, scroll: 0, status: 'ready',
    detail: { available_credits: 1234, reserved_credits: 20, lifetime_earned: 9, lifetime_spent: 35 },
  };
  const rec = recordingCtx();
  sc.renderMainPanel(rec.ctx, { route, rewards: { progress: 7, remaining: 3, capped: false } }, 'buy');
  for (const text of ['1,234', 'CREDITS', 'BUY CREDITS', 'REEL REWARD', '−35', '+1', '(reserved +20)', 'RESERVE', '2026-10-30']) {
    assert.ok(rec.texts.includes(text), text);
  }
  assert.ok(rec.texts.some((t) => t.includes('7/10 TO NEXT CREDIT')));
  const buy = sc.detailButtons(route)[0];
  assert.deepEqual({ ...sc.resolveMainHit({ route }, buy.x + 10, buy.y + 10) }, { action: 'buy' });
  assert.deepEqual({ ...sc.resolveMainHit({ route }, sc.MAIN_W - 96, 900) }, { action: 'scroll', arg: 1 });
  const row = sc.listRowRect(0);
  assert.equal(sc.resolveMainHit({ route }, row.x + 10, row.y + 10), null, 'ledger rows are read-only');
  const empty = recordingCtx();
  sc.renderMainPanel(empty.ctx, { route: { section: 'wallet', items: [], status: 'ready' } }, '');
  assert.ok(empty.texts.includes('NO CREDIT ACTIVITY YET'));
});
