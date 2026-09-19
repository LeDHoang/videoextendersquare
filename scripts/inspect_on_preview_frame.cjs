async function test() {
  const verRes = await fetch('http://localhost:9222/json/version');
  const ver = await verRes.json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 1;
  const send = (method, params = {}, sessionId) => {
    const msgId = id++;
    const payload = { id: msgId, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return msgId;
  };
  ws.addEventListener('open', () => {
    send('Target.attachToTarget', { targetId: '87D641BA3D788F8F18319A6A3A05ED6A', flatten: true });
  });
  ws.addEventListener('message', async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.params && m.params.sessionId) {
      const sid = m.params.sessionId;
      send('Runtime.enable', {}, sid);
      send('Log.enable', {}, sid);
      
      const inspectCode = `(() => {
        const vr = window.WebXRVR;
        const state = vr ? vr.getPreviewState() : null;
        return {
          state,
          previewRunning: vr?.isPreviewRunning?.(),
          // Test calling startPreview again to see if it throws or what it returns!
          restartResult: (() => {
            try {
              const canvas = document.querySelector('.sx-immersive-preview-canvas');
              return vr.startPreview(canvas, { cameraMode: 'headset', sceneMode: 'reels' });
            } catch(e) {
              return { error: e.message, stack: e.stack };
            }
          })()
        };
      })()`;
      send('Runtime.evaluate', { expression: inspectCode, returnByValue: true }, sid);
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      console.log('[BROWSER CONSOLE]', ...(m.params.args || []).map(a => a.value || a.description));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.error('[BROWSER EXCEPTION]', m.params.exceptionDetails);
    }
    if (m.result && m.result.result && m.result.result.value) {
      console.log('RESTART EVAL:', JSON.stringify(m.result.result.value, null, 2));
      setTimeout(() => {
        send('Runtime.evaluate', {
          expression: 'JSON.stringify(window.WebXRVR?.getPreviewState?.())',
          returnByValue: true
        }, m.sessionId);
      }, 1000);
    }
    if (m.result && m.result.result && typeof m.result.result.value === 'string' && m.result.result.value.includes('reelDrawCalls')) {
      console.log('AFTER 1s:', m.result.result.value);
      process.exit(0);
    }
  });
}
test().catch(console.error);
