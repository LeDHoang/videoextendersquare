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
  ws.addEventListener('open', () => send('Target.getTargets'));
  let sid = null;
  ws.addEventListener('message', async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.result && m.result.targetInfos) {
      const page = m.result.targetInfos.find(t => (t.url || '').includes('localhost:5173') || (t.url || '').includes('localhost:8000'));
      if (page) send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    }
    if (m.params && m.params.sessionId && !sid) {
      sid = m.params.sessionId;
      send('Runtime.evaluate', {
        expression: `(() => {
          const cells = Array.from(document.querySelectorAll('.sx-spec-cell')).map(c => c.innerText);
          const vrState = window.WebXRVR?.getPreviewState?.();
          return { cells, vrState };
        })()`,
        returnByValue: true
      }, sid);
    }
    if (m.result && m.result.result && m.result.result.value) {
      console.log('CURRENT STATS:', JSON.stringify(m.result.result.value, null, 2));
      process.exit(0);
    }
  });
}
test().catch(console.error);
