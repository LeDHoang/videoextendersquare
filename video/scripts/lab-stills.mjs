// Renders VisionLab stills in one browser session for fast shader tuning.
//   node scripts/lab-stills.mjs <shots.json> [outDir]
// shots.json: [{ "name": "ocean", "ssaa": 1, "stage": { ...Stage } }, ...]
// Optional "frame" per shot (default 0). Stills land in ../reports/video/lab.
import { bundle } from '@remotion/bundler';
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const [shotsFile, outArg] = process.argv.slice(2);
if (!shotsFile) {
  console.error('usage: node scripts/lab-stills.mjs <shots.json> [outDir]');
  process.exit(1);
}
const shots = JSON.parse(readFileSync(shotsFile, 'utf8'));
const outDir = path.resolve(outArg ?? '../reports/video/lab');
await mkdir(outDir, { recursive: true });

const serveUrl = await bundle({ entryPoint: path.resolve('src/index.ts') });
const browser = await openBrowser('chrome', { chromiumOptions: { gl: 'angle' } });
try {
  for (const shot of shots) {
    const inputProps = { stage: shot.stage, ssaa: shot.ssaa ?? 1 };
    const composition = await selectComposition({ serveUrl, id: 'VisionLab', inputProps, puppeteerInstance: browser });
    const t0 = Date.now();
    const output = path.join(outDir, `${shot.name}.png`);
    await renderStill({
      serveUrl,
      composition,
      inputProps,
      frame: shot.frame ?? 0,
      output,
      imageFormat: 'png',
      puppeteerInstance: browser,
      chromiumOptions: { gl: 'angle' },
      onBrowserLog: (log) => console.log(`  [browser] ${log.text}`),
    });
    console.log(`${shot.name}: ${Date.now() - t0} ms -> ${path.relative(process.cwd(), output)}`);
  }
} finally {
  await browser.close({ silent: true });
}
