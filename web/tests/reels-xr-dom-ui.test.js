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
function loadActions({ presenting, packMode = false, signedIn = true, reportAnswers = [], holdExit = false }) {
  const log = [];
  const engine = {
    presenting,
    exits: 0,
    isPresenting() { return this.presenting; },
    // Like the real engine: the promise settles only once the session has
    // ended (log 'xr ended'); releaseExit() is that moment.
    releaseExit: null,
    exitVR() {
      this.exits += 1; this.presenting = false; log.push('exitVR');
      return new Promise((resolve) => {
        this.releaseExit = () => { log.push('xr ended'); resolve(); };
        if (!holdExit) this.releaseExit();
      });
    },
  };
  const answers = reportAnswers.slice();
  const window = {
    dispatchEvent(event) { log.push(event.type); },
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
    requests: [],
    requestJson(url, init) { log.push('request ' + url); context.requests.push({ url, init }); return Promise.resolve({}); },
    eventId() { return 'event-1'; },
    recommendationImpressionId() { return null; },
    requestAuthentication(intent) { log.push('auth ' + intent.kind); },
    refreshAccountUI() {},
    showFlash(message) { log.push('flash ' + message); },
    // Stands in for the vanilla <dialog> (needs a DOM); resolves { reason, details } or null.
    askReportDetails(targetType) { log.push('report-dialog'); return Promise.resolve(answers.shift() ?? null); },
  };
  vm.runInNewContext(
    [block('vr-shell-nav'), block('reels-xr-dom-ui'), block('reels-share-reel'), block('reels-report')].join('\n'),
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

test('REPORT leaves XR before the report dialog for a signed-in user in feed mode', async () => {
  const { context, engine, log } = loadActions({ presenting: true, reportAnswers: [{ reason: 'spam', details: '' }] });
  await context.reportTarget('post', 'post-1');
  assert.equal(engine.exits, 1);
  assert.ok(log.indexOf('exitVR') < log.indexOf('report-dialog'), log.join(', '));
  assert.ok(log.includes('flash REPORT SUBMITTED'));
});

test('REPORT leaves XR in pack mode, signed in or not', async () => {
  const signedIn = loadActions({ presenting: true, packMode: true, reportAnswers: [null] });
  await signedIn.context.reportTarget('post', 'post-1');
  assert.equal(signedIn.engine.exits, 1);
  assert.ok(signedIn.log.indexOf('exitVR') < signedIn.log.indexOf('report-dialog'));

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

    const report = loadActions({ presenting: false, packMode, reportAnswers: [{ reason: 'spam', details: '' }] });
    await report.context.reportTarget('post', 'post-1');
    assert.equal(report.engine.exits, 0, `reportTarget packMode=${packMode}`);
    assert.ok(report.log.includes('report-dialog'));
  }
  const pack = loadActions({ presenting: false, packMode: true });
  await pack.context.shareCurrentPack();
  assert.equal(pack.engine.exits, 0);
  assert.ok(pack.log.includes('echo:share-pack'));
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('SHARE REEL and SHARE PACK open the share dialog only after the XR session has ended', async () => {
  for (const [packMode, action, event] of [
    [false, 'shareCurrentReel', 'echo:share-reel'],
    [true, 'shareCurrentPack', 'echo:share-pack'],
  ]) {
    const { context, engine, log } = loadActions({ presenting: true, packMode, holdExit: true });
    const done = context[action]();
    await tick();
    assert.ok(log.includes('exitVR'), `${action} requested the exit`);
    assert.equal(log.includes(event), false, `${action} must not open the dialog while XR is still ending`);
    engine.releaseExit();
    await done;
    assert.ok(log.indexOf('xr ended') < log.indexOf(event), `${action}: ${log.join(', ')}`);
  }
});

test('REPORT opens the report dialog only after the XR session has ended', async () => {
  for (const packMode of [false, true]) {
    const { context, engine, log } = loadActions({ presenting: true, packMode, holdExit: true, reportAnswers: [{ reason: 'spam', details: '' }] });
    const done = context.reportTarget('post', 'post-1');
    await tick();
    assert.equal(log.includes('report-dialog'), false, `packMode=${packMode}: no report dialog while XR is still ending`);
    engine.releaseExit();
    await done;
    assert.ok(log.indexOf('xr ended') < log.indexOf('report-dialog'), log.join(', '));
  }
});

test('a failing exitVR does not block the DOM UI', async () => {
  const { context, engine, log } = loadActions({ presenting: true });
  engine.exitVR = () => Promise.reject(new Error('xr gone'));
  await context.shareCurrentReel();
  assert.ok(log.includes('echo:share-reel'));
});

test('reportTarget and its dialog never use a browser prompt', () => {
  for (const name of ['reels-report', 'reels-report-dialog']) {
    assert.doesNotMatch(block(name), /\b(?:window\.)?(?:prompt|alert|confirm)\s*\(/, `${name} must not call prompt/alert/confirm`);
  }
});

test('REPORT posts the reason and details chosen in the dialog, and nothing when dismissed', async () => {
  const sent = loadActions({ presenting: false, reportAnswers: [{ reason: 'harassment', details: 'rude' }] });
  await sent.context.reportTarget('comment', 'comment-1');
  assert.equal(sent.context.requests.length, 1);
  assert.equal(sent.context.requests[0].url, '/api/reports');
  assert.deepEqual(JSON.parse(sent.context.requests[0].init.body), {
    target_type: 'comment', target_id: 'comment-1', reason: 'harassment', details: 'rude',
  });
  assert.ok(sent.log.includes('flash REPORT SUBMITTED'));

  const dismissed = loadActions({ presenting: false, reportAnswers: [null] });
  await dismissed.context.reportTarget('post', 'post-1');
  assert.equal(dismissed.context.requests.length, 0);
});

test('the report <dialog> lists exactly the reasons the server accepts', () => {
  const dialog = html.match(/<dialog[^>]*id="reportDialog"[\s\S]*?<\/dialog>/);
  assert.ok(dialog, 'reportDialog markup present');
  const values = [...dialog[0].matchAll(/<option value="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, ['spam', 'harassment', 'hate', 'sexual', 'violence', 'impersonation', 'privacy', 'other']);
  assert.match(dialog[0], /<textarea[^>]*maxlength="500"/);
});

test('with the VR shell, share opens the in-VR sheet and stays in XR', async () => {
  for (const [packMode, fn, kind, id] of [[false, 'shareCurrentReel', 'reel', 'post-1'], [true, 'shareCurrentPack', 'pack', 'pack-1']]) {
    const { context, engine, log } = loadActions({ presenting: true, packMode });
    const shared = [];
    engine.shell = { share(opts) { shared.push(opts); return true; } };
    await context[fn]();
    assert.equal(engine.exits, 0, fn);
    assert.equal(shared.length, 1);
    assert.equal(shared[0].kind, kind);
    assert.equal(shared[0].target_id, id);
    assert.ok(!log.some((e) => e.startsWith('echo:share')), 'no DOM dialog');
  }
});
