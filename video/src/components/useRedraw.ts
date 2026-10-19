import { useThree } from '@react-three/fiber';
import { useLayoutEffect } from 'react';
import { useDelayRender } from 'remotion';

// <ThreeCanvas> only redraws when the frame number changes. Textures that load
// after that (video frames, images) need an explicit redraw before the screenshot.
export const useRedraw = (dep: unknown) => {
  const advance = useThree((s) => s.advance);
  const { delayRender, continueRender } = useDelayRender();
  useLayoutEffect(() => {
    if (!dep) return;
    const handle = delayRender('Redrawing <ThreeCanvas> after texture load');
    advance(performance.now());
    requestAnimationFrame(() => continueRender(handle));
  }, [dep, advance, delayRender, continueRender]);
};
