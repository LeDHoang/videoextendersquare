const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9222;
const USER_DATA_DIR = '/tmp/echo_chrome_msg_populated';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForPort(port, maxTries = 60) {
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
  const outPagesDir = path.resolve(__dirname, '../.stitch/pages');
  if (!fs.existsSync(outPagesDir)) fs.mkdirSync(outPagesDir, { recursive: true });

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

    // Set 1440x900 viewport (scale factor 2 for high-DPI crisp screenshots)
    await client.call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false
    }, sessionId);

    // -------------------------------------------------------------
    // PART 1: Capture Full /messages Page with Active Conversation
    // -------------------------------------------------------------
    console.log('Navigating to http://localhost:5173/messages...');
    await client.call('Page.navigate', { url: 'http://localhost:5173/messages' }, sessionId);
    await sleep(2500);

    // Click on the conversation row with @pxtester01
    console.log('Selecting conversation row...');
    const selectRes = await client.call('Runtime.evaluate', {
      expression: `(() => {
        const rows = document.querySelectorAll('.sx-conversation-row');
        if (rows.length > 0) {
          rows[0].click();
          return { found: true, text: rows[0].innerText };
        }
        return { found: false };
      })()`,
      returnByValue: true
    }, sessionId);
    console.log('Conversation row selection result:', selectRes.result.value);

    // Wait for message bubbles to load
    for (let i = 0; i < 20; i++) {
      const bubbleCount = await client.call('Runtime.evaluate', {
        expression: `document.querySelectorAll('.sx-message-bubble').length`,
        returnByValue: true
      }, sessionId);
      console.log(`Checking message bubbles... found: ${bubbleCount.result.value}`);
      if (bubbleCount.result.value >= 2) break;
      await sleep(500);
    }

    await sleep(1500);

    // Get layout metrics for full page capture
    const layout = await client.call('Page.getLayoutMetrics', {}, sessionId);
    const contentWidth = Math.max(1440, Math.ceil(layout.contentSize.width));
    const contentHeight = Math.max(900, Math.ceil(layout.contentSize.height));

    console.log(`Capturing populated messages page (${contentWidth}x${contentHeight})...`);
    const pageScreenshot = await client.call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: contentWidth,
        height: contentHeight,
        scale: 2
      }
    }, sessionId);

    const messagesPngPath = path.join(outPagesDir, '13_messages.png');
    fs.writeFileSync(messagesPngPath, Buffer.from(pageScreenshot.data, 'base64'));
    console.log(`✅ Saved populated Direct Messages page: ${messagesPngPath} (${fs.statSync(messagesPngPath).size} bytes)`);

    // -------------------------------------------------------------
    // PART 2: Capture Isolated Messaging Panel (Message Dock)
    // -------------------------------------------------------------
    console.log('\nNavigating to http://localhost:5173/video to capture isolated dock...');
    await client.call('Page.navigate', { url: 'http://localhost:5173/video' }, sessionId);
    await sleep(2500);

    // Open Message Dock in bottom right
    await client.call('Runtime.evaluate', {
      expression: `(() => {
        const launcher = document.querySelector('.sx-message-launcher');
        if (launcher) launcher.click();
        return Boolean(launcher);
      })()`,
      returnByValue: true
    }, sessionId);
    await sleep(1500);

    // Select the conversation in dock
    await client.call('Runtime.evaluate', {
      expression: `(() => {
        const rows = document.querySelectorAll('.sx-conversation-row');
        if (rows.length > 0) rows[0].click();
      })()`,
      returnByValue: true
    }, sessionId);
    await sleep(2000);

    // Get dock element bounding box
    const boxResult = await client.call('Runtime.evaluate', {
      expression: `(() => {
        const dock = document.querySelector('.sx-message-dock');
        if (!dock) return null;
        const rect = dock.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      })()`,
      returnByValue: true
    }, sessionId);

    const box = boxResult.result.value;
    console.log('Message Dock bounding box:', box);
    if (!box) {
      throw new Error('Could not find .sx-message-dock element');
    }

    const isolatedScreenshot = await client.call('Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
        scale: 2
      }
    }, sessionId);

    const isolatedPngPath = path.join(outPagesDir, '23_message_dock_isolated.png');
    fs.writeFileSync(isolatedPngPath, Buffer.from(isolatedScreenshot.data, 'base64'));
    console.log(`✅ Saved isolated Messaging Panel: ${isolatedPngPath} (${fs.statSync(isolatedPngPath).size} bytes)`);

    client.close();
  } finally {
    try { chromeProc.kill(); } catch (e) {}
  }
}

main().catch(err => {
  console.error('Execution failed:', err);
  process.exit(1);
});
