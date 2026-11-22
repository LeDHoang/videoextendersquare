// Time to VR on the Quest: per run, (cold) clear DNS + sockets + HTTP cache, navigate the echo tab to
// /reels, then click the player's own VR button. Times are ms since Page.navigate.
// usage: node ttvr.mjs <out.json> [runs=4] [cold=1] [watchSecs=20]
import fs from 'node:fs';
const out = process.argv[2], RUNS = +(process.argv[3] || 4), COLD = (process.argv[4] || '1') === '1', WATCH = +(process.argv[5] || 20);
const URL = 'https://echomultiverse.com/reels';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOOK = `(() => {
  if (window.__tv) return; const T = window.__tv = { ev: [] };
  const now = () => Math.round(performance.now()); const push = (k, x) => T.ev.push(Object.assign({ k, t: now() }, x || {}));
  const base = s => String(s || '').split('?')[0].split('/').pop().slice(-50);
  if (navigator.xr) { const rs = navigator.xr.requestSession.bind(navigator.xr);
    navigator.xr.requestSession = async (...a) => { push('xr-request'); const s = await rs(...a); push('xr-start');
      const raf = s.requestAnimationFrame.bind(s); let first = true;
      s.requestAnimationFrame = cb => raf((t, f) => { if (first) { first = false; push('xr-first-frame'); } cb(t, f); }); return s; }; }
  const iv = setInterval(() => { const v = document.getElementById('reelsVideo'); if (!v) return; clearInterval(iv);
    let waitAt = null, framed = '';
    ['loadedmetadata', 'canplay', 'playing'].forEach(n => v.addEventListener(n, () => {
      if (n === 'playing' && waitAt !== null) { push('rebuffer', { ms: now() - waitAt }); waitAt = null; }
      push('v-' + n, { src: base(v.currentSrc) }); }));
    v.addEventListener('waiting', () => { waitAt = now(); push('v-waiting', { src: base(v.currentSrc), ct: +v.currentTime.toFixed(1) }); });
    const loop = (t, m) => { if (v.currentSrc !== framed) { framed = v.currentSrc; push('v-first-frame', { src: base(v.currentSrc), w: m.width, h: m.height }); } v.requestVideoFrameCallback(loop); };
    v.requestVideoFrameCallback(loop);
    const im = document.getElementById('reelsImage');
    if (im) im.addEventListener('load', () => push('img-load', { src: base(im.currentSrc) }));
  }, 50);
})()`;

import { pickTab } from './pick.mjs';
const tab = await pickTab();
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(), net = [];
const reqs = new Map(); let navWall = 0;
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); return; }
  const p = m.params || {};
  if (m.method === 'Network.requestWillBeSent') reqs.set(p.requestId, { at: Date.now() - navWall, url: p.request.url.replace(/^https?:\/\//, '').split('?')[0].slice(0, 90), type: p.type });
  else if (m.method === 'Network.responseReceived' && reqs.has(p.requestId)) Object.assign(reqs.get(p.requestId), { status: p.response.status, cf: (p.response.headers || {})['cf-cache-status'] || null, hdr: Date.now() - navWall });
  else if (m.method === 'Network.loadingFinished' && reqs.has(p.requestId)) { const r = reqs.get(p.requestId); r.end = Date.now() - navWall; r.bytes = p.encodedDataLength; net.push(r); reqs.delete(p.requestId); }
  else if (m.method === 'Network.loadingFailed' && reqs.has(p.requestId)) { const r = reqs.get(p.requestId); r.end = Date.now() - navWall; r.failed = p.errorText; net.push(r); reqs.delete(p.requestId); } });
const call = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression, g = false) => { const r = await Promise.race([call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: g }), sleep(8000).then(() => ({ to: 1 }))]); return r.to ? null : r.result?.value; };
await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
await call('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
const rows = [];
for (let run = 0; run < RUNS; run++) {
  if (COLD) {
    await call('Page.navigate', { url: 'chrome://net-internals/#sockets' }); await sleep(1200);
    await ev(`document.getElementById('dns-view-clear-cache').click();document.getElementById('sockets-view-flush-button').click();true`);
    await call('Network.clearBrowserCache'); await sleep(500);
  } else { await call('Page.navigate', { url: 'about:blank' }); await sleep(800); }
  net.length = 0; reqs.clear();
  navWall = Date.now(); await call('Page.navigate', { url: URL });
  const row = { run, cold: COLD };
  // Wait for the player (the reelrun "ready" test), then let the 2D video start.
  for (let i = 0; i < 120; i++) { if (await ev('!!(window.WebXRVR && document.getElementById("vrBtn") && window.__tv)')) break; await sleep(250); }
  row.playerReady = Date.now() - navWall;
  for (let i = 0; i < 80; i++) { if (await ev('!!window.__tv.ev.find(e=>e.k==="v-playing"||e.k==="img-load")')) break; await sleep(250); }
  const pg = await ev(`(()=>{const n=performance.getEntriesByType('navigation')[0], f=performance.getEntriesByName('first-contentful-paint')[0];
    return {ttfb:Math.round(n.responseStart), dcl:Math.round(n.domContentLoadedEventEnd), load:Math.round(n.loadEventEnd), fcp:f?Math.round(f.startTime):null, origin:Math.round(performance.timeOrigin)}})()`);
  Object.assign(row, pg);
  if (!process.env.NOVR) {
    const clickAt = Date.now() - navWall;
    await ev(`document.getElementById('vrBtn').click()`, true); await sleep(1200);
    if (await ev(`(()=>{const p=document.getElementById('vrNoticePanel'); return !!p && !p.hidden;})()`)) { row.notice = true; await ev(`document.getElementById('vrNoticeContinue').click()`, true); }
    row.vrClick = clickAt;
  }
  await sleep(WATCH * 1000);
  const evs = await ev('window.__tv.ev');
  // performance.now() is ms since the page's timeOrigin, which is ~navigation start.
  const at = k => { const e = (evs || []).find(x => x.k === k); return e ? e.t : null; };
  row.firstReel = ((evs || []).find(e => e.k === 'v-playing' || e.k === 'img-load') || {}).t ?? null;
  row.firstVideoPlaying = ((evs || []).find(e => e.k === 'v-playing') || {}).t ?? null;
  Object.assign(row, { firstFrame2d: at('v-first-frame'), playing2d: at('v-playing'), xrStart: at('xr-start'), xrFirstFrame: at('xr-first-frame') });
  const xs = row.xrStart || Infinity;
  const afterXr = (evs || []).filter(e => e.t >= xs);
  row.vrPlaying = (afterXr.find(e => e.k === 'v-playing') || {}).t ?? null;
  row.rebuffers = (evs || []).filter(e => e.k === 'rebuffer').map(e => e.ms);
  row.waitingOpen = (evs || []).filter(e => e.k === 'v-waiting').length - row.rebuffers.length;
  row.srcs = [...new Set((evs || []).filter(e => e.k === 'v-first-frame').map(e => `${e.src} ${e.w}x${e.h}`))];
  row.net = net.filter(r => !/\.(woff2?|svg|ico)$/.test(r.url)).map(r => ({ ...r }));
  row.events = evs;
  rows.push(row);
  const { net: _n, events: _e, ...short } = row; console.log(JSON.stringify(short));
  await ev(`window.WebXRVR && WebXRVR.exitVR && WebXRVR.exitVR()`, true); await sleep(2000);
  fs.writeFileSync(out, JSON.stringify(rows, null, 1));
}
await call('Page.navigate', { url: URL });
ws.close(); process.exit(0);
