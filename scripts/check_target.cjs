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
      send('Runtime.evaluate', {
        expression: `(() => {
          const cells = Array.from(document.querySelectorAll('.sx-spec-cell')).map(c => c.innerText);
          const vrState = window.WebXRVR?.getPreviewState?.();
          const pill = document.querySelector('.sx-stats-pill')?.innerText;
          return { pill, cells, vrState };
        })()`,
        returnByValue: true
      }, sid);
    }
    if (m.result && m.result.result && m.result.result.value) {
      console.log('TARGET 87D641BA STATS:', JSON.stringify(m.result.result.value, null, 2));
      process.exit(0);
    }
  });
}
test().catch(console.error);
