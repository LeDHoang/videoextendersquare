import { describe, expect, it } from 'vitest';
import { revealScrollTarget } from './revealPlayer.js';

// 1000px tall window, 64px sticky header, default 12px margin.
const base = { viewportHeight: 1000, headerBottom: 64, scrollY: 0 };

describe('revealScrollTarget', () => {
  it('scrolls down just enough that the whole square sits under the header (the clipped-bottom case)', () => {
    // frame top at 374 and 825 tall: bottom 1199 is below the fold
    expect(revealScrollTarget({ ...base, top: 374, bottom: 1199 })).toBe(374 - 64 - 12);
  });

  it('adds to the current scroll position', () => {
    expect(revealScrollTarget({ ...base, scrollY: 100, top: 274, bottom: 1099 })).toBe(100 + 274 - 76);
  });

  it('does nothing when the square is already fully visible', () => {
    expect(revealScrollTarget({ ...base, top: 80, bottom: 905 })).toBeNull();
    expect(revealScrollTarget({ ...base, top: 64, bottom: 1000 })).toBeNull();
  });

  it('never scrolls up: a frame above the header edge is left alone', () => {
    expect(revealScrollTarget({ ...base, scrollY: 600, top: 40, bottom: 1010 })).toBeNull();
    expect(revealScrollTarget({ ...base, top: 70, bottom: 1010 })).toBeNull();
  });

  it('still lines the top up when the square is taller than the window', () => {
    expect(revealScrollTarget({ ...base, viewportHeight: 600, top: 300, bottom: 1100 })).toBe(300 - 76);
  });

  it('with align, also lines up a square that is already fully visible (pack page with its toolbar above)', () => {
    expect(revealScrollTarget({ ...base, top: 138, bottom: 958, align: true })).toBe(138 - 76);
    expect(revealScrollTarget({ ...base, top: 80, bottom: 905, align: true })).toBe(4);
  });

  it('with align, still never scrolls up and leaves a square already at the header alone', () => {
    expect(revealScrollTarget({ ...base, top: 76, bottom: 900, align: true })).toBeNull();
    expect(revealScrollTarget({ ...base, scrollY: 600, top: 40, bottom: 860, align: true })).toBeNull();
  });

  it('works without a header and ignores bad numbers', () => {
    expect(revealScrollTarget({ viewportHeight: 800, top: 300, bottom: 1100, scrollY: 0 })).toBe(288);
    expect(revealScrollTarget({ ...base, top: NaN, bottom: 1199 })).toBeNull();
    expect(revealScrollTarget({ ...base, top: 374, bottom: undefined })).toBeNull();
  });
});
