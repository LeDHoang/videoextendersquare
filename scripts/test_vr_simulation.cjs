const fs = require('fs');
const path = require('path');

async function main() {
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

  const consoleLogs = [];
  const pageErrors = [];

  ws.addEventListener('open', () => {
    send('Target.setDiscoverTargets', { discover: true });
    setTimeout(() => send('Target.getTargets'), 200);
  });

  let targetId = null;
  let sessionId = null;

  ws.addEventListener('message', async (ev) => {
    const m = JSON.parse(ev.data);

    if (m.result && m.result.targetInfos && !targetId) {
      const page = m.result.targetInfos.find(t => (t.url || '').includes('localhost:5173') || (t.url || '').includes('localhost:8000'));
      if (!page) {
        console.error('No suitable tab found');
        process.exit(1);
      }
      targetId = page.targetId;
      console.log(`Attaching to target: ${page.url} (${targetId})`);
      send('Target.attachToTarget', { targetId, flatten: true });
    }

    if (!sessionId && (m.method === 'Target.attachedToTarget' || (m.result && m.result.sessionId))) {
      sessionId = m.params?.sessionId || m.result?.sessionId;
      console.log(`Attached with sessionId: ${sessionId}`);

      send('Runtime.enable', {}, sessionId);
      send('Log.enable', {}, sessionId);
      send('Page.enable', {}, sessionId);

      // Navigate to /reels/immersive-preview
      console.log('Navigating to http://localhost:5173/reels/immersive-preview');
      send('Page.navigate', { url: 'http://localhost:5173/reels/immersive-preview' }, sessionId);

      // Wait 3s, then check preview state and test UI actions
      setTimeout(async () => {
        console.log('\n--- Checking Preview State at 3s ---');
        send('Runtime.evaluate', {
          expression: `(() => {
            const vr = window.WebXRVR;
            return {
              running: vr?.isPreviewRunning?.(),
              state: vr?.getPreviewState?.(),
              hasTHREE: !!window.THREE,
              threeVersion: window.THREE?.REVISION
            };
          })()`,
          returnByValue: true
        }, sessionId);

        // Test Orbit Mode
        setTimeout(() => {
          console.log('\n--- Switching to ORBIT mode ---');
          send('Runtime.evaluate', {
            expression: `(() => {
              window.WebXRVR.setPreviewCameraMode('orbit');
              return window.WebXRVR.getPreviewState();
            })()`,
            returnByValue: true
          }, sessionId);
        }, 1500);

        // Test Earth Mode
        setTimeout(() => {
          console.log('\n--- Switching to EARTH scene mode ---');
          send('Runtime.evaluate', {
            expression: `(() => {
              window.WebXRVR.setSceneMode('earth');
              return window.WebXRVR.getPreviewState();
            })()`,
            returnByValue: true
          }, sessionId);
        }, 3000);

        // Test Switching back to REELS mode
        setTimeout(() => {
          console.log('\n--- Switching back to REELS mode ---');
          send('Runtime.evaluate', {
            expression: `(() => {
              window.WebXRVR.setSceneMode('reels');
              return window.WebXRVR.getPreviewState();
            })()`,
            returnByValue: true
          }, sessionId);
        }, 4500);

        // Now test VR entry simulation!
        setTimeout(() => {
          console.log('\n--- Testing enterVR() simulation ---');
          send('Runtime.evaluate', {
            expression: `(async () => {
              const vr = window.WebXRVR;
              try {
                console.log('navigator.xr supported:', !!navigator.xr);
                const isImmersiveSupported = navigator.xr ? await navigator.xr.isSessionSupported('immersive-vr') : false;
                console.log('immersive-vr supported:', isImmersiveSupported);
                const res = await vr.enterVR();
                return { success: true, res, isPresenting: vr.isPresenting() };
              } catch (e) {
                return { success: false, error: e.message || String(e), stack: e.stack };
              }
            })()`,
            awaitPromise: true,
            returnByValue: true
          }, sessionId);
        }, 6000);

        // Capture screenshot at 8s
        setTimeout(() => {
          console.log('\n--- Capturing screenshot ---');
          send('Page.captureScreenshot', { format: 'png' }, sessionId);
        }, 8000);

        setTimeout(() => {
          console.log('\nTest completed. Summary of errors:', pageErrors);
          process.exit(0);
        }, 9000);

      }, 3000);
    }

    if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map(a => a.value || a.description || JSON.stringify(a));
      const logLine = `[CONSOLE ${m.params.type}] ${args.join(' ')}`;
      console.log(logLine);
      consoleLogs.push(logLine);
    }

    if (m.method === 'Runtime.exceptionThrown') {
      const exc = m.params.exceptionDetails;
      const errLine = `[EXCEPTION] ${exc.text} at ${exc.url}:${exc.lineNumber}:${exc.columnNumber} - ${exc.exception?.description || ''}`;
      console.error(errLine);
      pageErrors.push(errLine);
    }

    if (m.result && m.result.result && m.result.result.value !== undefined) {
      console.log('EVAL RESULT:', JSON.stringify(m.result.result.value, null, 2));
    }

    if (m.result && m.result.data) {
      const buf = Buffer.from(m.result.data, 'base64');
      fs.writeFileSync('preview_investigation.png', buf);
      console.log('Saved preview_investigation.png (' + buf.length + ' bytes)');
    }
  });
}

main().catch(console.error);
