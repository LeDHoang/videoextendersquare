import { OffthreadVideo, Sequence, interpolate, useCurrentFrame } from 'remotion';
import type { SceneProps } from '../EchoIntro';
import { KineticText } from '../components/KineticText';
import { HudLabel } from '../components/HudLabel';
import { GlassFrame } from '../components/GlassFrame';
import { ScanLine } from '../components/ScanLine';
import { SceneShell } from '../components/SceneShell';
import { MEDIA } from '../media';

const SHOTS = [
  // The feed auto-advances into third-party dev-DB clips after ~1.3 s: keep to the first second, slowed.
  { src: MEDIA.web.reelsDesktop, from: 0, rate: 0.55, label: 'REELS · AMBILIGHT PLAYER' },
  { src: MEDIA.web.dome, from: 180, label: 'IMMERSIVE PREVIEW · DOME' },
  { src: MEDIA.web.extender, from: 30, label: 'EXTENDER · 720² → 3840²' },
  { src: MEDIA.web.wallet, from: 0, label: 'ECHO CREDITS · WALLET' },
];
const W = 1120;
const H = W * (9 / 16);

const Shot = ({ src, from, len, rate = 1 }: { src: string; from: number; len: number; rate?: number }) => {
  const f = useCurrentFrame();
  const z = interpolate(f, [0, len], [1.0, 1.07]);
  return <OffthreadVideo src={src} muted startFrom={from} playbackRate={rate} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${z})` }} />;
};

// Live product, four beats of real UI captures.
export const Proof = ({ dur }: SceneProps) => {
  const frame = useCurrentFrame();
  const len = Math.floor(dur / SHOTS.length);
  const i = Math.min(SHOTS.length - 1, Math.floor(frame / len));
  const local = frame - i * len;
  return (
    <SceneShell index={7} name="LIVE TODAY">
      <div style={{ position: 'absolute', left: 120, top: 150, width: 520 }}>
        <KineticText text="Live today. Built for headsets." accent={['today.']} size={80} delay={2} />
        <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <HudLabel text="WEBXR · QUEST 3 · NO INSTALL" size={19} delay={12} cps={3} />
          <HudLabel text="PACKS · SOCIAL · CREDITS" size={19} delay={Math.round(dur / 2)} cps={3} />
        </div>
      </div>
      <GlassFrame width={W} height={H} label={SHOTS[i].label} style={{ left: 680, top: 260 }}>
        {SHOTS.map((s, k) => (
          <Sequence key={k} from={k * len} durationInFrames={k === SHOTS.length - 1 ? dur - k * len : len} layout="none">
            <Shot src={s.src} from={s.from} len={len} rate={'rate' in s ? s.rate : 1} />
          </Sequence>
        ))}
        {local < 3 && i > 0 && <ScanLine x={`${(local / 3) * 100}%`} length="100%" thickness={6} />}
      </GlassFrame>
    </SceneShell>
  );
};
