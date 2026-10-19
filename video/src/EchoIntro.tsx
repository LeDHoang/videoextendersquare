import { AbsoluteFill, Audio, Series, getStaticFiles, interpolate, useVideoConfig } from 'remotion';
import { C } from './theme';
import { MEDIA } from './media';
import { CUT_30, CUT_60, SceneId } from './timing';
import { Hook } from './scenes/Hook';
import { Shift } from './scenes/Shift';
import { Extend } from './scenes/Extend';
import { StepInside } from './scenes/StepInside';
import { Stereo } from './scenes/Stereo';
import { World } from './scenes/World';
import { Proof } from './scenes/Proof';
import { Creators } from './scenes/Creators';
import { EndCard } from './scenes/EndCard';

export type SceneProps = { dur: number };

const SCENES: Record<SceneId, (p: SceneProps) => React.ReactNode> = {
  hook: Hook,
  shift: Shift,
  extend: Extend,
  stepInside: StepInside,
  stereo: Stereo,
  world: World,
  proof: Proof,
  creators: Creators,
  end: EndCard,
};

const hasMusic = () => getStaticFiles().some((f) => f.name === 'audio/track.mp3');

export const EchoIntro = ({ cutId }: { cutId: string }) => {
  const { durationInFrames } = useVideoConfig();
  const cut = cutId === CUT_60.id ? CUT_60 : CUT_30;
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      <Series>
        {cut.scenes.map(({ id, dur }) => {
          const Scene = SCENES[id];
          return (
            <Series.Sequence key={id} durationInFrames={dur} name={id}>
              <Scene dur={dur} />
            </Series.Sequence>
          );
        })}
      </Series>
      {hasMusic() && (
        <Audio
          src={MEDIA.music}
          volume={(f) =>
            interpolate(f, [0, 15, durationInFrames - 45, durationInFrames], [0, 0.9, 0.9, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })
          }
        />
      )}
    </AbsoluteFill>
  );
};
