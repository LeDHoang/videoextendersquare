import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { BOTTOM, DARK, ECHOES, GAZE_AMP, INK, IRIS, LENS, PUPIL, RED, SMALL_PX, TOP } from './echoGlass.js';

// The ECHO "Echo Glass" mark, alive. The eye glances and blinks on its own;
// the echo triangles breathe, lean after the gaze, ripple out on a glance and
// squeeze in on a blink. Hovering its link turns the hourglass over, then new
// echoes grow out of the eye while the eye follows the pointer.

const PLAY_MS = 1600;
const KICK_MS = { ping: 740, squeeze: 400 };

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const rand = (a, b) => a + Math.random() * (b - a);

// SVG transforms repaint on the main thread every frame, so the marks sleep
// (breath paused, no glances) after a minute without visitor input.
const SLEEP_MS = 60000;
const INPUT_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'];
const wakers = new Set();
let lastInput = Date.now();
const onInput = () => {
  lastInput = Date.now();
  wakers.forEach((wake) => wake());
};
function watchInput(wake) {
  if (!wakers.size) INPUT_EVENTS.forEach((t) => window.addEventListener(t, onInput, { passive: true }));
  wakers.add(wake);
  return () => {
    wakers.delete(wake);
    if (!wakers.size) INPUT_EVENTS.forEach((t) => window.removeEventListener(t, onInput));
  };
}

export function AnimatedEchoLogo({ className, title }) {
  const id = useId().replace(/:/g, '');
  const svgRef = useRef(null);
  const [small, setSmall] = useState(false);
  const [play, setPlay] = useState(false);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState({ n: 0, count: 1 });
  const [kick, setKick] = useState({ n: 0, kind: '' });
  const [asleep, setAsleep] = useState(false);

  // Optical size: measure the layout box (not the hover-scaled one).
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const measure = (w) => setSmall(w > 0 && w < SMALL_PX);
    measure(svg.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  // Hover: turn over once (a hover mid-play does not restart it) and follow the pointer.
  useEffect(() => {
    const svg = svgRef.current;
    const target = svg?.closest('a, button') ?? svg;
    if (!target) return undefined;
    let timer = 0;
    let raf = 0;
    let pointer = null;
    let playing = false;
    const start = () => {
      if (playing || reducedMotion()) return;
      playing = true;
      setPlay(true);
      timer = setTimeout(() => {
        playing = false;
        setPlay(false);
      }, PLAY_MS);
    };
    // At most one gaze update per frame, however fast the pointer reports.
    const aim = () => {
      raf = 0;
      const b = svg.getBoundingClientRect();
      const dx = pointer.clientX - (b.left + b.width / 2);
      const dy = pointer.clientY - (b.top + b.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / 120);
      svg.dataset.tracking = '1';
      setGaze({ x: (dx / d) * k, y: (dy / d) * k });
    };
    const follow = (e) => {
      if (reducedMotion()) return;
      pointer = { clientX: e.clientX, clientY: e.clientY };
      if (!raf) raf = requestAnimationFrame(aim);
    };
    const leave = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      delete svg.dataset.tracking;
      setGaze({ x: 0, y: 0 });
    };
    target.addEventListener('pointerenter', start);
    target.addEventListener('focus', start);
    target.addEventListener('pointermove', follow);
    target.addEventListener('pointerleave', leave);
    return () => {
      target.removeEventListener('pointerenter', start);
      target.removeEventListener('focus', start);
      target.removeEventListener('pointermove', follow);
      target.removeEventListener('pointerleave', leave);
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Idle eye: at random intervals it glances somewhere, looks back, or blinks.
  // It sleeps while offscreen, in a hidden tab, or once the visitor goes idle.
  useEffect(() => {
    if (reducedMotion()) return undefined;
    const svg = svgRef.current;
    let timer = 0;
    let away = false;
    let visible = true;
    let sleeping = false;
    const settle = () => {
      const s = document.hidden || !visible || Date.now() - lastInput > SLEEP_MS;
      if (s !== sleeping) {
        sleeping = s;
        setAsleep(s);
      }
      return s;
    };
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
            settle();
          });
    if (svg) io?.observe(svg);
    const unwatch = watchInput(() => sleeping && settle());
    document.addEventListener('visibilitychange', settle);
    const next = () => {
      timer = setTimeout(() => {
        if (!settle() && !svgRef.current?.dataset.tracking) {
          const r = Math.random();
          if (r < 0.3) {
            const count = Math.random() < 0.25 ? 2 : 1;
            setBlink((b) => ({ n: b.n + 1, count }));
            setKick((k) => ({ n: k.n + 1, kind: 'squeeze' }));
          } else if (away && r < 0.6) {
            away = false;
            setGaze({ x: 0, y: 0 });
          } else {
            const a = rand(0, Math.PI * 2);
            const d = rand(0.55, 1);
            away = true;
            setGaze({ x: Math.cos(a) * d, y: Math.sin(a) * d });
            setKick((k) => ({ n: k.n + 1, kind: 'ping' }));
          }
        }
        next();
      }, rand(900, 3800));
    };
    next();
    return () => {
      clearTimeout(timer);
      io?.disconnect();
      unwatch();
      document.removeEventListener('visibilitychange', settle);
    };
  }, []);

  // Drop the kick class once its animation is over, so a re-render cannot replay it.
  useEffect(() => {
    if (!kick.kind) return undefined;
    const t = setTimeout(() => setKick((k) => ({ ...k, kind: '' })), KICK_MS[kick.kind]);
    return () => clearTimeout(t);
  }, [kick.n, kick.kind]);

  const [ax, ay] = GAZE_AMP;
  const stroke = small ? 4.6 : 3.4;
  // A double blink runs the animation twice; the key restarts it each time.
  const blinkStyle = blink.n ? { animation: `sx-echo-blink 170ms ease-in-out ${blink.count}` } : undefined;
  const triangles = (color, width) => (
    <>
      <polygon points={TOP} stroke={color} strokeWidth={width} strokeLinejoin="bevel" />
      <polygon points={BOTTOM} stroke={color} strokeWidth={width} strokeLinejoin="bevel" />
    </>
  );

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 48 48"
      fill="none"
      className={`sx-echo-mark${play ? ' is-play' : ''}${asleep ? ' is-asleep' : ''}${className ? ` ${className}` : ''}`}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      style={{ overflow: 'visible' }}
    >
      <defs>
        {/* Cuts the lines away around the eye, whatever the background. */}
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="-32" y="-32" width="112" height="112">
          <rect x="-32" y="-32" width="112" height="112" fill="#fff" />
          <polygon points={LENS} fill="#000" stroke="#000" strokeWidth="3.2" strokeLinejoin="bevel" />
        </mask>
        <clipPath id={`${id}c`}>
          <polygon points={LENS} />
        </clipPath>
      </defs>
      <g className="sx-echo-body">
        <g mask={`url(#${id}m)`}>
          <g className="sx-echo-ghost">{triangles(RED, 2)}</g>
          {triangles(INK, stroke)}
          {small
            ? null
            : ECHOES.map((e, i) => (
                <g key={e.k} className={`sx-echo-echo${i ? ' sx-echo-echo2' : ''}`} opacity={e.o}>
                  <g
                    className="sx-echo-drift"
                    style={{ transform: `translate(${gaze.x * ax * e.drift}px, ${gaze.y * ay * e.drift * 1.6}px)` }}
                  >
                    <g className="sx-echo-breath">
                      <g key={kick.n} className={`sx-echo-kick${kick.kind ? ` is-${kick.kind}` : ''}`}>
                        <g transform={`translate(24 24) scale(${e.k}) translate(-24 -24)`}>{triangles(INK, e.w / e.k)}</g>
                      </g>
                    </g>
                  </g>
                </g>
              ))}
        </g>
        <g key={blink.n} className="sx-echo-lid" style={blinkStyle}>
          <polygon points={LENS} fill={INK} />
          <g clipPath={`url(#${id}c)`}>
            <g className="sx-echo-gaze" style={{ transform: `translate(${gaze.x * ax}px, ${gaze.y * ay}px)` }}>
              <polygon points={IRIS} fill={RED} />
              <polygon points={PUPIL} fill={DARK} />
              {small ? null : <rect x="25.4" y="20.4" width="1.6" height="1.6" fill={INK} />}
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
