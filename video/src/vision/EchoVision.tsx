// ECHO vision cut (30 s): every reel holds a world, and a headset lets you
// step inside it. All motion comes from director.ts; the overlays are DOM.
import { useMemo } from 'react';
import type React from 'react';
import { AbsoluteFill, Audio, staticFile, useCurrentFrame } from 'remotion';
import { direct, outroFade } from './director';
import { GLStage } from './gl/GLStage';
import { Copy } from './ui/Copy';
import { EndCard } from './ui/EndCard';
import { Goggles } from './ui/Goggles';
import { Phone } from './ui/Phone';
import { Tally } from './ui/Tally';

export type EchoVisionProps = { ssaa: number };

// The score is mastered hot (+2.3 dBTP); 1.5 dB of headroom keeps the AAC
// encode from clipping on inter-sample peaks.
const HEADROOM = 0.84;

export const EchoVision: React.FC<EchoVisionProps> = ({ ssaa }) => {
  const frame = useCurrentFrame();
  const shot = useMemo(() => direct(frame), [frame]);
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <GLStage stage={shot.stage} ssaa={ssaa} />
      {shot.phone ? <Phone state={shot.phone} frame={frame} /> : null}
      {shot.goggles ? <Goggles state={shot.goggles} /> : null}
      <Tally frame={frame} />
      <Copy frame={frame} />
      <EndCard frame={frame} />
      <Audio src={staticFile('audio/vision.mp3')} volume={(f) => HEADROOM * (1 - outroFade(f))} />
    </AbsoluteFill>
  );
};
