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
      
      const evalStr = `(() => {
        // Let's inspect why onPreviewFrame stopped
        const v = document.querySelector('video');
        const c = document.querySelector('.sx-immersive-preview-canvas');
        return {
          previewRunning: window.WebXRVR?.isPreviewRunning?.(),
          video: v ? { src: v.src, paused: v.paused, currentTime: v.currentTime, readyState: v.readyState } : null,
          canvas: c ? { width: c.width, height: c.height } : null
        };
      })()`;
      send('Runtime.evaluate', { expression: evalStr, returnByValue: true }, sid);
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      console.log('[BROWSER CONSOLE]', ...(m.params.args || []).map(a => a.value || a.description));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.error('[BROWSER EXCEPTION]', m.params.exceptionDetails);
    }
    if (m.result && m.result.result && m.result.result.value) {
      console.log('DIAGNOSTICS:', JSON.stringify(m.result.result.value, null, 2));
      process.exit(0);
    }
  });
}
test().catch(console.error);
