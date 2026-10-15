const fs = require('fs');
const { spawn } = require('child_process');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9225;
const USER_DATA_DIR = '/tmp/echo_chrome_earth_debug3';

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
    '--window-size=1280,720',
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

    const networkFails = [];
    const consoleLogs = [];

    browser.ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.method === 'Runtime.consoleAPICalled') {
          consoleLogs.push({ type: m.params.type, text: m.params.args.map(a => a.value || a.description).join(' ') });
        } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
          networkFails.push({ url: m.params.response.url, status: m.params.response.status });
        } else if (m.method === 'Network.loadingFailed') {
          networkFails.push({ url: m.params.url, error: m.params.errorText });
        }
      } catch (e) {}
    });

    await browser.call('Page.navigate', { url: 'http://localhost:5173/reels/immersive-preview' }, sessionId);
    await sleep(3500);

    console.log('Testing full-globe pointer drag at S=1...');
    const dragRes = await browser.call('Runtime.evaluate', {
      expression: `
        (async function() {
          const vr = window.WebXRVR;
          const api = vr && vr.__test;
          if (!api) return { error: 'No WebXRVR' };
          vr.setSceneMode('earth');
          api.setEarthZoom(1);
          await new Promise(r => setTimeout(r, 400));

          const initialYaw = api.getEarthState().yaw;
          const canvas = document.querySelector('canvas#previewCanvas, canvas');
          const rect = canvas.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;

          canvas.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 1,
            clientX: cx,
            clientY: cy,
            button: 0,
            bubbles: true
          }));
          await new Promise(r => setTimeout(r, 60));

          for (let step = 1; step <= 5; step++) {
            canvas.dispatchEvent(new PointerEvent('pointermove', {
              pointerId: 1,
              clientX: cx + step * 25,
              clientY: cy,
              bubbles: true
            }));
            await new Promise(r => setTimeout(r, 40));
          }

          canvas.dispatchEvent(new PointerEvent('pointerup', {
            pointerId: 1,
            clientX: cx + 125,
            clientY: cy,
            button: 0,
            bubbles: true
          }));
          await new Promise(r => setTimeout(r, 200));

          const afterYaw = api.getEarthState().yaw;
          return {
            dragSucceeded: Math.abs(afterYaw - initialYaw) > 0.001,
            initialYaw,
            afterYaw,
            yawDelta: afterYaw - initialYaw
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    console.log('Full-globe drag test result:', JSON.stringify(dragRes.result ? dragRes.result.value : dragRes, null, 2));

    // Zoom via mouse wheel simulation
    console.log('Simulating wheel zoom on the canvas center...');
    const res = await browser.call('Runtime.evaluate', {
      expression: `
        (async function() {
          const vr = window.WebXRVR;
          const api = vr && vr.__test;
          if (!api) return { error: 'No WebXRVR' };

          const canvas = document.querySelector('canvas#previewCanvas, canvas');
          const rect = canvas.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;

          for (let i = 0; i < 20; i++) {
            canvas.dispatchEvent(new WheelEvent('wheel', {
              clientX: cx,
              clientY: cy,
              deltaY: -120,
              bubbles: true
            }));
            await new Promise(r => setTimeout(r, 60));
          }

          // Wait 3.5 seconds for tiles to load
          await new Promise(r => setTimeout(r, 3500));
          const state = api.getEarthState();
          const tileStats = api.earthTileStats();
          return { state, tileStats };
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    console.log('Result:', JSON.stringify(res.result ? res.result.value : res, null, 2));

    const screenshot = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync('logs/debug-earth-wheel-screenshot.png', Buffer.from(screenshot.data, 'base64'));
    console.log('Saved screenshot to logs/debug-earth-wheel-screenshot.png');

    console.log('Zooming into Da Nang city at S=512...');
    const danangRes = await browser.call('Runtime.evaluate', {
      expression: `
        (async function() {
          const vr = window.WebXRVR;
          const api = vr && vr.__test;
          if (!api) return { error: 'No WebXRVR' };
          api.zoomEarthTo(16.0544, 108.2022, 512);
          await new Promise(r => setTimeout(r, 4500));
          return {
            state: api.getEarthState(),
            tileStats: api.earthTileStats()
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    console.log('Da Nang Result:', JSON.stringify(danangRes.result ? danangRes.result.value : danangRes, null, 2));

    const danangScreenshot = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync('logs/debug-earth-danang-screenshot.png', Buffer.from(danangScreenshot.data, 'base64'));
    console.log('Saved screenshot to logs/debug-earth-danang-screenshot.png');

    // Test Zoomed Drag-Pan
    console.log('Testing zoomed drag-pan at S=512...');
    const panRes = await browser.call('Runtime.evaluate', {
      expression: `
        (async function() {
          const vr = window.WebXRVR;
          const api = vr && vr.__test;
          if (!api) return { error: 'No WebXRVR' };

          const initialCenter = { ...api.getEarthState().liveCenter };
          const initialFocus = { ...api.getEarthState().focus };
          const canvas = document.querySelector('canvas#previewCanvas, canvas');
          const rect = canvas.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;

          canvas.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 1,
            clientX: cx,
            clientY: cy,
            button: 0,
            bubbles: true
          }));
          await new Promise(r => setTimeout(r, 60));

          for (let step = 1; step <= 5; step++) {
            canvas.dispatchEvent(new PointerEvent('pointermove', {
              pointerId: 1,
              clientX: cx + step * 20,
              clientY: cy + step * 10,
              bubbles: true
            }));
            await new Promise(r => setTimeout(r, 40));
          }

          canvas.dispatchEvent(new PointerEvent('pointerup', {
            pointerId: 1,
            clientX: cx + 100,
            clientY: cy + 50,
            button: 0,
            bubbles: true
          }));
          await new Promise(r => setTimeout(r, 300));

          const afterCenter = api.getEarthState().liveCenter;
          const afterFocus = api.getEarthState().focus;
          const dX = Math.abs(afterCenter.x - initialCenter.x);
          const dY = Math.abs(afterCenter.y - initialCenter.y);
          const dZ = Math.abs(afterCenter.z - initialCenter.z);
          return {
            panSucceeded: (dX > 0.001 || dY > 0.001 || dZ > 0.001),
            initialCenter,
            afterCenter,
            initialFocus,
            afterFocus,
            delta: { dX, dY, dZ }
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    console.log('Zoomed drag-pan result:', JSON.stringify(panRes.result ? panRes.result.value : panRes, null, 2));

    // Test Reset Globe
    console.log('Testing resetEarthZoom back to S=1...');
    const resetRes = await browser.call('Runtime.evaluate', {
      expression: `
        (async function() {
          const vr = window.WebXRVR;
          const api = vr && vr.__test;
          if (!api) return { error: 'No WebXRVR' };

          api.resetEarthZoom();
          await new Promise(r => setTimeout(r, 1600));

          const state = api.getEarthState();
          return {
            resetSucceeded: Math.abs(state.zoom - 1) < 0.05,
            state
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    console.log('Reset globe result:', JSON.stringify(resetRes.result ? resetRes.result.value : resetRes, null, 2));

    const resetScreenshot = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync('logs/debug-earth-reset-screenshot.png', Buffer.from(resetScreenshot.data, 'base64'));
    console.log('Saved screenshot to logs/debug-earth-reset-screenshot.png');

    // Test drag-to-rotate again at S=1 after reset
    console.log('Testing globe drag-to-rotate post-reset...');
    const postResetDragRes = await browser.call('Runtime.evaluate', {
      expression: `
        (async function() {
          const vr = window.WebXRVR;
          const api = vr && vr.__test;
          if (!api) return { error: 'No WebXRVR' };

          const initialYaw = api.getEarthState().yaw;
          const canvas = document.querySelector('canvas#previewCanvas, canvas');
          const rect = canvas.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;

          canvas.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 1,
            clientX: cx,
            clientY: cy,
            button: 0,
            bubbles: true
          }));
          await new Promise(r => setTimeout(r, 60));

          for (let step = 1; step <= 5; step++) {
            canvas.dispatchEvent(new PointerEvent('pointermove', {
              pointerId: 1,
              clientX: cx + step * 25,
              clientY: cy,
              bubbles: true
            }));
            await new Promise(r => setTimeout(r, 40));
          }

          canvas.dispatchEvent(new PointerEvent('pointerup', {
            pointerId: 1,
            clientX: cx + 125,
            clientY: cy,
            button: 0,
            bubbles: true
          }));
          await new Promise(r => setTimeout(r, 200));

          const afterYaw = api.getEarthState().yaw;
          return {
            postResetDragSucceeded: Math.abs(afterYaw - initialYaw) > 0.001,
            initialYaw,
            afterYaw,
            yawDelta: afterYaw - initialYaw
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    console.log('Post-reset drag result:', JSON.stringify(postResetDragRes.result ? postResetDragRes.result.value : postResetDragRes, null, 2));
    browser.close();
  } finally {
    chromeProc.kill();
  }
}

run().catch(err => {
  console.error('Probe failed:', err);
  process.exit(1);
});
