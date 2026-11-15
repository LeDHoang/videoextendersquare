import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RawIcon } from './RawIcon.jsx';

const SRC = '<svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>';

describe('RawIcon', () => {
  it('keeps the same svg node when the parent re-renders with the same props', () => {
    const { container, rerender } = render(<RawIcon src={SRC} className="a" />);
    const before = container.querySelector('svg');
    rerender(<RawIcon src={SRC} className="a" />);
    expect(container.querySelector('svg')).toBe(before);
  });

  it('swaps the artwork when the props change', () => {
    const { container, rerender } = render(<RawIcon src={SRC} className="a" />);
    rerender(<RawIcon src={SRC} className="b" />);
    expect(container.querySelector('svg').getAttribute('class')).toBe('b');
  });
});
