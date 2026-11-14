// VR soak on the live page: passive auto-advance, then a swipe every 3 s. Logs tab crashes, exceptions,
// console errors, video errors, XR session end/visibility and reel changes. usage: node soak.mjs <out.json> [passiveS] [swipeS]
import fs from 'node:fs';
const out = process.argv[2], PASS = Number(process.argv[3] || 150), SWIPE = Number(process.argv[4] || 150); const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = list.find(x => x.type === 'page' && /echomultiverse/.test(x.url));
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 1; const pend = new Map(); const log = { started: Date.now(), events: [], samples: [] };
const note = (k, x) => { const e = { wall: Date.now() - log.started, k, ...x }; log.events.push(e); console.log(JSON.stringify(e).slice(0, 300)); };
ws.addEventListener('close', () => note('ws-closed'));
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); return; }
  const p = m.params || {};
  if (m.method === 'Inspector.targetCrashed' || m.method === 'Target.targetCrashed') note('TAB-CRASHED', p);
  else if (m.method === 'Inspector.detached') note('inspector-detached', p);
  else if (m.method === 'Runtime.exceptionThrown') note('exception', { text: String(p.exceptionDetails.exception?.description || p.exceptionDetails.text).slice(0, 500) });
  else if (m.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) note('console-' + p.type, { text: p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
  else if (m.method === 'Log.entryAdded' && p.entry.level === 'error') note('log-error', { text: String(p.entry.text).slice(0, 300), url: (p.entry.url || '').slice(-80) });
  else if (m.method === 'Page.frameNavigated' && !p.frame.parentId) note('navigated', { url: p.frame.url });
  else if (m.method === 'Network.loadingFailed' && !p.canceled) note('net-failed', { err: p.errorText, type: p.type });
  else if (m.method === 'Network.responseReceived' && p.response.status >= 400) note('http-' + p.response.status, { url: p.response.url.slice(-90) }); });
const send = (method, params = {}) => new Promise(res => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression, g = false) => { const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: g }), sleep(8000).then(() => ({ timeout: true }))]); return r.timeout ? { TIMEOUT: 1 } : r.exceptionDetails ? { EXC: r.exceptionDetails.exception?.description } : r.result?.value; };
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable'); await send('Inspector.enable');
await send('Page.navigate', { url: 'https://echomultiverse.com/reels' });
for (let i = 0; i < 40 && !(await ev('!!(window.WebXRVR && document.getElementById("vrBtn"))')); i++) await sleep(1000);
await sleep(3000);
await ev(`(()=>{const w=window.__soak={ev:[]};const v=document.getElementById('reelsVideo');const push=(k,x)=>w.ev.push(Object.assign({k,t:Math.round(performance.now())},x||{}));
 ['error','stalled','waiting','emptied','abort'].forEach(n=>v.addEventListener(n,()=>push('v-'+n,{src:(v.currentSrc||'').split('/').pop().slice(-40),code:v.error&&v.error.code,msg:v.error&&v.error.message,rs:v.readyState})));
 window.addEventListener('error',e=>push('win-error',{msg:String(e.message).slice(0,200)}));window.addEventListener('unhandledrejection',e=>push('unhandled',{msg:String(e.reason&&e.reason.message||e.reason).slice(0,200)}));
 ['echo:vr-enter','echo:vr-exit'].forEach(n=>window.addEventListener(n,()=>push(n)));
 const rs=navigator.xr.requestSession.bind(navigator.xr);navigator.xr.requestSession=async(...a)=>{const s=await rs(...a);w.s=s;push('xr-session');s.addEventListener('end',()=>push('xr-end'));s.addEventListener('visibilitychange',()=>push('xr-vis',{vis:s.visibilityState}));return s;};
 document.querySelectorAll('canvas').forEach(c=>c.addEventListener('webglcontextlost',()=>push('webgl-context-lost')));
 new MutationObserver(()=>{const e=document.getElementById('errorTitle');const box=e&&e.closest('[hidden],[style]');push('error-ui',{title:e&&e.textContent,shown:!!(e&&e.offsetParent)})}).observe(document.getElementById('errorTitle'),{childList:true,characterData:true,subtree:true});
 return 'hooked'})()`);
const SAMPLE = `(()=>{const w=window.__soak,v=document.getElementById('reelsVideo'),im=document.getElementById('reelsImage');const e=w.ev;w.ev=[];const img=im&&im.style.display!=='none';const et=document.getElementById('errorTitle');
 return {t:Math.round(performance.now()),presenting:!!(window.WebXRVR&&WebXRVR.isPresenting()),vis:w.s?w.s.visibilityState:null,cur:(img?'img:':'vid:')+((img?im.currentSrc:v.currentSrc)||'').split('/').pop().slice(-34),rs:v.readyState,ct:+v.currentTime.toFixed(1),paused:v.paused,err:v.error?v.error.code:null,errUi:!!(et&&et.offsetParent),heap:performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null,ev:e}})()`;
await ev(`document.getElementById('vrBtn').click()`, true); await sleep(1200);
if (await ev(`(()=>{const p=document.getElementById('vrNoticePanel'); return !!p && !p.hidden;})()`)) await ev(`document.getElementById('vrNoticeContinue').click()`, true);
note('entered-click');
const t0 = Date.now(); let last = '';
while (Date.now() - t0 < (PASS + SWIPE) * 1000) {
  const s = await ev(SAMPLE);
  if (s && s.t) { s.wall = Date.now() - log.started; log.samples.push(s); for (const e of s.ev) note('page:' + e.k, e); if (s.cur !== last) { note('reel', { cur: s.cur, presenting: s.presenting, vis: s.vis }); last = s.cur; } if (s.errUi) note('ERROR-UI-SHOWN', { cur: s.cur }); }
  else note('sample-fail', { s: JSON.stringify(s).slice(0, 200) });
  if (Date.now() - t0 > PASS * 1000) { await ev(`document.getElementById('edgeNextBtn').click()`, true); await sleep(2000); } else await sleep(1000);
}
note('final', { s: JSON.stringify(await ev(SAMPLE)).slice(0, 400) });
await ev(`window.WebXRVR && WebXRVR.exitVR && WebXRVR.exitVR()`, true); await sleep(2000);
fs.writeFileSync(out, JSON.stringify(log, null, 1)); ws.close(); process.exit(0);
