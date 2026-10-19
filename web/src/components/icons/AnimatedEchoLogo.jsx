import { useEffect, useId, useRef, useState } from 'react';
import {
  BOTTOM_BULB,
  INNER_BOTTOM,
  INNER_TOP,
  OUTLINE,
  TOP_BULB,
  clamp01,
  outBack,
  sandLevels,
} from './echoHourglass.js';

// The ECHO mark as a live hourglass. Hovering its link turns it over and the
// sand runs back down; the centre eye glances around and blinks on its own.

const SAND = '#ffb35c';
const SAND_INNER = '#4fd1c5';
const FLIP_MS = 550;
const POUR_MS = 2200;
const REST = { turn: 0, p: 1, stream: 0 };

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const rand = (a, b) => a + Math.random() * (b - a);

/** Hourglass pose `ms` after a hover started. */
function poseAt(ms) {
  if (ms < FLIP_MS) return { turn: 180 * (1 - outBack(ms / FLIP_MS)), p: 0, stream: 0 };
  const t = ms - FLIP_MS;
  const p = clamp01(t / POUR_MS);
  const stream = clamp01(t / 130) * (1 - clamp01((t - (POUR_MS - 200)) / 200));
  return { turn: 0, p, stream };
}

export function AnimatedEchoLogo({ className, title }) {
  const id = useId().replace(/:/g, '');
  const svgRef = useRef(null);
  const [pose, setPose] = useState(REST);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState({ n: 0, count: 1 });

  // Hover: flip and pour once; a hover mid-pour does not restart it.
  useEffect(() => {
    const svg = svgRef.current;
    const target = svg?.closest('a, button') ?? svg;
    if (!target) return undefined;
    let raf = 0;
    let start = null;
    const tick = (now) => {
      const ms = now - start;
      if (ms >= FLIP_MS + POUR_MS) {
        start = null;
        setPose(REST);
        return;
      }
      setPose(poseAt(ms));
      raf = requestAnimationFrame(tick);
    };
    const play = () => {
      if (start !== null || reducedMotion()) return;
      start = performance.now();
      raf = requestAnimationFrame(tick);
    };
    target.addEventListener('pointerenter', play);
    target.addEventListener('focus', play);
    return () => {
      target.removeEventListener('pointerenter', play);
      target.removeEventListener('focus', play);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Idle eye: at random intervals it glances somewhere, looks back, or blinks.
  useEffect(() => {
    if (reducedMotion()) return undefined;
    let timer = 0;
    let away = false;
    const next = () => {
      timer = setTimeout(() => {
        if (!document.hidden) {
          const r = Math.random();
          if (r < 0.3) {
            const count = Math.random() < 0.25 ? 2 : 1;
            setBlink((b) => ({ n: b.n + 1, count }));
          } else if (away && r < 0.6) {
            away = false;
            setGaze({ x: 0, y: 0 });
          } else {
            const a = rand(0, Math.PI * 2);
            const d = rand(0.5, 1);
            away = true;
            setGaze({ x: Math.cos(a) * d, y: Math.sin(a) * d * 0.7 });
          }
        }
        next();
      }, rand(900, 3800));
    };
    next();
    return () => clearTimeout(timer);
  }, []);

  const lv = sandLevels(pose.p);
  const ramp = Math.min(1, pose.p * 6);
  const dip = pose.p < 1 ? 1.4 * ramp * (1 - clamp01((pose.p - 0.85) / 0.15)) : 0;
  const heap = 1.2 * ramp;
  const layers = [
    { top: `${id}t`, bottom: `${id}b`, color: SAND },
    { top: `${id}ti`, bottom: `${id}bi`, color: SAND_INNER },
  ];
  // A double blink runs the animation twice; the key restarts it each time.
  const blinkStyle = blink.n ? { animation: `sx-echo-blink 170ms ease-in-out ${blink.count}` } : undefined;

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      style={{ overflow: 'visible' }}
    >
      <defs>
        <clipPath id={`${id}t`}>
          <polygon points={TOP_BULB.join(' ')} />
        </clipPath>
        <clipPath id={`${id}b`}>
          <polygon points={BOTTOM_BULB.join(' ')} />
        </clipPath>
        <clipPath id={`${id}ti`}>
          <polygon points={INNER_TOP} />
        </clipPath>
        <clipPath id={`${id}bi`}>
          <polygon points={INNER_BOTTOM} />
        </clipPath>
      </defs>
      <g transform={`rotate(${pose.turn} 12 12)`}>
        <path d={OUTLINE} fill="#101214" />
        {layers.map((layer) => (
          <g key={layer.color}>
            {pose.p < 1 ? (
              <polygon
                clipPath={`url(#${layer.top})`}
                points={`2,${lv.top} 12,${lv.top + dip} 22,${lv.top} 22,12 2,12`}
                fill={layer.color}
              />
            ) : null}
            {pose.p > 0 ? (
              <polygon
                clipPath={`url(#${layer.bottom})`}
                points={`2,22 22,22 22,${lv.bottom + heap} 12,${lv.bottom - heap} 2,${lv.bottom + heap}`}
                fill={layer.color}
              />
            ) : null}
          </g>
        ))}
        <path d={OUTLINE} stroke="#ffffff" strokeWidth="1.5" strokeLinejoin="bevel" />
        <polygon points={INNER_TOP} stroke="#f2f3f5" strokeWidth="1.4" strokeLinejoin="bevel" />
        <polygon points={INNER_BOTTOM} stroke="#f2f3f5" strokeWidth="1.4" strokeLinejoin="bevel" />
        <line x1="12" y1="2.5" x2="12" y2="21.5" stroke="#ff3b1f" strokeWidth="1.6" strokeLinecap="square" />
        <path d="M8.5 12 L11 10.4 M8.5 12 L11 13.6" stroke="#ff3b1f" strokeWidth="1.4" strokeLinejoin="bevel" />
        <path d="M15.5 12 L13 10.4 M15.5 12 L13 13.6" stroke="#ff3b1f" strokeWidth="1.4" strokeLinejoin="bevel" />
        <line x1="4.5" y1="12" x2="7" y2="12" stroke="#ff3b1f" strokeWidth="1.3" />
        <line x1="17" y1="12" x2="19.5" y2="12" stroke="#ff3b1f" strokeWidth="1.3" />
        {pose.stream > 0 ? (
          <line
            x1="12"
            y1="11.4"
            x2="12"
            y2={lv.bottom - heap}
            stroke={SAND}
            strokeWidth={0.8 * pose.stream}
            strokeDasharray="0.45 0.35"
            className="sx-echo-stream"
          />
        ) : null}
        <polygon points="12,10.5 13.5,12 12,13.5 10.5,12" fill="#ff3b1f" />
        <g key={blink.n} className="sx-echo-eye" style={blinkStyle}>
          <circle cx="12" cy="12" r="0.62" fill="#f2f3f5" />
          <circle
            cx="12"
            cy="12"
            r="0.3"
            fill="#101214"
            className="sx-echo-pupil"
            style={{ transform: `translate(${0.3 * gaze.x}px, ${0.3 * gaze.y}px)` }}
          />
        </g>
      </g>
    </svg>
  );
}
