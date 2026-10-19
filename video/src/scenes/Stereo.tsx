import { AbsoluteFill, OffthreadVideo, interpolate, useCurrentFrame } from 'remotion';
import type { SceneProps } from '../EchoIntro';
import { KineticText } from '../components/KineticText';
import { Chip, HudLabel } from '../components/HudLabel';
import { SceneShell } from '../components/SceneShell';
import { MEDIA } from '../media';
import { C } from '../theme';

const S = 620;
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

// One eye, tinted: multiply a colour over the frame inside an isolated layer.
const Eye = ({ tint, dx, blend }: { tint: string; dx: number; blend?: boolean }) => (
  <div style={{ position: 'absolute', inset: 0, transform: `translateX(${dx}px)`, isolation: 'isolate', mixBlendMode: blend ? 'screen' : 'normal' }}>
    <OffthreadVideo src={MEDIA.reelVolley} muted startFrom={60} style={{ width: S, height: S }} />
    <div style={{ position: 'absolute', inset: 0, background: tint, mixBlendMode: 'multiply' }} />
  </div>
);

// L/R eyes slide apart, then converge as a red/cyan pair that settles into one 3D image.
export const Stereo = ({ dur }: SceneProps) => {
  const frame = useCurrentFrame();
  const split = interpolate(frame, [0, dur * 0.25, dur * 0.45], [0, 1, 0], clamp);
  const offset = interpolate(frame, [dur * 0.4, dur * 0.8], [36, 0], clamp);
  const tinted = interpolate(frame, [dur * 0.78, dur * 0.9], [1, 0], clamp);
  const gap = split * 360;
  return (
    <SceneShell index={5} name="STEREO 3D">
      <div style={{ position: 'absolute', left: 120, top: 150, width: 1700 }}>
        <KineticText text="Real 3D. Right in the browser." accent={['3D.']} size={104} delay={4} />
      </div>
      <div style={{ position: 'absolute', left: (1920 - S) / 2, top: 360, width: S, height: S, background: '#000', boxShadow: `0 0 120px ${C.accentGlow}` }}>
        <Eye tint={`rgb(255,${Math.round(255 * (1 - tinted))},${Math.round(255 * (1 - tinted))})`} dx={-gap - offset} />
        <Eye tint={`rgb(${Math.round(255 * (1 - tinted))},255,255)`} dx={gap + offset} blend />
        {split > 0.05 && (
          <>
            <div style={{ position: 'absolute', top: -40, left: -gap }}><HudLabel text="L EYE" size={20} accent /></div>
            <div style={{ position: 'absolute', top: -40, right: -gap }}><HudLabel text="R EYE" size={20} accent /></div>
          </>
        )}
      </div>
      <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 46 }}>
        <div style={{ display: 'flex', gap: 14, opacity: frame > dur * 0.8 ? 1 : 0.4 }}>
          <Chip text="STEREO 3D" active={frame > dur * 0.8} />
          <Chip text="SBS · TB" />
          <Chip text="PER-EYE · QUEST 3 / 3S" />
        </div>
      </AbsoluteFill>
    </SceneShell>
  );
};
