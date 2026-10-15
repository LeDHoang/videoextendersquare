import { describe, expect, it } from 'vitest';
import { formatClock, formatDuration, formatResolution, imagePostLabel, packRuntime } from './mediaFormat.js';

describe('formatClock', () => {
  it('formats whole seconds, including zero', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9)).toBe('0:09');
    expect(formatClock(75)).toBe('1:15');
    expect(formatClock(3723)).toBe('1:02:03');
  });

  it('rounds, and never goes negative or NaN', () => {
    expect(formatClock(14.6)).toBe('0:15');
    expect(formatClock(-3)).toBe('0:00');
    expect(formatClock(NaN)).toBe('0:00');
  });
});

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    expect(formatDuration(29000)).toBe('0:29');
    expect(formatDuration(65000)).toBe('1:05');
    expect(formatDuration(14967)).toBe('0:15');
    expect(formatDuration(600000)).toBe('10:00');
  });

  it('adds hours past 59:59', () => {
    expect(formatDuration(3723000)).toBe('1:02:03');
  });

  it('shows at least one second for very short clips', () => {
    expect(formatDuration(375)).toBe('0:01');
  });

  it('is empty when unknown or invalid', () => {
    for (const value of [null, undefined, 0, -5, NaN, 'abc']) expect(formatDuration(value)).toBe('');
  });
});

describe('formatResolution', () => {
  it('joins width and height', () => {
    expect(formatResolution(3840, 3840)).toBe('3840×3840');
    expect(formatResolution('1280', '720')).toBe('1280×720');
  });

  it('is empty unless both sides are known', () => {
    expect(formatResolution(null, 720)).toBe('');
    expect(formatResolution(1280, 0)).toBe('');
    expect(formatResolution(undefined, undefined)).toBe('');
  });
});

describe('packRuntime', () => {
  const video = (ms) => ({ available: true, post: { media_type: 'video', duration_ms: ms } });

  it('sums the known runtimes of available videos', () => {
    expect(packRuntime([video(29000), video(14000), video(45000)])).toEqual({ ms: 88000, known: 3, complete: true });
  });

  it('flags a partial total when some video has no runtime', () => {
    expect(packRuntime([video(29000), video(null)])).toEqual({ ms: 29000, known: 1, complete: false });
  });

  it('counts image posts at their dwell time and skips unavailable reels', () => {
    const items = [
      video(10000),
      { available: true, post: { media_type: 'image', duration_ms: null } },
      { available: true, post: { media_type: 'image', dwell_ms: 6000, images: [{}, {}, {}] } },
      { available: false, post: null },
      { available: false, post: { media_type: 'video', duration_ms: 99000 } },
    ];
    expect(packRuntime(items)).toEqual({ ms: 10000 + 15000 + 6000, known: 3, complete: true });
  });

  it('handles empty or missing lists', () => {
    expect(packRuntime([])).toEqual({ ms: 0, known: 0, complete: true });
    expect(packRuntime(undefined)).toEqual({ ms: 0, known: 0, complete: true });
  });
});

describe('imagePostLabel', () => {
  it('labels single images, slideshows, and nothing for video', () => {
    expect(imagePostLabel({ media_type: 'image', images: [{}] })).toBe('IMAGE');
    expect(imagePostLabel({ media_type: 'image' })).toBe('IMAGE');
    expect(imagePostLabel({ media_type: 'image', images: [{}, {}, {}] })).toBe('IMAGES · 3');
    expect(imagePostLabel({ media_type: 'video' })).toBe('');
  });
});
