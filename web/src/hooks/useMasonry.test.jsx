import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import useMasonry, { MASONRY_ROW, layoutMasonry } from './useMasonry.js';

describe('layoutMasonry', () => {
  it('puts each tile in the shortest column, ties to the left', () => {
    // 320px columns, 8px rows: 1:1 = 40 rows, 16:9 = 23, 9:16 = 71.
    const placed = layoutMasonry([1, 16 / 9, 9 / 16, 1, 1], 3, 320);
    expect(placed).toEqual([
      { column: 1, row: '1 / span 40' },
      { column: 2, row: '1 / span 23' },
      { column: 3, row: '1 / span 71' },
      { column: 2, row: '24 / span 40' },
      { column: 1, row: '41 / span 40' },
    ]);
  });

  it('counts the row gap in each span', () => {
    // (320 + 8) / (8 + 8) = 20.5 -> 21 rows.
    expect(layoutMasonry([1], 2, 320, 8)[0].row).toBe('1 / span 21');
  });

  it('keeps earlier tiles in place when more are appended', () => {
    const first = [1, 16 / 9, 9 / 16, 0.8, 1.2];
    const before = layoutMasonry(first, 3, 300);
    const after = layoutMasonry([...first, 1, 9 / 16, 16 / 9], 3, 300);
    expect(after.slice(0, first.length)).toEqual(before);
  });

  it('relays out from scratch for a new order or column count', () => {
    const aspects = [9 / 16, 1, 16 / 9, 1];
    expect(layoutMasonry([...aspects].reverse(), 3, 300)[0]).toEqual({ column: 1, row: '1 / span 38' });
    expect(layoutMasonry(aspects, 2, 300).map((p) => p.column)).toEqual([1, 2, 2, 2]);
  });
});

function Grid({ items, density = 'grid' }) {
  const ref = useMasonry(items, density);
  return (
    <div ref={ref} data-testid="grid">
      {items.map((item) => <div key={item.key} />)}
    </div>
  );
}

describe('useMasonry', () => {
  let tracks = '300px 300px 300px';
  let observerCallback = null;

  function stubBrowser() {
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb) { observerCallback = cb; }
      observe() {}
      disconnect() {}
    });
    const real = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      if (el.dataset?.testid === 'grid') return { gridTemplateColumns: tracks, rowGap: '0px' };
      return real(el);
    });
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    tracks = '300px 300px 300px';
  });

  const items = [
    { key: 'a', aspect: 1 },
    { key: 'b', aspect: 16 / 9 },
    { key: 'c', aspect: 9 / 16 },
    { key: 'd', aspect: 1 },
  ];

  it('places the grid children in DOM order and sets the row unit', () => {
    stubBrowser();
    const { getByTestId } = render(<Grid items={items} />);
    const grid = getByTestId('grid');
    expect(grid.style.gridAutoRows).toBe(MASONRY_ROW + 'px');
    const kids = Array.from(grid.children);
    expect(kids.map((kid) => kid.style.gridColumn)).toEqual(['1', '2', '3', '2']);
    expect(kids[3].style.gridRow).toBe('22 / span 38');
    expect(kids[0].style.aspectRatio).toBe('auto');
  });

  it('relays out when the columns change and falls back to flow at one column', () => {
    stubBrowser();
    const { getByTestId, rerender } = render(<Grid items={items} />);
    const grid = getByTestId('grid');
    tracks = '450px 450px';
    observerCallback();
    expect(Array.from(grid.children).map((kid) => kid.style.gridColumn)).toEqual(['1', '2', '2', '1']);
    tracks = '900px';
    rerender(<Grid items={items} density="stack" />);
    expect(grid.style.gridAutoRows).toBe('');
    expect(grid.children[0].style.gridColumn).toBe('');
    expect(grid.children[0].style.aspectRatio).toBe('');
  });

  it('leaves plain flow when the browser has no ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { getByTestId } = render(<Grid items={items} />);
    expect(getByTestId('grid').style.gridAutoRows).toBe('');
  });
});
