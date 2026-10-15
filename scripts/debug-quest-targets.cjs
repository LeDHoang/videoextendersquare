async function main() {
  let wsUrl = process.argv[2];
  if (!wsUrl) {
    try {
      const res = await fetch('http://localhost:9222/json/version');
      if (res.ok) {
        const info = await res.json();
        wsUrl = info.webSocketDebuggerUrl;
      }
    } catch (e) {
      // ignore
    }
  }

  if (!wsUrl) {
    console.log('Meta Quest CDP Target Discovery');
    console.log('Usage: node debug-quest-targets.cjs [webSocketDebuggerUrl]');
    console.log('\nNo active Quest CDP target found at http://localhost:9222.');
    console.log('To connect to Quest Browser via USB:');
    console.log('  1. Connect Quest 3 via USB and enable USB Debugging');
    console.log('  2. adb forward tcp:9222 localabstract:chrome_devtools_remote');
    console.log('  3. Open Quest Browser to http://localhost:5173/reels');
    console.log('  4. Re-run: node debug-quest-targets.cjs\n');
    process.exit(0);
  }

  const ws = new WebSocket(wsUrl);
  let id = 1;
  const send = (m, p={}) => ws.send(JSON.stringify({id:id++, method:m, params:p}));
  ws.addEventListener('open', () => {
    send('Target.setDiscoverTargets', { discover: true });
    setTimeout(() => send('Target.getTargets'), 300);
  });

ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && m.result && m.result.targetInfos) {
    console.log('=== ALL TARGETS ===');
    for (const t of m.result.targetInfos) {
      if (t.type === 'page' || (t.url||'').includes('localhost')) {
        console.log(t.type, '|', t.url.slice(0,90), '| attached:', t.attached, '| targetId:', t.targetId, '| ws:', t.browserContextId);
      }
    }
    // Now try to attach to each localhost page target and probe it.
    let pending = m.result.targetInfos.filter(t => (t.url||'').includes('localhost'));
    probeNext(pending);
  }
});
function probeNext(list){
  if(!list.length){ setTimeout(()=>{ws.close(); process.exit(0);}, 1500); return; }
  const t = list.shift();
  // Attach to target to get a sessionId, then evaluate.
  id++; const attachId = id;
  ws.send(JSON.stringify({id:attachId, method:'Target.attachToTarget', params:{targetId:t.targetId, flatten:true}}));
  const handler = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === attachId && m.result) {
      const sid = m.result.sessionId;
      const expr = `(async()=>{
        const v = document.querySelector('video');
        const pq = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
        const c = document.querySelector('canvas');
        let g = null;
        try {
          if (c) {
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            if (gl) {
              const d = gl.getExtension('WEBGL_debug_renderer_info');
              g = {
                ren: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
                db: [gl.drawingBufferWidth, gl.drawingBufferHeight]
              };
            }
          }
        } catch(e) { g = { err: String(e) }; }

        const three = window.THREE;
        const vr = window.WebXRVR;
        let curvatureTest = null;
        if (vr && vr.setCurvatureMode && vr.getCurvatureMode) {
          const orig = vr.getCurvatureMode();
          vr.setCurvatureMode('dome');
          const dome = vr.getCurvatureMode();
          vr.setCurvatureMode('flat');
          const flat = vr.getCurvatureMode();
          vr.setCurvatureMode('curved');
          const curved = vr.getCurvatureMode();
          curvatureTest = { orig, dome, flat, curved };
        }

        return {
          url: location.href,
          title: document.title,
          three: three ? {
            revision: three.REVISION,
            hasOrbitControls: typeof three.OrbitControls === 'function',
            hasXRControllerModelFactory: typeof three.XRControllerModelFactory === 'function'
          } : null,
          webxr_vr: vr ? {
            version: vr.version,
            hasGetThree: typeof vr.getThree === 'function',
            threeInstanceMatches: vr.getThree ? (vr.getThree() === three) : false,
            curvatureTest: curvatureTest
          } : null,
          video: v ? {
            src: (v.src || v.currentSrc || '').slice(0, 110),
            paused: v.paused,
            ready: v.readyState,
            ct: +v.currentTime.toFixed(2),
            dur: +(v.duration || 0).toFixed(2),
            vw: v.videoWidth,
            vh: v.videoHeight
          } : null,
          gl: g,
          xr: navigator.xr ? !!(navigator.xr.isPresenting) : 'no-xr',
          dpr: window.devicePixelRatio,
          cores: navigator.hardwareConcurrency
        };
      })()`;
      const evalId = id++;
      ws.send(JSON.stringify({id:evalId, sessionId:sid, method:'Runtime.evaluate', params:{expression:expr, returnByValue:true, awaitPromise:true}}));
      ws.removeEventListener('message', handler);
      const h2 = (e2) => {
        const m2 = JSON.parse(e2.data);
        if (m2.id === evalId) {
          console.log('\n=== PROBE:', t.url.slice(0,60), '===');
          console.log(JSON.stringify(m2.result?.result?.value ?? m2.result, null, 2));
          ws.removeEventListener('message', h2);
          setTimeout(()=>probeNext(list), 200);
        }
      };
      ws.addEventListener('message', h2);
    }
  };
    ws.addEventListener('message', handler);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
