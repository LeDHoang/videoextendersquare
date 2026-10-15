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
    send('Target.getTargets');
  });
  let sid = null;
  ws.addEventListener('message', async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.result && m.result.targetInfos) {
      const page = m.result.targetInfos.find(t => (t.url || '').includes('localhost:5173/reels'));
      if (page) send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    }
    if (m.params && m.params.sessionId && !sid) {
      sid = m.params.sessionId;
      send('Runtime.enable', {}, sid);
      send('Log.enable', {}, sid);
      
      // Let's test calling enterVR directly from inside a user gesture event listener!
      console.log('Attaching click listener to document to trigger enterVR on user gesture...');
      send('Runtime.evaluate', {
        expression: `(() => {
          let lastResult = null;
          document.body.addEventListener('click', async () => {
            console.log('[TEST] Body clicked! Calling WebXRVR.enterVR()...');
            try {
              const res = await window.WebXRVR.enterVR();
              console.log('[TEST] enterVR resolved:', res);
            } catch (err) {
              console.error('[TEST] enterVR threw:', err);
            }
          }, { once: true });
          return { ready: true };
        })()`,
        returnByValue: true
      }, sid);

      // Now dispatch mouse click via CDP (which counts as a trusted user gesture!)
      setTimeout(() => {
        console.log('Dispatching mouse click on body to trigger user gesture...');
        send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 200, button: 'left', clickCount: 1 }, sid);
        send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y: 200, button: 'left', clickCount: 1 }, sid);
      }, 1000);

      // Check results after 3 seconds
      setTimeout(() => {
        send('Runtime.evaluate', {
          expression: `(() => ({
            isPresenting: window.WebXRVR?.isPresenting?.(),
            xrErr: window.__xrErr,
            xrGL: window.__xrGL,
            xrPresented: window.__xrPresented
          }))()`,
          returnByValue: true
        }, sid);
      }, 3500);
    }

    if (m.method === 'Runtime.consoleAPICalled') {
      console.log('[BROWSER CONSOLE]', ...(m.params.args || []).map(a => a.value || a.description));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.error('[BROWSER EXCEPTION]', m.params.exceptionDetails);
    }
    if (m.result && m.result.result && m.result.result.value && m.result.result.value.isPresenting !== undefined) {
      console.log('ENTER VR RESULT:', JSON.stringify(m.result.result.value, null, 2));
      process.exit(0);
    }
  });
}
test().catch(console.error);
