import { C } from '../theme';

// The recurring orange scan line: "extends" frames and wipes between beats.
export const ScanLine = ({
  x, y, length = '100%', vertical = true, thickness = 4, opacity = 1,
}: { x?: number | string; y?: number | string; length?: number | string; vertical?: boolean; thickness?: number; opacity?: number }) => (
  <div
    style={{
      position: 'absolute',
      left: vertical ? x : 0,
      top: vertical ? 0 : y,
      width: vertical ? thickness : length,
      height: vertical ? length : thickness,
      transform: vertical ? 'translateX(-50%)' : 'translateY(-50%)',
      background: C.accent,
      boxShadow: `0 0 18px ${C.accent}, 0 0 60px ${C.accentGlow}, 0 0 140px ${C.accentGlow}`,
      opacity,
    }}
  />
);
