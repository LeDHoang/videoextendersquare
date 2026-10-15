// Pure layout math for the Upload Studio stage: where the source sits inside
// the 1:1 master and which bands the outpaint model has to generate.

export const MASTER_SIDE = 3840;

// Mirrors pipeline/utils.py calculate_square_padding (symmetric, floor first).
export function squarePadding(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w > h) {
    const diff = w - h;
    const top = Math.floor(diff / 2);
    return { top, bottom: diff - top, left: 0, right: 0 };
  }
  if (h > w) {
    const diff = h - w;
    const left = Math.floor(diff / 2);
    return { top: 0, bottom: 0, left, right: diff - left };
  }
  return { top: 0, bottom: 0, left: 0, right: 0 };
}

const pct = (value, side) => (side > 0 ? (value / side) * 100 : 0);

// Geometry for one staged item ({ width, height, padding? } as returned by
// /api/{image,video}/upload). Percentages are relative to the square stage.
export function stageLayout(meta) {
  const width = Number(meta?.width) || 0;
  const height = Number(meta?.height) || 0;
  if (!width || !height) return null;
  const side = Math.max(width, height);
  const padding = meta?.padding && typeof meta.padding === 'object'
    ? {
        top: Number(meta.padding.top) || 0,
        bottom: Number(meta.padding.bottom) || 0,
        left: Number(meta.padding.left) || 0,
        right: Number(meta.padding.right) || 0,
      }
    : squarePadding(width, height);
  const axis = padding.left || padding.right ? 'x' : padding.top || padding.bottom ? 'y' : null;
  const zones = axis === 'x'
    ? [
        { side: 'left', px: padding.left, style: { left: '0%', top: '0%', width: `${pct(padding.left, side)}%`, height: '100%' } },
        { side: 'right', px: padding.right, style: { right: '0%', top: '0%', width: `${pct(padding.right, side)}%`, height: '100%' } },
      ]
    : axis === 'y'
      ? [
          { side: 'top', px: padding.top, style: { left: '0%', top: '0%', width: '100%', height: `${pct(padding.top, side)}%` } },
          { side: 'bottom', px: padding.bottom, style: { left: '0%', bottom: '0%', width: '100%', height: `${pct(padding.bottom, side)}%` } },
        ]
      : [];
  return {
    width,
    height,
    side,
    padding,
    axis,
    square: axis === null,
    orientation: width > height ? 'LANDSCAPE' : height > width ? 'PORTRAIT' : 'SQUARE',
    aspect: aspectLabel(width, height),
    source: {
      left: `${pct(padding.left, side)}%`,
      top: `${pct(padding.top, side)}%`,
      width: `${pct(width, side)}%`,
      height: `${pct(height, side)}%`,
    },
    zones,
    padLabel: axis === 'x'
      ? `${padding.left === padding.right ? padding.left : `${padding.left}/${padding.right}`}px [L/R]`
      : axis === 'y'
        ? `${padding.top === padding.bottom ? padding.top : `${padding.top}/${padding.bottom}`}px [T/B]`
        : 'NONE',
  };
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

export function aspectLabel(width, height) {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  if (!w || !h) return '—';
  const g = gcd(w, h);
  const rw = w / g;
  const rh = h / g;
  if (rw <= 32 && rh <= 32) return `${rw}:${rh}`;
  return `${(w / h).toFixed(2)}:1`;
}

export function formatClock(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}

// One-line description of the configured pipeline for the studio banner.
export function pipelineSummary({ kind, path = 'extend', upscaleOnly, outpaintLabel, engine, upscaleLabel, bytedanceRes }) {
  if (!kind) return 'AWAITING SOURCE';
  if (path === 'skip') return 'AS-IS · NO EXTEND';
  const parts = [];
  if (!upscaleOnly) parts.push(`OUTPAINT: ${(outpaintLabel || 'STOCK').toUpperCase()}`);
  if (engine === 'FAL AI') {
    const label = (upscaleLabel || 'FAL').toUpperCase();
    parts.push(`UPSCALE: ${label}${kind === 'video' && /bytedance/i.test(upscaleLabel || '') && bytedanceRes ? ` ${String(bytedanceRes).toUpperCase()}` : ''}`);
  } else {
    parts.push(`UPSCALE: ${engine === 'STUDIO' ? 'STUDIO NNEDI3' : 'FAST LANCZOS'}`);
  }
  return parts.join(' · ');
}
