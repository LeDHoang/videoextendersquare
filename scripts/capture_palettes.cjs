// Captures every preview palette (web/src/dev/palettes.css) on a few public screens for
// docs/palette-test/index.html. Needs the Vite dev server on :5173 and the API on :8000.
//   node scripts/capture_palettes.cjs            (all palettes)
//   node scripts/capture_palettes.cjs indigo     (only the named ones)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9223;
const USER_DATA_DIR = '/tmp/echo_chrome_palette_profile';
const OUT_DIR = path.resolve(__dirname, '../docs/palette-test/img');

const PALETTES = ['current', 'violet', 'plum', 'lavender', 'periwinkle', 'wine', 'mulberry', 'indigo', 'slate', 'oxblood', 'cocoa', 'graphite'];
const SCREENS = [
  { id: 'explore', path: '/explore', width: 1280, height: 800 },
  { id: 'profile', path: '/profile/auravibe', width: 1280, height: 800 },
  { id: 'login', path: '/login', width: 1280, height: 800 },
  { id: 'explore-375', path: '/explore', width: 375, height: 812, mobile: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch (e) {}
    await sleep(200);
  }
  throw new Error(`Chrome debug port ${port} did not open`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(m.error) : resolve(m.result);
    }
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msgId = id++;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId && { sessionId }) }));
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({ call, close: () => ws.close() }), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const chrome = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const { webSocketDebuggerUrl } = await waitForPort(DEBUG_PORT);
    const client = await connect(webSocketDebuggerUrl);
    const { targetId } = await client.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.call('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => client.call(method, params, sessionId);
    await call('Page.enable');

    for (const screen of SCREENS) {
      await call('Emulation.setDeviceMetricsOverride', {
        width: screen.width, height: screen.height, deviceScaleFactor: screen.mobile ? 2 : 1, mobile: !!screen.mobile,
      });
      for (const palette of PALETTES.filter((p) => process.argv.length < 3 || process.argv.includes(p))) {
        await call('Page.navigate', { url: `http://localhost:5173${screen.path}?palette=${palette}` });
        await sleep(3500);
        await call('Runtime.evaluate', {
          expression: `(async () => {
            document.querySelector('.sx-palette-picker')?.remove();
            await Promise.race([
              Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; }))),
              new Promise((r) => setTimeout(r, 4000)),
            ]);
          })()`,
          awaitPromise: true,
        });
        await sleep(300);
        const shot = await call('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
        const file = path.join(OUT_DIR, `${palette}-${screen.id}.jpg`);
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        console.log(`saved ${path.relative(process.cwd(), file)}`);
      }
    }
    client.close();
  } finally {
    chrome.kill();
  }
}

main().catch((err) => {
  console.error('Capture failed:', err);
  process.exit(1);
});
