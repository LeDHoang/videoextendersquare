import { AbsoluteFill, random, useCurrentFrame } from 'remotion';
import { C } from '../theme';

// Matte-black stage with a faint engineering grid, vignette and film grain.
export const Backdrop = ({ grid = true, tint }: { grid?: boolean; tint?: string }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: tint ?? C.bg }}>
      {grid && (
        <AbsoluteFill
          style={{
            backgroundImage: `linear-gradient(${C.rule} 1px, transparent 1px), linear-gradient(90deg, ${C.rule} 1px, transparent 1px)`,
            backgroundSize: '120px 120px',
            backgroundPosition: '-1px -1px',
            opacity: 0.35,
            maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
          }}
        />
      )}
      <Grain seed={frame} />
    </AbsoluteFill>
  );
};

export const Vignette = ({ strength = 0.75 }: { strength?: number }) => (
  <AbsoluteFill style={{ background: `radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${strength}) 100%)`, pointerEvents: 'none' }} />
);

// Deterministic grain: offset a static noise tile by a seeded amount each frame.
const NOISE = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.55'/></svg>")`;

export const Grain = ({ seed }: { seed: number }) => (
  <AbsoluteFill
    style={{
      backgroundImage: NOISE,
      backgroundPosition: `${Math.floor(random(`gx${seed}`) * 240)}px ${Math.floor(random(`gy${seed}`) * 240)}px`,
      opacity: 0.07, mixBlendMode: 'overlay', pointerEvents: 'none',
    }}
  />
);
