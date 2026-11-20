import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// Row unit of the masonry grid in px. Browsers cap a grid at about 10k lines, so
// 8px keeps roughly 80,000px of column height addressable.
export const MASONRY_ROW = 8;

/* Greedy shortest-column placement (ties go left). Spans come from the aspect
   alone, so placing items[0..n) never depends on later items: an append keeps
   every earlier tile where it was. */
export function layoutMasonry(aspects, cols, colWidth, gap = 0, row = MASONRY_ROW) {
  const heights = new Array(cols).fill(0);
  return aspects.map((aspect) => {
    const col = heights.indexOf(Math.min(...heights));
    const span = Math.max(1, Math.round((colWidth / aspect + gap) / (row + gap)));
    const start = heights[col] + 1;
    heights[col] += span;
    return { column: col + 1, row: `${start} / span ${span}` };
  });
}

// [count, width] from the computed grid-template-columns, or null when the
// browser did not resolve the tracks to px.
function readColumns(el) {
  const tracks = getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/);
  if (!tracks.length || !tracks.every((t) => /^[\d.]+px$/.test(t))) return null;
  return [tracks.length, Math.round(parseFloat(tracks[0]) * 10) / 10];
}

function clear(el) {
  el.style.gridAutoRows = '';
  for (const child of el.children) {
    child.style.gridColumn = '';
    child.style.gridRow = '';
    child.style.aspectRatio = '';
  }
}

/* True-shape masonry on a CSS grid. items: [{ key, aspect }] in DOM order, one
   per grid child. Each child gets an explicit column and row span; DOM and tab
   order stay item order. `layoutKey` (e.g. the density) re-reads the columns
   when a class change swaps the tracks without resizing the grid. A single
   column, no items, or no ResizeObserver leaves plain CSS flow. Returns a
   callback ref. */
export default function useMasonry(items, layoutKey = '') {
  const [el, setEl] = useState(null);
  const applied = useRef('');
  const sig = items.map((item) => item.key + ':' + item.aspect).join('|');
  const aspects = useRef([]);
  aspects.current = items.map((item) => item.aspect);

  const apply = useCallback(() => {
    if (!el) return;
    // A placed column past the new track count adds an implicit track (so can
    // row-locked tiles that overlap), so read the columns with the placements
    // lifted, then put them back.
    const kids = Array.from(el.children);
    const held = kids.map((child) => [child.style.gridColumn, child.style.gridRow]);
    kids.forEach((child) => { child.style.gridColumn = ''; child.style.gridRow = ''; });
    const columns = readColumns(el);
    if (!columns || columns[0] < 2 || !aspects.current.length) {
      applied.current = '';
      clear(el);
      return;
    }
    const [cols, width] = columns;
    const key = `${sig}#${cols}#${width}`;
    if (key === applied.current) {
      kids.forEach((child, index) => { [child.style.gridColumn, child.style.gridRow] = held[index]; });
      return;
    }
    applied.current = key;
    const gap = parseFloat(getComputedStyle(el).rowGap) || 0;
    const placed = layoutMasonry(aspects.current, cols, width, gap);
    el.style.gridAutoRows = MASONRY_ROW + 'px';
    Array.from(el.children).forEach((child, index) => {
      const spot = placed[index];
      if (!spot) return;
      child.style.gridColumn = String(spot.column);
      child.style.gridRow = spot.row;
      // The tile fills its span; cover-fit media absorbs the row rounding.
      child.style.aspectRatio = 'auto';
    });
  }, [el, sig]);

  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    applied.current = '';
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, apply, layoutKey]);

  return setEl;
}
