// Passive watcher for "VR drops to 2D" on the Quest tab (read-only: it changes no page behaviour).
// It attaches over CDP and logs, with the page clock and wall clock, every immersive session start,
// visibility change and end, and who ended it: a stack when page code called XRSession.end() or
// WebXRVR.exitVR(), or "no page caller" when the browser or the headset ended it. It also logs
// navigations, uncaught errors, video errors, WebGL context loss and tab crashes.
// Usage: adb forward tcp:9222 localabstract:chrome_devtools_remote; node watch.mjs <log.jsonl>
import fs from 'node:fs';
const out = process.argv[2]; const sleep = ms => new Promise(r => setTimeout(r, ms));
const write = o => { const line = JSON.stringify({ wall: new Date().toISOString(), ...o }); fs.appendFileSync(out, line + '\n'); console.log(line.slice(0, 400)); };
const HOOK = `(() => {
  // Base hooks install once per document; the v2 block below also lands on a page
  // that an older watcher already hooked, so the watcher can restart without a reload.
  const fresh = !window.__vrWatch;
  const w = window.__vrWatch || (window.__vrWatch = { ev: [], lastCaller: null });
  const push = (k, x) => { w.ev.push(Object.assign({ k, t: Math.round(performance.now()), url: location.pathname + location.search }, x || {})); if (w.ev.length > 400) w.ev.shift(); };
  const stack = () => String(new Error().stack || '').split('\\n').slice(2, 9).map(s => s.trim().replace(/https?:\\/\\/[^/]+/, '')).join(' | ');
  const reel = () => { try { const v = document.getElementById('reelsVideo'), im = document.getElementById('reelsImage'); const img = im && im.style.display !== 'none'; return (img ? 'img:' : 'vid:') + ((img ? im.currentSrc : v.currentSrc) || '').split('/').pop().slice(-40) + (v && v.error ? ' verr' + v.error.code : ''); } catch (e) { return null; } };
  const media = () => { try { const v = document.getElementById('reelsVideo'), im = document.getElementById('reelsImage'); if (im && im.style.display !== 'none') return 'img'; return v ? (v.currentTime.toFixed(1) + '/' + (v.duration || 0).toFixed(1) + (v.paused ? ' paused' : '') + (v.ended ? ' ended' : '') + ' rs' + v.readyState) : null; } catch (e) { return null; } };
  if (!w.v2) {
    w.v2 = true;
    const src = s => s ? [s.handedness, s.targetRayMode, s.hand ? 'hand' : (s.gamepad ? 'pad' : 'none'), (s.profiles || [])[0] || ''].join('/') : null;
    if (navigator.xr) { const rs2 = navigator.xr.requestSession.bind(navigator.xr); navigator.xr.requestSession = async (...a) => { const s = await rs2(...a);
      ['selectstart', 'select', 'selectend', 'squeezestart', 'squeeze'].forEach(n => s.addEventListener(n, e => push('xr-' + n, { src: src(e.inputSource), reel: reel(), media: media() })));
      s.addEventListener('inputsourceschange', e => push('xr-inputs', { added: [...e.added].map(src), removed: [...e.removed].map(src) }));
      push('xr-inputs-initial', { now: [...s.inputSources].map(src) });
      return s; }; }
    // Reel changes while presenting, with where the outgoing reel stood, to line a drop up with a reel end.
    let lastReel = null, lastMedia = null;
    setInterval(() => { const r = reel(); if (r !== lastReel) { if (lastReel !== null) push('reel-change', { from: lastReel, fromMedia: lastMedia, to: r, presenting: !!(window.WebXRVR && WebXRVR.isPresenting && WebXRVR.isPresenting()) }); lastReel = r; } lastMedia = media(); }, 250);
  }
  if (!fresh) return 'v2-on-existing';
  if (window.XRSession) { const end = XRSession.prototype.end; XRSession.prototype.end = function () { w.lastCaller = { t: performance.now(), stack: stack() }; push('session.end() called', { stack: w.lastCaller.stack, reel: reel() }); return end.apply(this, arguments); }; }
  if (navigator.xr) { const rs = navigator.xr.requestSession.bind(navigator.xr); navigator.xr.requestSession = async (...a) => { let s; try { s = await rs(...a); } catch (e) { push('requestSession rejected', { err: e.name + ': ' + e.message }); throw e; }
    push('xr-start', { mode: a[0], reel: reel(), media: media() });
    s.addEventListener('visibilitychange', () => push('xr-visibility', { vis: s.visibilityState, reel: reel() }));
    s.addEventListener('end', () => { const c = w.lastCaller && performance.now() - w.lastCaller.t < 3000 ? w.lastCaller.stack : null; push('XR-END', { by: c ? 'page code' : 'browser or headset (no page caller)', stack: c, reel: reel(), media: media(), docVis: document.visibilityState, online: navigator.onLine, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null }); w.lastCaller = null; });
    return s; }; }
  window.addEventListener('error', e => push('win-error', { msg: String(e.message).slice(0, 300), src: String(e.filename || '').slice(-60) + ':' + e.lineno }));
  window.addEventListener('unhandledrejection', e => push('unhandled-rejection', { msg: String(e.reason && (e.reason.stack || e.reason.message) || e.reason).slice(0, 400) }));
  ['echo:vr-enter', 'echo:vr-exit', 'echo:navigate', 'echo:auth-required'].forEach(n => window.addEventListener(n, e => push(n, { detail: e.detail ? JSON.stringify(e.detail).slice(0, 200) : null })));
  document.addEventListener('visibilitychange', () => push('doc-visibility', { vis: document.visibilityState }));
  document.addEventListener('webglcontextlost', e => push('webgl-context-lost', { reel: reel() }), true);
  document.addEventListener('error', e => { const t = e.target; if (t && t.tagName === 'VIDEO') push('video-error', { src: (t.currentSrc || '').split('/').pop().slice(-50), code: t.error && t.error.code, msg: t.error && t.error.message }); }, true);
  const hs = history.replaceState, hp = history.pushState; history.replaceState = function () { push('history.replace', { to: String(arguments[2]).slice(0, 120) }); return hs.apply(this, arguments); }; history.pushState = function () { push('history.push', { to: String(arguments[2]).slice(0, 120) }); return hp.apply(this, arguments); };
  // Wrap the player's own exit once it exists, to name the caller of WebXRVR.exitVR().
  const wrap = () => { try { const X = window.WebXRVR; if (X && X.exitVR && !X.exitVR.__w) { const f = X.exitVR; const g = function () { if (X.isPresenting && X.isPresenting()) { w.lastCaller = { t: performance.now(), stack: stack() }; push('WebXRVR.exitVR() called', { stack: w.lastCaller.stack, reel: reel() }); } return f.apply(this, arguments); }; g.__w = true; X.exitVR = g; } } catch (e) {} };
  setInterval(wrap, 500); wrap();
  return 'hooked';
})()`;
const DRAIN = `(() => { const w = window.__vrWatch; if (!w) return null; const e = w.ev; w.ev = []; return JSON.stringify({ ev: e, presenting: !!(window.WebXRVR && WebXRVR.isPresenting && WebXRVR.isPresenting()), url: location.pathname + location.search }); })()`;
for (;;) {
  let ws;
  try {
    const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    const tab = list.find(x => x.type === 'page' && /echomultiverse/.test(x.url));
    if (!tab) { await sleep(5000); continue; }
    ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    let id = 1; const pend = new Map(); let closed = false;
    ws.addEventListener('close', () => { closed = true; for (const p of pend.values()) p({ closed: true }); });
    ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); return; } const p = m.params || {};
      if (m.method === 'Inspector.targetCrashed') write({ k: 'TAB-CRASHED' });
      else if (m.method === 'Page.frameNavigated' && !p.frame.parentId) write({ k: 'page-load', url: p.frame.url });
      else if (m.method === 'Runtime.exceptionThrown') write({ k: 'exception', text: String(p.exceptionDetails.exception?.description || p.exceptionDetails.text).slice(0, 600) });
      else if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') write({ k: 'console-error', text: (p.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 600) });
      else if (m.method === 'Log.entryAdded' && p.entry.level === 'error' && !/api\/reels\/diag/.test(p.entry.url || '')) write({ k: 'log-error', text: String(p.entry.text).slice(0, 300), url: (p.entry.url || '').slice(-90) }); });
    const send = (method, params = {}) => new Promise(res => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Inspector.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
    const h = await send('Runtime.evaluate', { expression: HOOK, returnByValue: true });
    write({ k: 'watcher-attached', tab: tab.url, hook: h.result?.value });
    let was = null;
    while (!closed) {
      const r = await Promise.race([send('Runtime.evaluate', { expression: DRAIN, returnByValue: true }), sleep(10000).then(() => ({ timeout: true }))]);
      if (r.closed) break;
      if (r.result?.value) { const d = JSON.parse(r.result.value); for (const e of d.ev) write({ k: e.k, pageT: e.t, ...e, t: undefined }); if (d.presenting !== was) { write({ k: d.presenting ? 'presenting' : 'not-presenting', url: d.url }); was = d.presenting; } }
      await sleep(1000);
    }
    write({ k: 'watcher-detached' });
  } catch (e) { /* headset asleep, adb gone or browser closed: retry */ }
  try { ws && ws.close(); } catch (e) {}
  await sleep(5000);
}
