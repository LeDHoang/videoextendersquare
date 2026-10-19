import { useMemo } from 'react';
import { AdditiveBlending, SRGBColorSpace, TextureLoader, Vector3 } from 'three';
import { continueRender, delayRender, random, useCurrentFrame } from 'remotion';
import { useEffect, useState } from 'react';
import type { Texture } from 'three';
import { useRedraw } from './useRedraw';

// Cities that carry Earth-activity heat zones (lat, lon).
const CITIES: [number, number][] = [
  [51.5, -0.13], [40.71, -74.0], [35.68, 139.69], [10.82, 106.63], [21.03, 105.85],
  [48.86, 2.35], [34.05, -118.24], [-23.55, -46.63], [1.35, 103.82], [37.57, 126.98],
  [52.52, 13.4], [25.2, 55.27], [19.43, -99.13], [-33.87, 151.21], [41.88, -87.63],
  [-1.29, 36.82], [13.75, 100.5], [55.75, 37.62],
];

const toVec = (lat: number, lon: number, r: number) => {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
};

const useTexture = (src: string) => {
  const [tex, setTex] = useState<Texture | null>(null);
  const [handle] = useState(() => delayRender(`globe texture ${src}`));
  useEffect(() => {
    new TextureLoader().load(src, (t) => {
      t.colorSpace = SRGBColorSpace;
      setTex(t);
      continueRender(handle);
    });
  }, [src, handle]);
  return tex;
};

// Earth globe with pulsing orange heat zones, spun from the frame number.
export const Globe = ({ src, spin }: { src: string; spin: number }) => {
  const frame = useCurrentFrame();
  const map = useTexture(src);
  useRedraw(map);
  const points = useMemo(() => CITIES.map(([la, lo]) => toVec(la, lo, 1.012)), []);
  return (
    <group rotation={[0.35, spin, 0]}>
      <mesh>
        <sphereGeometry args={[1, 96, 96]} />
        <meshStandardMaterial key={map ? 'tex' : 'none'} map={map ?? undefined} color="#9fb8d8" roughness={0.9} metalness={0} />
      </mesh>
      {/* atmosphere rim */}
      <mesh scale={1.06}>
        <sphereGeometry args={[1, 64, 64]} />
        <meshBasicMaterial color="#2a6cff" transparent opacity={0.08} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
      {points.map((p, i) => {
        const pulse = 0.5 + 0.5 * Math.sin(frame * 0.18 + random(`c${i}`) * 6.28);
        const s = 0.012 + 0.018 * pulse * (0.5 + random(`s${i}`));
        return (
          <mesh key={i} position={p} scale={s}>
            <sphereGeometry args={[1, 16, 16]} />
            <meshBasicMaterial color="#ff3b1f" transparent opacity={0.7 + 0.3 * pulse} toneMapped={false} />
          </mesh>
        );
      })}
    </group>
  );
};
