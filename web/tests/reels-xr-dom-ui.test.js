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

// Runs the real share/report actions from reels.html against a fake WebXRVR.
// `log` records the order of XR exit vs. DOM UI so tests can assert exit comes first.
function loadActions({ presenting, packMode = false, signedIn = true, promptAnswers = [] }) {
  const log = [];
  const engine = {
    presenting,
    exits: 0,
    isPresenting() { return this.presenting; },
    exitVR() { this.exits += 1; this.presenting = false; log.push('exitVR'); },
  };
  const answers = promptAnswers.slice();
  const window = {
    dispatchEvent(event) { log.push(event.type); },
    prompt(message) { log.push('prompt'); return answers.shift() ?? null; },
  };
  window.top = window;
  const context = {
    console,
    window,
    WebXRVR: engine,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    isPackMode: packMode,
    packState: { pack: packMode ? { id: 'pack-1', title: 'City pack' } : null },
    videoData: [{ post_id: 'post-1', title: 'Reel one' }],
    idx: 0,
    currentUser: signedIn ? { id: 'user-1' } : null,
    analyticsSource: 'feed',
    pauseCurrentPlayback() { log.push('pause'); },
    async persistPackProgress() { log.push('persist'); },
    recordPackEvent() {},
    requestJson(url) { log.push('request ' + url); return Promise.resolve({}); },
    eventId() { return 'event-1'; },
    recommendationImpressionId() { return null; },
    requestAuthentication(intent) { log.push('auth ' + intent.kind); },
    refreshAccountUI() {},
    showFlash(message) { log.push('flash ' + message); },
  };
  vm.runInNewContext(
    [block('reels-xr-dom-ui'), block('reels-share-reel'), block('reels-report')].join('\n'),
    context,
    { filename: 'reels.html' },
  );
  return { context, engine, log };
}

test('SHARE REEL leaves XR before opening the DOM share dialog in feed mode', async () => {
  const { context, engine, log } = loadActions({ presenting: true });
  await context.shareCurrentReel();
  assert.equal(engine.exits, 1);
  assert.ok(log.indexOf('exitVR') < log.indexOf('echo:share-reel'), log.join(', '));
});

test('SHARE REEL in pack mode still pauses and persists before leaving XR', async () => {
  const { context, engine, log } = loadActions({ presenting: true, packMode: true });
  await context.shareCurrentReel();
  assert.equal(engine.exits, 1);
  assert.deepEqual(log.slice(0, 3), ['pause', 'persist', 'exitVR']);
  assert.ok(log.indexOf('exitVR') < log.indexOf('echo:share-reel'));
});

test('SHARE PACK leaves XR before opening the DOM share dialog', async () => {
  const { context, engine, log } = loadActions({ presenting: true, packMode: true });
  await context.shareCurrentPack();
  assert.equal(engine.exits, 1);
  assert.ok(log.indexOf('exitVR') < log.indexOf('echo:share-pack'), log.join(', '));
});

test('REPORT leaves XR before window.prompt for a signed-in user in feed mode', async () => {
  const { context, engine, log } = loadActions({ presenting: true, promptAnswers: ['spam', ''] });
  await context.reportTarget('post', 'post-1');
  assert.equal(engine.exits, 1);
  assert.ok(log.indexOf('exitVR') < log.indexOf('prompt'), log.join(', '));
  assert.ok(log.includes('flash REPORT SUBMITTED'));
});

test('REPORT leaves XR in pack mode, signed in or not', async () => {
  const signedIn = loadActions({ presenting: true, packMode: true, promptAnswers: [null] });
  await signedIn.context.reportTarget('post', 'post-1');
  assert.equal(signedIn.engine.exits, 1);
  assert.ok(signedIn.log.indexOf('exitVR') < signedIn.log.indexOf('prompt'));

  const signedOut = loadActions({ presenting: true, packMode: true, signedIn: false });
  await signedOut.context.reportTarget('post', 'post-1');
  assert.equal(signedOut.engine.exits, 1);
  assert.ok(signedOut.log.indexOf('exitVR') < signedOut.log.indexOf('auth report'));
});

test('signed-out REPORT in feed mode leaves XR handling to requestAuthentication', async () => {
  const { context, engine, log } = loadActions({ presenting: true, signedIn: false });
  await context.reportTarget('post', 'post-1');
  assert.equal(engine.exits, 0);
  assert.deepEqual(log, ['auth report']);
});

test('share and report do not call exitVR when not presenting', async () => {
  for (const packMode of [false, true]) {
    const share = loadActions({ presenting: false, packMode });
    await share.context.shareCurrentReel();
    assert.equal(share.engine.exits, 0, `shareCurrentReel packMode=${packMode}`);
    assert.ok(share.log.includes('echo:share-reel'));

    const report = loadActions({ presenting: false, packMode, promptAnswers: ['spam', ''] });
    await report.context.reportTarget('post', 'post-1');
    assert.equal(report.engine.exits, 0, `reportTarget packMode=${packMode}`);
    assert.ok(report.log.includes('prompt'));
  }
  const pack = loadActions({ presenting: false, packMode: true });
  await pack.context.shareCurrentPack();
  assert.equal(pack.engine.exits, 0);
  assert.ok(pack.log.includes('echo:share-pack'));
});
