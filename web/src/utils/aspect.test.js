import { describe, expect, it } from 'vitest';
import vectors from '../../../tests/fixtures/aspect_vectors.json';
import { aspectCanvas, aspectMatches, aspectOf, aspectPadding, masterSize, nearestAspect, tileAspect } from './aspect.js';

describe('aspect helpers match pipeline/utils.py', () => {
  for (const c of vectors.cases) {
    it(`${c.w}x${c.h}`, () => {
      expect(nearestAspect(c.w, c.h)).toBe(c.nearest);
      expect(masterSize(c.w, c.h)).toEqual(c.master_native);
      for (const t of ['1:1', '16:9', '9:16']) {
        expect(aspectMatches(c.w, c.h, t)).toBe(c[t].matches);
        expect(aspectCanvas(c.w, c.h, t)).toEqual(c[t].canvas);
        expect(aspectPadding(c.w, c.h, t)).toEqual(c[t].padding);
        expect(masterSize(c.w, c.h, t)).toEqual(c[t].master);
      }
    });
  }
});

describe('aspectOf / tileAspect', () => {
  it('defaults to square and clamps tiles', () => {
    expect(aspectOf({})).toBe(1);
    expect(aspectOf({ aspect: 1.7778 })).toBe(1.7778);
    expect(tileAspect({ aspect: 2.37 })).toBeCloseTo(16 / 9);
    expect(tileAspect({ aspect: 0.4 })).toBeCloseTo(9 / 16);
  });
});
