// Full reel run in VR on the live /reels page, timed per switch (read-only: it changes no page behaviour,
// it only clicks the player's own buttons). Phase 1 lets AUTO advance on its own; phase 2 presses NEXT
// every few seconds, before the look-ahead preload can finish.
// It logs, per reel change: the moment the src changes; for a video the first decoded frame
// (requestVideoFrameCallback) and every later 'waiting' (rebuffer) with its length; for an image post the
// VR bitmap path (the page fetches the file with cache:'reload' and decodes it with createImageBitmap; the
// VR engine keeps the old frame until that bitmap exists). It also logs XR frame gaps, media responses
// (status, cf-cache-status, size, time to headers) and a 1 s sample of the player.
// Usage: adb forward tcp:9222 localabstract:chrome_devtools_remote
//        node reelrun.mjs <out.json> [autoSeconds=600] [nextSeconds=120] [nextEveryMs=5000]
import fs from 'node:fs';
const out = process.argv[2], AUTO = Number(process.argv[3] || 600), NEXT = Number(process.argv[4] || 120), EVERY = Number(process.argv[5] || 5000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = { started: new Date().toISOString(), args: { AUTO, NEXT, EVERY }, events: [], samples: [], net: [] };
const t0 = Date.now(); const flush = () => fs.writeFileSync(out, JSON.stringify(log));
const note = (k, x) => { const e = { wall: Date.now() - t0, k, ...x }; log.events.push(e); console.log(JSON.stringify(e).slice(0, 260)); };

const HOOK = `(() => {
  if (window.__rr) return 'already';
  const R = window.__rr = { ev: [] };
  const now = () => Math.round(performance.now());
  const base = s => String(s || '').split('?')[0].split('/').pop().slice(-60);
  const push = (k, x) => { R.ev.push(Object.assign({ k, t: now() }, x || {})); if (R.ev.length > 5000) R.ev.shift(); };
  R.push = push;
  // The VR image path: fetch(url, {cache:'reload'}) then createImageBitmap(blob).
  const isImg = u => /\\.(png|jpe?g|webp|avif|gif)(\\?|$)/i.test(u) || /^blob:/.test(u);
  const of = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = of.apply(this, arguments);
    if (!isImg(url)) return p;
    const s = now(), src = base(url);
    push('img-fetch', { src, cache: init && init.cache || null });
    return p.then(r => {
      push('img-headers', { src, ms: now() - s, status: r.status, cf: r.headers.get('cf-cache-status'), len: +r.headers.get('content-length') || null });
      const ob = r.blob.bind(r);
      r.blob = () => ob().then(b => { push('img-body', { src, ms: now() - s, bytes: b.size, type: b.type }); try { b.__src = src; } catch (e) {} return b; });
      return r;
    }, e => { push('img-fetch-fail', { src, ms: now() - s, err: String(e) }); throw e; });
  };
  const ocib = window.createImageBitmap;
  if (ocib) window.createImageBitmap = function (x) {
    const s = now(), src = x && x.__src || (x && x.tagName) || null;
    return ocib.apply(this, arguments).then(b => { push('img-bitmap', { src, ms: now() - s, w: b.width, h: b.height }); return b; },
      e => { push('img-bitmap-fail', { src, ms: now() - s, err: String(e) }); throw e; });
  };
  // XR frame gaps, total and per gap over 25 ms.
  R.xr = { n: 0, last: -1, over25: 0, over40: 0, max: 0 };
  if (navigator.xr) {
    const rs = navigator.xr.requestSession.bind(navigator.xr);
    navigator.xr.requestSession = async (...a) => {
      const s = await rs(...a); R.session = s; push('xr-start', { mode: a[0] });
      s.addEventListener('end', () => push('xr-end'));
      s.addEventListener('visibilitychange', () => push('xr-vis', { vis: s.visibilityState }));
      const raf = s.requestAnimationFrame.bind(s);
      s.requestAnimationFrame = cb => raf((time, frame) => {
        const x = R.xr;
        if (x.last >= 0) { const dt = time - x.last; if (dt > x.max) x.max = dt; if (dt > 25) { x.over25++; if (dt > 40) { x.over40++; push('xr-gap', { ms: Math.round(dt) }); } } }
        x.last = time; x.n++; cb(time, frame);
      });
      return s;
    };
  }
  const attach = () => {
    const v = document.getElementById('reelsVideo'), im = document.getElementById('reelsImage');
    if (!v || !im || R.attached) return !!R.attached;
    R.attached = true;
    const st = () => { let be = 0; try { for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.1) be = Math.max(be, v.buffered.end(i)); } catch (e) {} return { rs: v.readyState, ct: +v.currentTime.toFixed(2), buf: +(be - v.currentTime).toFixed(2) }; };
    let waitAt = null;
    ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'stalled', 'ended', 'error'].forEach(n =>
      v.addEventListener(n, () => {
        if (n === 'playing' && waitAt !== null) { push('rebuffer-end', Object.assign({ src: base(v.currentSrc), ms: now() - waitAt }, st())); waitAt = null; }
        push('v-' + n, Object.assign({ src: base(v.currentSrc), code: v.error && v.error.code }, st()));
      }));
    v.addEventListener('waiting', () => { waitAt = now(); push('v-waiting', Object.assign({ src: base(v.currentSrc) }, st())); });
    // First decoded frame of each new src.
    let framedSrc = '';
    const loop = (t, meta) => { if (v.currentSrc && v.currentSrc !== framedSrc) { framedSrc = v.currentSrc; push('v-first-frame', { src: base(v.currentSrc), w: meta.width, h: meta.height }); } v.requestVideoFrameCallback(loop); };
    v.requestVideoFrameCallback(loop);
    new MutationObserver(() => push('vid-src', { src: base(v.getAttribute('src')) })).observe(v, { attributes: true, attributeFilter: ['src'] });
    new MutationObserver(() => push('img-src', { src: base(im.getAttribute('src')), shown: im.style.display !== 'none' })).observe(im, { attributes: true, attributeFilter: ['src'] });
    im.addEventListener('load', () => push('img-load', { src: base(im.currentSrc), w: im.naturalWidth, h: im.naturalHeight }));
    im.addEventListener('error', () => push('img-error', { src: base(im.currentSrc) }));
    const c = document.getElementById('counter') || document.querySelector('.counter');
    if (c) new MutationObserver(() => push('counter', { text: c.textContent })).observe(c, { childList: true, characterData: true, subtree: true });
    return true;
  };
  const iv = setInterval(() => { if (attach()) clearInterval(iv); }, 200);
  return 'hooked';
})()`;

const SAMPLE = `(() => {
  const R = window.__rr; if (!R) return null; const v = document.getElementById('reelsVideo'), im = document.getElementById('reelsImage');
  const base = s => String(s || '').split('?')[0].split('/').pop().slice(-60);
  const e = R.ev; R.ev = []; const x = R.xr; R.xr = { n: 0, last: x.last, over25: 0, over40: 0, max: 0 };
  const img = im && im.style.display !== 'none';
  let be = 0; try { for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.1) be = Math.max(be, v.buffered.end(i)); } catch (er) {}
  const pq = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null; const mb = document.getElementById('modeBtn');
  return { t: Math.round(performance.now()), cur: (img ? 'img:' + base(im.currentSrc) : 'vid:' + base(v.currentSrc)), vw: v.videoWidth, vh: v.videoHeight,
    rs: v.readyState, ct: +v.currentTime.toFixed(1), dur: +(v.duration || 0).toFixed(1), buf: +(be - v.currentTime).toFixed(1), paused: v.paused,
    drop: pq && pq.droppedVideoFrames, frames: pq && pq.totalVideoFrames, presenting: !!(window.WebXRVR && WebXRVR.isPresenting && WebXRVR.isPresenting()),
    vis: R.session ? R.session.visibilityState : null, mode: mb ? (mb.textContent || '').trim().slice(0, 12) : null,
    heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, xr: { n: x.n, over25: x.over25, over40: x.over40, max: Math.round(x.max) }, ev: e };
})()`;

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = list.find(x => x.type === 'page' && /echomultiverse/.test(x.url));
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 1; const pend = new Map(); const reqs = new Map();
const isMedia = (u, type) => type === 'Media' || type === 'Image' || /\.(mp4|webm|mov|m4v|png|jpe?g|webp|avif)(\?|$)/i.test(u);
ws.addEventListener('close', () => note('ws-closed'));
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); return; }
  const p = m.params || {};
  if (m.method === 'Network.requestWillBeSent' && isMedia(p.request.url, p.type)) reqs.set(p.requestId, { wall: Date.now() - t0, url: p.request.url.split('?')[0].split('/').pop().slice(-60), host: (p.request.url.match(/^https?:\/\/([^/]+)/) || [])[1], type: p.type, range: p.request.headers.Range || p.request.headers.range || null });
  else if (m.method === 'Network.responseReceived' && reqs.has(p.requestId)) { const r = reqs.get(p.requestId), h = p.response.headers || {}, g = k => h[k] || h[k.toLowerCase()] || null, tm = p.response.timing;
    Object.assign(r, { status: p.response.status, cf: g('cf-cache-status'), len: +g('Content-Length') || null, crange: g('Content-Range'), fromCache: !!(p.response.fromDiskCache || p.response.fromMemoryCache), proto: p.response.protocol, ttfb: tm ? Math.round(tm.receiveHeadersEnd - tm.sendStart) : null, connect: tm && tm.connectStart >= 0 ? Math.round(tm.connectEnd - tm.connectStart) : null }); }
  else if (m.method === 'Network.loadingFinished' && reqs.has(p.requestId)) { const r = reqs.get(p.requestId); r.bytes = p.encodedDataLength; r.doneMs = Date.now() - t0 - r.wall; log.net.push(r); reqs.delete(p.requestId); }
  else if (m.method === 'Network.loadingFailed' && reqs.has(p.requestId)) { const r = reqs.get(p.requestId); r.failed = p.errorText; r.canceled = p.canceled; r.doneMs = Date.now() - t0 - r.wall; log.net.push(r); reqs.delete(p.requestId); }
  else if (m.method === 'Runtime.exceptionThrown') note('exception', { text: String(p.exceptionDetails.exception?.description || p.exceptionDetails.text).slice(0, 400) });
  else if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') note('console-error', { text: (p.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
  else if (m.method === 'Inspector.targetCrashed') note('TAB-CRASHED');
  else if (m.method === 'Page.frameNavigated' && !p.frame.parentId) note('navigated', { url: p.frame.url });
});
const send = (method, params = {}) => new Promise(res => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression, g = false) => { const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: g }), sleep(8000).then(() => ({ timeout: true }))]); return r.timeout ? { TIMEOUT: 1 } : r.exceptionDetails ? { EXC: r.exceptionDetails.exception?.description } : r.result?.value; };
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable'); await send('Inspector.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
const navAt = Date.now() - t0; note('navigate', {});
await send('Page.navigate', { url: 'https://echomultiverse.com/reels' });
for (let i = 0; i < 60 && !(await ev('!!(window.WebXRVR && document.getElementById("vrBtn") && window.__rr && window.__rr.attached)')); i++) await sleep(500);
note('player-ready', { sinceNav: Date.now() - t0 - navAt });
await sleep(4000);
const sample = async () => { const s = await ev(SAMPLE); if (s && s.t) { s.wall = Date.now() - t0; log.samples.push(s); } else note('sample-fail', { s: JSON.stringify(s).slice(0, 200) }); return s; };
await sample();
await ev(`document.getElementById('vrBtn').click()`, true); await sleep(1200);
if (await ev(`(()=>{const p=document.getElementById('vrNoticePanel'); return !!p && !p.hidden;})()`)) await ev(`document.getElementById('vrNoticeContinue').click()`, true);
note('vr-entered-click');
const phase = async (secs, press) => {
  const s0 = Date.now(); let nextAt = Date.now() + EVERY;
  while (Date.now() - s0 < secs * 1000) {
    await sample();
    if (press && Date.now() >= nextAt) { note('press-next'); await ev(`document.getElementById('edgeNextBtn').click()`, true); nextAt = Date.now() + EVERY; }
    if (log.samples.length % 30 === 0) flush();
    await sleep(1000);
  }
};
note('phase-auto'); await phase(AUTO, false);
note('phase-next'); await phase(NEXT, true);
await sample(); note('done');
await ev(`window.WebXRVR && WebXRVR.exitVR && WebXRVR.exitVR()`, true); await sleep(1500);
flush(); ws.close(); process.exit(0);
