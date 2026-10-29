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
