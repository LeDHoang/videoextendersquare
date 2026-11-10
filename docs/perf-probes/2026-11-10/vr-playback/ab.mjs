// VR reels capture over CDP: enters VR on the Quest tab, steps through reels,
// samples video + XR frame pacing, records the engine's ?xrdiag=1 posts and
// media requests. Usage: node capture.mjs <out.json> [reels=6] [dwellSec=12]
import fs from 'node:fs';
const [out, reelsArg, dwellArg, burstArg] = process.argv.slice(2);
const BURSTS = Number(burstArg || 0);
const REELS = Number(reelsArg || 6), DWELL = Number(dwellArg || 12) * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = list.find(x => x.type === 'page' && /echomultiverse/.test(x.url));
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let nextId = 1; const pending = new Map();
const send = (method, params = {}) => new Promise(res => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const log = { startedWall: Date.now(), tab: tab.url, marks: [], samples: [], diag: [], net: {}, console: [] };
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); return; }
  const p = m.params;
  if (m.method === 'Network.requestWillBeSent') {
    const u = p.request.url;
    if (/\/api\/reels\/diag/.test(u)) { try { log.diag.push({ wall: p.wallTime * 1000, ...JSON.parse(p.request.postData || '{}') }); } catch { } return; }
    if (/\.(mp4|webm|m3u8|m4s|mov)(\?|$)/i.test(u) || /media\.echomultiverse/.test(u)) {
      log.net[p.requestId] = { url: u.split('/').pop().slice(-70), host: new URL(u).host, range: p.request.headers.Range || p.request.headers.range || null, wall: p.wallTime * 1000, ts: p.timestamp, type: p.type };
    }
  } else if (m.method === 'Network.responseReceived' && log.net[p.requestId]) {
    const r = p.response, h = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
    Object.assign(log.net[p.requestId], { status: r.status, proto: r.protocol, cf: h['cf-cache-status'], age: h.age, cr: h['content-range'], cl: h['content-length'], ct: h['content-type'], fromDisk: r.fromDiskCache, ttfbMs: Math.round((p.timestamp - log.net[p.requestId].ts) * 1000), timing: r.timing && { dns: r.timing.dnsEnd - r.timing.dnsStart, connect: r.timing.connectEnd - r.timing.connectStart, ssl: r.timing.sslEnd - r.timing.sslStart, send2hdr: r.timing.receiveHeadersEnd - r.timing.sendEnd } });
  } else if (m.method === 'Network.loadingFinished' && log.net[p.requestId]) {
    Object.assign(log.net[p.requestId], { bytes: p.encodedDataLength, totalMs: Math.round((p.timestamp - log.net[p.requestId].ts) * 1000) });
  } else if (m.method === 'Network.loadingFailed' && log.net[p.requestId]) {
    Object.assign(log.net[p.requestId], { failed: p.errorText, canceled: p.canceled, totalMs: Math.round((p.timestamp - log.net[p.requestId].ts) * 1000) });
  } else if (m.method === 'Runtime.consoleAPICalled') {
    log.console.push({ wall: Date.now(), type: p.type, text: p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400) });
  } else if (m.method === 'Log.entryAdded') {
    log.console.push({ wall: Date.now(), type: 'log:' + p.entry.level, text: String(p.entry.text).slice(0, 400) });
  }
});
const ev = async (expression, gesture = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: gesture });
  if (r.exceptionDetails) return { EXC: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result ? r.result.value : r;
};
await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable', { maxPostDataSize: 65536 });
// A/B: reload with engine flags, then compare 3840 vs 2048 renditions of one clip from blob URLs.
const QUERY = process.env.AB_QUERY || '';
const PHASE_S = Number(process.env.AB_PHASE_S || 15);
import { execFileSync } from 'node:child_process';
const lmark = s => { try { execFileSync('adb', ['shell', 'log', '-t', 'ABMARK', s]); } catch (e) {} };
await send('Page.enable');
await send('Page.navigate', { url: 'https://echomultiverse.com/reels?xrdiag=1' + (QUERY ? '&' + QUERY : '') });
await sleep(7000);
console.log('url:', await ev('location.href'), 'ready:', await ev('document.readyState'));


const HOOK = `(() => {
  if (window.__cap) return 'already';
  const cap = window.__cap = { ev: [], frames: 0, meta: null, lastFrameSrc: '', xr: null, layer: null, session: null };
  const base = s => String(s || '').split('?')[0].split('/').pop().slice(-70);
  const v = document.getElementById('reelsVideo');
  const push = (k, x) => cap.ev.push(Object.assign({ k, t: Math.round(performance.now()) }, x || {}));
  ['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough','playing','waiting','stalled','error','emptied','pause','ended'].forEach(n =>
    v.addEventListener(n, () => push(n, { src: base(v.currentSrc), rs: v.readyState, ct: +v.currentTime.toFixed(2) })));
  const loop = (now, meta) => {
    cap.frames++; cap.meta = { pf: meta.presentedFrames, w: meta.width, h: meta.height, mt: meta.mediaTime, pd: meta.processingDuration };
    if (v.currentSrc !== cap.lastFrameSrc) { cap.lastFrameSrc = v.currentSrc; push('first-frame', { src: base(v.currentSrc), w: meta.width, h: meta.height }); }
    v.requestVideoFrameCallback(loop);
  };
  v.requestVideoFrameCallback(loop);
  const newXr = () => ({ n: 0, last: -1, dtMax: 0, hist: new Array(12).fill(0), cbMax: 0, cbSum: 0, cbOver8: 0 });
  cap.xr = newXr(); cap.newXr = newXr;
  // dt buckets (ms): <10,<12,<13,<15,<17,<20,<25,<30,<42,<60,<100,>=100
  const edges = [10,12,13,15,17,20,25,30,42,60,100];
  const xr = navigator.xr, rs = xr.requestSession.bind(xr);
  xr.requestSession = async (...a) => {
    const s = await rs(...a);
    cap.session = s; push('xr-session', { mode: a[0] });
    s.addEventListener('visibilitychange', () => push('xr-visibility', { vis: s.visibilityState }));
    s.addEventListener('end', () => push('xr-end'));
    const raf = s.requestAnimationFrame.bind(s);
    s.requestAnimationFrame = cb => raf((time, frame) => {
      const x = cap.xr;
      if (x.last >= 0) { const dt = time - x.last; let i = 0; while (i < edges.length && dt >= edges[i]) i++; x.hist[i]++; if (dt > x.dtMax) x.dtMax = dt; }
      x.last = time; x.n++;
      const t0 = performance.now(); cb(time, frame); const d = performance.now() - t0;
      x.cbSum += d; if (d > x.cbMax) x.cbMax = d; if (d > 8) x.cbOver8++;
    });
    return s;
  };
  if (window.XRWebGLBinding) {
    const P = XRWebGLBinding.prototype, cpl = P.createProjectionLayer;
    P.createProjectionLayer = function (...a) { const l = cpl.apply(this, a); try { cap.layer = { kind: 'projection', w: l.textureWidth, h: l.textureHeight, arr: l.textureArrayLength, init: a[0] || null, ffr: l.fixedFoveation }; cap.layerObj = l; } catch (e) {} return l; };
  }
  if (window.XRWebGLLayer) {
    const O = XRWebGLLayer;
    window.XRWebGLLayer = new Proxy(O, { construct(T, a) { const l = new T(...a); try { cap.layer = { kind: 'webgl', w: l.framebufferWidth, h: l.framebufferHeight, init: a[2] || null, aa: l.antialias }; } catch (e) {} return l; } });
  }
  return 'hooked';
})()`;
const HOOK2 = `(() => {
  const cap = window.__cap; if (!cap || cap.img) return 'img-already';
  cap.img = true;
  const im = document.getElementById('reelsImage'); if (!im) return 'no-img';
  const base = s => String(s || '').split('?')[0].split('/').pop().slice(-70);
  const push = (k, x) => cap.ev.push(Object.assign({ k, t: Math.round(performance.now()) }, x || {}));
  im.addEventListener('load', () => push('img-load', { src: base(im.currentSrc), w: im.naturalWidth, h: im.naturalHeight }));
  im.addEventListener('error', () => push('img-error', { src: base(im.currentSrc) }));
  new MutationObserver(() => push('img-src', { src: base(im.getAttribute('src')), shown: im.style.display !== 'none' })).observe(im, { attributes: true, attributeFilter: ['src', 'style'] });
  return 'img-hooked';
})()`;
const SAMPLE = `(() => {
  const cap = window.__cap, v = document.getElementById('reelsVideo'), pv = document.getElementById('preloadVideo');
  const base = s => String(s || '').split('?')[0].split('/').pop().slice(-70);
  const pq = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
  const x = cap.xr; cap.xr = cap.newXr(); cap.xr.last = x.last;
  const evs = cap.ev; cap.ev = [];
  const s = cap.session; let sess = null;
  try { if (s) sess = { vis: s.visibilityState, fr: s.frameRate, sup: s.supportedFrameRates ? Array.from(s.supportedFrameRates) : null, feats: s.enabledFeatures ? Array.from(s.enabledFeatures) : null, ffr: cap.layerObj ? cap.layerObj.fixedFoveation : undefined }; } catch (e) {}
  let be = 0; try { for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.1 && v.buffered.end(i) > be) be = v.buffered.end(i); } catch (e) {}
  return { t: Math.round(performance.now()), src: base(v.currentSrc), blob: /^blob:/.test(v.currentSrc), vw: v.videoWidth, vh: v.videoHeight, rs: v.readyState, ns: v.networkState, paused: v.paused, ct: +v.currentTime.toFixed(2), dur: +(v.duration || 0).toFixed(2), bufEnd: +be.toFixed(2),
    pqTotal: pq && pq.totalVideoFrames, pqDrop: pq && pq.droppedVideoFrames, rvfc: cap.frames, meta: cap.meta,
    pre: pv ? { src: base(pv.currentSrc), rs: pv.readyState } : null,
    img: (im => im ? { src: base(im.currentSrc), shown: im.style.display !== 'none', w: im.naturalWidth, h: im.naturalHeight, ok: im.complete } : null)(document.getElementById('reelsImage')),
    presenting: !!(window.WebXRVR && WebXRVR.isPresenting()), stereo: window.WebXRVR && WebXRVR.getSourceStereo && WebXRVR.getSourceStereo(),
    xr: { n: x.n, dtMax: +x.dtMax.toFixed(1), hist: x.hist, cbAvg: x.n ? +(x.cbSum / x.n).toFixed(2) : 0, cbMax: +x.cbMax.toFixed(1), cbOver8: x.cbOver8 },
    sess, layer: cap.layer, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, ev: evs,
    title: (document.querySelector('.reel-title,.video-title,#videoTitle,#reelTitle') || {}).textContent || null };
})()`;

const mark = async (name, extra = {}) => { const t = await ev('Math.round(performance.now())'); log.marks.push({ name, t, wall: Date.now(), ...extra }); console.log(new Date().toISOString().slice(11, 23), name, JSON.stringify(extra)); return t; };
const eventsSince = t => log.samples.flatMap(s => s.ev || []).filter(e => e.t >= t);

console.log('hook:', await ev(HOOK), await ev(HOOK2));
let sampling = true;
const sampler = (async () => { while (sampling) { const s = await ev(SAMPLE); if (s && s.t) { s.wall = Date.now(); log.samples.push(s); } await sleep(250); } })();
await mark('baseline-2d'); await sleep(3000);
await mark('enter-vr-click');
console.log('vrBtn:', await ev(`(()=>{const b=document.getElementById('vrBtn'); if(!b) return 'no-btn'; b.click(); return 'clicked';})()`, true));
await sleep(1200);
const notice = await ev(`(()=>{const p=document.getElementById('vrNoticePanel'); return p && !p.hidden;})()`);
if (notice) { await mark('vr-notice-continue'); await ev(`document.getElementById('vrNoticeContinue').click()`, true); }
let presenting = false;
for (let i = 0; i < 40 && !presenting; i++) { presenting = await ev('!!(window.WebXRVR && WebXRVR.isPresenting())'); if (!presenting) await sleep(500); }
await mark('presenting', { presenting });
if (!presenting) { sampling = false; await sampler; fs.writeFileSync(out, JSON.stringify(log, null, 1)); console.log('FAILED to enter VR'); process.exit(2); }
const cur = () => ev(`(()=>{const v=document.getElementById('reelsVideo'),im=document.getElementById('reelsImage');const img=im&&im.style.display!=='none';return (img?'img:':'vid:')+(img?im.currentSrc:v.currentSrc).split('?')[0].split('/').pop().slice(-60);})()`);

lmark('phase image'); await mark('phase-image'); await sleep(10000); lmark('phase none');
// step to a playing video reel so host + engine are in video mode
let onVideo = false;
for (let i = 0; i < 10 && !onVideo; i++) {
  await ev(`document.getElementById('edgeNextBtn').click()`, true); await sleep(3000);
  onVideo = await ev(`(()=>{const v=document.getElementById('reelsVideo'),im=document.getElementById('reelsImage');return !(im&&im.style.display!=='none') && !!v.currentSrc && v.videoWidth>0;})()`);
}
await mark('on-video', { onVideo, src: await cur() });
// build blob URLs: 3840 master from prod (browser cache), 2048 test rendition pushed from the Mac
console.log('blob3840:', await ev(`fetch('https://media.echomultiverse.com/pairs/12827489_studio.mp4').then(r=>r.blob()).then(b=>{window.__ab={u3840:URL.createObjectURL(b),parts:[]};return b.size;})`));
const buf = fs.readFileSync(new URL('./ab/media/r2048.mp4', import.meta.url)); const CH = 384 * 1024;
for (let o = 0; o < buf.length; o += CH) await ev(`(()=>{const s=atob('${buf.subarray(o, o + CH).toString('base64')}');const a=new Uint8Array(s.length);for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i);window.__ab.parts.push(a);return a.length;})()`);
console.log('blob2048:', await ev(`(()=>{const b=new Blob(window.__ab.parts,{type:'video/mp4'});window.__ab.parts=null;window.__ab.u2048=URL.createObjectURL(b);return b.size;})()`));
const play = async key => {
  const r = await ev(`(async()=>{const v=document.getElementById('reelsVideo');v.loop=true;v.src=window.__ab.${key};try{await v.play();}catch(e){v.muted=true;await v.play();}
    await new Promise(r=>{const c=()=>v.readyState>=3&&v.videoWidth>0?r():setTimeout(c,50);c();});
    try{WebXRVR.onVideoChange&&WebXRVR.onVideoChange();}catch(e){}
    return {w:v.videoWidth,h:v.videoHeight,paused:v.paused,loop:v.loop};})()`, true);
  await sleep(1500);
  const q0 = await ev(`(()=>{const v=document.getElementById('reelsVideo'),q=v.getVideoPlaybackQuality();return {tot:q.totalVideoFrames,drop:q.droppedVideoFrames,rvfc:window.__cap.frames,t:performance.now()};})()`);
  lmark('phase ' + key); await mark('phase-' + key, r);
  await sleep(PHASE_S * 1000);
  lmark('phase none');
  const q1 = await ev(`(()=>{const v=document.getElementById('reelsVideo'),q=v.getVideoPlaybackQuality();return {tot:q.totalVideoFrames,drop:q.droppedVideoFrames,rvfc:window.__cap.frames,t:performance.now(),paused:v.paused,w:v.videoWidth};})()`);
  const res = { key, sec: (q1.t - q0.t) / 1000, decoded: q1.tot - q0.tot, dropped: q1.drop - q0.drop, presentedFps: +((q1.rvfc - q0.rvfc) / ((q1.t - q0.t) / 1000)).toFixed(1), paused: q1.paused, w: q1.w };
  log.marks.push({ name: 'phase-' + key + '-result', ...res }); console.log('   ', JSON.stringify(res));
};
const clean = { u3840: 0, u2048: 0 };
if (onVideo) for (let i = 0; i < 10 && (clean.u3840 < 2 || clean.u2048 < 2); i++) {
  const k = i % 2 ? 'u2048' : 'u3840'; await play(k);
  const r = log.marks[log.marks.length - 1];
  const ours = await ev(`document.getElementById('reelsVideo').currentSrc===window.__ab.${k}`);
  r.clean = !!ours && !r.paused && r.presentedFps > 20; if (r.clean) clean[k]++;
  lmark('result ' + k + ' ' + (r.clean ? 'clean' : 'dirty')); console.log('    clean:', r.clean);
}
await mark('exit-vr');
await ev(`window.WebXRVR && WebXRVR.exitVR && WebXRVR.exitVR()`, true);
await sleep(2500);
await mark('end');
sampling = false; await sampler;
log.net = Object.values(log.net);
fs.writeFileSync(out, JSON.stringify(log, null, 1));
console.log('samples', log.samples.length, 'diag', log.diag.length, '->', out);
ws.close(); process.exit(0);
