// Cold vs warm first frame of feed reels on the Quest, over CDP, on the live
// site. For each video item not in SKIP: a fresh muted <video crossorigin>
// loads the URL as served (browser cache cold, edge as it is), then again
// (browser warm). Times run from setting src to loadeddata (readyState >= 2,
// what clears the VR spinner) and to the first video frame callback. The CDP
// Network domain records each media request's cf-cache-status and range.
// Images: first fetch of the PNG/JPG, then a repeat.
// Usage: node cold_first_frame.mjs <out.json>   (env N = videos, default 8)
import fs from 'node:fs';
const N = Number(process.env.N || 8);
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = list.find(x => x.type === 'page' && /echomultiverse/.test(x.url));
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 1; const pend = new Map(); const net = {};
ws.addEventListener('message', m => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.method === 'Network.requestWillBeSent' && /media\.echomultiverse/.test(d.params.request.url))
    net[d.params.requestId] = { url: d.params.request.url, range: d.params.request.headers.Range || d.params.request.headers.range, t: d.params.timestamp };
  if (d.method === 'Network.responseReceived' && net[d.params.requestId]) {
    const h = d.params.response.headers, r = net[d.params.requestId];
    r.status = d.params.response.status; r.cf = h['cf-cache-status'] || h['CF-Cache-Status']; r.disk = d.params.response.fromDiskCache;
    r.ttfb = Math.round((d.params.timestamp - r.t) * 1000); r.proto = d.params.response.protocol;
  }
});
const send = (method, params = {}) => new Promise(res => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Network.enable');
const pageFn = async (N) => {
  const v0 = document.getElementById('reelsVideo'); try { v0.pause(); } catch (e) {}
  const items = JSON.parse(await (await fetch('/api/reels/feed?limit=60', { cache: 'no-store' })).text()).items || [];
  const seen = new Set(performance.getEntriesByType('resource').map(e => e.name.split('?')[0]));
  const vids = items.filter(i => i.url && /\.mp4/.test(i.url) && !seen.has(i.url.split('?')[0])).slice(0, N);
  const imgs = items.filter(i => i.url && /\.(png|jpe?g|webp)/i.test(i.url) && !seen.has(i.url.split('?')[0])).slice(0, 6);
  const one = (url) => new Promise(res => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    const t0 = performance.now(), o = {};
    const done = () => { v.pause(); v.removeAttribute('src'); v.load(); res(o); };
    v.addEventListener('loadedmetadata', () => { o.meta = Math.round(performance.now() - t0); });
    v.addEventListener('loadeddata', () => { o.rs2 = Math.round(performance.now() - t0); });
    v.addEventListener('canplay', () => { o.rs3 = Math.round(performance.now() - t0); });
    v.addEventListener('error', () => { o.err = v.error && v.error.code; done(); });
    v.requestVideoFrameCallback(() => { o.frame = Math.round(performance.now() - t0); o.w = v.videoWidth; o.h = v.videoHeight; o.dur = Math.round(v.duration); setTimeout(done, 300); });
    setTimeout(() => { o.timeout = true; done(); }, 15000);
    v.src = url; v.play().catch(() => {});
  });
  const out = { vids: [], imgs: [] };
  for (const it of vids) {
    const cold = await one(it.url);
    await new Promise(r => setTimeout(r, 500));
    const warm = await one(it.url);
    out.vids.push({ url: it.url, cold, warm });
  }
  for (const it of imgs) {
    const t = async () => { const t0 = performance.now(); const r = await fetch(it.url, { mode: 'cors' }); const b = await r.arrayBuffer(); return { ms: Math.round(performance.now() - t0), kb: b.byteLength >> 10 }; };
    const cold = await t(); const warm = await t();
    out.imgs.push({ url: it.url, cold, warm });
  }
  return out;
};
const r = await send('Runtime.evaluate', { expression: `(${pageFn})(${N})`, awaitPromise: true, returnByValue: true, timeout: 600000 });
const res = r.result?.result?.value ?? r;
res.net = Object.values(net).map(x => ({ ...x, url: x.url.slice(-48) }));
fs.writeFileSync(process.argv[2], JSON.stringify(res, null, 1));
for (const v of res.vids || []) console.log('vid', v.url.slice(-40), 'cold', JSON.stringify(v.cold), 'warm', JSON.stringify(v.warm));
for (const i of res.imgs || []) console.log('img', i.url.slice(-40), 'cold', JSON.stringify(i.cold), 'warm', JSON.stringify(i.warm));
for (const n of res.net) console.log(' net', n.url, n.range, n.status, 'cf', n.cf, 'disk', n.disk, 'ttfb', n.ttfb, n.proto);
ws.close();
