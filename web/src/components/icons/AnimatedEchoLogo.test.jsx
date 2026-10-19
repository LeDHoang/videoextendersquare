import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimatedEchoLogo } from './AnimatedEchoLogo.jsx';
import { BOTTOM_BULB, SAND_AREA, TOP_BULB, areaBelow, sandLevels } from './echoHourglass.js';

describe('echoHourglass sand levels', () => {
  it('conserves sand between the bulbs while it pours', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const lv = sandLevels(p);
      const top = p < 1 ? areaBelow(TOP_BULB, lv.top) : 0;
      const bottom = p > 0 ? areaBelow(BOTTOM_BULB, lv.bottom) : 0;
      expect(top + bottom).toBeCloseTo(SAND_AREA, 3);
    }
  });
});

describe('AnimatedEchoLogo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('labels the mark when given a title and hides it otherwise', () => {
    const { getByRole, container, rerender } = render(<AnimatedEchoLogo className="x" title="ECHO Logo" />);
    expect(getByRole('img', { name: 'ECHO Logo' })).toBeTruthy();
    rerender(<AnimatedEchoLogo className="x" />);
    expect(container.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
  });

  it('turns the hourglass over when its link is hovered', () => {
    const frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    const { container } = render(
      <a href="/reels">
        <AnimatedEchoLogo />
      </a>,
    );
    const body = () => container.querySelector('svg > g');
    expect(body().getAttribute('transform')).toBe('rotate(0 12 12)');
    fireEvent.pointerEnter(container.querySelector('a'));
    const start = performance.now();
    act(() => frames.shift()(start + 100));
    expect(body().getAttribute('transform')).not.toBe('rotate(0 12 12)');
    vi.restoreAllMocks();
  });

  it('moves the pupil on its own over time', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const { container } = render(<AnimatedEchoLogo />);
    const pupil = () => container.querySelector('.sx-echo-pupil').style.transform;
    expect(pupil()).toBe('translate(0px, 0px)');
    act(() => vi.advanceTimersByTime(4000));
    expect(pupil()).not.toBe('translate(0px, 0px)');
    vi.restoreAllMocks();
  });
});
