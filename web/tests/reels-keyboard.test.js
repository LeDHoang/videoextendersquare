import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (rel) => readFileSync(join(root, rel), 'utf-8');
const html = read('ui/assets/reels.html');

// The key filter is a pure function between two markers in reels.html, so the real code is tested.
function loadFilter() {
  const match = html.match(/\/\/ <reels-key-filter>[\s\S]*?\n([\s\S]*?)\/\/ <\/reels-key-filter>/);
  assert.ok(match, 'reels-key-filter markers present');
  const context = {};
  vm.createContext(context);
  vm.runInContext(match[1] + '\nthis.reelsKeyFilter = reelsKeyFilter;', context);
  return context.reelsKeyFilter;
}

// Minimal fake element: tagName, isContentEditable, role, and closest() over a selector list.
function el({ tag = 'DIV', editable = false, role = null, within = [] } = {}) {
  return {
    tagName: tag,
    isContentEditable: editable,
    getAttribute: (name) => (name === 'role' ? role : null),
    closest: (selector) => (within.some((part) => selector.includes(part)) ? {} : null),
  };
}
const key = (k, target, extra = {}) => ({ key: k, target, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

test('plain shortcut keys on the page are handled', () => {
  const filter = loadFilter();
  for (const k of ['w', 's', 'm', 'f', 'c', 'l', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ']) {
    assert.equal(filter(key(k, el({ tag: 'BODY' })), false), 'handle', k);
  }
});

test('typing contexts never trigger shortcuts (only Esc is considered, as "field")', () => {
  const filter = loadFilter();
  const targets = {
    input: el({ tag: 'INPUT' }),
    textarea: el({ tag: 'TEXTAREA' }), // the message dock composer
    select: el({ tag: 'SELECT' }),
    contenteditable: el({ editable: true }),
    textbox: el({ role: 'textbox' }),
  };
  for (const [name, target] of Object.entries(targets)) {
    for (const k of ['w', 'm', 'f', ' ', 'Escape']) {
      assert.equal(filter(key(k, target), false), 'field', name + ' ' + k);
    }
  }
});

test('modifier combos are left to the browser (Ctrl/Cmd+F, Cmd+L, Alt+Left...)', () => {
  const filter = loadFilter();
  const body = el({ tag: 'BODY' });
  assert.equal(filter(key('f', body, { ctrlKey: true }), false), 'skip');
  assert.equal(filter(key('l', body, { metaKey: true }), false), 'skip');
  assert.equal(filter(key('ArrowLeft', body, { altKey: true }), false), 'skip');
  assert.equal(filter(key('c', el({ tag: 'INPUT' }), { ctrlKey: true }), false), 'skip');
});

test('Space/Enter on a focused control activates that control, not play/pause', () => {
  const filter = loadFilter();
  assert.equal(filter(key(' ', el({ tag: 'BUTTON', within: ['button'] })), false), 'skip');
  assert.equal(filter(key('Enter', el({ tag: 'A', within: ['a,'] })), false), 'skip');
  assert.equal(filter(key(' ', el({ tag: 'DIV', role: 'tab', within: ['[role="tab"]'] })), false), 'skip');
  assert.equal(filter(key(' ', el({ tag: 'DIV', role: 'slider', within: ['[role="slider"]'] })), false), 'skip');
  // other keys on a focused button still drive the player
  assert.equal(filter(key('w', el({ tag: 'BUTTON', within: ['button'] })), false), 'handle');
});

test('an already-handled event is skipped (e.g. the scrubber consumed an arrow key)', () => {
  const filter = loadFilter();
  assert.equal(filter(key('ArrowRight', el({ tag: 'BODY' }), { defaultPrevented: true }), false), 'skip');
  assert.equal(filter(null, false), 'skip');
});

test('shortcuts pause while a modal dialog outside the player is open', () => {
  const filter = loadFilter();
  assert.equal(filter(key('s', el({ tag: 'BODY' })), true), 'skip');
  assert.equal(filter(key('s', el({ tag: 'BODY' })), false), 'handle');
});

test('the SPA actually attaches the handler (regression: it used to be assigned but never attached)', () => {
  assert.match(html, /window\.__sxReelsKeydown = onKeydown;\s*\n\s*window\.addEventListener\('keydown', onKeydown\);/);
  assert.match(html, /window\.removeEventListener\('keydown', onKeydown\);/);
  const py = read('server/routers/reels.py');
  assert.doesNotMatch(py, /window\.__sxReelsKeydown = \(e\) => \{/, 'reels.py must not rewrite the listener into a bare assignment');
  assert.match(py, /window\.removeEventListener\('keydown', window\.__sxReelsKeydown\)/, 'SPA teardown still detaches it');
});

test('Esc inside a text field only acts for fields that belong to the player', () => {
  const body = html.slice(html.indexOf('function onKeydown(e)'), html.indexOf('window.__sxReelsKeydown = onKeydown'));
  assert.match(body, /e\.key === 'Escape' && keyHost\.contains\(e\.target\)/);
  assert.match(body, /\[role="dialog"\]\[aria-modal="true"\]/);
});
