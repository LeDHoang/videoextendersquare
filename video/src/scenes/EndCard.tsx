import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { SceneProps } from '../EchoIntro';
import { Backdrop, Grain, Vignette } from '../components/Backdrop';
import { KineticText } from '../components/KineticText';
import { HudLabel } from '../components/HudLabel';
import { ScanLine } from '../components/ScanLine';
import { EchoGlassMark } from '../components/EchoGlass';
import { C, CONTACT, F } from '../theme';

const CREDIT = '"Cyborg Ninja" Kevin MacLeod (incompetech.com) · Licensed under CC BY 4.0';

// Logo assembles out of the scan line, then the closing line and contact.
export const EndCard = ({ dur }: SceneProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const line = interpolate(frame, [0, 8, 14], [0, 1, 0], { extrapolateRight: 'clamp' });
  const lineW = interpolate(frame, [0, 8], [0, 1920], { extrapolateRight: 'clamp' });
  const logo = spring({ frame: frame - 6, fps, config: { damping: 14, stiffness: 150 } });
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      <Backdrop />
      <ScanLine vertical={false} y={420} length={lineW} opacity={line} />
      <AbsoluteFill style={{ alignItems: 'center', paddingTop: 210 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 36, opacity: logo, transform: `scaleY(${0.1 + 0.9 * logo})` }}>
          <EchoGlassMark t={frame - 6} size={160} />
          <div style={{ fontFamily: F.brand, fontWeight: 900, fontSize: 168, letterSpacing: '0.12em', color: C.ink }}>ECHO</div>
        </div>
        <div style={{ marginTop: 70 }}>
          <KineticText text="Every reel, a world." accent={['world.']} size={110} delay={16} align="center" />
        </div>
        <div style={{ marginTop: 56 }}>
          <HudLabel text={CONTACT} size={26} color={C.ink} delay={30} cps={3} />
        </div>
      </AbsoluteFill>
      <div style={{ position: 'absolute', bottom: 40, width: '100%', textAlign: 'center', fontFamily: F.mono, fontSize: 16, color: C.ink3, letterSpacing: '0.06em', opacity: interpolate(frame, [20, 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
        MUSIC: {CREDIT}
      </div>
      <Vignette strength={0.6} />
      <Grain seed={99} />
      <AbsoluteFill style={{ backgroundColor: '#000', opacity: interpolate(frame, [dur - 8, dur], [0, 1], { extrapolateLeft: 'clamp' }) }} />
    </AbsoluteFill>
  );
};
