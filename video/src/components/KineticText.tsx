import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, F } from '../theme';

type Props = {
  text: string;
  /** Words (exact, punctuation included) drawn in the accent colour. */
  accent?: string[];
  delay?: number;
  size?: number;
  stagger?: number;
  /** Frame (scene-relative) at which the line wipes out; omit to hold. */
  exitAt?: number;
  align?: 'left' | 'center';
  font?: string;
  color?: string;
};

// Headline that snaps in word by word (rise + unblur), brutalist and tight.
export const KineticText = ({
  text, accent = [], delay = 0, size = 112, stagger = 3, exitAt,
  align = 'left', font = F.display, color = C.ink,
}: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(' ');
  const exit = exitAt === undefined ? 0 : interpolate(frame, [exitAt, exitAt + 8], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        fontFamily: font, fontSize: size, lineHeight: 0.98, letterSpacing: '-0.035em',
        color, display: 'flex', flexWrap: 'wrap', gap: `0 ${size * 0.24}px`,
        justifyContent: align === 'center' ? 'center' : 'flex-start',
        textAlign: align,
        opacity: 1 - exit,
        transform: `translateY(${-exit * 30}px)`,
      }}
    >
      {words.map((w, i) => {
        const s = spring({ frame: frame - delay - i * stagger, fps, config: { damping: 18, stiffness: 220, mass: 0.6 } });
        return (
          <span key={i} style={{ overflow: 'hidden', display: 'inline-block', paddingBottom: size * 0.08 }}>
            <span
              style={{
                display: 'inline-block',
                transform: `translateY(${(1 - s) * 105}%)`,
                filter: `blur(${(1 - s) * 6}px)`,
                color: accent.includes(w) ? C.accent : undefined,
              }}
            >
              {w}
            </span>
          </span>
        );
      })}
    </div>
  );
};
