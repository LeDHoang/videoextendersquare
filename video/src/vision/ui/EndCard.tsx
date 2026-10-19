// End card: the galaxy of worlds collapses into the ECHO mark. It stays up
// while the stage and the music fade, so the last frame is the brand.
import type React from 'react';
import { C, CONTACT, F } from '../../theme';
import { ease, lerp, seg } from '../anim';
import { END_CARD } from '../director';
import { Line, MONO, SERIF, words } from './Copy';

const AT = END_CARD;
const STAY: [number, number] = [1e6, 1e6 + 1];

/** Stroke draw-on progress for an element with pathLength=1. */
const draw = (f: number, a: number, b: number) => ({
  pathLength: 1,
  strokeDasharray: 1,
  strokeDashoffset: 1 - ease.inOutCubic(seg(f, a, b)),
});

// The mark is an hourglass: it draws on upside down, turns over, and its
// sand runs from the top bulb into the bottom one until the video ends.
const FLIP: [number, number] = [AT + 12, AT + 28];
const POUR: [number, number] = [AT + 28, AT + 94];
const SAND = '#ffb35c'; // warm amber, so the sand never reads as outline
const SAND_INNER = '#4fd1c5'; // teal for the inner chambers, after the app's ambilight
const INNER_TOP = '8,4.5 16,4.5 12,10.4';
const INNER_BOTTOM = '8,19.5 16,19.5 12,13.6';
const OUTLINE = 'M7 2.5 H17 L21 7 L14.5 11.4 L16.8 12 L14.5 12.6 L21 17 L17 21.5 H7 L3 17 L9.5 12.6 L7.2 12 L9.5 11.4 L3 7 Z';
// The two dark bulbs of the outline, in logo units (y grows downward).
type Pt = [number, number];
const TOP_BULB: Pt[] = [[7, 2.5], [17, 2.5], [21, 7], [14.5, 11.4], [9.5, 11.4], [3, 7]];
const BOTTOM_BULB: Pt[] = TOP_BULB.map(([x, y]) => [x, 24 - y]);
const TOP_FULL = 4.6; // sand surface when the top bulb is full

/** Area of the polygon below the horizontal line at y (Sutherland-Hodgman + shoelace). */
const areaBelow = (poly: Pt[], y: number) => {
  const out: Pt[] = [];
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
};

/** Surface height that leaves `area` of sand below it in the bulb. */
const surface = (poly: Pt[], area: number) => {
  let lo = Math.min(...poly.map((p) => p[1]));
  let hi = Math.max(...poly.map((p) => p[1]));
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (areaBelow(poly, mid) > area) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

const SAND_AREA = areaBelow(TOP_BULB, TOP_FULL);

/** Sand surfaces (y, logo units) for pour progress p, conserving area. */
const sandLevels = (p: number) => ({
  top: surface(TOP_BULB, SAND_AREA * (1 - p)),
  bottom: p > 0 ? surface(BOTTOM_BULB, SAND_AREA * p) : 21.5,
});

// The pupil of the centre eye glances around while the sand runs, then
// settles on the viewer. Each entry is [frame, x, y] in eye-radius units.
const GAZE: [number, number, number][] = [
  [AT + 30, 0, 0],
  [AT + 38, -1, 0.1],
  [AT + 50, 1, -0.2],
  [AT + 60, 0.5, 0.7],
  [AT + 72, -0.6, -0.5],
  [AT + 84, 0, 0],
];
const SACCADE = 4; // frames per glance
const gaze = (f: number) => {
  let x = 0;
  let y = 0;
  GAZE.forEach(([at, gx, gy]) => {
    const k = ease.inOutCubic(seg(f, at, at + SACCADE));
    x = lerp(x, gx, k);
    y = lerp(y, gy, k);
  });
  return { x, y };
};

// The eye blinks between glances and once more after it settles.
const BLINKS = [AT + 45, AT + 93];
/** Eyelid closure 0..1: shut over 2 frames, hold 1, open over 3. */
const blink = (f: number) =>
  Math.max(...BLINKS.map((b) => ease.inOutCubic(seg(f, b, b + 2) * (1 - seg(f, b + 3, b + 6)))));

/** web/public/logo.svg as an hourglass: strokes draw on, it flips, sand runs. */
const Mark: React.FC<{ f: number; size: number }> = ({ f, size }) => {
  const fill = seg(f, AT + 8, AT + 18);
  const core = ease.outBack(seg(f, FLIP[1] - 4, FLIP[1] + 2));
  const turn = 180 * (1 - ease.outBack(seg(f, FLIP[0], FLIP[1])));
  // Sand settles into the top bulb as the mark lands upright.
  const sand = seg(f, FLIP[1] - 8, FLIP[1]);
  const p = seg(f, POUR[0], POUR[1]);
  const lv = sandLevels(p);
  // The stream thins in as the pour starts and out as the last grains fall.
  const stream = seg(f, POUR[0], POUR[0] + 4) * (1 - seg(f, POUR[1] - 6, POUR[1]));
  // The top surface dips into a funnel and the bottom one heaps into a cone.
  const dip = 1.4 * Math.min(1, p * 6) * (1 - seg(f, POUR[1] - 10, POUR[1]));
  const heap = 1.2 * Math.min(1, p * 6);
  const eye = gaze(f);
  const lid = 1 - 0.9 * blink(f);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{
        overflow: 'visible',
        transform: `rotate(${turn}deg)`,
        filter: `drop-shadow(0 0 ${lerp(30, 14, fill)}px ${C.accentGlow})`,
      }}
    >
      <defs>
        <clipPath id="sandTop">
          <polygon points={TOP_BULB.join(' ')} />
        </clipPath>
        <clipPath id="sandBottom">
          <polygon points={BOTTOM_BULB.join(' ')} />
        </clipPath>
        <clipPath id="sandTopInner">
          <polygon points={INNER_TOP} />
        </clipPath>
        <clipPath id="sandBottomInner">
          <polygon points={INNER_BOTTOM} />
        </clipPath>
      </defs>
      <path d={OUTLINE} fill="#101214" fillOpacity={fill} />
      {[
        { top: 'sandTop', bottom: 'sandBottom', color: SAND },
        { top: 'sandTopInner', bottom: 'sandBottomInner', color: SAND_INNER },
      ].map((layer) => (
        <g key={layer.color} opacity={sand}>
          <polygon
            clipPath={`url(#${layer.top})`}
            points={`2,${lv.top} 12,${lv.top + dip} 22,${lv.top} 22,12 2,12`}
            fill={layer.color}
          />
          {p > 0 ? (
            <polygon
              clipPath={`url(#${layer.bottom})`}
              points={`2,22 22,22 22,${lv.bottom + heap} 12,${lv.bottom - heap} 2,${lv.bottom + heap}`}
              fill={layer.color}
            />
          ) : null}
        </g>
      ))}
      <path d={OUTLINE} fill="none" stroke="#fff" strokeWidth={1.5} strokeLinejoin="bevel" {...draw(f, AT, AT + 12)} />
      <polygon points={INNER_TOP} fill="none" stroke={C.ink} strokeWidth={1.4} strokeLinejoin="bevel" {...draw(f, AT + 3, AT + 13)} />
      <polygon points={INNER_BOTTOM} fill="none" stroke={C.ink} strokeWidth={1.4} strokeLinejoin="bevel" {...draw(f, AT + 3, AT + 13)} />
      <line x1={12} y1={2.5} x2={12} y2={21.5} stroke={C.accent} strokeWidth={1.6} strokeLinecap="square" {...draw(f, AT + 6, AT + 12)} />
      <path d="M8.5 12 L11 10.4 M8.5 12 L11 13.6" fill="none" stroke={C.accent} strokeWidth={1.4} strokeLinejoin="bevel" {...draw(f, AT + 8, AT + 14)} />
      <path d="M15.5 12 L13 10.4 M15.5 12 L13 13.6" fill="none" stroke={C.accent} strokeWidth={1.4} strokeLinejoin="bevel" {...draw(f, AT + 8, AT + 14)} />
      <line x1={4.5} y1={12} x2={7} y2={12} stroke={C.accent} strokeWidth={1.3} {...draw(f, AT + 9, AT + 14)} />
      <line x1={17} y1={12} x2={19.5} y2={12} stroke={C.accent} strokeWidth={1.3} {...draw(f, AT + 9, AT + 14)} />
      {stream > 0 ? (
        <line
          x1={12}
          y1={11.4}
          x2={12}
          y2={lv.bottom - heap}
          stroke={SAND}
          strokeWidth={0.8 * stream}
          strokeDasharray="0.45 0.35"
          strokeDashoffset={-0.3 * f}
        />
      ) : null}
      <g transform={`translate(12 12) scale(${core}) translate(-12 -12)`}>
        <polygon points="12,10.5 13.5,12 12,13.5 10.5,12" fill={C.accent} />
        <g transform={`translate(0 12) scale(1 ${lid}) translate(0 -12)`}>
          <circle cx={12} cy={12} r={0.62} fill={C.ink} />
          <circle cx={12 + 0.3 * eye.x} cy={12 + 0.3 * eye.y} r={0.3} fill="#101214" />
        </g>
      </g>
    </svg>
  );
};

export const EndCard: React.FC<{ frame: number }> = ({ frame: f }) => {
  if (f < AT) return null;
  // Wordmark tracks in from wide to tight; the negative margin cancels the
  // trailing letter-spacing so the row stays optically centred.
  const track = lerp(0.55, 0.12, ease.outCubic(seg(f, AT + 4, AT + 26)));
  const word = seg(f, AT + 4, AT + 12);
  return (
    <>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: seg(f, AT + 4, AT + 20),
          background: 'radial-gradient(ellipse 62% 52% at 50% 50%, rgba(0,0,0,0.62), rgba(0,0,0,0) 100%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          width: 1920,
          top: 468,
          transform: 'translateY(-50%)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 46,
        }}
      >
        <Mark f={f} size={156} />
        <div
          style={{
            fontFamily: F.brand,
            fontWeight: 900,
            fontSize: 156,
            lineHeight: 1,
            color: C.ink,
            letterSpacing: `${track}em`,
            marginRight: `${-track}em`,
            opacity: word,
            filter: word < 0.999 ? `blur(${(1 - word) * 16}px)` : undefined,
            textShadow: '0 0 40px rgba(0,0,0,0.5)',
          }}
        >
          ECHO
        </div>
      </div>
      <Line f={f} words={words('Every reel, a world.', AT + 16, 4)} exit={STAY} y={632} font={{ ...SERIF, fontSize: 80 }} />
      <div
        style={{
          position: 'absolute',
          left: 0,
          width: 1920,
          top: 948,
          textAlign: 'center',
          ...MONO,
          fontWeight: 400,
          fontSize: 22,
          letterSpacing: '0.18em',
          color: C.ink2,
          whiteSpace: 'pre',
          opacity: seg(f, AT + 30, AT + 42),
        }}
      >
        {CONTACT}
      </div>
    </>
  );
};
