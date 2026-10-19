import { ThreeCanvas } from '@remotion/three';
import { AbsoluteFill, OffthreadVideo, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { SceneProps } from '../EchoIntro';
import { KineticText } from '../components/KineticText';
import { Chip } from '../components/HudLabel';
import { CurvedScreen } from '../components/CurvedScreen';
import { GlassFrame } from '../components/GlassFrame';
import { SceneShell } from '../components/SceneShell';
import { Starfield } from '../components/Starfield';
import { MEDIA } from '../media';
import { C } from '../theme';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

// Push into space: the square bends FLAT -> SQ CURVE -> DOME, as in the WebXR player.
export const StepInside = ({ dur }: SceneProps) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const curve = interpolate(frame, [dur * 0.28, dur * 0.45], [0, 1], clamp);
  const dome = interpolate(frame, [dur * 0.58, dur * 0.75], [0, 1], clamp);
  const camZ = interpolate(frame, [0, dur], [5.2, 2.9], { easing: (x) => 1 - Math.pow(1 - x, 2) });
  const yaw = Math.sin(frame / 40) * 0.12;
  const stage = dome > 0.5 ? 2 : curve > 0.5 ? 1 : 0;
  const pulse = 0.5 + 0.5 * Math.sin(frame / 7);
  const inset = interpolate(frame, [dur * 0.5, dur * 0.6], [0, 1], clamp);
  return (
    <SceneShell index={4} name="STEP INSIDE" grid={false} bg={C.navy}>
      <Starfield count={320} drift={0.25} />
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 45% 40% at 58% 52%, rgba(255,59,31,${0.18 + 0.12 * pulse}), rgba(46,230,255,${0.06 + 0.05 * (1 - pulse)}) 55%, transparent 75%)`,
        }}
      />
      <AbsoluteFill style={{ left: 340 }}>
        <ThreeCanvas width={width} height={height} camera={{ fov: 45, position: [0, 0, camZ] }} gl={{ alpha: true }}>
          <group rotation={[0, Math.PI + yaw, 0]} scale={[-1, 1, 1]}>
            <CurvedScreen src={MEDIA.reelVan} curve={curve} dome={dome} />
          </group>
        </ThreeCanvas>
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 120, top: 150, width: 820 }}>
        <KineticText text="…and lets you step inside." accent={['inside.']} size={104} delay={4} />
      </div>
      <div style={{ position: 'absolute', left: 120, bottom: 110, display: 'flex', gap: 14 }}>
        {['FLAT', 'SQ CURVE', 'DOME'].map((m, i) => <Chip key={m} text={m} active={stage === i} />)}
      </div>
      <GlassFrame
        width={300} height={338} label="QUEST 3S · LIVE CAPTURE"
        style={{ right: 110, bottom: 100, opacity: inset, transform: `translateY(${(1 - inset) * 40}px)` }}
      >
        <OffthreadVideo src={MEDIA.quest.dome} muted startFrom={300} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </GlassFrame>
    </SceneShell>
  );
};
