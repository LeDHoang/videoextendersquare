import { describe, expect, it } from 'vitest';
import { offeredValue, topTier, videoOptions } from './modelOptions.js';

describe('videoOptions', () => {
  it('offers every option while the catalog has not loaded', () => {
    expect(videoOptions(undefined, undefined)).toEqual({
      ltxRes: ['720p', '1080p', '480p'],
      btdRes: ['8k', '6k', '4k', '2k', '1080p'],
      btdFps: ['30fps', '60fps'],
      btdTier: ['fast', 'standard', 'pro'],
      seedvrTarget: ['1080p', '2160p', '1440p', '720p'],
    });
  });

  it('hides options the catalog entry no longer prices, in display order', () => {
    const ltx = { resolutions: { '480p': 480, '1080p': 1080 } };
    const bytedance = {
      base_rates_usd: { '1080p': '0.01', '4k': '0.04', '8k': '0.2' },
      fps_multiplier: { '30fps': 1 },
      tier_multiplier: { fast: 1, pro: 2 },
    };
    const options = videoOptions(ltx, bytedance);
    expect(options.ltxRes).toEqual(['1080p', '480p']);
    expect(options.btdRes).toEqual(['8k', '4k', '1080p']);
    expect(options.btdFps).toEqual(['30fps']);
    expect(options.btdTier).toEqual(['fast', 'pro']);
    expect(videoOptions(null, { resolutions: { '720p': 720, '1440p': 1440 } }).seedvrTarget).toEqual(['1440p', '720p']);
  });
});

describe('offeredValue', () => {
  it('keeps an offered pick and falls back to the first option once it is withdrawn', () => {
    expect(offeredValue('2k', ['4k', '2k'])).toBe('2k');
    expect(offeredValue('2k', ['4k', '1080p'])).toBe('4k');
  });
});

describe('topTier', () => {
  it('picks the highest priced tier, or the fallback', () => {
    const catalog = [{ model: 'wan', resolution_rates: { '480p': '0.04', '580p': '0.06' } }];
    expect(topTier(catalog, 'wan', '720p')).toBe('580p');
    expect(topTier(catalog, 'luma', '1080p')).toBe('1080p');
  });
});
