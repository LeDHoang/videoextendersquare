const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9222;
const USER_DATA_DIR = '/tmp/echo_chrome_video_expanded';
const SAMPLE_VIDEO_PATH = path.resolve(__dirname, '../input/sample_vertical_reel.mp4');

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForPort(port, maxTries = 30) {
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
          const cb = this.callbacks.get(m.id);
          this.callbacks.delete(m.id);
          if (m.error) cb.reject(new Error(JSON.stringify(m.error)));
          else cb.resolve(m.result);
        }
      });
    });
  }

  call(method, params = {}, sessionId = undefined) {
    const id = this.id++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try { this.ws.close(); } catch (e) {}
  }
}

async function main() {
  console.log('Sample video path:', SAMPLE_VIDEO_PATH);
  if (!fs.existsSync(SAMPLE_VIDEO_PATH)) {
    throw new Error(`Sample video file does not exist: ${SAMPLE_VIDEO_PATH}`);
  }

  const outDir = path.resolve(__dirname, '../.stitch/pages');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--window-size=1440,900',
    '--hide-scrollbars',
    '--disable-gpu=false',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    const ver = await waitForPort(DEBUG_PORT);
    console.log('Connected to Chrome. Debugger URL:', ver.webSocketDebuggerUrl);

    const client = new CDPClient(ver.webSocketDebuggerUrl);
    await client.connect();

    const { targetId } = await client.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.call('Target.attachToTarget', { targetId, flatten: true });

    await client.call('Page.enable', {}, sessionId);
    await client.call('DOM.enable', {}, sessionId);
    await client.call('Network.enable', {}, sessionId);

    // Set authenticated cookies for echodev
    await client.call('Network.setCookie', {
      name: 'echo_session',
      value: 'echo_master_test_session_token_1234567890',
      domain: 'localhost',
      path: '/'
    }, sessionId);
    await client.call('Network.setCookie', {
      name: 'echo_csrf',
      value: 'echo_master_test_csrf_token_1234567890',
      domain: 'localhost',
      path: '/'
    }, sessionId);

    // Set initial viewport
    await client.call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false
    }, sessionId);

    console.log('Navigating to http://localhost:5173/video...');
    await client.call('Page.navigate', { url: 'http://localhost:5173/video' }, sessionId);
    await sleep(2500);

    // Find file input
    const doc = await client.call('DOM.getDocument', {}, sessionId);
    const fileInput = await client.call('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[type="file"]'
    }, sessionId);

    if (!fileInput || !fileInput.nodeId) {
      throw new Error('Could not find file input element on /video page');
    }

    console.log(`Found file input (nodeId: ${fileInput.nodeId}). Supplying sample video...`);
    await client.call('DOM.setFileInputFiles', {
      files: [SAMPLE_VIDEO_PATH],
      nodeId: fileInput.nodeId
    }, sessionId);

    console.log('Waiting for video upload to process and populate stage metadata...');
    await sleep(3500);

    // Expand all options for the pipeline:
    // 1. Select FAL AI for Upscale Engine so FAL options appear
    // 2. Open all details.sx-expander (LTX settings, Bytedance settings, etc.)
    // 3. Enable 15s Trimmer toggle so trim fields appear
    console.log('Expanding all pipeline options (LoRA, FAL AI, Prompt Expansion, Trimmer, expanders)...');
    const expandResult = await client.call('Runtime.evaluate', {
      expression: `(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="tab"], .sx-seg-btn, .sx-btn'));
        
        // 1. Select LTX 2.3 QUALITY + LORA outpaint model
        const loraBtn = buttons.find(b => b.textContent.includes('LORA') || b.textContent.includes('LoRA'));
        if (loraBtn) loraBtn.click();

        // 2. Select FAL AI upscale engine
        const falBtn = buttons.find(b => b.textContent.trim() === 'FAL AI');
        if (falBtn) falBtn.click();

        // 3. Find and check all checkboxes (Preserve Audio, Prompt Expansion, Trimming)
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
        checkboxes.forEach(cb => {
          if (!cb.checked) cb.click();
        });

        // 4. Open all details tags
        const allDetails = document.querySelectorAll('details');
        allDetails.forEach(d => { d.open = true; });

        return {
          detailsCount: allDetails.length,
          checkboxesCount: checkboxes.length,
          falFound: Boolean(falBtn),
          loraFound: Boolean(loraBtn)
        };
      })()`,
      returnByValue: true
    }, sessionId);

    console.log('Expansion result:', expandResult.result?.value);
    await sleep(1000);

    // Ensure all details remain open after any state re-renders
    await client.call('Runtime.evaluate', {
      expression: `(() => {
        document.querySelectorAll('details').forEach(d => { d.open = true; });
        // Also ensure trimming checkbox is checked
        const labels = Array.from(document.querySelectorAll('label'));
        const trimLabel = labels.find(l => l.textContent.includes('Trimming'));
        if (trimLabel) {
          const input = document.getElementById(trimLabel.getAttribute('for'));
          if (input && !input.checked) input.click();
        }
      })()`
    }, sessionId);
    await sleep(600);

    // Compute full height
    const scrollEval = await client.call('Runtime.evaluate', {
      expression: `Math.max(
        document.body.scrollHeight || 0,
        document.documentElement.scrollHeight || 0,
        document.body.offsetHeight || 0,
        document.documentElement.offsetHeight || 0,
        1200
      )`,
      returnByValue: true
    }, sessionId);

    const fullHeight = Math.min(6000, Math.round(scrollEval?.result?.value || 1200));
    console.log(`Setting full viewport height: ${fullHeight}px (2x retina = ${fullHeight * 2}px)`);

    await client.call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: fullHeight,
      deviceScaleFactor: 2,
      mobile: false
    }, sessionId);
    await sleep(600);

    const shot = await client.call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true
    }, sessionId);

    const fileName = '22_video_extender_expanded.png';
    const filePath = path.join(outDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));

    const stats = fs.statSync(filePath);
    console.log(`Successfully saved ${filePath} (${stats.size} bytes, height: ${fullHeight}px)`);

    client.close();
  } finally {
    try { chromeProc.kill('SIGTERM'); } catch (e) {}
  }
}

main().catch(err => {
  console.error('Error during capture:', err);
  process.exit(1);
});
