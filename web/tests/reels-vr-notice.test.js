import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', '..', 'ui', 'assets', 'reels.html'), 'utf-8');

function block(name) {
  const match = html.match(new RegExp(`// <${name}>[^\\n]*\\n([\\s\\S]*?)// </${name}>`));
  assert.ok(match, `${name} markers present`);
  return match[1];
}

function fakeElement() {
  return { hidden: true, onclick: null, onkeydown: null, focused: false, focus() { this.focused = true; } };
}

// Runs the real <vr-pose-notice> block against a fake DOM and storage.
function loadNotice({ stored = null, storageThrows = false } = {}) {
  const elements = {
    vrNoticePanel: fakeElement(),
    vrNoticeBackdrop: fakeElement(),
    vrNoticeContinue: fakeElement(),
    vrNoticeCancel: fakeElement(),
  };
  const store = new Map(stored == null ? [] : [['echo_vr_pose_notice_v1', stored]]);
  const localStorage = {
    getItem(key) { if (storageThrows) throw new Error('blocked'); return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { if (storageThrows) throw new Error('blocked'); store.set(key, String(value)); },
  };
  const confirmCalls = [];
  const context = {
    window: { localStorage, confirm(message) { confirmCalls.push(message); return true; } },
    document: { getElementById: (id) => elements[id] || null },
  };
  vm.runInNewContext(
    `${block('vr-pose-notice')}\nthis.api = { vrPoseNoticeSeen, showVrPoseNotice };`,
    context,
    { filename: 'reels.html#vr-pose-notice' },
  );
  return { api: context.api, elements, store, confirmCalls };
}

test('notice shows once, and Continue calls enterVR inside its own click', () => {
  const { api, elements, store, confirmCalls } = loadNotice();
  assert.equal(api.vrPoseNoticeSeen(), false);

  let entered = 0;
  api.showVrPoseNotice(() => { entered += 1; });
  assert.equal(elements.vrNoticePanel.hidden, false);
  assert.equal(elements.vrNoticeBackdrop.hidden, false);
  assert.equal(elements.vrNoticeContinue.focused, true);
  assert.equal(entered, 0, 'opening the notice must not enter VR');

  // The click handler itself (synchronously) starts the session.
  elements.vrNoticeContinue.onclick();
  assert.equal(entered, 1);
  assert.equal(elements.vrNoticePanel.hidden, true);
  assert.equal(store.get('echo_vr_pose_notice_v1'), '1');
  assert.equal(api.vrPoseNoticeSeen(), true);
  assert.deepEqual(confirmCalls, [], 'never uses window.confirm');
});

test('Cancel, backdrop and Escape close the notice without entering or remembering', () => {
  for (const dismiss of ['cancel', 'backdrop', 'escape']) {
    const { api, elements, store } = loadNotice();
    let entered = 0;
    api.showVrPoseNotice(() => { entered += 1; });
    if (dismiss === 'cancel') elements.vrNoticeCancel.onclick();
    if (dismiss === 'backdrop') elements.vrNoticeBackdrop.onclick();
    if (dismiss === 'escape') {
      let stopped = false;
      elements.vrNoticePanel.onkeydown({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; } });
      assert.equal(stopped, true, 'Escape does not reach the player shortcuts');
    }
    assert.equal(entered, 0, `${dismiss} does not enter VR`);
    assert.equal(elements.vrNoticePanel.hidden, true, `${dismiss} hides the notice`);
    assert.equal(store.has('echo_vr_pose_notice_v1'), false, `${dismiss} is not remembered`);
    assert.equal(api.vrPoseNoticeSeen(), false);
  }
});

test('a previous dismissal is remembered; blocked storage still lets VR start', () => {
  assert.equal(loadNotice({ stored: '1' }).api.vrPoseNoticeSeen(), true);

  const blocked = loadNotice({ storageThrows: true });
  assert.equal(blocked.api.vrPoseNoticeSeen(), false);
  let entered = 0;
  blocked.api.showVrPoseNotice(() => { entered += 1; });
  assert.doesNotThrow(() => blocked.elements.vrNoticeContinue.onclick());
  assert.equal(entered, 1);
});

test('VR button gates enterVR on the notice and the copy says pose stays on-device', () => {
  const handler = html.match(/vrBtn\.addEventListener\('click', async function\(\) \{([\s\S]*?)\n {8}\}\);/);
  assert.ok(handler, 'VR button click handler present');
  assert.match(handler[1], /if \(!vrPoseNoticeSeen\(\)\) \{\s*showVrPoseNotice\(startImmersiveSession\);\s*return;\s*\}\s*startImmersiveSession\(\);/);
  assert.doesNotMatch(handler[1], /WebXRVR\.enterVR\(/, 'enterVR only runs through startImmersiveSession');
  assert.doesNotMatch(html, /window\.confirm\(|[^.\w]confirm\(/);

  // startImmersiveSession calls enterVR before any await (user activation).
  const start = html.match(/async function startImmersiveSession\(\) \{([\s\S]*?)\n {6}\}/);
  assert.ok(start, 'startImmersiveSession present');
  assert.match(start[1], /^\s*try \{\s*const session = await WebXRVR\.enterVR\(\);/);

  const text = html.match(/<p class="reels-vr-notice-text" id="vrNoticeText">([^<]*)<\/p>/);
  assert.ok(text, 'notice text present');
  assert.match(text[1], /head and hand position/);
  assert.match(text[1], /on your device only/);
  assert.match(text[1], /never sends it to a server or stores it/);
  assert.match(html, /id="vrNoticePanel" role="dialog" aria-modal="true"/);
});
