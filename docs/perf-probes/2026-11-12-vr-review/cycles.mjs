// Memory across VR enter/exit cycles on the live page. usage: node cycles.mjs <out.json> [cycles]
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const out = process.argv[2], N = Number(process.argv[3] || 4); const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = list.find(x => x.type === 'page' && /echomultiverse/.test(x.url));
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 1; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression, g = false) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: g }); return r.exceptionDetails ? { EXC: r.exceptionDetails.exception?.description } : r.result?.value; };
const pss = () => { try { const t = execFileSync('adb', ['shell', 'dumpsys', 'meminfo'], { encoding: 'utf8', timeout: 40000, maxBuffer: 1 << 26 });
  const sec = t.slice(t.indexOf('Total PSS by process'), t.indexOf('Total PSS by OOM')); const o = {}; let sum = 0;
  for (const m of sec.matchAll(/([\d,]+)K: (com\.oculus\.browser[^ ]*)/g)) { const mb = Math.round(Number(m[1].replace(/,/g, '')) / 1024); const k = m[2].replace('com.oculus.browser', 'br').replace(/sandboxed_process\d+.*/, 'renderer').replace(/privileged_process\d+.*/, 'gpu'); o[k] = (o[k] || 0) + mb; sum += mb; }
  const fr = /Free RAM:\s+([\d,]+)K/.exec(t); return { sum, ...o, freeMB: fr ? Math.round(Number(fr[1].replace(/,/g, '')) / 1024) : null }; } catch (e) { return { err: String(e).slice(0, 80) }; } };
const procs = () => [];
const state = () => ev(`JSON.stringify({heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null, canv: document.querySelectorAll('canvas').length, vids: document.querySelectorAll('video').length, presenting: !!(window.WebXRVR && WebXRVR.isPresenting()), gl: (()=>{try{const t=WebXRVR.__test; return t && t.rendererInfo ? t.rendererInfo() : null}catch(e){return null}})()})`);
const log = { started: Date.now(), rows: [] };
const rec = async name => { const st = await state(); const row = { name, wall: Date.now(), page: typeof st === 'string' ? JSON.parse(st) : st, pss: pss() }; log.rows.push(row); console.log(JSON.stringify(row)); };
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: 'https://echomultiverse.com/reels?xrdiag=1' }); for (let i = 0; i < 40 && !(await ev('!!(window.WebXRVR && document.getElementById("vrBtn"))')); i++) await sleep(1000);
await sleep(4000);
await rec('2d-start'); log.procs0 = procs();
for (let c = 1; c <= N; c++) {
  await ev(`document.getElementById('vrBtn').click()`, true); await sleep(1200);
  if (await ev(`(()=>{const p=document.getElementById('vrNoticePanel'); return !!p && !p.hidden;})()`)) await ev(`document.getElementById('vrNoticeContinue').click()`, true);
  let p = false; for (let i = 0; i < 30 && !p; i++) { p = await ev('WebXRVR.isPresenting()'); if (!p) await sleep(500); }
  if (!p) { await rec('enter-failed-' + c); break; }
  await sleep(5000); await ev(`document.getElementById('edgeNextBtn').click()`, true); await sleep(5000);
  await rec('vr-' + c);
  await ev(`WebXRVR.exitVR()`, true); await sleep(5000);
  await rec('exit-' + c);
}
log.procs1 = procs();
fs.writeFileSync(out, JSON.stringify(log, null, 1)); ws.close(); process.exit(0);
