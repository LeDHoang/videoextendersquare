import { Composition } from 'remotion';
import { EchoIntro } from './EchoIntro';
import { CUT_30, CUT_60, FPS, cutLength } from './timing';
import { EchoVision } from './vision/EchoVision';
import { VISION_LENGTH } from './vision/timing';
import { LAB_DEFAULT, VisionLab } from './vision/VisionLab';

export const RemotionRoot = () => (
  <>
    {[CUT_30, CUT_60].map((cut) => (
      <Composition
        key={cut.id}
        id={cut.id}
        component={EchoIntro}
        durationInFrames={cutLength(cut)}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ cutId: cut.id }}
      />
    ))}
    <Composition
      id="EchoVision30"
      component={EchoVision}
      durationInFrames={VISION_LENGTH}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ ssaa: 2 }}
    />
    <Composition
      id="VisionLab"
      component={VisionLab}
      durationInFrames={90}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={LAB_DEFAULT}
    />
  </>
);
