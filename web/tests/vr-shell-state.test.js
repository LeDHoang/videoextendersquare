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
  assert.equal(s.handleHit({ action: 'nav', arg: 'back' }), true, 'back on a closed shell is a no-op');
  assert.equal(s.handleHit(null), false);
  assert.equal(s.handleHit({ action: 'nope' }), false);
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
  assert.equal(s.getRenderState().route.scroll, 3, 'ceil(23/5) - 2 rows');
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
});

test('profile loads the author grid and the user card in parallel', async () => {
  const calls = [];
  const s = loadShell().create({
    request: (path, query) => {
      calls.push([path, { ...query }]);
      return Promise.resolve(path === '/api/reels' ? { videos: [reel(1)] } : { user: { username: 'bo b', follower_count: 3 } });
    },
  });
  s.open('/profile/bo%20b');
  await tick();
  assert.deepEqual(calls, [['/api/reels', { author: 'bo b', sort: 'newest' }], ['/api/users/bo%20b', {}]]);
  const route = s.getRenderState().route;
  assert.equal(route.status, 'ready');
  assert.equal(route.detail.follower_count, 3);
  assert.equal(route.items.length, 1);
  assert.equal(route.label, '@bo b');
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
