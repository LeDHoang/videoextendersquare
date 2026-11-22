// In VR: skip image posts fast, let every video play out; log video events + quality; screenshot a hang.
// usage: node mon2.mjs <out.json> [secs=240]
import fs from 'node:fs'; import { execSync } from 'node:child_process';
import { pickTab } from './pick.mjs';
const out = process.argv[2], SECS = +(process.argv[3] || 240);
const tab = await pickTab();
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const t0 = Date.now(); const reqs = new Map(), done = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); return; }
  const p = m.params || {}, t = Date.now() - t0;
  if (m.method === 'Network.requestWillBeSent') reqs.set(p.requestId, { at: t, url: p.request.url.split('?')[0].slice(-60), range: (p.request.headers || {}).Range || null, b: 0 });
  else if (m.method === 'Network.responseReceived' && reqs.has(p.requestId)) Object.assign(reqs.get(p.requestId), { status: p.response.status, cf: (p.response.headers || {})['cf-cache-status'] || null, fromCache: p.response.fromDiskCache || p.response.fromMemoryCache || false });
  else if (m.method === 'Network.dataReceived' && reqs.has(p.requestId)) reqs.get(p.requestId).b += p.encodedDataLength || p.dataLength;
  else if ((m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') && reqs.has(p.requestId)) { const r = reqs.get(p.requestId); r.end = t; if (p.errorText) r.failed = p.errorText; done.push(r); reqs.delete(p.requestId); } });
const call = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression, g = false) => { const r = await Promise.race([call('Runtime.evaluate', { expression, returnByValue: true, userGesture: g }), new Promise(r => setTimeout(() => r(null), 4000))]); return r && r.result ? r.result.value : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
await call('Network.enable', { maxTotalBufferSize: 0 });
await ev(`(()=>{const v=document.getElementById('reelsVideo'); window.__mv=[]; const b=s=>String(s||'').split('?')[0].split('/').pop().slice(-40);
 ['waiting','stalled','playing','ended','seeking','seeked','emptied','loadstart','canplay','canplaythrough','suspend','pause','error'].forEach(n=>v.addEventListener(n,()=>{let be=0;try{for(let i=0;i<v.buffered.length;i++)if(v.buffered.start(i)<=v.currentTime+0.1&&v.buffered.end(i)>=v.currentTime)be=v.buffered.end(i)-v.currentTime}catch(e){}
   window.__mv.push({k:n,t:Math.round(performance.now()),src:b(v.currentSrc),ct:+v.currentTime.toFixed(2),be:+be.toFixed(2),rs:v.readyState})}));return true})()`);
const EXPR = `(()=>{const v=document.getElementById('reelsVideo'),im=document.getElementById('reelsImage');const b=s=>String(s||'').split('?')[0].split('/').pop().slice(-40);
 let be=0,bt=0;try{for(let i=0;i<v.buffered.length;i++){bt=v.buffered.end(i);if(v.buffered.start(i)<=v.currentTime+0.1&&v.buffered.end(i)>=v.currentTime)be=v.buffered.end(i)-v.currentTime}}catch(e){}
 const q=v.getVideoPlaybackQuality?v.getVideoPlaybackQuality():{};let vs=null;try{vs=WebXRVR.__test.getVisualSourceState()}catch(e){}
 return {pt:Math.round(performance.now()),img:im.style.display!=='none',vid:v.style.display!=='none'&&!!v.getAttribute('src'),src:b(v.currentSrc),rs:v.readyState,ns:v.networkState,ct:+v.currentTime.toFixed(2),dur:+(v.duration||0).toFixed(2),be:+be.toFixed(2),bt:+bt.toFixed(2),paused:v.paused,ended:v.ended,tot:q.totalVideoFrames,drop:q.droppedVideoFrames,vs:vs&&[vs.kind,vs.ready],xr:WebXRVR.isPresenting()}})()`;
const samples = []; let curKey = '', keyAt = 0, shot = new Set();
while (Date.now() - t0 < SECS * 1000) {
  const s = await ev(EXPR); const t = Date.now() - t0;
  if (!s) { samples.push({ t, timeout: 1 }); continue; }
  s.t = t; samples.push(s);
  const key = s.vid ? 'V:' + s.src : 'I';
  if (key !== curKey || (key === 'I' && s.vs && s.vs[1] && t - keyAt > 1500)) {
    if (key !== curKey) { console.log(t, key, s.dur); curKey = key; keyAt = t; }
    if (key === 'I' && s.vs && s.vs[1] && t - keyAt > 1500) { await ev(`WebXRVR.__test.executeControl('next')`, true); keyAt = t; }
  }
  if (s.vid && s.dur && s.ct >= s.dur - 0.15 && !s.ended && !shot.has(s.src) && t - keyAt > 3000) {
    shot.add(s.src); try { execSync(`adb exec-out screencap -p > hang-${shot.size}.png`); console.log(t, 'hang screenshot', s.src); } catch (e) { console.log('screencap failed'); } }
  await sleep(400);
}
const mv = await ev('window.__mv');
for (const r of reqs.values()) done.push({ ...r, open: 1 });
fs.writeFileSync(out, JSON.stringify({ t0pt: samples.find(s => s.pt)?.pt - samples.find(s => s.pt)?.t, samples, mv, reqs: done }));
console.log('done', samples.length, (mv || []).length);
process.exit(0);
