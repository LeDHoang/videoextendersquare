// Records the ECHO WebXR player on a USB-attached Quest for the intro video.
//
// Needs: adb with the headset authorised, the dev stack (Vite :5173 + FastAPI
// :8000), and the headset resting somewhere stable. The script keeps the
// headset awake while recording and restores its power settings afterwards.
//
//   cd video && node scripts/capture-quest.mjs            # all takes
//   cd video && node scripts/capture-quest.mjs dome
//
// Output: video/public/media/quest/<take>.mp4 (gitignored), the full left eye
// (lens view, 960x1080) from the raw dual-eye `screenrecord` capture.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'public', 'media', 'quest');
const POST = 'a45db96c-f152-56dc-b519-25cb697a31d5'; // ECHO 4K square output (Pexels source)
const URL = `http://localhost:5173/reels?post=${POST}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync('adb', a, { encoding: 'utf8' }).trim();

// Each take: seconds to record and the scripted calls into window.WebXRVR.
const TAKES = {
  dome: {
    secs: 22,
    act: async (ev) => {
      await ev(`WebXRVR.setSceneMode('reels')`);
      await ev(`WebXRVR.setCurvatureMode('flat')`);
      await sleep(5000);
      await ev(`WebXRVR.setCurvatureMode('sq_curve')`);
      await sleep(5000);
      await ev(`WebXRVR.setCurvatureMode('dome')`);
      await sleep(8000);
    },
  },
  earth: {
    secs: 16,
    act: async (ev) => {
      await ev(`WebXRVR.setSceneMode('earth')`);
      await sleep(14000);
      await ev(`WebXRVR.setSceneMode('reels')`);
    },
  },
};

async function cdpPage() {
  // Talk to the tab's own socket: input dispatched through a flattened
  // browser-target session does not count as a user gesture for requestSession.
  const targets = await (await fetch('http://localhost:9222/json')).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes(POST));
  if (!page) throw new Error(`no Quest tab on ${URL}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((r) => {
    pending.set(++id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };
  return { send, ev, close: () => ws.close() };
}

async function enterVR(page) {
  if (await page.ev('WebXRVR.isPresenting()')) return;
  // A CDP mouse click counts as a trusted user gesture for requestSession.
  await page.ev(`document.body.addEventListener('click', () => WebXRVR.enterVR(), { once: true }); 1`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: 300, y: 300, button: 'left', clickCount: 1 });
  }
  for (let i = 0; i < 20 && !(await page.ev('WebXRVR.isPresenting()')); i++) await sleep(500);
  if (!(await page.ev('WebXRVR.isPresenting()'))) throw new Error('enterVR did not start an XR session');
  await sleep(3000); // let the reel texture and starfield settle
}

async function recordTake(page, id, take) {
  const dev = `/sdcard/echo_${id}.mp4`;
  const rec = spawn('adb', ['shell', 'screenrecord', '--time-limit', String(take.secs), '--bit-rate', '40000000', dev]);
  await sleep(800);
  await take.act(page.ev);
  await new Promise((r) => rec.on('exit', r));
  const raw = join(OUT, `_${id}-raw.mp4`);
  adb('pull', dev, raw);
  adb('shell', 'rm', dev);
  // screenrecord gives both eyes side by side; keep the whole left eye (the lens-shaped view is the point).
  const out = join(OUT, `${id}.mp4`);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-i', raw,
    '-vf', 'crop=iw/2:ih:0:0,scale=960:1080:flags=lanczos,fps=30',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-an', out,
  ]);
  console.log(`  -> ${out}`);
}

const wanted = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
adb('shell', 'svc', 'power', 'stayon', 'true');
adb('shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.prox_close');
let page;
try {
  adb('reverse', 'tcp:8000', 'tcp:8000');
  adb('reverse', 'tcp:5173', 'tcp:5173');
  adb('forward', 'tcp:9222', 'localabstract:chrome_devtools_remote');
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', URL, 'com.oculus.browser');
  await sleep(6000);
  page = await cdpPage();
  await enterVR(page);
  for (const [id, take] of Object.entries(TAKES)) {
    if (wanted.length && !wanted.includes(id)) continue;
    console.log(`[${id}] ${take.secs}s`);
    try { await recordTake(page, id, take); } catch (e) { console.error(`  FAILED ${id}: ${e.message}`); }
  }
  await page.ev('WebXRVR.exitVR()');
} finally {
  page?.close();
  adb('shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.prox_open');
  adb('shell', 'svc', 'power', 'stayon', 'false');
}
