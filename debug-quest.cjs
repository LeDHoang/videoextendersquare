// Raw CDP bridge: connect directly to a Quest browser tab's webSocketDebuggerUrl,
// enable Runtime+Log, evaluate a playback/perf probe, and capture console logs.
// Zero dependencies — uses Node 26 global fetch + WebSocket.

const REELS_HOST = 'localhost:5173/reels';

async function probeTab(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const send = (method, params = {}) => ws.send(JSON.stringify({ id: nextId++, method, params }));
    const events = [];
    const consoleLogs = [];
    let evalResult = null;
    let closed = false;

    ws.addEventListener('open', () => {
      send('Runtime.enable');
      send('Log.enable');
      // Big evaluate that returns playback + decode + rAF cadence.
      const expr = `(async () => {
        const v = document.querySelector('video');
        const c = document.querySelector('canvas');
        let glInfo = null;
        try {
          if (c) {
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            if (gl) {
              const dbg = gl.getExtension('WEBGL_debug_renderer_info');
              glInfo = {
                renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
                drawBuf: [gl.drawingBufferWidth, gl.drawingBufferHeight],
              };
            }
          }
        } catch(e){ glInfo = {err:String(e)}; }
        const pq = (v && v.getVideoPlaybackQuality) ? v.getVideoPlaybackQuality() : null;
        const raf = [];
        await new Promise(r => {
          let last = performance.now(), start = last;
          (function tick(t){ if(last!==null) raf.push(t-last); last=t; if(t-start<1000) requestAnimationFrame(tick); else r(); })(start);
        });
        raf.sort((a,b)=>a-b);
        return {
          url: location.href,
          video: v ? {
            src: (v.src||v.currentSrc||'').slice(0,110),
            paused: v.paused, ready: v.readyState,
            ct: +v.currentTime.toFixed(2), dur: +(v.duration||0).toFixed(2),
            vw: v.videoWidth, vh: v.videoHeight, rate: v.playbackRate,
            webkitDecoded: v.webkitDecodedFrameCount, webkitDropped: v.webkitDroppedFrameCount,
            pqTotal: pq?pq.totalVideoFrames:null, pqDropped: pq?pq.droppedVideoFrames:null, pqCorrupt: pq?pq.corruptedVideoFrames:null,
          } : 'no-video',
          gl: glInfo,
          xrPresenting: navigator.xr ? !!(navigator.xr.isPresenting) : 'no-xr',
          dpr: window.devicePixelRatio, cores: navigator.hardwareConcurrency,
          rafN: raf.length, rafMed: +raf[raf.length>>1]?.toFixed(2), rafOver20: raf.filter(x=>x>20).length,
        };
      })()`;
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    });

    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && m.result) { if (m.result.result) evalResult = m.result.result.value; }
      if (m.method === 'Runtime.consoleAPICalled') {
        consoleLogs.push(`[${m.params.type}] ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
      }
      if (m.method === 'Log.entryAdded') {
        consoleLogs.push(`[log:${m.params.entry.level}] ${m.params.entry.text}`);
      }
    });

    ws.addEventListener('error', (e) => { if (!closed) { closed = true; resolve({ error: String(e) }); } });

    // Wait 2.5s after eval result to collect console events, then close.
    const check = setInterval(() => {
      if (evalResult !== null || closed) {
        clearInterval(check);
        setTimeout(() => {
          if (!closed) { closed = true; try { ws.close(); } catch(e){} resolve({ eval: evalResult, console: consoleLogs.slice(-15) }); }
        }, evalResult !== null ? 1200 : 0);
      }
    }, 100);

    setTimeout(() => { if (!closed) { closed = true; try { ws.close(); } catch(e){} resolve({ eval: evalResult, console: consoleLogs.slice(-15), timeout: true }); } }, 8000);
  });
}

(async () => {
  const res = await fetch('http://localhost:9222/json');
  const tabs = await res.json();
  const reels = tabs.filter(t => t.type === 'page' && (t.url || '').includes(REELS_HOST));
  if (!reels.length) { console.error('No reels tab. Tabs:', tabs.map(t=>t.url).join('\n')); process.exit(1); }
  for (const t of reels) {
    console.log('\n===== TAB', t.url.slice(0, 70), '=====');
    const out = await probeTab(t.webSocketDebuggerUrl);
    console.log(JSON.stringify(out.eval ?? out, null, 2));
    if (out.console && out.console.length) { console.log('--- console ---'); console.log(out.console.join('\n')); }
  }
})();
