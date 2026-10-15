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
      send('Page.enable', {}, sid);

      // Scroll to top
      send('Runtime.evaluate', {
        expression: 'window.scrollTo({ top: 0, behavior: \"instant\" });'
      }, sid);

      setTimeout(() => {
        send('Page.captureScreenshot', { format: 'png' }, sid);
      }, 500);
    }

    if (m.result && m.result.data) {
      const buf = Buffer.from(m.result.data, 'base64');
      require('fs').writeFileSync('/Users/hoangleduc/.gemini/antigravity-ide/brain/612f5585-456c-49e6-b7fb-1dbaf5d96ad0/full_preview_toolbar_view.png', buf);
      console.log('Saved /Users/hoangleduc/.gemini/antigravity-ide/brain/612f5585-456c-49e6-b7fb-1dbaf5d96ad0/full_preview_toolbar_view.png');
      process.exit(0);
    }
  });
}
test().catch(console.error);
