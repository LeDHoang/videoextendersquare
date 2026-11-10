// Cold probe in the existing Quest tab: per run, net-internals "Clear host cache" + "Flush socket pools",
// HTTP cache disabled, navigate to URL, read Navigation Timing. Restores /reels?xrdiag=1 at the end.
const PORT = 9334, N = +(process.env.N || 5), HOME = 'https://echomultiverse.com/reels?xrdiag=1';
const urls = JSON.parse(process.argv[2]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find(x => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map(); ws.onmessage = m => { const d = JSON.parse(m.data); pend.get(d.id)?.(d); };
const call = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await call('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const NAV = `(async()=>{for(let i=0;i<120;i++){const e=performance.getEntriesByType('navigation')[0];if(e&&e.responseEnd>0&&location.href!=='about:blank'){const r=x=>Math.round(x);
return {code:e.responseStatus,proto:e.nextHopProtocol,dns:r(e.domainLookupEnd-e.domainLookupStart),conn:r(e.connectEnd-e.connectStart),
tls:e.secureConnectionStart>0?r(e.connectEnd-e.secureConnectionStart):null,ttfb:r(e.responseStart-e.startTime),req_to_first_byte:r(e.responseStart-e.requestStart),total:r(e.responseEnd-e.startTime)}}
await new Promise(r=>setTimeout(r,250))}return null})()`;
const med = a => { a = a.filter(x => x != null).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };

await call('Network.enable'); await call('Network.setCacheDisabled', { cacheDisabled: true });
const out = {};
try {
  for (const [name, url] of Object.entries(urls)) {
    const rows = [];
    for (let i = 0; i < N; i++) {
      await call('Page.navigate', { url: 'chrome://net-internals/#sockets' }); await sleep(1200);
      await ev(`document.getElementById('dns-view-clear-cache').click();document.getElementById('sockets-view-flush-button').click();true`);
      await sleep(500);
      await call('Page.navigate', { url }); await sleep(300);
      const row = (await ev(NAV)) ?? { err: 'no nav timing' };
      rows.push(row); console.error(name, i, JSON.stringify(row));
    }
    const ok = rows.filter(r => r && r.ttfb != null);
    out[name] = { n: ok.length, codes: [...new Set(rows.map(r => r?.code ?? r?.err))], proto: ok[0]?.proto,
      dns: med(ok.map(r => r.dns)), conn: med(ok.map(r => r.conn)), tls: med(ok.map(r => r.tls)),
      ttfb: med(ok.map(r => r.ttfb)), req_to_first_byte: med(ok.map(r => r.req_to_first_byte)), total: med(ok.map(r => r.total)) };
  }
} finally {
  await call('Network.setCacheDisabled', { cacheDisabled: false });
  await call('Page.navigate', { url: HOME });
}
console.log(JSON.stringify(out, null, 1));
process.exit(0);
