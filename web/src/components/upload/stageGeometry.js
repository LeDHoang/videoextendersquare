import { aspectCanvas, aspectPadding } from '../../utils/aspect.js';

// Pure layout math for the Upload Studio stage: where the source sits inside
// the master of the target shape and which bands the outpaint model has to generate.

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

// The padding that takes width×height to `target`: the server's square padding
// ({ width, height, padding? } as returned by /api/{image,video}/upload) for 1:1,
// the shared aspect rule for 16:9 / 9:16, none for null (the file keeps its shape).
function targetPadding(meta, width, height, target) {
  if (!target) return { top: 0, bottom: 0, left: 0, right: 0 };
  if (target !== '1:1') {
    const [top, bottom, left, right] = aspectPadding(width, height, target);
    return { top, bottom, left, right };
  }
  return meta?.padding && typeof meta.padding === 'object'
    ? {
        top: Number(meta.padding.top) || 0,
        bottom: Number(meta.padding.bottom) || 0,
        left: Number(meta.padding.left) || 0,
        right: Number(meta.padding.right) || 0,
      }
    : squarePadding(width, height);
}

// Geometry for one staged item made into `target` ('1:1' | '16:9' | '9:16', or
// null for its own shape). The stage has the canvas's shape (`stageWidth` ×
// `stageHeight`); x percentages are of its width, y percentages of its height.
export function stageLayout(meta, target = '1:1') {
  const width = Number(meta?.width) || 0;
  const height = Number(meta?.height) || 0;
  if (!width || !height) return null;
  const side = Math.max(width, height);
  const padding = targetPadding(meta, width, height, target);
  const [stageWidth, stageHeight] = target === '1:1'
    ? [side, side]
    : target ? aspectCanvas(width, height, target) : [width, height];
  const x = (value) => pct(value, stageWidth);
  const y = (value) => pct(value, stageHeight);
  const axis = padding.left || padding.right ? 'x' : padding.top || padding.bottom ? 'y' : null;
  const zones = axis === 'x'
    ? [
        { side: 'left', px: padding.left, style: { left: '0%', top: '0%', width: `${x(padding.left)}%`, height: '100%' } },
        { side: 'right', px: padding.right, style: { right: '0%', top: '0%', width: `${x(padding.right)}%`, height: '100%' } },
      ]
    : axis === 'y'
      ? [
          { side: 'top', px: padding.top, style: { left: '0%', top: '0%', width: '100%', height: `${y(padding.top)}%` } },
          { side: 'bottom', px: padding.bottom, style: { left: '0%', bottom: '0%', width: '100%', height: `${y(padding.bottom)}%` } },
        ]
      : [];
  return {
    width,
    height,
    side,
    stageWidth,
    stageHeight,
    padding,
    axis,
    square: axis === null,
    orientation: width > height ? 'LANDSCAPE' : height > width ? 'PORTRAIT' : 'SQUARE',
    aspect: aspectLabel(width, height),
    source: {
      left: `${x(padding.left)}%`,
      top: `${y(padding.top)}%`,
      width: `${x(width)}%`,
      height: `${y(height)}%`,
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
  if (!kind) return '';
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
