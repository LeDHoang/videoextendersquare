import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { SceneProps } from '../EchoIntro';
import { KineticText } from '../components/KineticText';
import { HudLabel } from '../components/HudLabel';
import { ScanLine } from '../components/ScanLine';
import { SceneShell } from '../components/SceneShell';
import { MEDIA } from '../media';

// The flat line from the Hook opens up into the headset controller graphic.
export const Shift = ({ dur }: SceneProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const line = interpolate(frame, [0, 10], [1, 0], { extrapolateRight: 'clamp' });
  const s = spring({ frame: frame - 4, fps, config: { damping: 16, stiffness: 120 } });
  const drift = interpolate(frame, [0, dur], [0, -30]);
  return (
    <SceneShell index={2} name="NEXT SCREEN">
      <ScanLine vertical={false} y={540} opacity={line} />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'flex-end', paddingRight: 220 }}>
        <Img
          src={MEDIA.controller}
          style={{
            height: 900, opacity: s,
            transform: `translateX(${(1 - s) * 260 + drift}px) rotate(${(1 - s) * 8}deg) scale(${0.9 + 0.1 * s})`,
          }}
        />
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 120, top: 300, width: 980 }}>
        <KineticText text="The next screen isn't a phone." accent={["isn't"]} size={128} delay={8} />
        <div style={{ marginTop: 44 }}>
          <HudLabel text="QUEST 3 · QUEST 3S · WEBXR BROWSER" delay={26} />
        </div>
      </div>
    </SceneShell>
  );
};
