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

  ws.addEventListener('message', (ev) => {
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

      // Enable console & runtime domains
      send('Runtime.enable', {}, sessionId);
      send('Log.enable', {}, sessionId);
      send('Page.enable', {}, sessionId);

      // Navigate to http://localhost:5173/reels/immersive-preview
      console.log('Navigating to http://localhost:5173/reels/immersive-preview...');
      send('Page.navigate', { url: 'http://localhost:5173/reels/immersive-preview' }, sessionId);

      setTimeout(async () => {
        console.log('Gathering diagnostics after 4s...');
        const expr = `(() => {
          const vr = window.WebXRVR;
          const three = window.THREE;
          const canvas = document.querySelector('.sx-immersive-preview-canvas');
          const errorBox = document.querySelector('.sx-error-box');

          let vrState = null;
          if (vr && vr.getPreviewState) {
            try { vrState = vr.getPreviewState(); } catch(e) { vrState = { error: String(e) }; }
          }

          return {
            title: document.title,
            errorBoxText: errorBox ? errorBox.innerText : null,
            hasCanvas: !!canvas,
            canvasSize: canvas ? [canvas.clientWidth, canvas.clientHeight, canvas.width, canvas.height] : null,
            hasTHREE: !!three,
            hasWebXRVR: !!vr,
            vrMethods: vr ? Object.keys(vr) : [],
            vrState,
            windowErrors: window.__lastErrors || []
          };
        })()`;

        const evalMsgId = send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
      }, 4000);
    }

    if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map(a => a.value || a.description || JSON.stringify(a));
      const logLine = `[BROWSER CONSOLE ${m.params.type}] ${args.join(' ')}`;
      console.log(logLine);
      consoleLogs.push(logLine);
    }

    if (m.method === 'Runtime.exceptionThrown') {
      const exc = m.params.exceptionDetails;
      const errLine = `[BROWSER EXCEPTION] ${exc.text} at ${exc.url}:${exc.lineNumber}:${exc.columnNumber} - ${exc.exception?.description || ''}`;
      console.error(errLine);
      pageErrors.push(errLine);
    }

    if (m.id && m.result && m.result.result && m.result.result.value) {
      console.log('\n--- DIAGNOSTICS RESULT ---');
      console.log(JSON.stringify(m.result.result.value, null, 2));

      // Take screenshot
      send('Page.captureScreenshot', { format: 'png' }, sessionId);
    }

    if (m.result && m.result.data) {
      const buf = Buffer.from(m.result.data, 'base64');
      const outPath = path.join('/Users/hoangleduc/.gemini/antigravity-ide/brain/612f5585-456c-49e6-b7fb-1dbaf5d96ad0', 'immersive_preview_debug.png');
      fs.writeFileSync(outPath, buf);
      console.log(`Saved screenshot to ${outPath}`);
      ws.close();
      process.exit(0);
    }
  });

  setTimeout(() => {
    console.log('Timeout reached');
    process.exit(0);
  }, 10000);
}

main().catch(console.error);
