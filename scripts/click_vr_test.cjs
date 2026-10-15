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
      send('Page.enable', {}, sid);
      
      console.log('Navigating to http://localhost:5173/reels...');
      send('Page.navigate', { url: 'http://localhost:5173/reels' }, sid);

      setTimeout(() => {
        console.log('Looking for VR button on /reels...');
        send('Runtime.evaluate', {
          expression: `(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const vrBtn = btns.find(b => b.innerText.trim() === 'VR' || b.getAttribute('aria-label')?.includes('VR') || b.title?.includes('VR'));
            if (!vrBtn) {
              return { found: false, allBtns: btns.map(b => b.innerText.trim()).filter(Boolean) };
            }
            const rect = vrBtn.getBoundingClientRect();
            return {
              found: true,
              id: vrBtn.id,
              className: vrBtn.className,
              rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
            };
          })()`,
          returnByValue: true
        }, sid);
      }, 4000);
    }

    if (m.method === 'Runtime.consoleAPICalled') {
      console.log('[CONSOLE]', ...(m.params.args || []).map(a => a.value || a.description));
    }

    if (m.method === 'Runtime.exceptionThrown') {
      console.error('[EXCEPTION]', m.params.exceptionDetails);
    }

    if (m.result && m.result.result && m.result.result.value && m.result.result.value.found !== undefined) {
      const vrInfo = m.result.result.value;
      console.log('VR Button info:', vrInfo);
      if (vrInfo.found) {
        const x = Math.round(vrInfo.rect.x + vrInfo.rect.width / 2);
        const y = Math.round(vrInfo.rect.y + vrInfo.rect.height / 2);
        console.log(`Simulating user click on VR button at (${x}, ${y})...`);
        send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid);
        send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid);
        
        setTimeout(() => {
          send('Runtime.evaluate', {
            expression: `(() => ({
              isPresenting: window.WebXRVR?.isPresenting?.(),
              xrErr: window.__xrErr,
              xrGL: window.__xrGL,
              hasXrSession: !!window.WebXRVR?.__test?.getXrSession?.()
            }))()`,
            returnByValue: true
          }, sid);
        }, 2000);

        setTimeout(() => {
          send('Page.captureScreenshot', { format: 'png' }, sid);
        }, 3000);
      } else {
        process.exit(1);
      }
    }

    if (m.result && m.result.result && m.result.result.value && m.result.result.value.isPresenting !== undefined) {
      console.log('Post-click VR state:', m.result.result.value);
    }

    if (m.result && m.result.data) {
      const buf = Buffer.from(m.result.data, 'base64');
      require('fs').writeFileSync('/Users/hoangleduc/.gemini/antigravity-ide/brain/612f5585-456c-49e6-b7fb-1dbaf5d96ad0/vr_click_result.png', buf);
      console.log('Saved vr_click_result.png (' + buf.length + ' bytes)');
      process.exit(0);
    }
  });
}
test();
