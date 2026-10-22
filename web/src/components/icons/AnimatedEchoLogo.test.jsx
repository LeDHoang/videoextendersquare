import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimatedEchoLogo } from './AnimatedEchoLogo.jsx';

describe('AnimatedEchoLogo', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('labels the mark when given a title and hides it otherwise', () => {
    const { getByRole, container, rerender } = render(<AnimatedEchoLogo className="x" title="ECHO Logo" />);
    expect(getByRole('img', { name: 'ECHO Logo' })).toBeTruthy();
    rerender(<AnimatedEchoLogo className="x" />);
    expect(container.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
  });

  it('turns the hourglass over once when its link is hovered', () => {
    vi.useFakeTimers();
    const { container } = render(
      <a href="/reels">
        <AnimatedEchoLogo className="x" />
      </a>,
    );
    const svg = () => container.querySelector('svg');
    expect(svg().classList.contains('is-play')).toBe(false);
    fireEvent.pointerEnter(container.querySelector('a'));
    expect(svg().classList.contains('is-play')).toBe(true);
    expect(svg().classList.contains('x')).toBe(true);
    act(() => vi.advanceTimersByTime(1600));
    expect(svg().classList.contains('is-play')).toBe(false);
  });

  it('glances on its own and the echoes lean after the eye', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const { container } = render(<AnimatedEchoLogo />);
    const gaze = () => container.querySelector('.sx-echo-gaze').style.transform;
    const drift = () => [...container.querySelectorAll('.sx-echo-drift')].map((g) => g.style.transform);
    expect(gaze()).toBe('translate(0px, 0px)');
    act(() => vi.advanceTimersByTime(4000));
    expect(gaze()).not.toBe('translate(0px, 0px)');
    const [outer, inner] = drift();
    expect(outer).not.toBe('translate(0px, 0px)');
    // The deeper echo travels further than the outer one.
    const x = (t) => Math.abs(parseFloat(t.match(/translate\((-?[\d.e-]+)px/)[1]));
    expect(x(inner)).toBeGreaterThan(x(outer));
    expect(container.querySelector('.sx-echo-kick.is-ping')).toBeTruthy();
  });

  it('falls asleep after a minute without input and wakes on the next one', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const { container } = render(<AnimatedEchoLogo />);
    const svg = () => container.querySelector('svg');
    fireEvent.pointerMove(window);
    act(() => vi.advanceTimersByTime(30000));
    expect(svg().classList.contains('is-asleep')).toBe(false);
    act(() => vi.advanceTimersByTime(40000));
    expect(svg().classList.contains('is-asleep')).toBe(true);
    // Asleep, the eye stops glancing.
    const gaze = container.querySelector('.sx-echo-gaze').style.transform;
    act(() => vi.advanceTimersByTime(8000));
    expect(container.querySelector('.sx-echo-gaze').style.transform).toBe(gaze);
    act(() => {
      fireEvent.keyDown(window, { key: 'a' });
    });
    expect(svg().classList.contains('is-asleep')).toBe(false);
  });

  it('drops the echoes at small sizes', () => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(20);
    const { container } = render(<AnimatedEchoLogo />);
    expect(container.querySelector('.sx-echo-echo')).toBeNull();
    expect(container.querySelector('.sx-echo-gaze')).toBeTruthy();
  });

  it('keeps the echoes at header sizes', () => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(36);
    const { container } = render(<AnimatedEchoLogo />);
    expect(container.querySelectorAll('.sx-echo-echo')).toHaveLength(2);
  });
});
