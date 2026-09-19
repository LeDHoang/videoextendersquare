const fs = require('fs');

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

      send('Page.navigate', { url: 'http://localhost:5173/reels/immersive-preview' }, sessionId);

      // Wait 5 seconds for React and player to fully mount
      setTimeout(async () => {
        console.log('\n=== Evaluating Immersive Preview Detailed State ===');
        const evalCode = `(() => {
          const canvas = document.querySelector('.sx-immersive-preview-canvas');
          const errorBox = document.querySelector('.sx-error-box');
          const vr = window.WebXRVR;
          const previewState = vr ? vr.getPreviewState() : null;
          
          let pixelSample = null;
          if (canvas) {
            try {
              const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
              if (gl) {
                const pixels = new Uint8Array(4 * 4 * 4);
                gl.readPixels(canvas.width / 2, canvas.height / 2, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                pixelSample = Array.from(pixels.slice(0, 16));
              }
            } catch(e) {
              pixelSample = 'error: ' + e.message;
            }
          }

          const statusPill = document.querySelector('.sx-stats-pill');
          const specCells = Array.from(document.querySelectorAll('.sx-spec-cell')).map(c => c.innerText);

          return {
            title: document.title,
            errorBox: errorBox ? errorBox.innerText : null,
            statusPill: statusPill ? statusPill.innerText : null,
            specCells,
            previewState,
            canvasClient: canvas ? [canvas.clientWidth, canvas.clientHeight] : null,
            canvasInternal: canvas ? [canvas.width, canvas.height] : null,
            pixelSample,
            video: (() => {
              const v = document.querySelector('video');
              return v ? { src: v.src, readyState: v.readyState, paused: v.paused, currentTime: v.currentTime, videoWidth: v.videoWidth, videoHeight: v.videoHeight } : null;
            })()
          };
        })()`;

        send('Runtime.evaluate', { expression: evalCode, returnByValue: true }, sessionId);

        // Take a screenshot and save it
        setTimeout(() => {
          send('Page.captureScreenshot', { format: 'png' }, sessionId);
        }, 1500);

      }, 5000);
    }

    if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map(a => a.value || a.description || JSON.stringify(a));
      console.log(`[CONSOLE ${m.params.type}]`, ...args);
    }

    if (m.method === 'Runtime.exceptionThrown') {
      const exc = m.params.exceptionDetails;
      console.error(`[EXCEPTION] ${exc.text} at line ${exc.lineNumber}:${exc.columnNumber} - ${exc.exception?.description || ''}`);
    }

    if (m.result && m.result.result && m.result.result.value !== undefined) {
      console.log('\n--- EVAL RESULT ---');
      console.log(JSON.stringify(m.result.result.value, null, 2));
    }

    if (m.result && m.result.data) {
      const buf = Buffer.from(m.result.data, 'base64');
      fs.writeFileSync('/Users/hoangleduc/.gemini/antigravity-ide/brain/612f5585-456c-49e6-b7fb-1dbaf5d96ad0/live_preview_now.png', buf);
      console.log('Successfully saved /Users/hoangleduc/.gemini/antigravity-ide/brain/612f5585-456c-49e6-b7fb-1dbaf5d96ad0/live_preview_now.png (' + buf.length + ' bytes)');
      setTimeout(() => process.exit(0), 500);
    }
  });
}

main().catch(console.error);
