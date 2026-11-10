// usage: node quest_probe.mjs <ws-url>  -- runs a warm fetch probe inside the Quest browser page
const ws = new WebSocket(process.argv[2]);
const pageFn = async () => {
  const B = location.origin, N = 15;
  performance.setResourceTimingBufferSize(5000);
  const txt = async u => (await fetch(u, { cache: 'no-store' })).text();
  const trace = Object.fromEntries((await txt(B + '/cdn-cgi/trace')).trim().split('\n').map(l => l.split('=')));
  const js = (await txt(B + '/')).match(/\/assets\/index-[\w-]+\.js/)[0];
  const items = JSON.parse(await txt(B + '/api/reels/feed')).items.filter(i => i.poster_url && i.url).slice(0, 5);
  const T = {
    edge_trace: [B + '/cdn-cgi/trace'], healthz: [B + '/api/healthz'], feed: [B + '/api/reels/feed'],
    reels: [B + '/api/reels'], player: [B + '/api/reels/player'], spa_index: [B + '/'], spa_js: [B + js],
    r2_poster: [items[0].poster_url], r2_mp4_1MB: [items[0].url, { Range: 'bytes=0-1048575' }],
  };
  const med = a => { a = a.filter(x => x != null).sort((x, y) => x - y); return a.length ? Math.round(a[a.length >> 1]) : null; };
  const out = { colo: trace.colo, loc: trace.loc, ua: navigator.userAgent, targets: {} };
  for (const [k, [u, h]] of Object.entries(T)) {
    const rows = [];
    for (let i = 0; i < N; i++) {
      performance.clearResourceTimings();
      const t0 = performance.now();
      let code = 0, size = 0;
      try { const r = await fetch(u, { cache: 'no-store', headers: h || {} }); code = r.status; size = (await r.arrayBuffer()).byteLength; } catch (e) { code = String(e); }
      const t1 = performance.now();
      const e = performance.getEntriesByType('resource').find(x => x.name.startsWith(u.split('?')[0]));
      const ok = e && e.responseStart > 0;
      rows.push({ code, size, total: t1 - t0, ttfb: ok ? e.responseStart - e.requestStart : null,
        conn: ok ? e.connectEnd - e.connectStart : null, proto: e?.nextHopProtocol });
    }
    const w = rows.slice(1);
    out.targets[k] = { codes: [...new Set(rows.map(r => r.code))], size: rows[0].size, proto: rows[0].proto,
      first_total: Math.round(rows[0].total), first_conn: rows[0].conn == null ? null : Math.round(rows[0].conn),
      warm_ttfb: med(w.map(r => r.ttfb)), warm_total: med(w.map(r => r.total)) };
  }
  return out;
};
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
  params: { expression: `(${pageFn})()`, awaitPromise: true, returnByValue: true, timeout: 600000 } }));
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id !== 1) return;
  console.log(JSON.stringify(d.result?.result?.value ?? d, null, 1)); ws.close(); };
