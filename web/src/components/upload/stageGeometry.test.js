import { describe, expect, it } from 'vitest';
import { aspectLabel, formatClock, pipelineSummary, squarePadding, stageLayout } from './stageGeometry.js';

describe('squarePadding', () => {
  it('matches pipeline/utils.py calculate_square_padding', () => {
    expect(squarePadding(1080, 1920)).toEqual({ top: 0, bottom: 0, left: 420, right: 420 });
    expect(squarePadding(1600, 900)).toEqual({ top: 350, bottom: 350, left: 0, right: 0 });
    // Odd differences put the extra pixel on the far side, like the backend.
    expect(squarePadding(1001, 1000)).toEqual({ top: 0, bottom: 1, left: 0, right: 0 });
    expect(squarePadding(512, 512)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });
});

describe('stageLayout', () => {
  it('places a portrait source between left/right outpaint bands', () => {
    const layout = stageLayout({ width: 1080, height: 1920, padding: { top: 0, bottom: 0, left: 420, right: 420 } });
    expect(layout.axis).toBe('x');
    expect(layout.square).toBe(false);
    expect(layout.source).toEqual({ left: '21.875%', top: '0%', width: '56.25%', height: '100%' });
    expect(layout.zones.map((zone) => [zone.side, zone.px, zone.style.width])).toEqual([
      ['left', 420, '21.875%'],
      ['right', 420, '21.875%'],
    ]);
    expect(layout.padLabel).toBe('420px [L/R]');
    expect(layout.aspect).toBe('9:16');
  });

  it('places a landscape source between top/bottom bands, deriving padding when missing', () => {
    const layout = stageLayout({ width: 1600, height: 900 });
    expect(layout.axis).toBe('y');
    expect(layout.source.top).toBe('21.875%');
    expect(layout.zones.map((zone) => zone.side)).toEqual(['top', 'bottom']);
    expect(layout.padLabel).toBe('350px [T/B]');
    expect(layout.orientation).toBe('LANDSCAPE');
  });

  it('reports square sources without bands', () => {
    const layout = stageLayout({ width: 512, height: 512, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    expect(layout.square).toBe(true);
    expect(layout.zones).toEqual([]);
    expect(layout.padLabel).toBe('NONE');
  });

  it('returns null without dimensions', () => {
    expect(stageLayout(null)).toBeNull();
    expect(stageLayout({ width: 0, height: 100 })).toBeNull();
  });
});

describe('labels', () => {
  it('formats aspect ratios and clock times', () => {
    expect(aspectLabel(1920, 1080)).toBe('16:9');
    expect(aspectLabel(1001, 1000)).toBe('1.00:1');
    expect(formatClock(0)).toBe('00:00.00');
    expect(formatClock(65.5)).toBe('01:05.50');
  });

  it('summarises the configured pipeline', () => {
    expect(pipelineSummary({})).toBe('AWAITING SOURCE');
    expect(pipelineSummary({ kind: 'image', path: 'skip' })).toBe('AS-IS · NO EXTEND');
    expect(pipelineSummary({ kind: 'video', outpaintLabel: 'LTX 2.3 Quality', engine: 'FAL AI', upscaleLabel: 'Bytedance Upscaler', bytedanceRes: '4k' }))
      .toBe('OUTPAINT: LTX 2.3 QUALITY · UPSCALE: BYTEDANCE UPSCALER 4K');
    expect(pipelineSummary({ kind: 'video', upscaleOnly: true, engine: 'STUDIO' })).toBe('UPSCALE: STUDIO NNEDI3');
    expect(pipelineSummary({ kind: 'image', outpaintLabel: 'Image Apps Outpaint', engine: 'FAST' }))
      .toBe('OUTPAINT: IMAGE APPS OUTPAINT · UPSCALE: FAST LANCZOS');
  });
});
