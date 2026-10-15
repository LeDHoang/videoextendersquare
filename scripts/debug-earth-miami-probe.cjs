const fs = require('fs');
const { spawn } = require('child_process');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9226;
const USER_DATA_DIR = '/tmp/echo_chrome_earth_miami_debug';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForPort(port, maxTries = 40) {
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch (e) {}
    await sleep(200);
  }
  throw new Error(`Chrome debug port ${port} did not become available`);
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
      this.ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.callbacks.has(m.id)) {
          const { resolve, reject } = this.callbacks.get(m.id);
          this.callbacks.delete(m.id);
          if (m.error) reject(m.error);
          else resolve(m.result);
        }
      });
    });
  }

  call(method, params = {}, sessionId) {
    const msgId = this.id++;
    const payload = { id: msgId, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.callbacks.set(msgId, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try { this.ws.close(); } catch (e) {}
  }
}

async function run() {
  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--headless=new',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=1440,1100',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    const version = await waitForPort(DEBUG_PORT);
    const browser = new CDPClient(version.webSocketDebuggerUrl);
    await browser.connect();

    const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.call('Target.attachToTarget', { targetId, flatten: true });

    await browser.call('Network.enable', {}, sessionId);
    await browser.call('Runtime.enable', {}, sessionId);
    await browser.call('Page.enable', {}, sessionId);

    await browser.call('Network.setCookie', {
      name: 'echo_session',
      value: 'echo_master_test_session_token_1234567890',
      domain: 'localhost',
      path: '/'
    }, sessionId);
    await browser.call('Network.setCookie', {
      name: 'echo_csrf',
      value: 'echo_master_test_csrf_token_1234567890',
      domain: 'localhost',
      path: '/'
    }, sessionId);

    console.log('Navigating to immersive preview...');
    await browser.call('Page.navigate', { url: 'http://localhost:5173/reels/immersive-preview' }, sessionId);
    await sleep(3500);

    console.log('Activating earth mode and zooming to Miami with selection...');
    const evalRes = await browser.call('Runtime.evaluate', {
      expression: `
        (async function() {
          for (let i = 0; i < 40; i++) {
            if (window.WebXRVR && window.WebXRVR.__test) break;
            await new Promise(r => setTimeout(r, 200));
          }
          const vr = window.WebXRVR;
          const api = vr && vr.__test;
          if (!api) return { error: 'No WebXRVR' };

          vr.setSceneMode('earth');

          for (let i = 0; i < 30; i++) {
            const s = api.getEarthState();
            if (s && s.locationSlugs && s.locationSlugs.length > 0) break;
            await new Promise(r => setTimeout(r, 200));
          }

          const state0 = api.getEarthState();
          const slugs = state0.locationSlugs || [];
          let miamiIdx = slugs.findIndex(s => s && s.toLowerCase().includes('miami'));
          if (miamiIdx < 0) miamiIdx = 0;
          api.setEarthHoveredIndex(miamiIdx);

          // Zoom into Miami at S=32
          api.zoomEarthTo(25.7617, -80.1918, 32);

          // Wait for tiles, dressing and preview to settle
          await new Promise(r => setTimeout(r, 4000));

          const sceneInfo = api.getSceneInfo();
          const state = api.getEarthState();
          const tileStats = api.earthTileStats();

          let labelProbe = null;
          try {
            const labelMesh = api.getLabelMesh ? api.getLabelMesh() : null;
            const cam = api.getCamera ? api.getCamera() : null;
            if (labelMesh && cam) {
              const THREE = window.THREE;
              const wp = new THREE.Vector3();
              labelMesh.getWorldPosition(wp);
              const ndc = wp.clone().project(cam);
              const canvas = labelMesh.material && labelMesh.material.map ? labelMesh.material.map.image : null;
              let canvasProbe = null;
              if (canvas && canvas.getContext) {
                const ctx = canvas.getContext('2d');
                const idata = ctx.getImageData(0, 0, canvas.width, canvas.height);
                let nonZero = 0;
                for (let i = 3; i < idata.data.length; i += 4) {
                  if (idata.data[i] > 10) nonZero++;
                }
                canvasProbe = {
                  w: canvas.width,
                  h: canvas.height,
                  totalPixels: canvas.width * canvas.height,
                  nonZeroAlphaPixels: nonZero
                };
              }

              let centerPixel = null;
              try {
                const cEl = document.querySelector('.sx-immersive-preview-canvas');
                if (cEl) {
                  const gl = cEl.getContext('webgl2') || cEl.getContext('webgl');
                  if (gl) {
                    const p = new Uint8Array(4);
                    // In WebGL, Y=0 is bottom
                    // Our NDC Y = -0.0819 -> canvas Y = 0.5 + (-0.0819 / 2) = 0.459
                    const px = Math.floor(cEl.width * 0.5);
                    const py = Math.floor(cEl.height * 0.459);
                    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
                    centerPixel = { px, py, r: p[0], g: p[1], b: p[2], a: p[3] };
                  }
                }
              } catch (e) {
                centerPixel = { err: String(e && e.message || e) };
              }

              const rend = api.getRenderer ? api.getRenderer() : null;
              labelProbe = {
                worldPos: { x: wp.x, y: wp.y, z: wp.z },
                ndc: { x: ndc.x, y: ndc.y, z: ndc.z },
                visible: labelMesh.visible,
                parent: labelMesh.parent ? labelMesh.parent.type : null,
                matOpacity: labelMesh.material ? labelMesh.material.opacity : null,
                matVisible: labelMesh.material ? labelMesh.material.visible : null,
                renderOrder: labelMesh.renderOrder,
                texVersion: labelMesh.material && labelMesh.material.map ? labelMesh.material.map.version : null,
                texNeedsUpdate: labelMesh.material && labelMesh.material.map ? labelMesh.material.map.needsUpdate : null,
                centerPixel,
                canvasProbe
              };
            }
          } catch (e) {
            labelProbe = { err: String(e && e.message || e) };
          }

          return {
            slugs,
            miamiIdx,
            sceneInfo,
            state,
            tileStats,
            labelProbe
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    console.log('Miami Probe Evaluation Result:', JSON.stringify(evalRes.result ? evalRes.result.value : evalRes, null, 2));

    await sleep(500);
    const screenshot = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    if (!fs.existsSync('logs')) fs.mkdirSync('logs');
    fs.writeFileSync('logs/debug-earth-miami-screenshot.png', Buffer.from(screenshot.data, 'base64'));
    console.log('Saved screenshot to logs/debug-earth-miami-screenshot.png');

    browser.close();
  } finally {
    chromeProc.kill();
  }
}

run().catch(err => {
  console.error('Miami probe failed:', err);
  process.exit(1);
});
