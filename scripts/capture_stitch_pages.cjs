const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9222;
const USER_DATA_DIR = '/tmp/echo_chrome_stitch_expanded';
const SAMPLE_VIDEO_PATH = path.resolve(__dirname, '../input/sample_vertical_reel.mp4');

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

async function extractStaticHtml(client, sessionId) {
  const result = await client.call('Runtime.evaluate', {
    expression: `(() => {
      let cssRules = "";
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules || [])) {
            cssRules += rule.cssText + "\\n";
          }
        } catch (e) {}
      }

      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll("script").forEach(s => s.remove());

      const styleEl = document.createElement("style");
      styleEl.setAttribute("data-stitch-inlined", "true");
      styleEl.textContent = cssRules;
      clone.querySelector("head")?.appendChild(styleEl);

      return "<!DOCTYPE html>\\n" + clone.outerHTML;
    })()`,
    returnByValue: true
  }, sessionId);

  return result.result.value;
}

async function main() {
  console.log('Sample video path:', SAMPLE_VIDEO_PATH);
  if (!fs.existsSync(SAMPLE_VIDEO_PATH)) {
    throw new Error(`Sample video file does not exist: ${SAMPLE_VIDEO_PATH}`);
  }

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

    // Viewport for desktop capture
    await client.call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false
    }, sessionId);

    console.log('Navigating to http://localhost:5173/video...');
    await client.call('Page.navigate', { url: 'http://localhost:5173/video' }, sessionId);
    await sleep(2500);

    // 1. Ingest video file
    const doc = await client.call('DOM.getDocument', {}, sessionId);
    const fileInput = await client.call('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[type="file"]'
    }, sessionId);

    if (!fileInput || !fileInput.nodeId) {
      throw new Error('Could not find file input element on /video page');
    }

    console.log(`Found file input (nodeId: ${fileInput.nodeId}). Ingesting sample video...`);
    await client.call('DOM.setFileInputFiles', {
      files: [SAMPLE_VIDEO_PATH],
      nodeId: fileInput.nodeId
    }, sessionId);

    console.log('Waiting for video ingestion to complete...');
    await sleep(3500);

    // 2. Expand all options for the pipeline
    console.log('Expanding all pipeline options (LoRA, FAL AI, all details, checkboxes)...');
    await client.call('Runtime.evaluate', {
      expression: `(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="tab"], .sx-seg-btn, .sx-btn'));
        
        // Select LTX 2.3 QUALITY + LORA outpaint model
        const loraBtn = buttons.find(b => b.textContent.includes('LORA') || b.textContent.includes('LoRA'));
        if (loraBtn) loraBtn.click();

        // Select FAL AI upscale engine
        const falBtn = buttons.find(b => b.textContent.trim() === 'FAL AI');
        if (falBtn) falBtn.click();

        // Check checkboxes
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
        checkboxes.forEach(cb => {
          if (!cb.checked) cb.click();
        });

        // Open all details tags
        const allDetails = document.querySelectorAll('details');
        allDetails.forEach(d => { d.open = true; });

        return true;
      })()`,
      returnByValue: true
    }, sessionId);
    await sleep(1500);

    // Capture Full Page Screenshot of Video Extender (Expanded)
    const metrics = await client.call('Page.getLayoutMetrics', {}, sessionId);
    const fullHeight = Math.ceil(metrics.contentSize.height);
    const fullWidth = Math.ceil(metrics.contentSize.width);
    console.log(`Full page dimensions: ${fullWidth}x${fullHeight}`);

    await client.call('Emulation.setDeviceMetricsOverride', {
      width: fullWidth,
      height: fullHeight,
      deviceScaleFactor: 2,
      mobile: false
    }, sessionId);
    await sleep(1000);

    const videoScreenshot = await client.call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true
    }, sessionId);

    const videoPngPath = path.join(outPagesDir, '22_video_extender_expanded.png');
    fs.writeFileSync(videoPngPath, Buffer.from(videoScreenshot.data, 'base64'));
    console.log(`✅ Saved screenshot: ${videoPngPath}`);

    // Extract HTML for Video Extender (Expanded)
    const videoHtml = await extractStaticHtml(client, sessionId);
    const videoHtmlPath = path.join(stitchDir, 'video_extender_expanded.html');
    fs.writeFileSync(videoHtmlPath, videoHtml, 'utf-8');
    console.log(`✅ Saved static HTML: ${videoHtmlPath} (${(videoHtml.length / 1024).toFixed(1)} KB)`);

    // Reset viewport back to desktop 1440x900
    await client.call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false
    }, sessionId);
    await sleep(500);

    // 3. Open Message Dock in bottom right
    console.log('Opening bottom-right Message Dock launcher...');
    const dockResult = await client.call('Runtime.evaluate', {
      expression: `(() => {
        const launcher = document.querySelector('.sx-message-launcher');
        if (launcher) {
          launcher.click();
          return { found: true, text: launcher.textContent };
        }
        return { found: false };
      })()`,
      returnByValue: true
    }, sessionId);
    console.log('Launcher click result:', dockResult.result.value);
    await sleep(2500);

    // Check if dock opened and select conversation if available
    const dockCheck = await client.call('Runtime.evaluate', {
      expression: `(() => {
        const dock = document.querySelector('.sx-message-dock');
        const rows = document.querySelectorAll('.sx-conversation-row');
        if (rows.length > 0) {
          rows[0].click(); // open the conversation thread
        }
        return {
          dockFound: Boolean(dock),
          conversationsCount: rows.length,
          messagesInThread: document.querySelectorAll('.sx-message-item, .sx-message-bubble, .sx-message-content').length
        };
      })()`,
      returnByValue: true
    }, sessionId);
    console.log('Dock status:', dockCheck.result.value);
    await sleep(2000);

    // Capture screenshot of page with expanded Message Dock
    const dockScreenshot = await client.call('Page.captureScreenshot', {
      format: 'png'
    }, sessionId);

    const dockPngPath = path.join(outPagesDir, '23_message_dock_expanded.png');
    fs.writeFileSync(dockPngPath, Buffer.from(dockScreenshot.data, 'base64'));
    console.log(`✅ Saved screenshot: ${dockPngPath}`);

    // Extract HTML for page with expanded Message Dock
    const dockHtml = await extractStaticHtml(client, sessionId);
    const dockHtmlPath = path.join(stitchDir, 'message_dock_expanded.html');
    fs.writeFileSync(dockHtmlPath, dockHtml, 'utf-8');
    console.log(`✅ Saved static HTML: ${dockHtmlPath} (${(dockHtml.length / 1024).toFixed(1)} KB)`);

    client.close();
  } finally {
    chromeProc.kill();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
