const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9222;
const USER_DATA_DIR = '/tmp/echo_chrome_msg_isolated';

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
  const stitchDir = path.resolve(__dirname, '../.stitch');
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

    // Viewport
    await client.call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false
    }, sessionId);

    console.log('Navigating to http://localhost:5173/video...');
    await client.call('Page.navigate', { url: 'http://localhost:5173/video' }, sessionId);
    await sleep(2500);

    // Open Message Dock in bottom right
    console.log('Opening bottom-right Message Dock launcher...');
    await client.call('Runtime.evaluate', {
      expression: `(() => {
        const launcher = document.querySelector('.sx-message-launcher');
        if (launcher) launcher.click();
        return Boolean(launcher);
      })()`,
      returnByValue: true
    }, sessionId);
    await sleep(2000);

    // Select the active conversation row if present
    await client.call('Runtime.evaluate', {
      expression: `(() => {
        const rows = document.querySelectorAll('.sx-conversation-row');
        if (rows.length > 0) rows[0].click();
      })()`,
      returnByValue: true
    }, sessionId);
    await sleep(1500);

    // Get the exact bounding box of .sx-message-dock
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
      throw new Error('Could not find .sx-message-dock element on page');
    }

    // 1. Capture isolated screenshot of JUST .sx-message-dock
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
    console.log(`✅ Saved isolated screenshot: ${isolatedPngPath}`);

    // Also overwrite the 23_message_dock_expanded.png so the local artifact matches
    const oldPngPath = path.join(outPagesDir, '23_message_dock_expanded.png');
    fs.writeFileSync(oldPngPath, Buffer.from(isolatedScreenshot.data, 'base64'));

    // 2. Extract self-contained HTML for JUST the messaging panel
    const isolatedHtmlResult = await client.call('Runtime.evaluate', {
      expression: `(() => {
        let cssRules = "";
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            for (const rule of Array.from(sheet.cssRules || [])) {
              cssRules += rule.cssText + "\\n";
            }
          } catch (e) {}
        }

        const dock = document.querySelector('.sx-message-dock');
        if (!dock) return null;

        // Clone dock and style it as a standalone centered component
        const dockClone = dock.cloneNode(true);
        dockClone.style.position = 'relative';
        dockClone.style.right = 'auto';
        dockClone.style.bottom = 'auto';
        dockClone.style.margin = '40px auto';
        dockClone.style.width = '720px';
        dockClone.style.height = '520px';

        return \`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ECHO - Messaging Panel</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800&family=Archivo+Black&family=JetBrains+Mono:wght@400;700&family=Orbitron:wght@600;700;800;900&display=swap" rel="stylesheet">
  <style>
    \${cssRules}
    body {
      margin: 0;
      padding: 24px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #08090a;
      box-sizing: border-box;
    }
  </style>
</head>
<body class="dark">
  \${dockClone.outerHTML}
</body>
</html>\`;
      })()`,
      returnByValue: true
    }, sessionId);

    const isolatedHtml = isolatedHtmlResult.result.value;
    const isolatedHtmlPath = path.join(stitchDir, 'message_dock_isolated.html');
    fs.writeFileSync(isolatedHtmlPath, isolatedHtml, 'utf-8');
    console.log(`✅ Saved isolated HTML: ${isolatedHtmlPath} (${(isolatedHtml.length / 1024).toFixed(1)} KB)`);

    // Also overwrite message_dock_expanded.html
    const oldHtmlPath = path.join(stitchDir, 'message_dock_expanded.html');
    fs.writeFileSync(oldHtmlPath, isolatedHtml, 'utf-8');

    client.close();
  } finally {
    chromeProc.kill();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
