import { ThreeCanvas } from '@remotion/three';
import { AbsoluteFill, OffthreadVideo, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { SceneProps } from '../EchoIntro';
import { KineticText } from '../components/KineticText';
import { HudLabel } from '../components/HudLabel';
import { GlassFrame } from '../components/GlassFrame';
import { Globe } from '../components/Globe';
import { SceneShell } from '../components/SceneShell';
import { Starfield } from '../components/Starfield';
import { MEDIA } from '../media';
import { C } from '../theme';

const TILES = [
  { src: MEDIA.reelVan, from: 0 },
  { src: MEDIA.reelVolley, from: 30 },
  { src: MEDIA.reelVan, from: 150 },
  { src: MEDIA.reelVolley, from: 120 },
];
const T = 140;

// Earth discovery: globe with city heat zones, a Reel Pack assembling, the live Quest view.
export const World = ({ dur }: SceneProps) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const grow = spring({ frame, fps, config: { damping: 22, stiffness: 70 } });
  const inset = interpolate(frame, [dur * 0.45, dur * 0.55], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <SceneShell index={6} name="WORLD" grid={false} bg={C.navy}>
      <Starfield count={220} drift={0.1} seed="world" />
      <AbsoluteFill style={{ left: 300 }}>
        <ThreeCanvas width={width} height={height} camera={{ fov: 40, position: [0, 0, 3.4] }} gl={{ alpha: true }}>
          <ambientLight intensity={0.55} />
          <directionalLight position={[-3, 2, 4]} intensity={2.2} />
          <group scale={0.55 + 0.45 * grow}>
            <Globe src={MEDIA.earth} spin={-1.2 + frame * 0.012} />
          </group>
        </ThreeCanvas>
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 120, top: 150, width: 800 }}>
        <KineticText text="Discover the world, reel by reel." accent={['world,']} size={100} delay={4} />
      </div>
      <div style={{ position: 'absolute', left: 120, top: 560 }}>
        <HudLabel text="REEL PACK · CITY STREETS · 12 REELS" size={18} delay={18} cps={3} />
        <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: `repeat(2, ${T}px)`, gap: 10 }}>
          {TILES.map((t, i) => {
            const s = spring({ frame: frame - 14 - i * 4, fps, config: { damping: 14, stiffness: 160 } });
            return (
              <div
                key={i}
                style={{
                  width: T, height: T, overflow: 'hidden', border: `1px solid ${i === 0 ? C.accent : C.ruleStrong}`,
                  opacity: s, transform: `translate(${(1 - s) * (300 - i * 40)}px, ${(1 - s) * (i % 2 ? -120 : 120)}px) rotate(${(1 - s) * 20}deg)`,
                }}
              >
                <OffthreadVideo src={t.src} muted startFrom={t.from} style={{ width: T, height: T }} />
              </div>
            );
          })}
        </div>
      </div>
      <GlassFrame
        width={280} height={315} label="QUEST 3S · EARTH"
        style={{ right: 110, bottom: 100, opacity: inset, transform: `translateY(${(1 - inset) * 40}px)` }}
      >
        <OffthreadVideo src={MEDIA.quest.earth} muted startFrom={90} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </GlassFrame>
    </SceneShell>
  );
};
