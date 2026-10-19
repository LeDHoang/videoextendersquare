import { interpolate, useCurrentFrame } from 'remotion';
import { C, F } from '../theme';

// Mono HUD label that types itself on: `[ 02 / SPATIAL ]`, `4K · 3840²`.
export const HudLabel = ({
  text, delay = 0, size = 22, color = C.ink2, accent = false, cps = 1.6,
}: { text: string; delay?: number; size?: number; color?: string; accent?: boolean; cps?: number }) => {
  const frame = useCurrentFrame();
  const n = Math.floor(interpolate(frame - delay, [0, text.length / cps], [0, text.length], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  }));
  const cursor = n < text.length && frame >= delay;
  return (
    <div
      style={{
        fontFamily: F.mono, fontSize: size, letterSpacing: '0.14em', textTransform: 'uppercase',
        color: accent ? C.accent : color, whiteSpace: 'pre', opacity: frame < delay ? 0 : 1,
      }}
    >
      {text.slice(0, n)}
      {cursor && <span style={{ color: C.accent }}>▌</span>}
    </div>
  );
};

// Bordered chip, used for mode labels (FLAT · SQ CURVE · DOME).
export const Chip = ({ text, active = false, size = 20 }: { text: string; active?: boolean; size?: number }) => (
  <div
    style={{
      fontFamily: F.mono, fontSize: size, fontWeight: 700, letterSpacing: '0.16em',
      padding: `${size * 0.45}px ${size * 0.9}px`,
      border: `2px solid ${active ? C.accent : C.ruleStrong}`,
      background: active ? C.accent : 'rgba(8,9,10,0.6)',
      color: active ? '#0a0a0a' : C.ink2,
      boxShadow: active ? `0 0 28px ${C.accentGlow}` : 'none',
    }}
  >
    {text}
  </div>
);
