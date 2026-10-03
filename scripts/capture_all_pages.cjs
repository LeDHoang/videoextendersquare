const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9222;
const USER_DATA_DIR = '/tmp/echo_chrome_pages_profile';

const PAGES = [
  { id: '01_reels', path: '/reels', title: 'ECHO - Reels Feed & Player', auth: true },
  { id: '02_image_studio', path: '/image', title: 'ECHO - 4K Square Image Studio', auth: true },
  { id: '03_video_extender', path: '/video', title: 'ECHO - AI Video Extender Studio', auth: true },
  { id: '04_compare', path: '/compare', title: 'ECHO - A/B Video & Audio Compare', auth: true },
  { id: '05_explore', path: '/explore', title: 'ECHO - Explore Discovery Feed', auth: true },
  { id: '06_explore_tag', path: '/explore/tag/viral', title: 'ECHO - Tag Explore: viral', auth: true },
  { id: '07_explore_location', path: '/explore/location/Tokyo', title: 'ECHO - Location Explore: Tokyo', auth: true },
  { id: '08_profile', path: '/profile/echodev', title: 'ECHO - Creator Profile: echodev', auth: true },
  { id: '09_pack_detail', path: '/packs/b0d55291-206e-4c82-9b42-68a67ac6dede', title: 'ECHO - Pack: Cyberpunk Spatial Masters', auth: true },
  { id: '10_upload', path: '/upload', title: 'ECHO - Media Upload & Publish Studio', auth: true },
  { id: '11_profile_settings', path: '/settings/profile', title: 'ECHO - Profile & Account Settings', auth: true },
  { id: '12_wallet', path: '/wallet', title: 'ECHO - Creator Wallet & Billing', auth: true },
  { id: '13_messages', path: '/messages', title: 'ECHO - Direct Messages', auth: true },
  { id: '14_pack_creator', path: '/packs/new', title: 'ECHO - Reel Pack Creator', auth: true },
  { id: '15_moderation', path: '/moderation', title: 'ECHO - Moderator Admin Console', auth: true },
  { id: '16_immersive_preview', path: '/reels/immersive-preview', title: 'ECHO - WebXR Immersive Preview', auth: true },
  { id: '17_login', path: '/login', title: 'ECHO - Sign In', auth: false },
  { id: '18_signup', path: '/signup', title: 'ECHO - Create Account', auth: false },
  { id: '19_forgot_password', path: '/forgot-password', title: 'ECHO - Password Reset Request', auth: false },
  { id: '20_reset_password', path: '/reset-password', title: 'ECHO - Password Reset', auth: false },
  { id: '21_settings_drawer', path: '/reels', title: 'ECHO - Diagnostics & Settings Drawer', auth: true, openDrawer: true }
];

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

async function captureAll() {
  console.log(`Starting capture of ${PAGES.length} pages...`);
  const outDir = path.resolve('.stitch/pages');
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
    console.log('Chrome connected. Debugger URL:', ver.webSocketDebuggerUrl);

    const client = new CDPClient(ver.webSocketDebuggerUrl);
    await client.connect();

    const { targetId } = await client.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.call('Target.attachToTarget', { targetId, flatten: true });

    await client.call('Page.enable', {}, sessionId);
    await client.call('DOM.enable', {}, sessionId);
    await client.call('Network.enable', {}, sessionId);

    const results = [];

    for (const pageDef of PAGES) {
      console.log(`\n[${pageDef.id}] Navigating to http://localhost:5173${pageDef.path} (Auth: ${pageDef.auth})...`);

      // Reset cookies as needed
      if (pageDef.auth) {
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
      } else {
        await client.call('Network.deleteCookies', { name: 'echo_session', domain: 'localhost' }, sessionId);
        await client.call('Network.deleteCookies', { name: 'echo_csrf', domain: 'localhost' }, sessionId);
      }

      // Reset default viewport first
      await client.call('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 2,
        mobile: false
      }, sessionId);

      await client.call('Page.navigate', { url: `http://localhost:5173${pageDef.path}` }, sessionId);

      // Allow React component to load and fetch data
      await sleep(2500);

      // If drawer should be opened
      if (pageDef.openDrawer) {
        await client.call('Runtime.evaluate', {
          expression: `(() => {
            const toggle = document.querySelector('[aria-label="Toggle diagnostics drawer"], [aria-label*="menu" i], button.sx-topbar-btn, .sx-brand-btn');
            if (toggle) toggle.click();
          })()`,
          awaitPromise: true
        }, sessionId);
        await sleep(600);
      }

      // Get page height
      const scrollHeightEval = await client.call('Runtime.evaluate', {
        expression: `Math.max(
          document.body.scrollHeight || 0,
          document.documentElement.scrollHeight || 0,
          document.body.offsetHeight || 0,
          document.documentElement.offsetHeight || 0,
          900
        )`,
        returnByValue: true
      }, sessionId);

      const pageHeight = Math.min(6000, Math.max(900, Math.round(scrollHeightEval?.result?.value || 900)));

      // Set device height to full page height
      await client.call('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: pageHeight,
        deviceScaleFactor: 2,
        mobile: false
      }, sessionId);
      await sleep(400);

      const shot = await client.call('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        fromSurface: true
      }, sessionId);

      const fileName = `${pageDef.id}.png`;
      const filePath = path.join(outDir, fileName);
      fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
      const stats = fs.statSync(filePath);
      console.log(`Saved ${fileName} (${stats.size} bytes, height: ${pageHeight}px) - "${pageDef.title}"`);

      results.push({
        id: pageDef.id,
        path: pageDef.path,
        title: pageDef.title,
        fileName,
        filePath,
        sizeBytes: stats.size,
        height: pageHeight
      });
    }

    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(results, null, 2));
    console.log(`\nSuccessfully captured all ${results.length} pages. Manifest written to manifest.json`);

    client.close();
    return results;
  } finally {
    chromeProc.kill();
  }
}

captureAll().catch(err => {
  console.error('Capture failed:', err);
  process.exit(1);
});
