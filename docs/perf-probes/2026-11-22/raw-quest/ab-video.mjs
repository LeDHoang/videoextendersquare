// Run ab-video.html on the Quest for each clip under a throttle; print a summary. Serve the page and clips with ab-serve.mjs on 8099 and `adb reverse tcp:8099 tcp:8099`. usage: MBPS=10 node ab-video.mjs <out.json> <secs> clip...
import fs from 'node:fs';
const [out, secs, ...clips] = process.argv.slice(2); const sleep = ms => new Promise(r => setTimeout(r, ms));
import { pickTab } from './pick.mjs';
const tab = await pickTab();
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); } });
const call = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x, g = false) => (await call('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: g })).result?.value;
await call('Page.enable'); await call('Network.enable'); await call('Network.setCacheDisabled', { cacheDisabled: true });
await call('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: +process.env.MBPS * 125000, uploadThroughput: 2500000 });
await call('Page.navigate', { url: 'http://localhost:8099/ab-video.html' }); await sleep(3000);
const res = {};
for (const [i, c] of clips.entries()) {
  console.log(c, await ev(`go('http://localhost:8099/${c}.mp4?r=${Date.now()}')`, true));
  await sleep(+secs * 1000); res[c + '#' + i] = await ev('window.log');
  const L = res[c + '#' + i], S = L.filter(x => x.k === 's');
  const end = L.find(x => x.k === 'ended'), w = L.filter(x => x.k === 'waiting').length;
  const ahead = S.filter(x => !x.paused && !x.ended && x.ct > x.bt + 0.3).length * 0.25;
  const firstEndClock = (S.find(x => x.ct >= 6.4) || {}).t;
  console.log(`  waiting=${w} clockAheadOfBuffer_s=${ahead} clockAtEnd_ms=${firstEndClock} ended_ms=${end && end.t} last=${JSON.stringify(L[L.length - 1])}`);
  await ev(`v.pause(); v.removeAttribute('src'); v.load(); 1`);
}
fs.writeFileSync(out, JSON.stringify(res));
await call('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await call('Page.navigate', { url: 'https://echomultiverse.com/reels' }); await sleep(1000); process.exit(0);
