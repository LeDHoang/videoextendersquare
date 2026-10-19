import { AbsoluteFill, OffthreadVideo, interpolate, useCurrentFrame } from 'remotion';
import type { SceneProps } from '../EchoIntro';
import { KineticText } from '../components/KineticText';
import { Chip, HudLabel } from '../components/HudLabel';
import { ScanLine } from '../components/ScanLine';
import { SceneShell } from '../components/SceneShell';
import { MEDIA } from '../media';
import { C } from '../theme';

const SQ = 800;
const NARROW = SQ * (9 / 16);

// Hero beat: a 9:16 reel outpaints into a 4K square, two scan lines pushing the frame open.
export const Extend = ({ dur }: SceneProps) => {
  const frame = useCurrentFrame();
  const t0 = Math.round(dur * 0.3);
  const t1 = Math.round(dur * 0.62);
  const open = interpolate(frame, [t0, t1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: (x) => 1 - Math.pow(1 - x, 3) });
  const w = NARROW + (SQ - NARROW) * open;
  const inset = (SQ - w) / 2;
  const lineOn = frame >= t0 - 4 && frame <= t1 + 6 ? 1 : 0;
  const done = frame > t1;
  return (
    <SceneShell index={3} name="EXTEND">
      <AbsoluteFill style={{ opacity: 0.16, filter: 'blur(6px) saturate(0.6)' }}>
        <OffthreadVideo src={MEDIA.web.extender} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 120, top: 300, width: 780 }}>
        <KineticText text="ECHO extends any reel." accent={['extends']} size={118} delay={4} />
        <div style={{ marginTop: 44, display: 'flex', gap: 14, flexWrap: 'wrap', opacity: frame > t1 - 6 ? 1 : 0.35 }}>
          <Chip text="AI OUTPAINT" active={done} />
          <Chip text="4K · 3840²" active={done} />
          <Chip text="HEVC" active={done} />
        </div>
      </div>
      <div style={{ position: 'absolute', left: 1000, top: 140, width: SQ, height: SQ }}>
        {/* ECHO output: the full 4K square, revealed outward from the centre. */}
        <div style={{ position: 'absolute', inset: 0, clipPath: `inset(0 ${inset}px)` }}>
          <OffthreadVideo src={MEDIA.reelVolley} muted style={{ width: SQ, height: SQ }} />
        </div>
        {/* Before: the 9:16 source, soft and boxed, fades as the frame opens. */}
        <div style={{ position: 'absolute', top: 0, left: (SQ - NARROW) / 2, width: NARROW, height: SQ, overflow: 'hidden', opacity: 1 - open }}>
          <OffthreadVideo src={MEDIA.reelVolleySource} muted style={{ width: SQ, height: SQ, marginLeft: -(SQ - NARROW) / 2, filter: 'blur(1.5px)' }} />
        </div>
        <div style={{ position: 'absolute', inset: 0, left: inset, right: inset, border: `2px solid ${done ? C.accent : C.ruleStrong}` }} />
        {lineOn > 0 && (
          <>
            <ScanLine x={inset} length={SQ} />
            <ScanLine x={SQ - inset} length={SQ} />
          </>
        )}
        <div style={{ position: 'absolute', top: SQ + 22, left: 0, right: 0, display: 'flex', justifyContent: 'space-between' }}>
          <HudLabel text={done ? '1:1 · 3840 × 3840 OUTPUT' : '9:16 · 720P SOURCE'} size={20} accent={done} cps={3} />
          <HudLabel text="LTX · RAY-2 · WAN VACE" size={20} delay={t1} cps={3} />
        </div>
      </div>
    </SceneShell>
  );
};
