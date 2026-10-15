const fs = require('fs');

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
      send('Runtime.enable', {}, sid);
      send('Log.enable', {}, sid);
      send('Page.navigate', { url: 'http://localhost:5173/reels/immersive-preview' }, sid);
      setTimeout(() => {
        console.log('Clicking EARTH ACTIVITY button...');
        send('Runtime.evaluate', {
          expression: `(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const earthBtn = btns.find(b => b.innerText.includes('EARTH'));
            if (earthBtn) earthBtn.click();
            return { clicked: !!earthBtn, state: window.WebXRVR?.getPreviewState?.() };
          })()`,
          returnByValue: true
        }, sid);
      }, 3500);
      setTimeout(() => {
        send('Runtime.evaluate', {
          expression: 'JSON.stringify(window.WebXRVR?.getPreviewState?.())',
          returnByValue: true
        }, sid);
      }, 5000);
      setTimeout(() => {
        send('Page.captureScreenshot', { format: 'png' }, sid);
      }, 6000);
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      console.log('[CONSOLE]', ...(m.params.args || []).map(a => a.value || a.description));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.error('[EXCEPTION]', m.params.exceptionDetails);
    }
    if (m.result && m.result.result && m.result.result.value) {
      console.log('STATE:', m.result.result.value);
    }
    if (m.result && m.result.data) {
      const buf = Buffer.from(m.result.data, 'base64');
      fs.writeFileSync('/Users/hoangleduc/.gemini/antigravity-ide/brain/612f5585-456c-49e6-b7fb-1dbaf5d96ad0/earth_preview_click.png', buf);
      console.log('Saved earth_preview_click.png');
      process.exit(0);
    }
  });
}
test().catch(console.error);
