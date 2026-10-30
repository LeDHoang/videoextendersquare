import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../ui/assets/reels.html', import.meta.url), 'utf-8');

function block(name) {
  const match = html.match(new RegExp(`// <${name}>[^\\n]*\\n([\\s\\S]*?)// </${name}>`));
  assert.ok(match, `${name} markers present`);
  return match[1];
}

function loadOpenInVrShell(WebXRVR) {
  const sandbox = { WebXRVR };
  vm.runInNewContext(block('vr-shell-nav') + '\nthis.openInVrShell = openInVrShell;', sandbox);
  return sandbox.openInVrShell;
}

test('while presenting, navigation opens the VR shell instead of leaving XR', () => {
  const opened = [];
  const open = loadOpenInVrShell({
    isPresenting: () => true,
    shell: { open: (p) => { opened.push(p); return true; } },
  });
  assert.equal(open('/explore'), true);
  assert.deepEqual([...opened], ['/explore']);
});

test('outside XR, or without the shell modules, navigation falls through to 2D', () => {
  assert.equal(loadOpenInVrShell({ isPresenting: () => false, shell: { open: () => true } })('/x'), false);
  assert.equal(loadOpenInVrShell({ isPresenting: () => true, shell: { open: () => false } })('/x'), false);
  assert.equal(loadOpenInVrShell({ isPresenting: () => true })('/x'), false);
  assert.equal(loadOpenInVrShell({ isPresenting: () => true, shell: { open() { throw new Error('boom'); } } })('/x'), false);
  assert.equal(loadOpenInVrShell(undefined)('/x'), false);
});

test('dispatchNavigation checks the shell before saving pack progress or exiting XR', () => {
  const body = html.slice(html.indexOf('async function dispatchNavigation(path) {'));
  const shellAt = body.indexOf('if (openInVrShell(path)) return;');
  assert.ok(shellAt > 0, 'intercept present');
  assert.ok(shellAt < body.indexOf('persistPackProgress'));
  assert.ok(shellAt < body.indexOf('leaveImmersiveModes()'));
});

test('the engine handoff callback navigates through dispatchNavigation', () => {
  assert.match(html, /onShellHandoff: function\(path\) \{ dispatchNavigation\(path\); \}/);
  assert.match(html, /new CustomEvent\('echo:vr-enter'\)/);
  assert.match(html, /new CustomEvent\('echo:vr-exit'\)/);
});

test('shell grids play through replaceFeedForVr, which keeps the original feed restorable', () => {
  assert.match(html, /onShellPlayFeed: replaceFeedForVr,/);
  assert.match(html, /shellRequest: function\(path\) \{/);
  const body = html.slice(html.indexOf('function replaceFeedForVr(feed) {'), html.indexOf('async function restoreAllLocations()'));
  assert.ok(body.indexOf('captureOriginalFeed()') < body.indexOf('videoData = items.slice()'));
  assert.match(body, /feedHasMore = false;/);
  assert.match(body, /activeLocationFeed = \{/);
});
