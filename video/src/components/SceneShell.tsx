import { AbsoluteFill } from 'remotion';
import { Backdrop, Grain, Vignette } from './Backdrop';
import { HudLabel } from './HudLabel';
import { C } from '../theme';

// Common scene chrome: backdrop, `[ 0N / NAME ]` index tag, vignette and grain.
export const SceneShell = ({
  index, name, children, grid = true, tint, bg = C.bg,
}: { index: number; name: string; children: React.ReactNode; grid?: boolean; tint?: string; bg?: string }) => (
  <AbsoluteFill style={{ backgroundColor: bg }}>
    <Backdrop grid={grid} tint={tint} />
    {children}
    <div style={{ position: 'absolute', left: 120, top: 64 }}>
      <HudLabel text={`[ ${String(index).padStart(2, '0')} / ${name} ]`} size={20} accent />
    </div>
    <Vignette />
    <Grain seed={index} />
  </AbsoluteFill>
);
