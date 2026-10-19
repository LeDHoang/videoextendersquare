import { OffthreadVideo, interpolate, useCurrentFrame } from 'remotion';
import type { SceneProps } from '../EchoIntro';
import { KineticText } from '../components/KineticText';
import { HudLabel } from '../components/HudLabel';
import { GlassFrame } from '../components/GlassFrame';
import { SceneShell } from '../components/SceneShell';
import { MEDIA } from '../media';

// Extended cut only: the creator economy.
export const Creators = ({ dur }: SceneProps) => {
  const frame = useCurrentFrame();
  const z = interpolate(frame, [0, dur], [1.04, 1.12]);
  return (
    <SceneShell index={8} name="CREATORS">
      <div style={{ position: 'absolute', left: 120, top: 330, width: 560 }}>
        <KineticText text="Creators earn." accent={['earn.']} size={130} delay={4} />
        <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <HudLabel text="ECHO CREDITS · STRIPE" size={20} delay={16} cps={3} />
          <HudLabel text="WATCH-TO-EARN REWARDS" size={20} delay={28} cps={3} />
        </div>
      </div>
      <GlassFrame width={1080} height={608} label="WALLET · LIVE" style={{ left: 720, top: 236 }}>
        <OffthreadVideo src={MEDIA.web.wallet} muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${z})`, transformOrigin: '60% 40%' }} />
      </GlassFrame>
    </SceneShell>
  );
};
