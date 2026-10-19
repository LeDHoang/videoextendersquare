// The ECHO "Echo Glass" mark, frame-driven for the end cards. Same geometry as
// web/src/components/icons/echoGlass.js (3dreels): two chamfered triangles
// meeting at a hex eye, with two inner echoes. It draws on upside down, turns
// over, the eye opens and the echoes grow out of it; then the eye glances and
// blinks while the echoes breathe, lean after the gaze, ripple out on each
// glance and squeeze in on each blink.
import type React from 'react';
import { useId } from 'react';
import { C } from '../theme';
import { ease, lerp, seg } from '../vision/anim';

const TOP = '9,4 39,4 43,8 24,25 5,8';
const BOTTOM = '9,44 39,44 43,40 24,23 5,40';
const LENS = '12,24 18,17.5 30,17.5 36,24 30,30.5 18,30.5';
const IRIS = '24,17.5 30.5,24 24,30.5 17.5,24';
const PUPIL = '24,21 27,24 24,27 21,24';
const ECHOES = [
  { k: 0.68, w: 1.8, o: 0.5, drift: 0.3, lag: 0 },
  { k: 0.44, w: 1.3, o: 0.28, drift: 0.55, lag: 1 },
];
const [AX, AY] = [3.5, 1.5]; // iris travel in viewBox units at full gaze

// Choreography, in frames from the start of the card.
const DRAW: [number, number] = [0, 12];
const FLIP: [number, number] = [12, 28];
const BREATH = 102; // 3.4 s at 30 fps, as on the web
// Glances: [frame, x, y] with x, y in -1..1 (direction times distance).
const GAZE: [number, number, number][] = [
  [38, -1, 0.1],
  [50, 1, -0.2],
  [60, 0.5, 0.7],
  [72, -0.6, -0.5],
  [84, 0, 0],
];
const BLINKS = [45, 93];

/** Stroke draw-on for an element with pathLength=1. */
const draw = (t: number, a: number, b: number) => ({
  pathLength: 1,
  strokeDasharray: 1,
  strokeDashoffset: 1 - ease.inOutCubic(seg(t, a, b)),
});

/** Gaze at frame t, each glance easing over `span` frames. */
const look = (t: number, span: number) => {
  let x = 0;
  let y = 0;
  GAZE.forEach(([at, gx, gy]) => {
    const k = ease.inOutCubic(seg(t, at, at + span));
    x = lerp(x, gx, k);
    y = lerp(y, gy, k);
  });
  return { x, y };
};

/** One-shot bump 0 -> 1 -> 0 over [at, at + len], peaking at `peak` of the way. */
const bump = (t: number, at: number, len: number, peak: number) => {
  const p = seg(t, at, at + len);
  if (p <= 0 || p >= 1) return 0;
  return p < peak ? ease.outCubic(p / peak) : 1 - ease.inOutCubic((p - peak) / (1 - peak));
};

export const EchoGlassMark: React.FC<{ t: number; size: number }> = ({ t, size }) => {
  const id = useId().replace(/:/g, '');
  const fill = seg(t, 8, 18);
  const turn = 180 * (1 - ease.outBack(seg(t, FLIP[0], FLIP[1])));
  const core = ease.outBack(seg(t, FLIP[1] - 4, FLIP[1] + 2));
  const ghost = seg(t, FLIP[1] - 4, FLIP[1] + 24);
  const eye = look(t, 4);
  const lean = look(t, 12); // the echoes follow the eye a beat later
  const lid = 1 - 0.92 * Math.max(...BLINKS.map((b) => bump(t, b, 6, 0.45)));
  const triangles = (color: string, width: number, extra?: object) => (
    <>
      <polygon points={TOP} stroke={color} strokeWidth={width} strokeLinejoin="bevel" {...extra} />
      <polygon points={BOTTOM} stroke={color} strokeWidth={width} strokeLinejoin="bevel" {...extra} />
    </>
  );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      style={{
        overflow: 'visible',
        transform: `rotate(${turn}deg)`,
        filter: `drop-shadow(0 0 ${lerp(30, 14, fill)}px ${C.accentGlow})`,
      }}
    >
      <defs>
        {/* Cuts the lines away around the eye, whatever the background. */}
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="-32" y="-32" width="112" height="112">
          <rect x="-32" y="-32" width="112" height="112" fill="#fff" />
          <polygon points={LENS} fill="#000" stroke="#000" strokeWidth="3.2" strokeLinejoin="bevel" />
        </mask>
        <clipPath id={`${id}c`}>
          <polygon points={LENS} />
        </clipPath>
      </defs>
      <g mask={`url(#${id}m)`}>
        {/* Dark glass, so the mark reads over the galaxy behind it. */}
        <polygon points={TOP} fill={C.surface} fillOpacity={0.85 * fill} />
        <polygon points={BOTTOM} fill={C.surface} fillOpacity={0.85 * fill} />
        {ghost > 0 && ghost < 1 ? (
          <g
            opacity={0.85 * (1 - ease.outCubic(ghost))}
            transform={`translate(24 24) scale(${lerp(1, 1.65, ease.outCubic(ghost))}) translate(-24 -24)`}
          >
            {triangles(C.accent, 2)}
          </g>
        ) : null}
        {triangles(C.ink, 3.4, draw(t, DRAW[0], DRAW[1]))}
        {ECHOES.map((e, i) => {
          const born = ease.outCubic(seg(t, FLIP[1] - 2 + 7 * i, FLIP[1] + 22 + 7 * i));
          if (born <= 0) return null;
          const breath = lerp(0.94, 1.05, (1 - Math.cos((2 * Math.PI * (t - FLIP[1] + 15 * i)) / BREATH)) / 2);
          const ping = Math.max(...GAZE.map(([at]) => bump(t, at + 3 * e.lag, 19, 0.35)));
          const squeeze = Math.max(...BLINKS.map((b) => bump(t, b + e.lag, 11, 0.45)));
          const s = lerp(0.3, 1, born) * breath * (1 + 0.14 * ping) * (1 - 0.2 * squeeze) * e.k;
          const dx = lean.x * AX * e.drift;
          const dy = lean.y * AY * e.drift * 1.6;
          return (
            <g
              key={e.k}
              opacity={e.o * born}
              transform={`translate(${24 + dx} ${24 + dy}) scale(${s}) translate(-24 -24)`}
            >
              {triangles(C.ink, e.w / e.k)}
            </g>
          );
        })}
      </g>
      <g transform={`translate(24 24) scale(${core}, ${core * lid}) translate(-24 -24)`}>
        <polygon points={LENS} fill={C.ink} />
        <g clipPath={`url(#${id}c)`}>
          <g transform={`translate(${eye.x * AX} ${eye.y * AY})`}>
            <polygon points={IRIS} fill={C.accent} />
            <polygon points={PUPIL} fill={C.bg} />
            <rect x="25.4" y="20.4" width="1.6" height="1.6" fill={C.ink} />
          </g>
        </g>
      </g>
    </svg>
  );
};
