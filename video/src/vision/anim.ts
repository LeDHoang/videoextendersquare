// Small deterministic animation helpers for the vision cut: easing, segment
// progress and monotone keyframe curves (no overshoot unless a slope is given).
import type { Vec3 } from './gl/GLStage';

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
/** 0..1 progress of f through [a, b], clamped. */
export const seg = (f: number, a: number, b: number) => clamp01((f - a) / (b - a));
/** Exponential interpolation, for scales and zooms. */
export const elerp = (a: number, b: number, t: number) => Math.exp(lerp(Math.log(a), Math.log(b), t));
/** Decaying pulse after `at` (0 before it). */
export const pulse = (f: number, at: number, tau: number) => (f < at ? 0 : Math.exp(-(f - at) / tau));

export const ease = {
  linear: (x: number) => x,
  inCubic: (x: number) => x * x * x,
  outCubic: (x: number) => 1 - Math.pow(1 - x, 3),
  inOutCubic: (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  outQuart: (x: number) => 1 - Math.pow(1 - x, 4),
  outQuint: (x: number) => 1 - Math.pow(1 - x, 5),
  inOutSine: (x: number) => -(Math.cos(Math.PI * x) - 1) / 2,
  outBack: (x: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  },
};

/** Keyframe: [frame, value, optional slope in value per frame]. */
export type Key = [number, number, number?];

/**
 * Monotone cubic Hermite curve through the keys (Fritsch-Butland tangents).
 * End slopes are 0 unless given, explicit slopes are used as-is, and the
 * value holds outside the key range.
 */
export const curve = (keys: Key[]) => {
  const n = keys.length;
  const x = keys.map((k) => k[0]);
  const y = keys.map((k) => k[1]);
  const fixed = keys.map((k) => k[2] !== undefined);
  const d = x.slice(0, -1).map((_, i) => (y[i + 1] - y[i]) / (x[i + 1] - x[i]));
  const m = keys.map((k, i) => {
    if (k[2] !== undefined) return k[2];
    if (i === 0 || i === n - 1) return 0;
    if (d[i - 1] * d[i] <= 0) return 0;
    const h0 = x[i] - x[i - 1];
    const h1 = x[i + 1] - x[i];
    const w1 = 2 * h1 + h0;
    const w2 = h1 + 2 * h0;
    return (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  });
  // Fritsch-Carlson limiter on the free tangents keeps every span monotone.
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      if (!fixed[i]) m[i] = 0;
      if (!fixed[i + 1]) m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      if (!fixed[i]) m[i] = t * a * d[i];
      if (!fixed[i + 1]) m[i + 1] = t * b * d[i];
    }
  }
  return (f: number) => {
    if (f <= x[0]) return y[0];
    if (f >= x[n - 1]) return y[n - 1];
    let i = 0;
    while (f > x[i + 1]) i++;
    const h = x[i + 1] - x[i];
    const t = (f - x[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * h * m[i + 1];
  };
};

/** Vec3 keyframe: [frame, value, optional per-axis slope]. */
export type Key3 = [number, Vec3, Vec3?];

export const curve3 = (keys: Key3[]) => {
  const axis = (a: 0 | 1 | 2) => curve(keys.map(([f, v, s]): Key => (s ? [f, v[a], s[a]] : [f, v[a]])));
  const cx = axis(0);
  const cy = axis(1);
  const cz = axis(2);
  return (f: number): Vec3 => [cx(f), cy(f), cz(f)];
};
