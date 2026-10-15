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

      console.log('Testing Curvature Mode Buttons Click...');
      // 1. Click SQ CURVE
      setTimeout(() => {
        send('Runtime.evaluate', {
          expression: `(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const sqBtn = btns.find(b => b.innerText.trim() === 'SQ CURVE');
            if (sqBtn) sqBtn.click();
            return {
              clicked: !!sqBtn,
              state: window.WebXRVR?.getPreviewState?.(),
              pill: document.querySelector('.sx-stats-pill')?.innerText
            };
          })()`,
          returnByValue: true
        }, sid);
      }, 500);

      // 2. Click FLAT after 1.5s
      setTimeout(() => {
        send('Runtime.evaluate', {
          expression: `(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const flatBtn = btns.find(b => b.innerText.trim() === 'FLAT');
            if (flatBtn) flatBtn.click();
            return {
              clicked: !!flatBtn,
              state: window.WebXRVR?.getPreviewState?.(),
              pill: document.querySelector('.sx-stats-pill')?.innerText
            };
          })()`,
          returnByValue: true
        }, sid);
      }, 2000);

      // 3. Click DOME after 3.5s
      setTimeout(() => {
        send('Runtime.evaluate', {
          expression: `(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const domeBtn = btns.find(b => b.innerText.trim() === 'DOME');
            if (domeBtn) domeBtn.click();
            return {
              clicked: !!domeBtn,
              state: window.WebXRVR?.getPreviewState?.(),
              pill: document.querySelector('.sx-stats-pill')?.innerText
            };
          })()`,
          returnByValue: true
        }, sid);
      }, 3500);

      // 4. Capture screenshot after 4.5s
      setTimeout(() => {
        send('Page.captureScreenshot', { format: 'png' }, sid);
      }, 4500);
    }

    if (m.result && m.result.result && m.result.result.value && m.result.result.value.clicked !== undefined) {
      console.log('CLICK RESULT:', JSON.stringify(m.result.result.value, null, 2));
    }

    if (m.result && m.result.data) {
      const buf = Buffer.from(m.result.data, 'base64');
      require('fs').writeFileSync('/Users/hoangleduc/.gemini/antigravity-ide/brain/612f5585-456c-49e6-b7fb-1dbaf5d96ad0/curvature_toggles_verified.png', buf);
      console.log('Saved /Users/hoangleduc/.gemini/antigravity-ide/brain/612f5585-456c-49e6-b7fb-1dbaf5d96ad0/curvature_toggles_verified.png (' + buf.length + ' bytes)');
      process.exit(0);
    }
  });
}
test().catch(console.error);
