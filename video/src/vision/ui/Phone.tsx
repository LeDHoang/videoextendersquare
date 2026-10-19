// Phone bezel, ambilight and feed chrome over the GL feed. The GL canvas
// draws the reels inside SCREEN; everything here zooms with it about the
// frame centre so the two stay locked together.
import type React from 'react';
import { AbsoluteFill } from 'remotion';
import { F } from '../../theme';
import { SCREEN, SCREEN_R, type PhoneState } from '../director';

const SW = SCREEN[2] * 2; // 344
const SH = SCREEN[3] * 2; // 744
const SX = SCREEN[0] - SCREEN[2];
const SY = SCREEN[1] - SCREEN[3];
const BEZEL = 14;
const RIM = 3;

type ReelUI = { handle: string; caption: string; likes: string; comments: string; saves: string; hue: string };

/** Made-up accounts for the five feed reels (same order as REELS). */
const FEED_UI: ReelUI[] = [
  { handle: '@saltwater.days', caption: 'golden hour, nowhere in particular', likes: '1.2M', comments: '4.8K', saves: '92K', hue: '#ff8a3d' },
  { handle: '@far.planets', caption: "found a planet. don't tell anyone", likes: '384K', comments: '2.1K', saves: '40K', hue: '#d65c2c' },
  { handle: '@deep.field', caption: "this is real (ok it isn't)", likes: '2.7M', comments: '11K', saves: '210K', hue: '#965cff' },
  { handle: '@above.everything', caption: 'flight mode', likes: '96K', comments: '880', saves: '12K', hue: '#9fc2ff' },
  { handle: '@northern.quiet', caption: 'the sky did this last night', likes: '5.1M', comments: '23K', saves: '402K', hue: '#40f0aa' },
];

const ICON = {
  heart: 'M12 20.5C12 20.5 2.5 14.8 2.5 8.6 2.5 5.8 4.7 3.6 7.4 3.6 9.3 3.6 11 4.7 12 6.3 13 4.7 14.7 3.6 16.6 3.6 19.3 3.6 21.5 5.8 21.5 8.6 21.5 14.8 12 20.5 12 20.5Z',
  comment: 'M12 3.5C6.8 3.5 2.5 7 2.5 11.3 2.5 13.6 3.7 15.6 5.6 17L4.9 20.8 9 18.8C9.9 19 10.9 19.1 12 19.1 17.2 19.1 21.5 15.6 21.5 11.3 21.5 7 17.2 3.5 12 3.5Z',
  bookmark: 'M6 3H18V21L12 16.8 6 21Z',
  share: 'M13.5 4.5 21.5 12 13.5 19.5V15.3C8.3 15.3 5 16.9 2.5 20.5 3.3 14.6 6.7 10.1 13.5 9.2Z',
};

/** Rounded-rect path (x, y, w, h, r) for even-odd rings. */
const rr = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}` +
  `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;

const SCREEN_PATH = rr(SX, SY, SW, SH, SCREEN_R);
const BEZEL_PATH = rr(SX - BEZEL, SY - BEZEL, SW + 2 * BEZEL, SH + 2 * BEZEL, SCREEN_R + BEZEL);
const RIM_PATH = rr(SX - BEZEL - RIM, SY - BEZEL - RIM, SW + 2 * (BEZEL + RIM), SH + 2 * (BEZEL + RIM), SCREEN_R + BEZEL + RIM);

const label: React.CSSProperties = {
  fontFamily: F.sans,
  fontWeight: 600,
  fontSize: 12.5,
  color: '#fff',
  textShadow: '0 1px 3px rgba(0,0,0,0.55)',
};

const RailIcon: React.FC<{ d: string; text: string }> = ({ d, text }) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
    <svg width={34} height={34} viewBox="0 0 24 24" style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.45))' }}>
      <path d={d} fill="#fff" />
    </svg>
    <span style={label}>{text}</span>
  </div>
);

const Cell: React.FC<{ ui: ReelUI; y: number; frame: number; k: number }> = ({ ui, y, frame, k }) => {
  const progress = ((frame / 30 + k * 1.7) % 9) / 9;
  return (
    <div style={{ position: 'absolute', left: 0, top: y, width: SW, height: SH }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 320,
          background: 'linear-gradient(to top, rgba(0,0,0,0.58), rgba(0,0,0,0))',
        }}
      />
      <div
        style={{
          position: 'absolute',
          right: 9,
          bottom: 104,
          width: 54,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 17,
        }}
      >
        <div style={{ position: 'relative', width: 46, height: 54 }}>
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: 23,
              border: '2px solid #fff',
              boxSizing: 'border-box',
              background: `radial-gradient(circle at 35% 30%, ${ui.hue}, #15171a 78%)`,
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: 14,
              top: 36,
              width: 18,
              height: 18,
              borderRadius: 9,
              background: '#ff3b1f',
              color: '#fff',
              fontFamily: F.sans,
              fontWeight: 600,
              fontSize: 15,
              lineHeight: '17px',
              textAlign: 'center',
            }}
          >
            +
          </div>
        </div>
        <RailIcon d={ICON.heart} text={ui.likes} />
        <RailIcon d={ICON.comment} text={ui.comments} />
        <RailIcon d={ICON.bookmark} text={ui.saves} />
        <RailIcon d={ICON.share} text="Share" />
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            background: `radial-gradient(circle, ${ui.hue} 0 7px, #0b0b0c 8px 12px, #26292d 13px, #0d0e10 20px)`,
            transform: `rotate(${frame * 4}deg)`,
            boxShadow: '0 1px 4px rgba(0,0,0,0.5)',
          }}
        />
      </div>
      <div style={{ position: 'absolute', left: 16, right: 80, bottom: 46, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.55)' }}>
        <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 17 }}>{ui.handle}</div>
        <div style={{ fontFamily: F.sans, fontWeight: 400, fontSize: 15, marginTop: 6, lineHeight: 1.3 }}>{ui.caption}</div>
        <div style={{ fontFamily: F.sans, fontWeight: 400, fontSize: 13, marginTop: 9, opacity: 0.85 }}>
          ♫ original sound · {ui.handle.slice(1)}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 14, right: 14, bottom: 28, height: 2.5, borderRadius: 2, background: 'rgba(255,255,255,0.22)' }}>
        <div style={{ width: `${progress * 100}%`, height: '100%', borderRadius: 2, background: '#fff' }} />
      </div>
    </div>
  );
};

const StatusBar: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      top: 14,
      width: SW,
      height: 22,
      color: '#fff',
      fontFamily: F.sans,
      fontWeight: 600,
      fontSize: 15,
    }}
  >
    <span style={{ position: 'absolute', left: 36, top: 1 }}>9:41</span>
    <svg style={{ position: 'absolute', right: 26, top: 4 }} width={70} height={14} viewBox="0 0 70 14">
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={i * 5} y={10 - i * 3} width={3.4} height={4 + i * 3} rx={1} fill="#fff" />
      ))}
      <path d="M27 5.2a10 10 0 0 1 14 0l-1.6 1.7a7.6 7.6 0 0 0-10.8 0zM30.2 8.6a5.4 5.4 0 0 1 7.6 0L34 12.6z" fill="#fff" />
      <rect x={45.5} y={1.5} width={21} height={11} rx={3.2} fill="none" stroke="rgba(255,255,255,0.55)" />
      <rect x={47.5} y={3.5} width={15} height={7} rx={1.6} fill="#fff" />
      <rect x={67.6} y={5} width={1.6} height={4} rx={0.8} fill="rgba(255,255,255,0.55)" />
    </svg>
  </div>
);

const Tabs: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      top: 56,
      width: SW,
      display: 'flex',
      justifyContent: 'center',
      gap: 20,
      fontFamily: F.sans,
      fontSize: 16,
      textShadow: '0 1px 3px rgba(0,0,0,0.5)',
    }}
  >
    <span style={{ fontWeight: 600, color: 'rgba(255,255,255,0.62)' }}>Following</span>
    <span style={{ position: 'relative', fontWeight: 600, color: '#fff' }}>
      For You
      <span style={{ position: 'absolute', left: '50%', top: 25, width: 24, height: 2.5, marginLeft: -12, borderRadius: 2, background: '#fff' }} />
    </span>
    <svg style={{ position: 'absolute', right: 18, top: 0 }} width={20} height={20} viewBox="0 0 24 24">
      <circle cx={10.5} cy={10.5} r={6.5} fill="none" stroke="#fff" strokeWidth={2.4} />
      <path d="M15.5 15.5 21 21" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" />
    </svg>
  </div>
);

export const Phone: React.FC<{ state: PhoneState; frame: number }> = ({ state, frame }) => {
  const { s, bodyOpacity, bodyScale, ui, p, glow, glowAmt } = state;
  const [r, g, b] = glow.map(Math.round);
  const visible = FEED_UI.map((cell, k) => ({ cell, k })).filter(({ k }) => Math.abs(k - p) < 1);
  return (
    <AbsoluteFill style={{ transform: `scale(${s})`, transformOrigin: '960px 540px' }}>
      {glowAmt > 0.001 ? (
        <div
          style={{
            position: 'absolute',
            left: SX - BEZEL,
            top: SY - BEZEL,
            width: SW + 2 * BEZEL,
            height: SH + 2 * BEZEL,
            borderRadius: SCREEN_R + BEZEL,
            boxShadow: `0 0 70px 8px rgba(${r},${g},${b},${0.5 * glowAmt}), 0 0 240px 70px rgba(${r},${g},${b},${0.22 * glowAmt})`,
          }}
        />
      ) : null}
      {bodyOpacity > 0.001 ? (
        <svg
          width={1920}
          height={1080}
          style={{
            position: 'absolute',
            inset: 0,
            overflow: 'visible',
            opacity: bodyOpacity,
            transform: `scale(${bodyScale})`,
            transformOrigin: '960px 540px',
          }}
        >
          <defs>
            <linearGradient id="phoneRim" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#80868e" />
              <stop offset="0.28" stopColor="#25282c" />
              <stop offset="0.55" stopColor="#555b62" />
              <stop offset="1" stopColor="#141518" />
            </linearGradient>
          </defs>
          {[
            [SX - BEZEL - RIM - 3, 300, 3, 34],
            [SX - BEZEL - RIM - 3, 360, 3, 62],
            [SX - BEZEL - RIM - 3, 436, 3, 62],
            [SX + SW + BEZEL + RIM, 380, 3, 96],
          ].map(([x, y, w, h], i) => (
            <rect key={i} x={x} y={y} width={w} height={h} rx={1.5} fill="#2b2f34" />
          ))}
          <path d={RIM_PATH + SCREEN_PATH} fillRule="evenodd" fill="url(#phoneRim)" />
          <path d={BEZEL_PATH + SCREEN_PATH} fillRule="evenodd" fill="#050506" />
          <rect x={960 - 52} y={SY + 13} width={104} height={30} rx={15} fill="#000" />
        </svg>
      ) : null}
      {ui > 0.001 ? (
        <div
          style={{
            position: 'absolute',
            left: SX,
            top: SY,
            width: SW,
            height: SH,
            borderRadius: SCREEN_R,
            overflow: 'hidden',
            opacity: ui,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: SW,
              height: 160,
              background: 'linear-gradient(to bottom, rgba(0,0,0,0.42), rgba(0,0,0,0))',
            }}
          />
          {visible.map(({ cell, k }) => (
            <Cell key={k} ui={cell} k={k} y={(k - p) * SH} frame={frame} />
          ))}
          <StatusBar />
          <Tabs />
          <div
            style={{
              position: 'absolute',
              left: (SW - 124) / 2,
              bottom: 8,
              width: 124,
              height: 5,
              borderRadius: 3,
              background: 'rgba(255,255,255,0.85)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'linear-gradient(125deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0) 36%)',
            }}
          />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
