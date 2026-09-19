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

  ws.addEventListener('open', () => send('Target.getTargets'));

  let targetId = null;
  let sessionId = null;

  ws.addEventListener('message', async (ev) => {
    const m = JSON.parse(ev.data);

    if (m.result && m.result.targetInfos && !targetId) {
      const page = m.result.targetInfos.find(t => (t.url || '').includes('localhost:5173/reels/immersive-preview'));
      if (!page) {
        console.error('No immersive preview page found among targets');
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

      console.log('Reloading /reels/immersive-preview...');
      send('Page.navigate', { url: 'http://localhost:5173/reels/immersive-preview' }, sessionId);

      // Wait 4 seconds for mount & first frames
      setTimeout(async () => {
        console.log('\n=== STEP 1: Inspect Initial State ===');
        const s1 = `(() => {
          const vr = window.WebXRVR;
          const pill = document.querySelector('.sx-stats-pill')?.innerText;
          const statCells = Array.from(document.querySelectorAll('.sx-stat-cell')).map(c => c.innerText.replace(/\\n/g, ' '));
          const buttons = Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(Boolean);
          return {
            hasTHREE: !!vr?.getThree?.(),
            threeVersion: vr?.getThree?.()?.REVISION,
            hasOrbitControls: !!vr?.getThree?.()?.OrbitControls,
            curvatureMode: vr?.getCurvatureMode?.(),
            previewRunning: vr?.isPreviewRunning?.(),
            state: vr?.getPreviewState?.(),
            pill,
            statCells,
            buttons
          };
        })()`;
        send('Runtime.evaluate', { expression: s1, returnByValue: true }, sessionId);

        // Step 2: Toggle Curvature to SQ CURVE
        setTimeout(() => {
          console.log('\n=== STEP 2: Toggle Curvature to SQ CURVE ===');
          const s2 = `(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const sqBtn = btns.find(b => b.innerText.trim() === 'SQ CURVE');
            if (sqBtn) sqBtn.click();
            return {
              clicked: !!sqBtn,
              curve: window.WebXRVR?.getCurvatureMode?.(),
              pill: document.querySelector('.sx-stats-pill')?.innerText
            };
          })()`;
          send('Runtime.evaluate', { expression: s2, returnByValue: true }, sessionId);
        }, 1500);

        // Step 3: Toggle Curvature to FLAT
        setTimeout(() => {
          console.log('\n=== STEP 3: Toggle Curvature to FLAT ===');
          const s3 = `(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const flatBtn = btns.find(b => b.innerText.trim() === 'FLAT');
            if (flatBtn) flatBtn.click();
            return {
              clicked: !!flatBtn,
              curve: window.WebXRVR?.getCurvatureMode?.(),
              pill: document.querySelector('.sx-stats-pill')?.innerText
            };
          })()`;
          send('Runtime.evaluate', { expression: s3, returnByValue: true }, sessionId);
        }, 3000);

        // Step 4: Toggle Orbit Inspect
        setTimeout(() => {
          console.log('\n=== STEP 4: Switch to ORBIT INSPECT ===');
          const s4 = `(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const orbitBtn = btns.find(b => b.innerText.trim() === 'ORBIT INSPECT');
            if (orbitBtn) orbitBtn.click();
            return {
              clicked: !!orbitBtn,
              cameraMode: window.WebXRVR?.getPreviewState?.()?.cameraMode,
              pill: document.querySelector('.sx-stats-pill')?.innerText
            };
          })()`;
          send('Runtime.evaluate', { expression: s4, returnByValue: true }, sessionId);
        }, 4500);

        // Step 5: Switch back to DOME and HEADSET POV
        setTimeout(() => {
          console.log('\n=== STEP 5: Switch back to DOME and HEADSET POV ===');
          const s5 = `(() => {
            window.WebXRVR.setCurvatureMode('dome');
            window.WebXRVR.setPreviewCameraMode('headset');
            return {
              curve: window.WebXRVR?.getCurvatureMode?.(),
              camera: window.WebXRVR?.getPreviewState?.()?.cameraMode,
              statCells: Array.from(document.querySelectorAll('.sx-stat-cell')).map(c => c.innerText.replace(/\\n/g, ' '))
            };
          })()`;
          send('Runtime.evaluate', { expression: s5, returnByValue: true }, sessionId);
        }, 6000);

        // Step 6: Capture high-res screenshot
        setTimeout(() => {
          console.log('\n=== STEP 6: Capture Screenshot ===');
          send('Page.captureScreenshot', { format: 'png' }, sessionId);
        }, 7500);

      }, 4000);
    }

    if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map(a => a.value || a.description || JSON.stringify(a));
      console.log(`[CONSOLE ${m.params.type}]`, ...args);
    }

    if (m.method === 'Runtime.exceptionThrown') {
      console.error('[EXCEPTION]', m.params.exceptionDetails);
    }

    if (m.result && m.result.result && m.result.result.value) {
      console.log('EVAL VALUE:', JSON.stringify(m.result.result.value, null, 2));
    }

    if (m.result && m.result.data) {
      const buf = Buffer.from(m.result.data, 'base64');
      fs.writeFileSync('/Users/hoangleduc/.gemini/antigravity-ide/brain/612f5585-456c-49e6-b7fb-1dbaf5d96ad0/threejs_live_parity_verified.png', buf);
      console.log('Saved /Users/hoangleduc/.gemini/antigravity-ide/brain/612f5585-456c-49e6-b7fb-1dbaf5d96ad0/threejs_live_parity_verified.png (' + buf.length + ' bytes)');
      process.exit(0);
    }
  });
}

main().catch(console.error);
