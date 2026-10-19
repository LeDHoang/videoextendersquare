// The inside of a headset, seen as you lift it to your face. Lens holes are
// cut out of the shell so the GL lens layers show the world through them.
import type React from 'react';
import { AbsoluteFill } from 'remotion';
import { ease, seg } from '../anim';
import { LENS, type GogglesState } from '../director';

// Headset units: lenses sit at LENS, the shell is symmetric about MID.
const MID = LENS.cx + LENS.dx / 2; // 960
const RX = LENS.cx + LENS.dx; // right lens centre x
const SHELL = { l: 160, r: 1760, t: 160, b: 900 };
const HOUSING = 268;
const FRESNEL = [48, 84, 114, 140, 163, 184, 203, 220, 235, 246];

/** Visor outline inset by d, with the nose bridge cut up from the bottom edge. */
const visor = (d: number) => {
  const L = SHELL.l + d;
  const R = SHELL.r - d;
  const Tp = SHELL.t + d;
  const B = SHELL.b - d;
  const r = 200 - 0.6 * d;
  const w = 175 + d;
  const ny = 712 - 0.8 * d;
  const tw = 62 + 0.4 * d;
  return [
    `M${L + r} ${Tp}H${R - r}Q${R} ${Tp} ${R} ${Tp + r}V${B - r}Q${R} ${B} ${R - r} ${B}`,
    `H${MID + w}C${MID + w * 0.45} ${B} ${MID + tw} ${ny} ${MID} ${ny}`,
    `C${MID - tw} ${ny} ${MID - w * 0.45} ${B} ${MID - w} ${B}`,
    `H${L + r}Q${L} ${B} ${L} ${B - r}V${Tp + r}Q${L} ${Tp} ${L + r} ${Tp}Z`,
  ].join('');
};

const STRAP_L = `M${SHELL.l + 30} 420L-700 300L-700 840L${SHELL.l + 30} 650Z`;
const STRAP_R = `M${SHELL.r - 30} 420L2620 300L2620 840L${SHELL.r - 30} 650Z`;

/** Arc on a lens from angle a0 to a1 (degrees, SVG y down). */
const arc = (cx: number, r: number, a0: number, a1: number) => {
  const p = (a: number) => [cx + r * Math.cos((a * Math.PI) / 180), LENS.cy + r * Math.sin((a * Math.PI) / 180)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0} ${y0}A${r} ${r} 0 0 1 ${x1} ${y1}`;
};

const Housing: React.FC<{ cx: number }> = ({ cx }) => (
  <circle cx={cx} cy={LENS.cy} r={HOUSING} fill="url(#gHousing)" stroke="#2a2f35" strokeWidth={2} />
);

/** Light from the lens spilling onto the cavity around it. */
const Spill: React.FC<{ cx: number }> = ({ cx }) => <circle cx={cx} cy={LENS.cy} r={HOUSING + 150} fill="url(#gSpill)" />;

const Bezel: React.FC<{ cx: number }> = ({ cx }) => (
  <circle cx={cx} cy={LENS.cy} r={LENS.r + 3} fill="none" stroke="#4a5057" strokeWidth={4} />
);

const LensGlass: React.FC<{ cx: number }> = ({ cx }) => (
  <>
    {FRESNEL.map((r, i) => (
      <circle key={r} cx={cx} cy={LENS.cy} r={r} fill="none" stroke="#fff" strokeOpacity={0.035 + i * 0.006} strokeWidth={1.3} />
    ))}
    <path d={arc(cx, 212, 200, 248)} fill="none" stroke="#fff" strokeOpacity={0.2} strokeWidth={12} strokeLinecap="round" />
    <path d={arc(cx, 226, 262, 272)} fill="none" stroke="#fff" strokeOpacity={0.28} strokeWidth={6} strokeLinecap="round" />
  </>
);

export const Goggles: React.FC<{ state: GogglesState }> = ({ state }) => {
  const { P, s, blur, opacity } = state;
  // The lens glass details fade as the lens fills the frame.
  const glass = 1 - ease.inOutSine(seg(s, 2.2, 4.6));
  return (
    <AbsoluteFill style={{ opacity, filter: blur > 0.05 ? `blur(${blur}px)` : undefined }}>
      <svg width={1920} height={1080} viewBox="0 0 1920 1080" style={{ overflow: 'visible' }}>
        <defs>
          <mask id="lensHoles" maskUnits="userSpaceOnUse" x={-4000} y={-4000} width={10000} height={10000}>
            <rect x={-4000} y={-4000} width={10000} height={10000} fill="#fff" />
            <circle cx={LENS.cx} cy={LENS.cy} r={LENS.r} fill="#000" />
            <circle cx={RX} cy={LENS.cy} r={LENS.r} fill="#000" />
          </mask>
          <linearGradient id="gShell" x1="0" y1={SHELL.t} x2="0" y2={SHELL.b} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#262a2f" />
            <stop offset="0.55" stopColor="#111214" />
            <stop offset="1" stopColor="#0a0b0c" />
          </linearGradient>
          <linearGradient id="gRim" x1="0" y1={SHELL.t} x2="0" y2={SHELL.t + 220} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#c8f7e2" stopOpacity={0.55} />
            <stop offset="1" stopColor="#c8f7e2" stopOpacity={0} />
          </linearGradient>
          <radialGradient id="gFoam" cx={MID} cy={520} r={900} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#1d2024" />
            <stop offset="1" stopColor="#0e0f11" />
          </radialGradient>
          <radialGradient id="gHousing" r="0.5">
            <stop offset="0.85" stopColor="#0a0b0c" />
            <stop offset="1" stopColor="#1f2327" />
          </radialGradient>
          <radialGradient id="gSpill" r="0.5">
            <stop offset="0.6" stopColor="#46f0b2" stopOpacity={0.16} />
            <stop offset="1" stopColor="#46f0b2" stopOpacity={0} />
          </radialGradient>
          <linearGradient id="gStrap" x1="1" y1="0" x2="0" y2="0">
            <stop offset="0" stopColor="#15171a" />
            <stop offset="1" stopColor="#060607" />
          </linearGradient>
          <linearGradient id="gStrapR" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#15171a" />
            <stop offset="1" stopColor="#060607" />
          </linearGradient>
          <clipPath id="cavity">
            <path d={visor(66)} />
          </clipPath>
        </defs>
        <g transform={`translate(${P[0]} ${P[1]}) scale(${s}) translate(${-LENS.cx} ${-LENS.cy})`}>
          <g mask="url(#lensHoles)">
            <path d={STRAP_L} fill="url(#gStrap)" stroke="#24282d" strokeWidth={2} />
            <path d={STRAP_R} fill="url(#gStrapR)" stroke="#24282d" strokeWidth={2} />
            <path d={visor(0)} fill="url(#gShell)" stroke="#3a4047" strokeWidth={2} />
            <path d={visor(0)} fill="none" stroke="url(#gRim)" strokeWidth={4} />
            <path d={visor(26)} fill="url(#gFoam)" />
            <path d={visor(66)} fill="#070809" />
            <Housing cx={LENS.cx} />
            <Housing cx={RX} />
            <g clipPath="url(#cavity)">
              <Spill cx={LENS.cx} />
              <Spill cx={RX} />
            </g>
            <Bezel cx={LENS.cx} />
            <Bezel cx={RX} />
          </g>
          <g opacity={glass}>
            <LensGlass cx={LENS.cx} />
            <LensGlass cx={RX} />
          </g>
        </g>
      </svg>
    </AbsoluteFill>
  );
};
