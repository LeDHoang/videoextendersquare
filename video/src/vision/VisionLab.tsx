// Dev-only composition: renders a raw GLStage from props so worlds, portals
// and the galaxy can be tuned with `remotion still VisionLab --props=…`.
import { AbsoluteFill } from 'remotion';
import { GLStage, type Stage } from './gl/GLStage';

export type VisionLabProps = { stage: Stage; ssaa: number };

export const LAB_DEFAULT: VisionLabProps = {
  ssaa: 1,
  stage: {
    layers: [
      {
        world: 'ocean',
        pos: [0, 2.2, 0],
        rot: [0, 0.02, 0],
        fov: 55,
        time: 3,
        anchor: [960, 540, 540],
        mask: [960, 540, 960, 540],
      },
    ],
  },
};

export const VisionLab: React.FC<VisionLabProps> = ({ stage, ssaa }) => (
  <AbsoluteFill style={{ background: '#000' }}>
    <GLStage stage={stage} ssaa={ssaa} />
  </AbsoluteFill>
);
