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

/** web/public/logo.svg, with each stroke drawn on in turn. */
const Mark: React.FC<{ f: number; size: number }> = ({ f, size }) => {
  const fill = seg(f, AT + 8, AT + 18);
  const core = ease.outBack(seg(f, AT + 10, AT + 16));
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ overflow: 'visible', filter: `drop-shadow(0 0 ${lerp(30, 14, fill)}px ${C.accentGlow})` }}
    >
      <path
        d="M7 2.5 H17 L21 7 L14.5 11.4 L16.8 12 L14.5 12.6 L21 17 L17 21.5 H7 L3 17 L9.5 12.6 L7.2 12 L9.5 11.4 L3 7 Z"
        fill="#101214"
        fillOpacity={fill}
        stroke="#fff"
        strokeWidth={1.5}
        strokeLinejoin="bevel"
        {...draw(f, AT, AT + 12)}
      />
      <polygon points="8,4.5 16,4.5 12,10.4" fill="none" stroke={C.ink} strokeWidth={1.4} strokeLinejoin="bevel" {...draw(f, AT + 3, AT + 13)} />
      <polygon points="8,19.5 16,19.5 12,13.6" fill="none" stroke={C.ink} strokeWidth={1.4} strokeLinejoin="bevel" {...draw(f, AT + 3, AT + 13)} />
      <line x1={12} y1={2.5} x2={12} y2={21.5} stroke={C.accent} strokeWidth={1.6} strokeLinecap="square" {...draw(f, AT + 6, AT + 12)} />
      <path d="M8.5 12 L11 10.4 M8.5 12 L11 13.6" fill="none" stroke={C.accent} strokeWidth={1.4} strokeLinejoin="bevel" {...draw(f, AT + 8, AT + 14)} />
      <path d="M15.5 12 L13 10.4 M15.5 12 L13 13.6" fill="none" stroke={C.accent} strokeWidth={1.4} strokeLinejoin="bevel" {...draw(f, AT + 8, AT + 14)} />
      <line x1={4.5} y1={12} x2={7} y2={12} stroke={C.accent} strokeWidth={1.3} {...draw(f, AT + 9, AT + 14)} />
      <line x1={17} y1={12} x2={19.5} y2={12} stroke={C.accent} strokeWidth={1.3} {...draw(f, AT + 9, AT + 14)} />
      <g transform={`translate(12 12) scale(${core}) translate(-12 -12)`}>
        <polygon points="12,10.5 13.5,12 12,13.5 10.5,12" fill={C.accent} />
        <circle cx={12} cy={12} r={0.6} fill={C.ink} />
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
          gap: 40,
        }}
      >
        <Mark f={f} size={136} />
        <div
          style={{
            fontFamily: F.brand,
            fontWeight: 900,
            fontSize: 136,
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
