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
        expression: `JSON.stringify({
          vrState: window.WebXRVR?.getPreviewState?.(),
          pill: document.querySelector('.sx-stats-pill')?.innerText,
          cells: Array.from(document.querySelectorAll('.sx-stat-cell')).map(c => c.innerText.replace(/\\n/g, ' '))
        })`,
        returnByValue: true
      }, sid);
    }
    if (m.result && m.result.result && m.result.result.value) {
      console.log('LIVE STATE:', m.result.result.value);
      process.exit(0);
    }
  });
}
test().catch(console.error);
