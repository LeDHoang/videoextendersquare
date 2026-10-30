import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../ui/assets/vr_shell.js', import.meta.url), 'utf8');

function loadShell() {
  const window = {};
  vm.runInNewContext(source, { window });
  return window.VRShell;
}

test('parseRoute maps site paths to shell sections', () => {
  const { parseRoute } = loadShell();
  const section = (p) => parseRoute(p).section;
  assert.equal(section('/'), 'reels');
  assert.equal(section('/reels/'), 'reels');
  assert.equal(section('/explore'), 'explore');
  assert.deepEqual({ ...parseRoute('/explore?q=new+york%21') }, { path: '/explore?q=new+york%21', section: 'search', arg: 'new york!' });
  assert.equal(parseRoute('/explore/tag/sunset').arg, 'sunset');
  assert.equal(section('/explore/location/paris-fr'), 'location');
  assert.equal(parseRoute('/profile/al%20ice').arg, 'al ice');
  assert.equal(section('/packs/abc'), 'pack');
  assert.equal(section('/messages'), 'messages');
  assert.equal(section('/messages/42'), 'thread');
  assert.equal(section('/wallet'), 'wallet');
});

test('parseRoute sends forms, auth and unknown paths to the 2D handoff', () => {
  const { parseRoute } = loadShell();
  for (const p of ['/login?next=%2Freels', '/signup', '/upload', '/settings', '/settings/privacy',
    '/packs/new', '/packs/abc/edit', '/support', '/terms', '/no-such-page', 'https://evil.test/', '//evil.test']) {
    assert.equal(parseRoute(p).section, 'handoff', p);
  }
});

test('open pushes a back stack; back pops it and closes at the root', () => {
  const s = loadShell().create({});
  s.open('/explore');
  s.open('/explore/tag/a');
  s.open('/explore/tag/a'); // same route twice is not a new entry
  assert.equal(s.getRenderState().depth, 2);
  assert.equal(s.getRenderState().tab, 'explore');
  s.back();
  assert.equal(s.section(), 'explore');
  s.back();
  assert.equal(s.isOpen(), false);
});

test('opening /reels closes the shell', () => {
  const s = loadShell().create({});
  s.open('/profile/bob');
  s.open('/reels');
  assert.equal(s.isOpen(), false);
});

test('handoff card: cancel returns to the section, confirm exits to the 2D path', () => {
  const exits = [];
  const s = loadShell().create({ exitAndNavigate: (p) => exits.push(p) });
  s.open('/explore');
  s.open('/upload');
  assert.equal(s.section(), 'handoff');
  assert.equal(s.getRenderState().handoff.path, '/upload');
  assert.equal(s.getRenderState().tab, '');
  s.handleHit({ action: 'handoff-cancel' });
  assert.equal(s.section(), 'explore');

  s.open('/settings');
  assert.equal(s.handleHit({ action: 'handoff-confirm' }), true);
  assert.deepEqual(exits, ['/settings']);
  assert.equal(s.isOpen(), false);
});

test('a handoff with no section underneath closes on cancel', () => {
  const s = loadShell().create({});
  s.showHandoff('/login', 'SIGN IN ON 2D', 'msg');
  assert.equal(s.getRenderState().handoff.title, 'SIGN IN ON 2D');
  s.handleHit({ action: 'handoff-cancel' });
  assert.equal(s.isOpen(), false);
});

test('nav hits route to sections; profile needs a signed-in user', () => {
  let user = null;
  const s = loadShell().create({ getUser: () => user });
  s.handleHit({ action: 'nav', arg: 'profile' });
  assert.equal(s.getRenderState().handoff.path, '/login');
  user = { username: 'zoë' };
  s.handleHit({ action: 'nav', arg: 'profile' });
  assert.equal(s.getRenderState().route.path, '/profile/zo%C3%AB');
  s.handleHit({ action: 'nav', arg: 'wallet' });
  assert.equal(s.getRenderState().tab, 'wallet');
  s.handleHit({ action: 'nav', arg: 'reels' });
  assert.equal(s.isOpen(), false);
  assert.equal(s.handleHit({ action: 'nav', arg: 'back' }), false, 'no back tab');
  assert.equal(s.handleHit(null), false);
  assert.equal(s.handleHit({ action: 'nope' }), false);
});

test('REELS and EARTH nav tabs close the shell and switch the scene', () => {
  const calls = [];
  let scene = 'reels';
  let packs = false;
  const s = loadShell().create({
    getScene: () => scene,
    setScene: (mode, wasOpen) => { calls.push([mode, wasOpen]); scene = mode; },
    earthAvailable: () => !packs,
  });
  s.handleHit({ action: 'nav', arg: 'explore' });
  s.handleHit({ action: 'nav', arg: 'earth' });
  assert.equal(s.isOpen(), false);
  assert.equal(s.getRenderState().scene, 'earth');
  s.handleHit({ action: 'nav', arg: 'reels' });
  assert.deepEqual(calls, [['earth', true], ['reels', false]]);
  assert.equal(s.getRenderState().earthOff, false);
  packs = true;
  assert.equal(s.getRenderState().earthOff, true);
});

test('every state change bumps the version and notifies listeners', () => {
  const s = loadShell().create({});
  const seen = [];
  const off = s.onDirty((v) => seen.push(v));
  s.open('/explore');
  s.close();
  off();
  s.open('/wallet');
  assert.deepEqual(seen, [1, 2]);
  assert.equal(s.version, 3);
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const reel = (n) => ({ post_id: 'p' + n, title: 't' + n });

test('grid sections load from the API and drop stale replies', async () => {
  const calls = [];
  const replies = {};
  const s = loadShell().create({
    request: (path, query) => { calls.push([path, { ...query }]); return replies[path]; },
  });
  replies['/api/reels/tags/sun%20set'] = Promise.resolve({
    videos: [reel(1)], related_tags: [{ name: 'Beach', slug: 'beach' }, { name: 'no slug' }],
  });
  s.open('/explore/tag/sun%20set');
  assert.equal(s.getRenderState().route.status, 'loading');
  await tick();
  const route = s.getRenderState().route;
  assert.equal(route.status, 'ready');
  assert.equal(route.label, '#sun set');
  assert.deepEqual([...route.related.map((c) => c.path)], ['/explore/tag/beach']);

  replies['/api/reels'] = Promise.reject(new Error('x'));
  s.open('/explore?q=cats');
  await tick();
  assert.deepEqual(calls[1], ['/api/reels', { search: 'cats', sort: 'shuffle' }]);
  assert.equal(s.getRenderState().route.status, 'error');

  let resolveLate;
  replies['/api/reels/locations/paris'] = new Promise((r) => { resolveLate = r; });
  s.open('/explore/location/paris');
  s.back();
  const v = s.version;
  resolveLate({ videos: [reel(1)] });
  await tick();
  assert.equal(s.version, v, 'reply for a popped route does not redraw');
});

test('scroll is clamped to the grid rows', async () => {
  const s = loadShell().create({ request: () => Promise.resolve({ videos: Array.from({ length: 23 }, (_, i) => reel(i)) }) });
  s.open('/explore');
  await tick();
  assert.equal(s.scroll(-1), false);
  assert.equal(s.scroll(1), true);
  s.scroll(10);
  assert.equal(s.getRenderState().route.scroll, 4, 'ceil(23/4) - 2 rows');
});

test('search field: focus, type, backspace, enter opens the search route', () => {
  const s = loadShell().create({});
  s.open('/explore');
  assert.equal(s.type('a'), false, 'typing needs focus');
  s.handleHit({ action: 'search-focus' });
  assert.equal(s.getRenderState().field.focused, true);
  for (const k of ['c', 'a', 't', 'x', 'backspace', 'space', 's']) s.handleHit({ action: 'key', arg: k });
  assert.equal(s.getRenderState().field.text, 'cat s');
  s.handleHit({ action: 'key', arg: 'enter' });
  assert.equal(s.getRenderState().route.path, '/explore?q=cat%20s');
  assert.equal(s.getRenderState().field.focused, false);
  s.focusField(true);
  assert.equal(s.getRenderState().field.text, 'cat s', 'search route seeds the field');
  s.type('close');
  assert.equal(s.getRenderState().field.focused, false);
});

test('keystrokes bump the version but not the content version', () => {
  const s = loadShell().create({});
  s.open('/explore');
  s.focusField(true);
  const focused = s.getRenderState();
  assert.equal(focused.contentVersion, focused.version, 'focus is a content change');
  for (const k of ['c', 'shift', 'layout:symbols', 'backspace', 'space']) s.type(k);
  let st = s.getRenderState();
  assert.equal(st.version, focused.version + 5);
  assert.equal(st.contentVersion, focused.contentVersion, 'field-only changes');
  s.type('close');
  st = s.getRenderState();
  assert.equal(st.contentVersion, st.version, 'closing the keyboard repaints the panels');
});

test('play hands the grid to the player and closes the shell', async () => {
  const played = [];
  const s = loadShell().create({
    request: () => Promise.resolve({ videos: [reel(1), reel(2)], location: { name: 'Paris' } }),
    playFeed: (f) => played.push(f),
  });
  s.open('/explore/location/paris');
  await tick();
  assert.equal(s.handleHit({ action: 'play', arg: 5 }), false);
  assert.equal(s.handleHit({ action: 'play', arg: 1 }), true);
  assert.equal(played[0].startIndex, 1);
  assert.equal(played[0].label, 'Paris');
  assert.equal(played[0].videoData.length, 2);
  assert.equal(s.isOpen(), false);
});

test('grid constants match the canvas module', () => {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('../../ui/assets/vr_shell_canvas.js', import.meta.url), 'utf8'), { window });
  assert.equal(loadShell().GRID_COLS, window.VRShellCanvas.GRID_COLS);
  assert.equal(loadShell().GRID_ROWS, window.VRShellCanvas.GRID_ROWS);
  assert.equal(loadShell().PROFILE_COLS, window.VRShellCanvas.gridLayout({ section: 'profile' }).cols);
});

test('profile loads the author grid, user card and highlights in parallel', async () => {
  const calls = [];
  const s = loadShell().create({
    request: (path, query) => {
      calls.push([path, { ...query }]);
      if (path === '/api/reels') return Promise.resolve({ videos: Array.from({ length: 10 }, (_, i) => reel(i)) });
      if (path.endsWith('/packs')) return Promise.resolve({ items: [{ id: 'a', status: 'published' }, { id: 'b', status: 'draft' }] });
      return Promise.resolve({ user: { username: 'bo b', follower_count: 3 } });
    },
  });
  s.open('/profile/bo%20b');
  await tick();
  assert.deepEqual(calls, [['/api/reels', { author: 'bo b', sort: 'newest' }], ['/api/users/bo%20b', {}],
    ['/api/users/bo%20b/packs', {}]]);
  const route = s.getRenderState().route;
  assert.equal(route.status, 'ready');
  assert.equal(route.detail.follower_count, 3);
  assert.equal(route.items.length, 10);
  assert.deepEqual([...route.highlights.map((p) => p.id)], ['a'], 'published packs only');
  assert.equal(route.label, '@bo b');
  s.scroll(10);
  assert.equal(s.getRenderState().route.scroll, 2, 'ceil(10/3) - 2 rows');
});

test('a failed highlights fetch leaves the profile loaded', async () => {
  const s = loadShell().create({
    request: (path) => (path.endsWith('/packs') ? Promise.reject(new Error('nope'))
      : Promise.resolve(path === '/api/reels' ? { videos: [reel(1)] } : { user: { username: 'bob' } })),
  });
  s.open('/profile/bob');
  await tick();
  const route = s.getRenderState().route;
  assert.equal(route.status, 'ready');
  assert.deepEqual([...route.highlights], []);
});

test('pack loads available items as the play queue and links the creator', async () => {
  const played = [];
  const s = loadShell().create({
    request: () => Promise.resolve({ pack: {
      id: 'pk', title: 'Trip', creator: { username: 'amy' },
      items: [{ available: true, post: reel(1) }, { available: false, post: null }, { available: true, post: reel(2) }],
    } }),
    playFeed: (f) => played.push(f),
  });
  s.open('/packs/pk');
  await tick();
  const route = s.getRenderState().route;
  assert.equal(route.label, 'Trip');
  assert.deepEqual([...route.related.map((c) => c.path)], ['/profile/amy']);
  s.handleHit({ action: 'play', arg: 0 });
  assert.deepEqual([...played[0].videoData.map((v) => v.post_id)], ['p1', 'p2']);
  assert.equal(played[0].label, 'Trip');
});

async function openProfile(send, user) {
  const s = loadShell().create({
    getUser: () => (user === undefined ? { username: 'me' } : user),
    send,
    request: (path) => Promise.resolve(path === '/api/reels' ? { videos: [] }
      : { user: { username: 'bob', is_following: false, follower_count: 5 } }),
  });
  s.open('/profile/bob');
  await tick();
  return s;
}

test('follow is optimistic and settles on the server count', async () => {
  const sent = [];
  let finish;
  const s = await openProfile((m, p) => { sent.push([m, p]); return new Promise((r) => { finish = r; }); });
  assert.equal(s.handleHit({ action: 'follow' }), true);
  let det = s.getRenderState().route.detail;
  assert.equal(det.is_following, true);
  assert.equal(det.follower_count, 6);
  assert.equal(s.handleHit({ action: 'follow' }), false, 'second tap ignored while pending');
  await tick();
  finish({ following: true, follower_count: 9 });
  await tick(); await tick();
  det = s.getRenderState().route.detail;
  assert.equal(det.follower_count, 9);
  s.handleHit({ action: 'follow' });
  await tick();
  assert.deepEqual(sent, [['PUT', '/api/users/bob/follow'], ['DELETE', '/api/users/bob/follow']]);
  assert.equal(s.getRenderState().route.detail.is_following, false);
});

test('a failed follow rolls back; signed-out viewers get the sign-in card', async () => {
  const s = await openProfile(() => Promise.reject(new Error('403')));
  s.handleHit({ action: 'follow' });
  await tick(); await tick();
  const det = s.getRenderState().route.detail;
  assert.equal(det.is_following, false);
  assert.equal(det.follower_count, 5);

  const out = await openProfile(() => Promise.resolve({}), null);
  out.handleHit({ action: 'follow' });
  assert.equal(out.getRenderState().handoff.path, '/login');
});

test('pack like and save toggle their own flags', async () => {
  const sent = [];
  const s = loadShell().create({
    getUser: () => ({ username: 'me' }),
    send: (m, p) => { sent.push([m, p]); return Promise.resolve(p.endsWith('/like') ? { likes: 1 } : { saves: 1 }); },
    request: () => Promise.resolve({ pack: { id: 'pk', items: [], likes: 0, saves: 0, liked_by_me: false, saved_by_me: false } }),
  });
  s.open('/packs/pk');
  await tick();
  s.handleHit({ action: 'pack-like' });
  s.handleHit({ action: 'pack-save' });
  await tick(); await tick();
  const det = s.getRenderState().route.detail;
  assert.equal(det.liked_by_me && det.saved_by_me, true);
  assert.deepEqual(sent, [['PUT', '/api/packs/pk/like'], ['PUT', '/api/packs/pk/save']]);
});

const CONVS = [
  { id: 'c1', can_message: true, unread_count: 2, participant: { id: 'u-amy', username: 'amy' } },
  { id: 'c2', can_message: false, participant: { id: 'u-bob', username: 'bob' } },
];

function messagingShell(send, user = { username: 'me' }) {
  const asked = [];
  const s = loadShell().create({
    getUser: () => user,
    send,
    request: (path, query) => {
      asked.push([path, { ...query }]);
      if (path === '/api/messages/unread-count') return Promise.resolve({ unread_count: 3, inbox: 2, requests: 1 });
      if (path.endsWith('/messages')) {
        return Promise.resolve({
          conversation: { id: 'c1', can_message: true, can_accept: true, can_decline: true, participant: { id: 'u-amy', username: 'amy' } },
          messages: [{ id: 1, sender_id: 'u-amy', kind: 'text', text: 'hi' }, { id: 2, sender_id: 'u-me', kind: 'text', text: 'yo' }],
        });
      }
      return Promise.resolve({ conversations: CONVS });
    },
  });
  return { s, asked };
}

test('messages: inbox loads, box tab reloads requests, unread counts reach the nav', async () => {
  const { s, asked } = messagingShell(() => Promise.resolve({}));
  s.open('/messages');
  await tick();
  assert.equal(s.getRenderState().route.items.length, 2);
  s.refreshUnread();
  await tick(); await tick();
  assert.equal(s.getRenderState().unread, 3);
  assert.deepEqual({ ...s.getRenderState().unreadBox }, { inbox: 2, requests: 1 });
  assert.equal(s.handleHit({ action: 'box', arg: 'requests' }), true);
  await tick();
  assert.deepEqual(asked.filter((a) => a[0] === '/api/messages/conversations').map((a) => a[1].box), ['inbox', 'requests']);
});

test('messages need a signed-in user', () => {
  const { s } = messagingShell(() => Promise.resolve({}), null);
  s.open('/messages/c1');
  assert.equal(s.getRenderState().handoff.path, '/login');
});

test('thread: loads, marks read, scrolls to the newest message', async () => {
  const sent = [];
  const { s } = messagingShell((m, p, b) => { sent.push([m, p, b]); return Promise.resolve({}); });
  s.open('/messages/c1');
  await tick(); await tick();
  const route = s.getRenderState().route;
  assert.deepEqual(route.items.map((m) => m.mine), [false, true]);
  assert.equal(route.label, '@amy');
  assert.deepEqual(sent[0].slice(0, 2), ['POST', '/api/messages/conversations/c1/read']);
});

test('compose: typed text sends optimistically and settles on the server message', async () => {
  const sent = [];
  let finish;
  const { s } = messagingShell((m, p, b) => {
    sent.push([m, p, b]);
    return p.endsWith('/messages') ? new Promise((r) => { finish = r; }) : Promise.resolve({});
  });
  s.open('/messages/c1');
  await tick(); await tick();
  assert.equal(s.handleHit({ action: 'compose-focus' }), true);
  for (const k of ['shift', 'h', 'i', 'space', 'layout:emoji', '👋']) s.type(k);
  assert.equal(s.getRenderState().field.text, 'Hi 👋');
  assert.equal(s.getRenderState().field.layout, 'emoji');
  s.type('enter');
  let items = s.getRenderState().route.items;
  assert.equal(items[2].text, 'Hi 👋');
  assert.equal(items[2].pending, true);
  assert.equal(s.getRenderState().field.text, '', 'field clears, stays focused');
  assert.equal(s.getRenderState().field.focused, true);
  await tick();
  const post = sent.find((x) => x[1].endsWith('/messages'));
  assert.equal(post[2].kind, 'text');
  assert.equal(post[2].text, 'Hi 👋');
  assert.ok(post[2].client_id.length >= 8 && post[2].client_id.length <= 64);
  finish({ message: { id: 9, kind: 'text', text: 'Hi 👋' } });
  await tick(); await tick();
  items = s.getRenderState().route.items;
  assert.equal(items[2].id, 9);
  assert.equal(items[2].mine, true);
});

test('a failed send marks the bubble; quick replies send directly', async () => {
  const { s } = messagingShell((m, p) => (p.endsWith('/messages') ? Promise.reject(new Error('x')) : Promise.resolve({})));
  s.open('/messages/c1');
  await tick(); await tick();
  assert.equal(s.handleHit({ action: 'quick-reply', arg: 'Nice!' }), true);
  await tick(); await tick();
  const last = s.getRenderState().route.items.at(-1);
  assert.equal(last.text, 'Nice!');
  assert.equal(last.failed, true);
  assert.equal(last.pending, false);
});

test('accept reloads the thread; decline leaves it', async () => {
  const sent = [];
  const { s } = messagingShell((m, p) => { sent.push(p); return Promise.resolve({}); });
  s.open('/messages');
  s.open('/messages/c1');
  await tick(); await tick();
  s.handleHit({ action: 'accept' });
  await tick(); await tick();
  assert.ok(sent.includes('/api/messages/conversations/c1/accept'));
  assert.equal(s.section(), 'thread');
  await tick();
  s.handleHit({ action: 'decline' });
  await tick(); await tick();
  assert.ok(sent.includes('/api/messages/conversations/c1/decline'));
  assert.equal(s.section(), 'messages');
});

test('share sheet lists chats you can message and sends to one', async () => {
  const sent = [];
  const { s } = messagingShell((m, p, b) => { sent.push([p, b]); return Promise.resolve({ succeeded: 1 }); });
  assert.equal(s.share({ kind: 'reel', target_id: 'post-1', title: 'Clip' }).section, 'share');
  await tick();
  const route = s.getRenderState().route;
  assert.deepEqual(route.items.map((c) => c.id), ['c1']);
  assert.equal(route.label, 'Clip');
  assert.equal(s.handleHit({ action: 'share-to', arg: 0 }), true);
  assert.equal(s.getRenderState().route.sent.c1, 'sending');
  assert.equal(s.handleHit({ action: 'share-to', arg: 0 }), false, 'no double send');
  await tick(); await tick();
  assert.equal(s.getRenderState().route.sent.c1, 'sent');
  assert.equal(sent[0][0], '/api/messages/share-content');
  assert.equal(sent[0][1].kind, 'reel');
  assert.equal(sent[0][1].target_id, 'post-1');
  assert.deepEqual([...sent[0][1].usernames], ['amy']);
  assert.equal(s.share({ kind: 'nope', target_id: 'x' }), null);
});

function walletShell(user = { username: 'me' }) {
  const asked = [];
  const s = loadShell().create({
    getUser: () => user,
    exitAndNavigate: (p) => asked.push(['exit', p]),
    request: (path, query) => {
      asked.push([path, { ...query }]);
      if (path === '/api/billing/wallet') return Promise.resolve({ available_credits: 42 });
      return Promise.resolve({ transactions: [{ id: 't1', delta_available: 1 }, { id: 't2', delta_available: -5 }] });
    },
  });
  return { s, asked };
}

test('wallet: loads balance and ledger; BUY hands off to the 2D wallet', async () => {
  const { s, asked } = walletShell();
  s.open('/wallet');
  await tick(); await tick();
  const route = s.getRenderState().route;
  assert.equal(route.detail.available_credits, 42);
  assert.deepEqual(route.items.map((e) => e.id), ['t1', 't2']);
  assert.ok(asked.some(([p, q]) => p === '/api/billing/transactions' && q.limit === 50));
  assert.equal(s.getRenderState().tab, 'wallet');
  assert.equal(s.handleHit({ action: 'buy' }), true);
  assert.equal(s.getRenderState().handoff.path, '/wallet');
  s.handleHit({ action: 'handoff-cancel' });
  assert.equal(s.section(), 'wallet');
  s.handleHit({ action: 'buy' });
  s.handleHit({ action: 'handoff-confirm' });
  assert.deepEqual(asked[asked.length - 1], ['exit', '/wallet']);
  assert.equal(s.isOpen(), false);
});

test('wallet needs a signed-in user', () => {
  const { s, asked } = walletShell(null);
  s.open('/wallet');
  assert.equal(s.getRenderState().handoff.path, '/login');
  assert.equal(asked.length, 0);
});

test('noteReward keeps the progress line and reloads an open wallet on an award', async () => {
  const { s, asked } = walletShell();
  s.noteReward({ progress: 3, remaining: 7 });
  assert.deepEqual({ ...s.getRenderState().rewards }, { progress: 3, remaining: 7, capped: false });
  s.open('/wallet');
  await tick(); await tick();
  const before = asked.length;
  s.noteReward({ progress: 0, remaining: 10, credit_awarded: true, daily_cap_reached: true });
  assert.equal(s.getRenderState().rewards.capped, true);
  await tick(); await tick();
  assert.equal(asked.length, before + 2, 'balance and ledger reloaded');
  s.noteReward(null);
  assert.equal(s.getRenderState().rewards.capped, true);
});

test('drag scroll: small moves stay clicks, drags step and fling decays to rest', () => {
  const drag = loadShell().createDragScroll();
  drag.begin(500, 0);
  assert.equal(drag.move(492, 10), 0);
  assert.equal(drag.moved(), false);
  assert.equal(drag.end(20), false);

  drag.begin(500, 0);
  assert.equal(drag.move(400, 50), 0); // past the threshold, under one step
  assert.equal(drag.move(340, 80), 1); // dragging up scrolls down
  assert.equal(drag.end(90), true);
  let flung = 0;
  for (let t = 100; t < 3000; t += 16) flung += drag.tick(t);
  assert.ok(flung > 0, 'fling keeps scrolling');
  assert.equal(drag.tick(4000), 0, 'fling comes to rest');

  drag.begin(500, 0);
  drag.move(300, 20);
  drag.stop();
  assert.equal(drag.moved(), false);
  assert.equal(drag.active(), false);
  assert.equal(drag.tick(100), 0);
});

test('drag scroll: a pause before release cancels the fling', () => {
  const drag = loadShell().createDragScroll();
  drag.begin(500, 0);
  drag.move(200, 30);
  assert.equal(drag.end(400), true);
  assert.equal(drag.tick(416), 0);
});
