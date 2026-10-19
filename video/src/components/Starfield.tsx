import { AbsoluteFill, random, useCurrentFrame } from 'remotion';
import { C } from '../theme';

// Seeded, frame-driven twinkling starfield over the app's midnight-blue cosmos.
export const Starfield = ({ count = 260, drift = 0.15, seed = 'stars' }: { count?: number; drift?: number; seed?: string }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 40%, ${C.navy2} 0%, ${C.navy} 55%, #02040a 100%)` }}>
      <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0 }}>
        {Array.from({ length: count }, (_, i) => {
          const x = random(`${seed}x${i}`) * 1920;
          const y = random(`${seed}y${i}`) * 1080;
          const z = random(`${seed}z${i}`);
          const r = 0.5 + z * 1.6;
          const tw = 0.55 + 0.45 * Math.sin(frame * (0.05 + z * 0.12) + i);
          const px = (x - frame * drift * (0.3 + z) + 1920) % 1920;
          return <circle key={i} cx={px} cy={y} r={r} fill={z > 0.93 ? '#ffd9cf' : '#dfe8ff'} opacity={tw * (0.35 + z * 0.65)} />;
        })}
      </svg>
    </AbsoluteFill>
  );
};
