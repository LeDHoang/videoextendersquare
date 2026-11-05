import { useEffect, useRef } from 'react';

/*
 * Sonar maze behind the auth rail's copy. A hidden maze fills 75% of the rail; sonar pings
 * (from the cursor, clicks, and at random) run as a small wave simulation, bounce off the
 * maze walls and the rail edges, and briefly light up the walls they hit. A new maze is
 * built on every mount and resize. On phones the rail is a short strip, so the maze is small.
 */

const RAMP = ' .·:-=+*#%@';
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

const DX = 4; // simulation cell size in px
const C2 = 0.25; // (wave speed * dt / dx)^2, stable below 0.5
const STEPS_PER_SEC = 150; // wave speed = 0.5 * 4px * 150 = 300 px/s
const DAMP = 0.994; // per step; echoes fade over ~1-2 s
const GAIN = 6; // a ping of strength 1 peaks near |u| = 0.2, i.e. full brightness
const NOISE_FLOOR = 0.03; // hides the faint ripples left behind each front
const WALL_FADE = 0.965; // per frame; a lit wall fades out over ~1 s
const TEXT_DIM = 0.22; // waves and walls behind the copy
const MAZE_AREA = 0.75;
const PING_AREA = 90000; // px² of rail per simultaneous random ping
const LEFT = 1, RIGHT = 2, UP = 4, DOWN = 8, OUTER = 16;

const parseColor = (value, fallback) => {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const rgb = value.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  return rgb ? rgb.slice(1, 4).map(Number) : fallback;
};

export function SonarMaze() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const rail = canvas?.parentElement;
    const ctx = canvas?.getContext?.('2d');
    if (!rail || !ctx) return undefined;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const s = { m: null, click: null, lastPing: 0, nextRandom: 0, u: null, ink: [245, 241, 232], acc: [255, 59, 31] };

    function readColors() {
      const css = getComputedStyle(rail);
      s.ink = parseColor(css.getPropertyValue('--sx-ink'), s.ink);
      s.acc = parseColor(css.getPropertyValue('--sx-accent'), s.acc);
    }

    function buildMaze() {
      const k = Math.sqrt(MAZE_AREA);
      const mw = s.w * k, mh = s.h * k, ox = (s.w - mw) / 2, oy = (s.h - mh) / 2;
      // 64px cells on the desktop rail, down to 32px in the short phone strip
      const cell = clamp(s.h / 5, 32, 64);
      const mc = Math.max(3, Math.round(mw / cell)), mr = Math.max(3, Math.round(mh / cell));
      // wall lines snap to character-cell centres so drawn walls sit exactly where waves reflect
      const snapX = (x) => (Math.round(x / s.cw - 0.5) + 0.5) * s.cw;
      const snapY = (y) => (Math.round(y / s.ch - 0.5) + 0.5) * s.ch;
      const xs = Array.from({ length: mc + 1 }, (_, i) => snapX(ox + (i * mw) / mc));
      const ys = Array.from({ length: mr + 1 }, (_, j) => snapY(oy + (j * mh) / mr));

      // recursive backtracker
      const right = [...Array(mr)].map(() => Array(mc).fill(true));
      const bottom = [...Array(mr)].map(() => Array(mc).fill(true));
      const seen = [...Array(mr)].map(() => Array(mc).fill(false));
      const stack = [[(Math.random() * mc) | 0, (Math.random() * mr) | 0]];
      seen[stack[0][1]][stack[0][0]] = true;
      while (stack.length) {
        const [i, j] = stack[stack.length - 1];
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .map(([di, dj]) => [i + di, j + dj, di, dj])
          .filter(([a, b]) => a >= 0 && b >= 0 && a < mc && b < mr && !seen[b][a]);
        if (!nb.length) { stack.pop(); continue; }
        const [a, b, di, dj] = nb[(Math.random() * nb.length) | 0];
        if (di === 1) right[j][i] = false;
        if (di === -1) right[j][a] = false;
        if (dj === 1) bottom[j][i] = false;
        if (dj === -1) bottom[b][i] = false;
        seen[b][a] = true;
        stack.push([a, b]);
      }

      const segs = [], entry = (Math.random() * mc) | 0, exit = (Math.random() * mc) | 0;
      for (let i = 0; i < mc; i++) {
        if (i !== entry) segs.push([xs[i], ys[0], xs[i + 1], ys[0], true]);
        if (i !== exit) segs.push([xs[i], ys[mr], xs[i + 1], ys[mr], true]);
      }
      for (let j = 0; j < mr; j++) {
        segs.push([xs[0], ys[j], xs[0], ys[j + 1], true]);
        segs.push([xs[mc], ys[j], xs[mc], ys[j + 1], true]);
      }
      for (let j = 0; j < mr; j++) for (let i = 0; i < mc; i++) {
        if (i < mc - 1 && right[j][i]) segs.push([xs[i + 1], ys[j], xs[i + 1], ys[j + 1]]);
        if (j < mr - 1 && bottom[j][i]) segs.push([xs[i], ys[j + 1], xs[i + 1], ys[j + 1]]);
      }

      // rasterise: simulation wall mask + per-cell wall pieces (which edges the line runs to)
      s.wall = new Uint8Array(s.nx * s.ny);
      s.piece = new Uint8Array(s.cols * s.rows);
      s.glow = new Float32Array(s.cols * s.rows); // how recently an echo lit this wall cell
      const col = (x) => Math.round(x / s.cw - 0.5), row = (y) => Math.round(y / s.ch - 0.5);
      for (const [x0, y0, x1, y1, outer] of segs) {
        const o = outer ? OUTER : 0;
        if (y0 === y1) {
          const gy = Math.floor(y0 / DX);
          for (let gx = Math.floor(x0 / DX); gx <= Math.floor(x1 / DX); gx++) s.wall[gy * s.nx + gx] = 1;
          const r = row(y0), c0 = col(x0), c1 = col(x1);
          for (let c = c0; c <= c1; c++) s.piece[r * s.cols + c] |= (c > c0 ? LEFT : 0) | (c < c1 ? RIGHT : 0) | o;
        } else {
          const gx = Math.floor(x0 / DX);
          for (let gy = Math.floor(y0 / DX); gy <= Math.floor(y1 / DX); gy++) s.wall[gy * s.nx + gx] = 1;
          const c = col(x0), r0 = row(y0), r1 = row(y1);
          for (let r = r0; r <= r1; r++) s.piece[r * s.cols + c] |= (r > r0 ? UP : 0) | (r < r1 ? DOWN : 0) | o;
        }
      }
      if (reduced) s.glow.fill(0.35); // no pings under reduced motion, so show the maze faintly
      s.maze = { x0: xs[0], y0: ys[0], x1: xs[mc], y1: ys[mr] };
    }

    function ping(x, y, amp) {
      const gx = x / DX, gy = y / DX, sig = 1.8, R = 6;
      for (let j = Math.max(1, Math.floor(gy - R)); j <= Math.min(s.ny - 2, gy + R); j++)
        for (let i = Math.max(1, Math.floor(gx - R)); i <= Math.min(s.nx - 2, gx + R); i++) {
          const n = j * s.nx + i;
          if (s.wall[n]) continue;
          const g = amp * Math.exp(-((i - gx) ** 2 + (j - gy) ** 2) / (2 * sig * sig));
          s.u[n] += g;
          s.p[n] += g; // equal current/previous = zero velocity, so it spreads as a ring
        }
    }

    function step() {
      const { nx, ny, wall } = s, u = s.u, p = s.p;
      for (let y = 1; y < ny - 1; y++) {
        let i = y * nx + 1;
        for (let x = 1; x < nx - 1; x++, i++) {
          if (wall[i]) { p[i] = 0; continue; }
          p[i] = (2 * u[i] - p[i] + C2 * (u[i - 1] + u[i + 1] + u[i - nx] + u[i + nx] - 4 * u[i])) * DAMP;
        }
      }
      s.u = p; // edge cells stay 0, so the rail border reflects too
      s.p = u;
    }

    function layout() {
      const w = rail.clientWidth, h = rail.clientHeight;
      if (!canvas.offsetParent || !w || !h) { s.u = null; return; } // not laid out
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const mono = getComputedStyle(rail).getPropertyValue('--sx-font-mono').trim() || 'monospace';
      ctx.font = `500 12px ${mono}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      s.w = w; s.h = h; s.cw = ctx.measureText('M').width || 7.2; s.ch = 16;
      s.cols = Math.ceil(w / s.cw); s.rows = Math.ceil(h / s.ch);
      s.nx = Math.ceil(w / DX) + 1; s.ny = Math.ceil(h / DX) + 1;
      s.u = new Float32Array(s.nx * s.ny);
      s.p = new Float32Array(s.nx * s.ny);
      readColors();
      buildMaze();

      // text keep-out: dim everything under the rail's copy
      s.dim = new Float32Array(s.cols * s.rows).fill(1);
      const base = rail.getBoundingClientRect(), walker = document.createTreeWalker(rail, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode());) {
        if (!n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const b of range.getClientRects()) {
          const c0 = Math.floor((b.left - base.left - 6) / s.cw), c1 = Math.ceil((b.right - base.left + 6) / s.cw);
          const r0 = Math.floor((b.top - base.top - 2) / s.ch), r1 = Math.ceil((b.bottom - base.top + 2) / s.ch);
          for (let r = Math.max(0, r0); r < Math.min(s.rows, r1); r++)
            for (let c = Math.max(0, c0); c < Math.min(s.cols, c1); c++) s.dim[r * s.cols + c] = TEXT_DIM;
        }
      }
      if (reduced) draw();
    }

    function drawWall(g, x, y, hw, hh) {
      ctx.lineWidth = g & OUTER ? 4 : 3;
      ctx.beginPath();
      if (g & LEFT) { ctx.moveTo(x, y); ctx.lineTo(x - hw, y); }
      if (g & RIGHT) { ctx.moveTo(x, y); ctx.lineTo(x + hw, y); }
      if (g & UP) { ctx.moveTo(x, y); ctx.lineTo(x, y - hh); }
      if (g & DOWN) { ctx.moveTo(x, y); ctx.lineTo(x, y + hh); }
      ctx.stroke();
    }

    const mix = (k) => s.ink.map((x, n) => Math.round(x + (s.acc[n] - x) * k));

    function draw() {
      ctx.lineCap = 'square';
      ctx.clearRect(0, 0, s.w, s.h);
      const { nx, cw, ch, cols, rows } = s, u = s.u;
      for (let r = 0; r < rows; r++) {
        const gy0 = Math.floor((r * ch) / DX), gy1 = Math.min(s.ny - 1, Math.floor(((r + 1) * ch - 1) / DX));
        for (let c = 0; c < cols; c++) {
          const gx0 = Math.floor((c * cw) / DX), gx1 = Math.min(nx - 1, Math.floor(((c + 1) * cw - 1) / DX));
          let a = 0;
          for (let gy = gy0; gy <= gy1; gy++)
            for (let gx = gx0; gx <= gx1; gx++) { const v = Math.abs(u[gy * nx + gx]); if (v > a) a = v; }
          const v = clamp((a - NOISE_FLOOR) * GAIN), i = r * cols + c, g = s.piece[i];
          if (g) {
            // hidden until an echo reaches it, then fades back out
            const gl = (s.glow[i] = Math.max(s.glow[i] * WALL_FADE, v));
            const alpha = clamp(gl * 1.2) * s.dim[i];
            if (alpha < 0.02) continue;
            const cc = mix(clamp((gl - 0.35) * 1.6));
            ctx.strokeStyle = `rgba(${cc[0]},${cc[1]},${cc[2]},${alpha.toFixed(3)})`;
            drawWall(g, (c + 0.5) * cw, (r + 0.5) * ch, cw / 2, ch / 2);
            continue;
          }
          if (v <= 0.12) continue;
          const chr = RAMP[Math.round(clamp(0.2 + v * 0.8) * (RAMP.length - 1))];
          const cc = mix(clamp((v - 0.45) * 2));
          ctx.fillStyle = `rgba(${cc[0]},${cc[1]},${cc[2]},${(clamp(0.2 + v * 0.7) * s.dim[i]).toFixed(3)})`;
          ctx.fillText(chr, (c + 0.5) * cw, (r + 0.5) * ch);
        }
      }
    }

    let raf = 0, last = 0, acc = 0, visible = true, lastColors = 0;
    function frame(ms) {
      const t = ms / 1000, dt = Math.min(0.05, t - (last || t));
      last = t;
      if (visible && s.u) {
        if (t - lastColors > 0.5) { readColors(); lastColors = t; } // follows theme switches
        if (s.m && t - s.lastPing > 0.64) { ping(s.m.x, s.m.y, 0.7); s.lastPing = t; }
        if (s.click) { ping(s.click.x, s.click.y, 1.6); s.click = null; }
        if (t > s.nextRandom) {
          // several pings at once, one per ~90,000px² of rail (3 on desktop, 1 on a phone strip)
          const { x0, y0, x1, y1 } = s.maze;
          const count = Math.max(1, Math.round((s.w * s.h) / PING_AREA));
          for (let n = 0; n < count; n++) ping(x0 + Math.random() * (x1 - x0), y0 + Math.random() * (y1 - y0), 2.2);
          s.nextRandom = t + 1.5 + Math.random() * 2;
        }
        acc += dt * STEPS_PER_SEC;
        while (acc >= 1) { step(); acc -= 1; }
        draw();
      }
      raf = requestAnimationFrame(frame);
    }

    const pos = (e) => { const b = rail.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
    const onMove = (e) => { s.m = pos(e); };
    const onLeave = () => { s.m = null; };
    const onDown = (e) => { s.click = pos(e); };
    rail.addEventListener('pointermove', onMove);
    rail.addEventListener('pointerleave', onLeave);
    rail.addEventListener('pointerdown', onDown);

    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([en]) => { visible = en.isIntersecting; })
      : null;
    io?.observe(rail);
    let resizeTimer = 0;
    const ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 120); })
      : null;
    ro?.observe(rail);

    let cancelled = false;
    (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (cancelled) return;
      layout();
      if (!reduced) raf = requestAnimationFrame(frame);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      io?.disconnect();
      ro?.disconnect();
      rail.removeEventListener('pointermove', onMove);
      rail.removeEventListener('pointerleave', onLeave);
      rail.removeEventListener('pointerdown', onDown);
    };
  }, []);

  return <canvas ref={canvasRef} className="sx-au-sonar" aria-hidden="true" />;
}
