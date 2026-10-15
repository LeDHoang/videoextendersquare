const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = '/Users/hoangleduc/.gemini/antigravity-ide/brain/612f5585-456c-49e6-b7fb-1dbaf5d96ad0';

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
  let navMsgId = null;
  let evalMsgId = null;
  let shotMsgId = null;

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);

    if (m.result && m.result.targetInfos && !targetId) {
      const page = m.result.targetInfos.find(t => (t.url || '').includes('localhost:8000') || (t.url || '').includes('localhost:5173'));
      if (!page) {
        console.error('No suitable page tab found');
        process.exit(1);
      }
      targetId = page.targetId;
      console.log(`Attaching to target: ${page.url} (${targetId})`);
      send('Target.attachToTarget', { targetId, flatten: true });
    }

    if (!sessionId && (m.method === 'Target.attachedToTarget' || (m.result && m.result.sessionId))) {
      sessionId = m.params?.sessionId || m.result?.sessionId;
      console.log(`Attached with sessionId: ${sessionId}`);

      // Navigate to /api/reels/player
      console.log('Navigating to http://localhost:8000/api/reels/player...');
      navMsgId = send('Page.navigate', { url: 'http://localhost:8000/api/reels/player' }, sessionId);

      // Wait 3s after navigation then evaluate
      setTimeout(() => {
        console.log('Evaluating Three.js and WebXR runtime state...');
        const expr = `(() => {
          const three = window.THREE;
          const vr = window.WebXRVR;
          let curvatureTest = null;
          if (vr && vr.setCurvatureMode && vr.getCurvatureMode) {
            const orig = vr.getCurvatureMode();
            vr.setCurvatureMode('dome');
            const dome = vr.getCurvatureMode();
            vr.setCurvatureMode('flat');
            const flat = vr.getCurvatureMode();
            vr.setCurvatureMode('sq_curve');
            const curved = vr.getCurvatureMode();
            curvatureTest = { orig, dome, flat, curved };
          }

          let glInfo = null;
          const c = document.querySelector('canvas');
          if (c) {
            try {
              const gl = c.getContext('webgl2') || c.getContext('webgl');
              if (gl) {
                glInfo = {
                  vendor: gl.getParameter(gl.VENDOR),
                  renderer: gl.getParameter(gl.RENDERER),
                  db: [gl.drawingBufferWidth, gl.drawingBufferHeight],
                };
              }
            } catch(e) { glInfo = { err: String(e) }; }
          }

          return {
            url: location.href,
            title: document.title,
            hasTHREE: typeof three !== 'undefined',
            threeRevision: three ? three.REVISION : null,
            hasOrbitControls: three ? typeof three.OrbitControls === 'function' : false,
            hasXRControllerModelFactory: three ? typeof three.XRControllerModelFactory === 'function' : false,
            hasWebXRVR: typeof vr !== 'undefined',
            vrVersion: vr ? (vr.version || vr.vrVersion || null) : null,
            hasGetThree: vr ? typeof vr.getThree === 'function' : false,
            getThreeMatchesInstance: (vr && vr.getThree) ? (vr.getThree() === three) : false,
            curvatureTest,
            canvases: Array.from(document.querySelectorAll('canvas')).map(cv => ({
              id: cv.id,
              w: cv.width,
              h: cv.height,
              style: cv.style.cssText
            })),
            gl: glInfo,
            vrButtonPresent: !!document.getElementById('vrBtn') || !!document.getElementById('vr-button') || !!document.querySelector('.vr-btn')
          };
        })()`;

        evalMsgId = send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
      }, 3000);
    }

    if (m.id === evalMsgId) {
      console.log('\n========================================');
      console.log('LIVE THREE.JS & WEBXR VERIFICATION REPORT');
      console.log('========================================');
      const val = m.result?.result?.value ?? m.result;
      console.log(JSON.stringify(val, null, 2));

      // Now capture a high-res screenshot of the live player
      shotMsgId = send('Page.captureScreenshot', { format: 'png' }, sessionId);
    }

    if (m.id === shotMsgId && m.result?.data) {
      const buf = Buffer.from(m.result.data, 'base64');
      const outPath = path.join(ARTIFACT_DIR, 'threejs_reels_player_live.png');
      fs.writeFileSync(outPath, buf);
      console.log(`\nScreenshot saved: ${outPath} (${buf.length} bytes)`);
      setTimeout(() => {
        ws.close();
        process.exit(0);
      }, 500);
    }
  });

  setTimeout(() => {
    console.log('Verification completed or timeout reached.');
    process.exit(0);
  }, 12000);
}

main().catch(console.error);
