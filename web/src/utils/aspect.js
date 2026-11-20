// Aspect rules shared with pipeline/utils.py (docs/multi-format.md).
// tests/fixtures/aspect_vectors.json keeps the two in step.

export const TARGET_ASPECTS = ['1:1', '16:9', '9:16'];
export const ASPECT_TOLERANCE = 0.01;
export const MASTER_SHORT = 2048;
export const MASTER_LONG_CAP = 4096;
// Grid tiles clamp odd shapes into this range and cover-fit inside.
export const TILE_ASPECT_MIN = 9 / 16;
export const TILE_ASPECT_MAX = 16 / 9;

export function parseAspect(target) {
  if (!TARGET_ASPECTS.includes(target)) throw new Error(`unsupported target aspect: ${target}`);
  const [w, h] = target.split(':').map(Number);
  return w / h;
}

export function aspectMatches(width, height, target) {
  return Math.abs((width / height) / parseAspect(target) - 1) <= ASPECT_TOLERANCE;
}

export function nearestAspect(width, height) {
  const have = Math.log(width / height);
  let best = TARGET_ASPECTS[0];
  for (const t of TARGET_ASPECTS) {
    if (Math.abs(Math.log(parseAspect(t)) - have) < Math.abs(Math.log(parseAspect(best)) - have)) best = t;
  }
  return best;
}

const evenUp = (n) => n + (n % 2);
const evenDown = (n) => Math.max(2, n - (n % 2));
// Python's round(): halves go to the even neighbour.
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function aspectCanvas(width, height, target) {
  const want = parseAspect(target);
  const [cw, ch] = width / height > want ? [width, width / want] : [height * want, height];
  return [evenUp(Math.ceil(cw - 1e-6)), evenUp(Math.ceil(ch - 1e-6))];
}

export function aspectPadding(width, height, target) {
  const [cw, ch] = aspectCanvas(width, height, target);
  const rel = (width / height) / parseAspect(target);
  if (rel - 1 > ASPECT_TOLERANCE) {
    const dy = Math.max(0, ch - height);
    const top = Math.floor(dy / 2);
    return [top, dy - top, 0, 0];
  }
  if (1 - rel > ASPECT_TOLERANCE) {
    const dx = Math.max(0, cw - width);
    const left = Math.floor(dx / 2);
    return [0, 0, left, dx - left];
  }
  return [0, 0, 0, 0];
}

export function masterSize(width, height, target = null) {
  const ratio = target ? parseAspect(target) : width / height;
  const longRatio = Math.max(ratio, 1 / ratio);
  const longSide = Math.min(MASTER_LONG_CAP, MASTER_SHORT * longRatio);
  const shortSide = longSide / longRatio;
  return ratio >= 1
    ? [evenDown(pyRound(longSide)), evenDown(pyRound(shortSide))]
    : [evenDown(pyRound(shortSide)), evenDown(pyRound(longSide))];
}

// The one aspect a post shows at: the server's eye-adjusted `aspect`, else 1.
export function aspectOf(post) {
  const a = Number(post?.aspect);
  return Number.isFinite(a) && a > 0 ? a : 1;
}

export function tileAspect(post) {
  return Math.min(TILE_ASPECT_MAX, Math.max(TILE_ASPECT_MIN, aspectOf(post)));
}
