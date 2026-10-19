// Geometry for the animated ECHO hourglass mark (mirrors the end card in
// video/src/vision/ui/EndCard.tsx). Units are the 24x24 logo viewBox, y down.

export const OUTLINE =
  'M7 2.5 H17 L21 7 L14.5 11.4 L16.8 12 L14.5 12.6 L21 17 L17 21.5 H7 L3 17 L9.5 12.6 L7.2 12 L9.5 11.4 L3 7 Z';
export const TOP_BULB = [[7, 2.5], [17, 2.5], [21, 7], [14.5, 11.4], [9.5, 11.4], [3, 7]];
export const BOTTOM_BULB = TOP_BULB.map(([x, y]) => [x, 24 - y]);
export const INNER_TOP = '8,4.5 16,4.5 12,10.4';
export const INNER_BOTTOM = '8,19.5 16,19.5 12,13.6';
const TOP_FULL = 4.6; // sand surface when the top bulb is full

/** Area of the polygon below the horizontal line at y (Sutherland-Hodgman + shoelace). */
export function areaBelow(poly, y) {
  const out = [];
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const inA = a[1] >= y;
    const inB = b[1] >= y;
    if (inA) out.push(a);
    if (inA !== inB) out.push([a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), y]);
  });
  let s = 0;
  out.forEach((a, i) => {
    const b = out[(i + 1) % out.length];
    s += a[0] * b[1] - b[0] * a[1];
  });
  return Math.abs(s) / 2;
}

/** Surface height that leaves `area` of sand below it in the bulb. */
function surface(poly, area) {
  let lo = Math.min(...poly.map((p) => p[1]));
  let hi = Math.max(...poly.map((p) => p[1]));
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (areaBelow(poly, mid) > area) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export const SAND_AREA = areaBelow(TOP_BULB, TOP_FULL);

/** Sand surfaces (y) for pour progress p in [0, 1], conserving area. */
export function sandLevels(p) {
  return {
    top: p < 1 ? surface(TOP_BULB, SAND_AREA * (1 - p)) : 12,
    bottom: p > 0 ? surface(BOTTOM_BULB, SAND_AREA * p) : 21.5,
  };
}

export const clamp01 = (v) => Math.min(1, Math.max(0, v));
export const outBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};
