const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = '/Users/hoangleduc/.gemini/antigravity-ide/brain/612f5585-456c-49e6-b7fb-1dbaf5d96ad0';

async function main() {
  const verRes = await fetch('http://localhost:9222/json/version');
  const ver = await verRes.json();
  const browserWsUrl = ver.webSocketDebuggerUrl;
  console.log(`Connecting to browser CDP: ${browserWsUrl}`);

  const ws = new WebSocket(browserWsUrl);
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
    setTimeout(() => send('Target.getTargets'), 300);
  });

  let reelsTarget = null;
  let sessionId = null;
  let evalMsgId = null;
  let shotMsgId = null;

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);

    // 1. Discover targets
    if (m.result && m.result.targetInfos) {
      reelsTarget = m.result.targetInfos.find(t => (t.url || '').includes('/reels'));
      if (!reelsTarget) {
        console.error('No reels target found among:', m.result.targetInfos.map(t => t.url));
        process.exit(1);
      }
      console.log(`Found reels target: ${reelsTarget.url} (id: ${reelsTarget.targetId})`);
      send('Target.attachToTarget', { targetId: reelsTarget.targetId, flatten: true });
    }

    // 2. Attached
    if (!sessionId && (m.method === 'Target.attachedToTarget' || (m.result && m.result.sessionId))) {
      sessionId = m.params?.sessionId || m.result?.sessionId;
      console.log(`Attached with sessionId: ${sessionId}`);

      // Probe Three.js and WebXR
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

        return {
          url: location.href,
          title: document.title,
          hasTHREE: typeof three !== 'undefined',
          threeRevision: three ? three.REVISION : null,
          hasOrbitControls: three ? typeof three.OrbitControls : null,
          hasXRControllerModelFactory: three ? typeof three.XRControllerModelFactory : null,
          hasWebXRVR: typeof vr !== 'undefined',
          vrVersion: vr ? vr.version : null,
          hasGetThree: vr ? typeof vr.getThree : null,
          getThreeReturnsInstance: (vr && vr.getThree) ? (vr.getThree() === three) : false,
          curvatureTest,
          canvases: Array.from(document.querySelectorAll('canvas')).map(c => ({
            id: c.id,
            width: c.width,
            height: c.height
          }))
        };
      })()`;

      evalMsgId = send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
    }

    // 3. Eval Result
    if (m.id === evalMsgId) {
      console.log('\n=== THREE.JS & WEBXR CDP REPORT ===');
      console.log(JSON.stringify(m.result?.result?.value ?? m.result, null, 2));
      shotMsgId = send('Page.captureScreenshot', { format: 'png' }, sessionId);
    }

    // 4. Screenshot Result
    if (m.id === shotMsgId && m.result?.data) {
      const buf = Buffer.from(m.result.data, 'base64');
      const outPath = path.join(ARTIFACT_DIR, 'threejs_reels_cdp_verified.png');
      fs.writeFileSync(outPath, buf);
      console.log(`Saved screenshot to ${outPath} (${buf.length} bytes)`);
      setTimeout(() => {
        ws.close();
        process.exit(0);
      }, 500);
    }
  });

  setTimeout(() => {
    console.log('Timeout reached');
    process.exit(0);
  }, 10000);
}

main().catch(console.error);
