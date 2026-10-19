// Kinetic copy for the vision cut. Every line is pinned to the beat grid in
// timing.ts; the story must read with the sound off.
import { Fragment } from 'react';
import type React from 'react';
import { C, F } from '../../theme';
import { ease, lerp, pulse, seg } from '../anim';
import { HOPS } from '../director';
import { beat, T } from '../timing';

const SHADOW = '0 0 44px rgba(0,0,0,0.5), 0 2px 10px rgba(0,0,0,0.4)';

export const SERIF: React.CSSProperties = { fontFamily: F.serif, fontStyle: 'italic', fontWeight: 400, letterSpacing: '-0.01em' };
const SANS: React.CSSProperties = { fontFamily: F.sans, fontWeight: 600, letterSpacing: '-0.015em' };
const DISPLAY: React.CSSProperties = { fontFamily: F.display, fontWeight: 400, letterSpacing: '-0.02em' };
export const MONO: React.CSSProperties = { fontFamily: F.mono, fontWeight: 700, letterSpacing: '0.26em' };

export type Word = { text: string; at: number; style?: React.CSSProperties };

/** Splits a line into words that start `stagger` frames apart. */
export const words = (text: string, at: number, stagger: number, style?: (w: string, i: number) => React.CSSProperties | undefined): Word[] =>
  text.split(' ').map((t, i) => ({ text: t, at: at + i * stagger, style: style?.(t, i) }));

type LineProps = {
  f: number;
  words: Word[];
  /** Frames over which the whole line leaves. */
  exit: [number, number];
  /** Vertical centre of the line. */
  y: number;
  /** Left edge; the line is centred when omitted. */
  x?: number;
  font: React.CSSProperties;
  rise?: number;
  blur?: number;
  dur?: number;
  easing?: (x: number) => number;
  /** Strength of a soft dark pool behind the words, for bright backgrounds. */
  scrim?: number;
};

/** Words rise and sharpen in one by one, then the line drifts up and blurs out. */
export const Line: React.FC<LineProps> = ({ f, words: ws, exit, y, x, font, rise = 34, blur = 14, dur = 14, easing = ease.outCubic, scrim = 0 }) => {
  if (f < ws[0].at || f >= exit[1]) return null;
  const e = ease.inCubic(seg(f, exit[0], exit[1]));
  const place: React.CSSProperties = x === undefined ? { left: 0, width: 1920, textAlign: 'center' } : { left: x };
  return (
    <div
      style={{
        position: 'absolute',
        top: y,
        ...place,
        transform: `translateY(-50%) translateY(${-18 * e}px)`,
        opacity: 1 - e,
        filter: e > 0.001 ? `blur(${10 * e}px)` : undefined,
        whiteSpace: 'pre',
        lineHeight: 1.05,
        color: C.ink,
        textShadow: SHADOW,
        ...font,
      }}
    >
      <span style={{ position: 'relative', display: 'inline-block' }}>
        {scrim > 0 ? (
          <span
            style={{
              position: 'absolute',
              left: '-14%',
              right: '-14%',
              top: '-55%',
              bottom: '-55%',
              zIndex: -1,
              opacity: seg(f, ws[0].at, ws[0].at + dur),
              background: `radial-gradient(closest-side, rgba(0,0,0,${scrim}), rgba(0,0,0,${scrim * 0.45}) 55%, rgba(0,0,0,0))`,
            }}
          />
        ) : null}
        {ws.map((w, i) => {
          const t = easing(seg(f, w.at, w.at + dur));
          return (
            <Fragment key={i}>
              {i > 0 ? ' ' : null}
              <span
                style={{
                  display: 'inline-block',
                  opacity: Math.min(1, t * 1.6),
                  transform: `translateY(${(1 - t) * rise}px)`,
                  filter: t < 0.999 ? `blur(${(1 - t) * blur}px)` : undefined,
                  ...w.style,
                }}
              >
                {w.text}
              </span>
            </Fragment>
          );
        })}
      </span>
    </div>
  );
};

// ---------------------------------------------------------------- "flat."
const FLAT_IN = 124;
const FLAT_SQUASH = beat(7); // 143
const FLAT_OUT: [number, number] = [151, 157];

/** "flat." slams in, then gets pressed flat on the next beat. */
const Flat: React.FC<{ f: number }> = ({ f }) => {
  if (f < FLAT_IN || f >= FLAT_OUT[1]) return null;
  const inT = ease.outCubic(seg(f, FLAT_IN, FLAT_IN + 5));
  const sq = ease.outBack(seg(f, FLAT_SQUASH, FLAT_SQUASH + 5));
  const e = seg(f, FLAT_OUT[0], FLAT_OUT[1]);
  const pop = lerp(1.45, 1, inT);
  return (
    <div
      style={{
        position: 'absolute',
        left: 132,
        top: 476,
        ...DISPLAY,
        fontSize: 210,
        lineHeight: 1,
        color: C.accent,
        textShadow: `0 0 60px ${C.accentGlow}`,
        transformOrigin: '0% 82%',
        transform: `scale(${pop * lerp(1, 1.42, sq)}, ${pop * lerp(1, 0.14, sq)})`,
        filter: inT < 0.999 ? `blur(${(1 - inT) * 14}px)` : undefined,
        opacity: Math.min(1, seg(f, FLAT_IN, FLAT_IN + 2)) * (1 - e),
      }}
    >
      flat.
    </div>
  );
};

// ---------------------------------------------------------------- "Wait."
const Wait: React.FC<{ f: number }> = ({ f }) => {
  const at = T.stop;
  if (f < at || f >= T.extend + 7) return null;
  const k = pulse(f, at, 4);
  const inT = ease.outCubic(seg(f, at, at + 4));
  const e = ease.inCubic(seg(f, T.extend, T.extend + 7));
  return (
    <div
      style={{
        position: 'absolute',
        left: 136,
        top: 540,
        ...DISPLAY,
        fontSize: 180,
        lineHeight: 1,
        color: C.ink,
        textShadow: SHADOW,
        transform: `translate(${14 * k * Math.sin(f * 2.9)}px, ${8 * k * Math.cos(f * 3.7)}px) translateY(-50%) scale(${lerp(1.12, 1, inT)})`,
        transformOrigin: '0% 50%',
        opacity: 1 - e,
        filter: e > 0.001 ? `blur(${12 * e}px)` : undefined,
      }}
    >
      Wait.
    </div>
  );
};

// ---------------------------------------------------------------- world HUD
const HUD = [
  { at: beat(18) + 3, label: 'WORLD 01 / AURORA' },
  { at: 550, label: 'WORLD 02 / OCEAN' },
  { at: HOPS[0].fc, label: 'WORLD 03 / DUNES' },
  { at: HOPS[1].fc, label: 'WORLD 04 / CLOUDS' },
  { at: HOPS[2].fc, label: 'WORLD 05 / NEBULA' },
];

/** Mono readout of the world you are standing in; glitches on each crossing. */
const WorldHud: React.FC<{ f: number }> = ({ f }) => {
  if (f < HUD[0].at || f >= T.drop) return null;
  let i = 0;
  while (i + 1 < HUD.length && f >= HUD[i + 1].at) i++;
  const since = f - HUD[i].at;
  const glitch = i > 0 && since < 3;
  const fadeIn = i === 0 ? seg(f, HUD[0].at, HUD[0].at + 8) : 1;
  return (
    <div
      style={{
        position: 'absolute',
        left: 64,
        bottom: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        ...MONO,
        fontSize: 20,
        color: glitch ? C.accent : C.ink,
        opacity: fadeIn,
        transform: glitch ? `translateX(${since % 2 === 0 ? 7 : -5}px)` : undefined,
        textShadow: SHADOW,
      }}
    >
      <span style={{ width: 10, height: 10, background: C.accent, display: 'inline-block', boxShadow: `0 0 10px ${C.accentGlow}` }} />
      {HUD[i].label}
    </div>
  );
};

// ---------------------------------------------------------------- clap slams
type Part = { text: string; style?: React.CSSProperties };

/** A line that slams in on a clap. `stereo` splits a word into red/cyan eyes
 *  that converge; `through` makes the line fly past the camera on exit. */
const Slam: React.FC<{
  f: number;
  at: number;
  exit: [number, number];
  parts: Part[];
  size: number;
  kicker?: string;
  stereo?: number;
  through?: boolean;
}> = ({ f, at, exit, parts, size, kicker, stereo, through }) => {
  if (f < at || f >= exit[1]) return null;
  const inT = ease.outCubic(seg(f, at, at + 4));
  const e = seg(f, exit[0], exit[1]);
  const drift = 1 + 0.035 * seg(f, at, exit[1]);
  const fly = through ? lerp(1, 4, ease.inCubic(e)) : 1;
  const d = 3 + 18 * (1 - ease.outCubic(seg(f, at, at + 16)));
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 540,
        width: 1920,
        textAlign: 'center',
        transform: `translateY(-50%) scale(${lerp(1.25, 1, inT) * drift * fly})`,
        filter: inT < 0.999 || e > 0 ? `blur(${(1 - inT) * 12 + e * (through ? 18 : 10)}px)` : undefined,
        opacity: Math.min(1, seg(f, at, at + 2)) * (1 - (through ? ease.inCubic(e) : e)),
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 260,
          right: 260,
          top: -140,
          bottom: -140,
          background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.5), rgba(0,0,0,0) 70%)',
        }}
      />
      {kicker ? (
        <div
          style={{
            position: 'relative',
            ...MONO,
            fontSize: 28,
            letterSpacing: '0.34em',
            marginRight: '-0.34em',
            color: C.accentHi,
            marginBottom: 24,
            textShadow: `0 0 18px ${C.accentGlow}, 0 0 4px rgba(0,0,0,0.8)`,
          }}
        >
          {kicker}
        </div>
      ) : null}
      <div style={{ position: 'relative', ...DISPLAY, fontSize: size, lineHeight: 1, color: C.ink, textShadow: SHADOW, whiteSpace: 'pre' }}>
        {parts.map((p, i) => (
          <span
            key={i}
            style={{
              ...(stereo === i ? { textShadow: `${-d}px 0 0 rgba(255,59,31,0.9), ${d}px 0 0 rgba(46,230,255,0.9), ${SHADOW}` } : null),
              ...p.style,
            }}
          >
            {p.text}
          </span>
        ))}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- timeline
export const Copy: React.FC<{ frame: number }> = ({ frame: f }) => (
  <>
    <Line f={f} words={words('Every reel holds a world.', 11, 4)} exit={[80, 90]} y={830} scrim={0.32} font={{ ...SERIF, fontSize: 112 }} />

    <Line f={f} words={words("On a phone, it's", 105, 3)} exit={[151, 157]} x={140} y={430} font={{ ...SANS, fontSize: 64 }} />
    <Flat f={f} />

    <Line
      f={f}
      words={[
        { text: 'So', at: T.swipe },
        { text: 'we', at: T.swipe + 3 },
        { text: 'scroll', at: beat(9) },
      ]}
      exit={[230, 237]}
      x={140}
      y={466}
      rise={46}
      easing={ease.outQuint}
      font={{ ...SANS, fontSize: 62 }}
    />
    <Line
      f={f}
      words={[
        { text: 'right', at: beat(10) },
        { text: 'past.', at: beat(11), style: { color: C.accent } },
      ]}
      exit={[230, 237]}
      x={140}
      y={542}
      rise={46}
      easing={ease.outQuint}
      font={{ ...SANS, fontSize: 62 }}
    />
    <Wait f={f} />

    <Line
      f={f}
      words={words('ECHO extends any reel', 258, 3, (w) =>
        w === 'ECHO' ? { fontFamily: F.brand, fontWeight: 900, color: C.accent, letterSpacing: '0.06em' } : undefined,
      )}
      exit={[304, 312]}
      y={800}
      font={{ ...SANS, fontSize: 60 }}
    />
    <Line f={f} words={words('into a world.', 278, 4)} exit={[304, 312]} y={905} font={{ ...SERIF, fontSize: 116 }} />

    <Line f={f} words={words('Put these on.', 314, 3)} exit={[331, 338]} y={82} font={{ ...SANS, fontSize: 60 }} />

    <Line f={f} words={words('A world to lose yourself in.', 408, 4)} exit={[449, 458]} y={540} font={{ ...SERIF, fontSize: 116 }} />
    <Line f={f} words={words('Every reel becomes a door.', 482, 4)} exit={[526, 535]} y={905} scrim={0.3} font={{ ...SERIF, fontSize: 100 }} />

    <Line f={f} words={words('Next reel?', 558, 4)} exit={[603, 611]} y={470} scrim={0.36} font={{ ...SANS, fontSize: 64 }} />
    <Line f={f} words={words('Next world.', 576, 4)} exit={[603, 611]} y={575} scrim={0.36} font={{ ...SERIF, fontSize: 124 }} />
    <WorldHud f={f} />

    <Slam f={f} at={T.hit1} exit={[T.hit2 - 5, T.hit2]} kicker="[ THEN ]" parts={[{ text: 'VIDEO WENT VERTICAL.' }]} size={104} />
    <Slam
      f={f}
      at={T.hit2}
      exit={[T.hit3 - 5, T.hit3]}
      kicker="[ NEXT ]"
      parts={[{ text: 'NEXT, IT GOES ' }, { text: 'SPATIAL.' }]}
      stereo={1}
      size={104}
    />
    <Slam f={f} at={T.hit3} exit={[T.end - 6, T.end + 2]} parts={[{ text: 'STEP INSIDE.' }]} size={160} through />
  </>
);
