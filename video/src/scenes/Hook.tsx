import { AbsoluteFill, OffthreadVideo, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { SceneProps } from '../EchoIntro';
import { KineticText } from '../components/KineticText';
import { HudLabel } from '../components/HudLabel';
import { SceneShell } from '../components/SceneShell';
import { MEDIA } from '../media';
import { C } from '../theme';

const PW = 400;
const PH = PW * (932 / 430);

// A reel boxed inside a phone. On the last beat the phone squashes flat into the scan line.
export const Hook = ({ dur }: SceneProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 20, stiffness: 140 } });
  const squash = interpolate(frame, [dur - 10, dur - 2], [1, 0.004], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const widen = interpolate(frame, [dur - 4, dur], [1, 5], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <SceneShell index={1} name="TODAY">
      <div style={{ position: 'absolute', left: 120, top: 330, width: 900 }}>
        <KineticText text="Short video is flat." accent={['flat.']} size={150} delay={6} />
        <div style={{ marginTop: 40 }}>
          <HudLabel text="9:16 · 2D · BOXED IN A PHONE" delay={22} />
        </div>
      </div>
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'flex-end', paddingRight: 260 }}>
        <div
          style={{
            width: PW, height: PH * 0.92 + 28, padding: 14, borderRadius: 54,
            border: `3px solid ${squash < 0.2 ? C.accent : C.ruleStrong}`,
            background: '#000', boxShadow: `0 50px 140px rgba(0,0,0,0.7)`,
            transform: `translateY(${(1 - enter) * 120}px) scaleY(${squash}) scaleX(${widen})`,
            opacity: enter, overflow: 'hidden',
          }}
        >
          <div style={{ width: '100%', height: '100%', borderRadius: 40, overflow: 'hidden' }}>
            <OffthreadVideo src={MEDIA.web.reelsPhone} muted style={{ width: '100%', height: PH, objectFit: 'cover', marginTop: -PH * 0.04 }} />
          </div>
        </div>
      </AbsoluteFill>
    </SceneShell>
  );
};
