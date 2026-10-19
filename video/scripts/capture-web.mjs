// Records short scripted clips of the live ECHO web app for the intro video.
//
// Needs the dev stack running (Vite :5173 + FastAPI :8000) and the dev
// master-test session that scripts/capture_all_pages.cjs also uses.
//
//   cd video && node scripts/capture-web.mjs            # all clips
//   cd video && node scripts/capture-web.mjs earth wallet
//
// Output: video/public/media/web/<id>.mp4 (gitignored). Frames come from the
// CDP screencast (high-quality JPEG, real timestamps); ffmpeg resamples them to
// constant 30 fps H.264 and trims the page-load lead-in.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const OUT = resolve(HERE, '..', 'public', 'media', 'web');
const RAW = join(OUT, '_raw');
const BASE = process.env.ECHO_BASE_URL || 'http://localhost:5173';

const PEXELS_POST = 'a45db96c-f152-56dc-b519-25cb697a31d5'; // 12492094_3840_3840.mp4
const SOURCE_CLIP = join(REPO, 'input', '1:1', '12827489_720_720_30fps.mp4');

const DESKTOP = { width: 1920, height: 1080 };
const PHONE = { width: 430, height: 932 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function smoothDrag(page, from, to, steps = 60, holdMs = 320) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await sleep(holdMs); // Earth drag engages after a 280 ms hold
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t * t * (3 - 2 * t);
    await page.mouse.move(from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e);
    await sleep(16);
  }
  await page.mouse.up();
}

async function smoothScroll(page, total, steps = 90) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, total / steps);
    await sleep(22);
  }
}

async function clickText(page, text) {
  // Preview buttons stay disabled until the WebGL renderer is ready.
  const el = page.getByRole('button', { name: text, exact: true }).first();
  await el.click({ timeout: 20000 }).catch((e) => console.warn(`  could not click "${text}": ${e.message.split('\n')[0]}`));
}

// Each clip: path, viewport, `trim` = seconds of lead-in to cut, `act` = scripted motion.
const CLIPS = {
  'reels-phone': {
    path: `/reels?post=${PEXELS_POST}`,
    viewport: PHONE,
    trim: 4,
    act: async (p) => { await sleep(4000); await sleep(5000); },
  },
  'reels-desktop': {
    path: `/reels?post=${PEXELS_POST}`,
    viewport: DESKTOP,
    trim: 10, // the 4K reel takes ~8 s to start; the feed auto-advances ~1.3 s later
    act: async (p) => {
      await sleep(10000);
      await p.mouse.move(960, 540);
      await sleep(6000);
    },
  },
  explore: {
    path: '/explore',
    viewport: DESKTOP,
    trim: 8,
    act: async (p) => {
      await sleep(8000); // thumbnails lazy-load
      const search = p.getByPlaceholder(/search titles/i).first();
      await search.fill('frames').catch(() => {});
      await sleep(2500);
      await smoothScroll(p, 900);
      await sleep(1500);
    },
  },
  extender: {
    path: '/video',
    viewport: DESKTOP,
    trim: 2,
    act: async (p) => {
      await sleep(2000);
      const input = p.locator('input[type=file]').first();
      await input.setInputFiles(SOURCE_CLIP).catch((e) => console.warn('  upload failed', e.message));
      await sleep(3500);
      await smoothScroll(p, 700);
      await sleep(2500);
    },
  },
  dome: {
    path: '/reels/immersive-preview',
    viewport: DESKTOP,
    trim: 6,
    act: async (p) => {
      await sleep(6000);
      await clickText(p, 'ORBIT INSPECT');
      await sleep(800);
      await smoothDrag(p, [700, 820], [1150, 760], 120, 50);
      await sleep(1200);
      await clickText(p, 'SQ CURVE');
      await sleep(1800);
      await clickText(p, 'FLAT');
      await sleep(1800);
      await clickText(p, 'DOME');
      await sleep(2000);
    },
  },
  earth: {
    path: '/reels/immersive-preview',
    viewport: DESKTOP,
    trim: 6,
    act: async (p) => {
      await sleep(4000);
      await clickText(p, 'EARTH ACTIVITY');
      await sleep(3000);
      await smoothDrag(p, [800, 850], [1150, 820], 120);
      await sleep(1500);
      await smoothDrag(p, [1100, 820], [820, 860], 120);
      await sleep(2000);
    },
  },
  wallet: {
    path: '/wallet',
    viewport: DESKTOP,
    trim: 2,
    act: async (p) => {
      await sleep(2500);
      await p.mouse.move(1150, 800);
      await sleep(1000);
      await smoothScroll(p, 500);
      await sleep(2000);
    },
  },
  messages: {
    path: '/messages',
    viewport: DESKTOP,
    trim: 2,
    act: async (p) => { await sleep(2500); await sleep(4000); },
  },
};

async function record(browser, id, clip) {
  rmSync(RAW, { recursive: true, force: true });
  mkdirSync(RAW, { recursive: true });
  const ctx = await browser.newContext({ viewport: clip.viewport, deviceScaleFactor: 1 });
  await ctx.addCookies([
    { name: 'echo_session', value: 'echo_master_test_session_token_1234567890', domain: 'localhost', path: '/' },
    { name: 'echo_csrf', value: 'echo_master_test_csrf_token_1234567890', domain: 'localhost', path: '/' },
  ]);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  let recording = true;
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    if (!recording) return;
    const file = join(RAW, `f${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 92,
    maxWidth: clip.viewport.width, maxHeight: clip.viewport.height, everyNthFrame: 1,
  });
  await page.goto(BASE + clip.path, { waitUntil: 'domcontentloaded' });
  await clip.act(page);
  recording = false;
  await cdp.send('Page.stopScreencast').catch(() => {});
  await ctx.close();
  if (frames.length < 2) throw new Error('no screencast frames');

  // concat demuxer with per-frame durations keeps real timing; fps filter resamples to CFR.
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const dur = i + 1 < frames.length ? Math.max(frames[i + 1].t - frames[i].t, 0.001) : 0.1;
    lines.push(`file '${frames[i].file}'`, `duration ${dur.toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file}'`);
  const list = join(RAW, 'list.txt');
  writeFileSync(list, lines.join('\n'));
  const out = join(OUT, `${id}.mp4`);
  const { width, height } = clip.viewport;
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `fps=30,scale=${width}:${height}:flags=lanczos,trim=start=${clip.trim},setpts=PTS-STARTPTS`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-an', out,
  ]);
  const span = (frames[frames.length - 1].t - frames[0].t).toFixed(1);
  console.log(`  ${frames.length} frames over ${span}s -> ${out}`);
}

const wanted = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome', // system Chrome: HEVC decode + proprietary codecs
  headless: !process.env.CAPTURE_HEADED, // CAPTURE_HEADED=1: real GPU for WebGL-heavy pages
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
for (const [id, clip] of Object.entries(CLIPS)) {
  if (wanted.length && !wanted.includes(id)) continue;
  console.log(`[${id}] ${clip.path}`);
  try { await record(browser, id, clip); } catch (e) { console.error(`  FAILED ${id}: ${e.message}`); }
}
await browser.close();
rmSync(RAW, { recursive: true, force: true });
