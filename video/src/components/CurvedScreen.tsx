import { useOffthreadVideoTexture } from '@remotion/three';
import { useLayoutEffect, useMemo } from 'react';
import { useRemotionEnvironment } from 'remotion';
import { DoubleSide, PlaneGeometry, SRGBColorSpace } from 'three';
import type { Texture } from 'three';
import { useRedraw } from './useRedraw';

const SEG = 64;
const HALF = 1; // square screen, 2 x 2 units

// Square reel screen that morphs FLAT -> SQ CURVE (cylinder) -> DOME (sphere cap),
// mirroring the player's curvature modes, rebuilt from `curve` / `dome` each frame.
type Props = { src: string; curve: number; dome: number };

// useOffthreadVideoTexture() only works while rendering; the Studio preview shows a blank screen.
export const CurvedScreen = (p: Props) =>
  useRemotionEnvironment().isRendering ? <VideoScreen {...p} /> : <Screen {...p} texture={null} />;

const VideoScreen = (p: Props) => {
  const texture = useOffthreadVideoTexture({ src: p.src });
  return <Screen {...p} texture={texture} />;
};

const Screen = ({ curve, dome, texture }: Props & { texture: Texture | null }) => {
  const geometry = useMemo(() => new PlaneGeometry(HALF * 2, HALF * 2, SEG, SEG), []);
  const base = useMemo(() => Float32Array.from(geometry.attributes.position.array), [geometry]);

  useLayoutEffect(() => {
    const pos = geometry.attributes.position;
    const Rc = 1.45; // SQ CURVE radius
    const Rd = 1.05; // DOME radius
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3];
      const y = base[i * 3 + 1];
      // Cylinder: bend around the vertical axis, edges wrap toward the viewer.
      const a = x / Rc;
      const cx = Rc * Math.sin(a);
      const cz = Rc * (1 - Math.cos(a));
      // Sphere cap: bend on both axes.
      const t = x / Rd;
      const p = y / Rd;
      const sx = Rd * Math.sin(t) * Math.cos(p);
      const sy = Rd * Math.sin(p);
      const sz = Rd * (1 - Math.cos(t) * Math.cos(p));
      const X = x + (cx - x) * curve + (sx - (x + (cx - x) * curve)) * dome;
      const Y = y + (sy - y) * dome;
      const Z = cz * curve + (sz - cz * curve) * dome;
      pos.setXYZ(i, X, Y, Z);
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
  }, [base, curve, dome, geometry]);

  if (texture) texture.colorSpace = SRGBColorSpace;
  useRedraw(texture);
  return (
    <mesh geometry={geometry}>
      {/* keyed so the shader recompiles once the texture arrives (null -> map) */}
      <meshBasicMaterial key={texture ? 'tex' : 'none'} map={texture} side={DoubleSide} toneMapped={false} />
    </mesh>
  );
};
