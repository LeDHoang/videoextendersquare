// Rerun of the VR reels probe against unreleased player code, served to the
// Quest tab over CDP. Production stays as it is: the Fetch domain rewrites
// /api/reels/player-inline (the inline player script gets the hunks of
// REELS_DIFF) and answers /player-script/webxr_vr.js with WEBXR_JS. With
// R2K_FILE set, the first feed item whose url contains R2K_MATCH gains a
// vr2k_url that this driver serves from R2K_FILE (ranged, CORS-open), and is
// moved to the front of the feed.
//
// Usage: node verify.mjs <out.json>
// Env: REELS_DIFF, WEBXR_JS, AB_QUERY (extra query, e.g. vrtexcap=3840),
//      STEPS (reel switches, default 10), DWELL (s per reel, default 12),
//      R2K_FILE, R2K_MATCH, NO_OVERRIDE=1 (control pass on production code).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hunks, applyToPlayerInline } from './hunks.mjs';

const out = process.argv[2];
const STEPS = Number(process.env.STEPS || 10), DWELL = Number(process.env.DWELL || 12) * 1000;
const QUERY = process.env.AB_QUERY || '';
const R2K_FILE = process.env.R2K_FILE, R2K_MATCH = process.env.R2K_MATCH || '';
const R2K_URL = 'https://media.echomultiverse.com/uploads/__vr2ktest-2k.mp4';
const NO_OVERRIDE = process.env.NO_OVERRIDE === '1'; // control pass: production code as served
const HS = NO_OVERRIDE ? [] : hunks(process.env.REELS_DIFF);
const WEBXR = NO_OVERRIDE ? null : fs.readFileSync(process.env.WEBXR_JS);
const R2K = R2K_FILE ? fs.readFileSync(R2K_FILE) : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lmark = s => { try { execFileSync('adb', ['shell', 'log', '-t', 'ABMARK', s.replace(/[^\w .:=/-]/g, '_')]); } catch (e) { } };

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = list.find(x => x.type === 'page' && /echomultiverse/.test(x.url));
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let nextId = 1; const pending = new Map();
const send = (method, params = {}) => new Promise(res => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const log = { startedWall: Date.now(), query: QUERY, override: {}, marks: [], samples: [], diag: [], net: {}, console: [] };
const b64 = s => Buffer.from(s).toString('base64');

async function onPaused(p) {
  const u = p.request.url;
  if (/\/player-script\/webxr_vr\.js/.test(u)) {
    log.override.webxr = (log.override.webxr || 0) + 1;
    return send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, body: WEBXR.toString('base64'),
      responseHeaders: [{ name: 'Content-Type', value: 'text/javascript; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }] });
  }
  if (u.startsWith(R2K_URL) && R2K) {
    const h = Object.fromEntries(Object.entries(p.request.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const m = /bytes=(\d+)-(\d*)/.exec(h.range || '');
    const a = m ? Number(m[1]) : 0, z = m && m[2] ? Math.min(Number(m[2]), R2K.length - 1) : R2K.length - 1;
    log.override.r2k = (log.override.r2k || []).concat([[a, z]]);
    return send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: m ? 206 : 200, body: R2K.subarray(a, z + 1).toString('base64'),
      responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Accept-Ranges', value: 'bytes' }, { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Content-Length', value: String(z - a + 1) }, ...(m ? [{ name: 'Content-Range', value: `bytes ${a}-${z}/${R2K.length}` }] : [])] });
  }
  if (/\/api\/reels\/player-inline/.test(u) && p.responseStatusCode) {
    const r = await send('Fetch.getResponseBody', { requestId: p.requestId });
    const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
    let j; try { j = JSON.parse(body); } catch (e) { log.override.inlineError = String(e); return send('Fetch.continueRequest', { requestId: p.requestId }); }
    const rep = applyToPlayerInline(j, HS);
    if (R2K) rep.push(injectR2k(j));
    (log.override.inline = log.override.inline || []).push({ url: u.slice(0, 160), hunks: rep });
    return send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, body: b64(JSON.stringify(j)),
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }] });
  }
  return send('Fetch.continueRequest', { requestId: p.requestId });
}

function injectR2k(j) {
  const k = j.scripts.findIndex(s => typeof s === 'string' && s.includes('let videoData = '));
  if (k < 0) return { r2k: 'no-videoData' };
  const s = j.scripts[k], i = s.indexOf('let videoData = ') + 16, e = s.indexOf(';\n', i);
  const arr = JSON.parse(s.slice(i, e));
  const at = arr.findIndex(x => x.url && x.url.includes(R2K_MATCH));
  if (at < 0) return { r2k: 'no-match', urls: arr.map(x => (x.url || '').slice(-40)) };
  const [it] = arr.splice(at, 1); it.vr2k_url = R2K_URL; arr.unshift(it);
  j.scripts[k] = s.slice(0, i) + JSON.stringify(arr).replace(/</g, '\\u003c') + s.slice(e);
  return { r2k: 'injected', from: at, url: it.url.slice(-60) };
}

ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); return; }
  const p = m.params;
  if (m.method === 'Fetch.requestPaused') { onPaused(p).catch(err => { log.override.err = String(err); send('Fetch.continueRequest', { requestId: p.requestId }); }); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = p.request.url;
    if (/\/api\/reels\/diag/.test(u)) { try { log.diag.push({ wall: p.wallTime * 1000, ...JSON.parse(p.request.postData || '{}') }); } catch { } return; }
    if (/\.(mp4|webm|m3u8|m4s|mov|png|jpe?g|webp)(\?|$)/i.test(u) || /media\.echomultiverse/.test(u)) {
      log.net[p.requestId] = { url: u.split('?')[0].split('/').pop().slice(-70), full: u.split('?')[0], host: new URL(u).host, range: p.request.headers.Range || p.request.headers.range || null, wall: p.wallTime * 1000, ts: p.timestamp, type: p.type, initiator: p.initiator && p.initiator.type };
    }
  } else if (m.method === 'Network.responseReceived' && log.net[p.requestId]) {
    const r = p.response, h = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
    Object.assign(log.net[p.requestId], { status: r.status, cr: h['content-range'], cl: h['content-length'], fromDisk: r.fromDiskCache, ttfbMs: Math.round((p.timestamp - log.net[p.requestId].ts) * 1000) });
  } else if (m.method === 'Network.loadingFinished' && log.net[p.requestId]) {
    Object.assign(log.net[p.requestId], { bytes: p.encodedDataLength, totalMs: Math.round((p.timestamp - log.net[p.requestId].ts) * 1000) });
  } else if (m.method === 'Network.loadingFailed' && log.net[p.requestId]) {
    Object.assign(log.net[p.requestId], { failed: p.errorText, canceled: p.canceled, totalMs: Math.round((p.timestamp - log.net[p.requestId].ts) * 1000) });
  } else if (m.method === 'Runtime.consoleAPICalled') {
    log.console.push({ wall: Date.now(), type: p.type, text: p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400) });
  } else if (m.method === 'Runtime.exceptionThrown') {
    log.console.push({ wall: Date.now(), type: 'exception', text: String(p.exceptionDetails.exception?.description || p.exceptionDetails.text).slice(0, 600) });
  } else if (m.method === 'Log.entryAdded') {
    log.console.push({ wall: Date.now(), type: 'log:' + p.entry.level, text: String(p.entry.text).slice(0, 400) });
  }
});
const ev = async (expression, gesture = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: gesture });
  if (r.exceptionDetails) return { EXC: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result ? r.result.value : r;
};

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Network.enable', { maxPostDataSize: 65536 });
await send('Network.setCacheDisabled', { cacheDisabled: false });
if (!NO_OVERRIDE) await send('Fetch.enable', { patterns: [
  { urlPattern: '*/api/reels/player-inline*', requestStage: 'Response' },
  { urlPattern: '*/player-script/webxr_vr.js*', requestStage: 'Request' },
  ...(R2K ? [{ urlPattern: R2K_URL + '*', requestStage: 'Request' }] : []),
] });
await send('Page.navigate', { url: 'https://echomultiverse.com/reels?xrdiag=1' + (QUERY ? '&' + QUERY : '') });
await sleep(8000);
const version = await ev('window.WebXRVR && WebXRVR.version');
console.log('url:', await ev('location.href'), 'engine:', version, 'override:', JSON.stringify(log.override));
log.engine = version;
if (!NO_OVERRIDE && !/vr-fixes-integration/.test(String(version))) { console.log('OVERRIDE NOT ACTIVE'); fs.writeFileSync(out, JSON.stringify(log, null, 1)); process.exit(3); }

const HOOK = fs.readFileSync(new URL('./hook.js', import.meta.url), 'utf8');
console.log('hook:', await ev(HOOK));
const SAMPLE = fs.readFileSync(new URL('./sample.js', import.meta.url), 'utf8');
let sampling = true;
const sampler = (async () => { while (sampling) { const s = await ev(SAMPLE); if (s && s.t) { s.wall = Date.now(); log.samples.push(s); } await sleep(250); } })();
const mark = async (name, extra = {}) => { const t = await ev('Math.round(performance.now())'); log.marks.push({ name, t, wall: Date.now(), ...extra }); console.log(new Date().toISOString().slice(11, 23), name, JSON.stringify(extra)); return t; };
const cur = () => ev(`(()=>{const v=document.getElementById('reelsVideo'),im=document.getElementById('reelsImage');const img=im&&im.style.display!=='none';return (img?'img:':'vid:')+(img?im.currentSrc:v.currentSrc).split('?')[0].split('/').pop().slice(-60);})()`);

await mark('baseline-2d', { reel: await cur() }); await sleep(3000);
await mark('enter-vr-click'); lmark('phase enter');
console.log('vrBtn:', await ev(`(()=>{const b=document.getElementById('vrBtn'); if(!b) return 'no-btn'; b.click(); return 'clicked';})()`, true));
await sleep(1200);
if (await ev(`(()=>{const p=document.getElementById('vrNoticePanel'); return !!p && !p.hidden;})()`)) { await mark('vr-notice-continue'); await ev(`document.getElementById('vrNoticeContinue').click()`, true); }
let presenting = false;
for (let i = 0; i < 40 && !presenting; i++) { presenting = await ev('!!(window.WebXRVR && WebXRVR.isPresenting())'); if (!presenting) await sleep(500); }
await mark('presenting', { presenting });
if (!presenting) { sampling = false; await sampler; log.net = Object.values(log.net); fs.writeFileSync(out, JSON.stringify(log, null, 1)); console.log('FAILED to enter VR'); process.exit(2); }

let reel = await cur(); lmark('phase r0 ' + reel); await mark('reel', { i: 0, reel });
await sleep(DWELL);
for (let i = 1; i <= STEPS; i++) {
  await mark('switch-click', { i }); lmark('phase none');
  await ev(`document.getElementById('edgeNextBtn').click()`, true);
  await sleep(1500);
  reel = await cur(); lmark('phase r' + i + ' ' + reel); await mark('reel', { i, reel });
  await sleep(DWELL - 1500);
}
lmark('phase none');
await mark('exit-vr');
await ev(`window.WebXRVR && WebXRVR.exitVR && WebXRVR.exitVR()`, true);
await sleep(2500);
await mark('end');
sampling = false; await sampler;
log.net = Object.values(log.net);
fs.writeFileSync(out, JSON.stringify(log, null, 1));
console.log('samples', log.samples.length, 'diag', log.diag.length, 'net', log.net.length, '->', out);
ws.close(); process.exit(0);
