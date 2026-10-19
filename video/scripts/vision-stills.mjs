// Renders EchoVision30 key frames in one browser session for review.
//   node scripts/vision-stills.mjs [frames] [ssaa]
// frames: comma list, e.g. 40,130,245 (default: one per section).
// Stills land in ../reports/video/vision/f<frame>.png.
import { bundle } from '@remotion/bundler';
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT = [40, 100, 130, 145, 190, 245, 280, 320, 340, 360, 430, 490, 520, 545, 590, 625, 660, 690, 720, 760, 805, 870];
const [framesArg, ssaaArg] = process.argv.slice(2);
const frames = framesArg ? framesArg.split(',').map(Number) : DEFAULT;
const inputProps = { ssaa: Number(ssaaArg ?? 1) };
const outDir = path.resolve('../reports/video/vision');
await mkdir(outDir, { recursive: true });

const serveUrl = await bundle({ entryPoint: path.resolve('src/index.ts') });
const browser = await openBrowser('chrome', { chromiumOptions: { gl: 'angle' } });
try {
  const composition = await selectComposition({ serveUrl, id: 'EchoVision30', inputProps, puppeteerInstance: browser });
  for (const frame of frames) {
    const t0 = Date.now();
    const output = path.join(outDir, `f${String(frame).padStart(3, '0')}.png`);
    await renderStill({
      serveUrl,
      composition,
      inputProps,
      frame,
      output,
      imageFormat: 'png',
      puppeteerInstance: browser,
      chromiumOptions: { gl: 'angle' },
      onBrowserLog: (log) => console.log(`  [browser] ${log.text}`),
    });
    console.log(`f${frame}: ${Date.now() - t0} ms -> ${path.relative(process.cwd(), output)}`);
  }
} finally {
  await browser.close({ silent: true });
}
