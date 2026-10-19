// Frame director for the vision cut. Maps a frame to the GL stage (world
// layers, door, galaxy, post) and to the state of the DOM phone and headset.
// Every value is a pure function of the frame, so frames render in any order.
import { beat, T } from './timing';
import { clamp01, curve, curve3, ease, elerp, lerp, mix3, pulse, seg } from './anim';
import type { Layer, Portal, Rect, Stage, Vec2, Vec3 } from './gl/GLStage';
import { lookBasis, type GalaxyState } from './gl/galaxy';
import type { WorldName } from './gl/worlds';

export type PhoneState = {
  /** Zoom of the whole phone about the frame centre (1 = resting size). */
  s: number;
  bodyOpacity: number;
  /** Extra scale of the bezel alone as it lifts away. */
  bodyScale: number;
  /** Opacity of the app chrome. */
  ui: number;
  /** Feed position in reels (0 = first reel). */
  p: number;
  /** Ambilight colour (0..255 rgb) and strength. */
  glow: Vec3;
  glowAmt: number;
};

export type GogglesState = {
  /** Screen position of the left lens centre. */
  P: Vec2;
  s: number;
  blur: number;
  opacity: number;
};

export type Shot = { stage: Stage; phone: PhoneState | null; goggles: GogglesState | null };

/** Phone screen rect at rest: 344 x 744 px. */
export const SCREEN: Rect = [960, 540, 172, 372];
export const SCREEN_R = 40;
const FULL: Rect = [960, 540, 960, 540];
const BG: Vec3 = [0.002, 0.0022, 0.0026];
const CELL_H = 2 * SCREEN[3];

/** Headset lens geometry in the headset's own SVG units. */
export const LENS = { cx: 650, cy: 520, dx: 620, r: 250 } as const;

// ---------------------------------------------------------------- vectors
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** Turns v about y the way adding `a` to a camera's yaw does (frag.ts yawTurn). */
const yawTurn = (v: Vec3, a: number): Vec3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c + v[2] * s, v[1], v[2] * c - v[0] * s];
};
/** Forward step of length d for a camera with this yaw. */
const ahead = (yaw: number, d: number): Vec3 => [-Math.sin(yaw) * d, 0, -Math.cos(yaw) * d];

// ---------------------------------------------------------------- feed (0-255)
type Reel = { world: WorldName; pos: (f: number) => Vec3; rot: (f: number) => Vec3; fov: number; t0: number; glow: Vec3 };

/** The five reels of the feed, top to bottom. fov spans the screen height. */
export const REELS: Reel[] = [
  { world: 'ocean', pos: (f) => [0, 2.2, -0.02 * f], rot: () => [-0.11, -0.045, 0], fov: 60, t0: 3, glow: [255, 128, 56] },
  { world: 'dunes', pos: () => [0, 6, 0], rot: (f) => [-0.42 + 0.0008 * (f - 161), 0.1, 0], fov: 62, t0: 2, glow: [214, 92, 44] },
  { world: 'cosmos', pos: () => [0, 0, 0], rot: (f) => [0.4 + 0.0006 * (f - 180), 0.1, 0], fov: 60, t0: 6, glow: [150, 92, 255] },
  { world: 'clouds', pos: (f) => add([0, 85, 0], ahead(1.2, 0.05 * (f - 199))), rot: () => [1.2, -0.22, 0], fov: 60, t0: 4, glow: [176, 206, 255] },
  { world: 'aurora', pos: () => [-4, 3.5, 60], rot: () => [0, 0.06, 0], fov: 41.8, t0: 9, glow: [64, 240, 170] },
];

const S_OPEN = 960 / SCREEN[2]; // the screen spans the frame width
const S_PEAK = 6.2;
const REVEAL_END = T.reveal + 32;
const OPEN_EXPOSURE = 0.6;

/** Phone zoom: a slow push inside the first reel, then the pull back. */
const feedScale = (f: number) =>
  f < T.reveal
    ? S_OPEN * Math.pow(S_PEAK / S_OPEN, f / T.reveal)
    : elerp(S_PEAK, 1, ease.inOutCubic(seg(f, T.reveal, REVEAL_END)));

export const SWIPES = [beat(8), beat(9), beat(10), beat(11)];
const SWIPE_LEN = 13;
const feedP = (f: number) => SWIPES.reduce((p, b) => p + ease.outQuint(seg(f, b, b + SWIPE_LEN)), 0);

const reelLayer = (k: number, f: number, s: number, p: number): Layer | null => {
  const r = REELS[k];
  const half = SCREEN[3] * s;
  const cy = 540 + (k - p) * CELL_H * s;
  const top = Math.max(cy - half, 540 - half);
  // Each reel runs a corner's depth under the next one, so the incoming
  // reel's rounded top corners show this reel rather than a black notch.
  const bot = Math.min(cy + half + SCREEN_R * s, 540 + half);
  if (bot - top < 0.5) return null;
  return {
    world: r.world,
    pos: r.pos(f),
    rot: r.rot(f),
    fov: r.fov,
    time: r.t0 + f / 30,
    anchor: [960, cy, half],
    mask: [960, (top + bot) / 2, SCREEN[2] * s + 1, (bot - top) / 2 + 1],
    radius: SCREEN_R * s,
  };
};

const glowAt = (p: number): Vec3 => {
  const i = Math.min(REELS.length - 2, Math.floor(p));
  return mix3(REELS[i].glow, REELS[i + 1].glow, clamp01(p - i));
};

const feedShot = (f: number): Shot => {
  const s = feedScale(f);
  const p = feedP(f);
  const layers: Layer[] = [];
  REELS.forEach((_, k) => {
    const l = reelLayer(k, f, s, p);
    if (l) layers.push(l);
  });
  return {
    stage: {
      layers,
      bg: BG,
      post: {
        fade: 1 - ease.outCubic(seg(f, 0, 11)),
        zoomBlur: 0.12 * Math.sin(Math.PI * seg(f, T.reveal, REVEAL_END)),
        // The telephoto opening sits inside the sun's glow; exposing down
        // keeps it amber instead of cream, then adapts as the phone appears.
        exposure: lerp(OPEN_EXPOSURE, 1, ease.inOutSine(seg(f, T.reveal, REVEAL_END))),
        sat: lerp(1.12, 1, seg(f, T.reveal, REVEAL_END)),
      },
    },
    phone: {
      s,
      bodyOpacity: 1,
      bodyScale: 1,
      ui: seg(f, 96, 116) * (1 - seg(f, T.stop, T.stop + 10)),
      p,
      glow: glowAt(p),
      glowAmt: ease.inOutSine(seg(f, 100, 124)),
    },
    goggles: null,
  };
};

// ---------------------------------------------------------------- aurora camera (255-550)
const AUR_POS = curve3([
  [T.extend, [-4, 3.5, 60]],
  [T.inside, [-4, 3.55, 58.8]],
  [beat(18), [-4, 3.6, 57]],
  [T.breath, [-4, 4.0, 51]],
  [T.door, [-4, 4.2, 46]],
  [500, [-4, 4.1, 41]],
  [T.through, [-4, 4.0, 34], [0, 0, -0.2]],
  [550, [-4, 4.0, 22], [0, 0, -0.857]],
]);
const AUR_PITCH = curve([
  [348, 0.06],
  [375, 0.1],
  [435, 0.75],
  [475, 0.08],
  [530, 0.03],
]);

const swayAmt = (f: number) => ease.inOutSine(seg(f, T.extend, 340));
const yawSway = (f: number) => swayAmt(f) * 0.02 * Math.sin(f * 0.03);
const rollSway = (f: number) => swayAmt(f) * 0.01 * Math.sin(f * 0.021);

const auroraLayer = (f: number, anchor: Vec3 = [960, 540, 540], fov = 58): Layer => ({
  world: 'aurora',
  pos: AUR_POS(f),
  rot: [yawSway(f), AUR_PITCH(f), rollSway(f)],
  fov,
  time: 9 + f / 30,
  anchor,
  mask: FULL,
});

// ---------------------------------------------------------------- extend (255-311)
const FRONT_HW = curve([
  [T.extend, 172],
  [262, 260],
  [290, 1050],
  [305, 1400],
]);

const extendShot = (f: number): Shot => {
  const hw = FRONT_HW(f);
  const hh = 372 + ((hw - 172) * 608) / 1228;
  const lift = seg(f, T.extend, T.extend + 17);
  return {
    stage: {
      // Same view as the aurora reel: fov 41.8 over the 744 px screen.
      layers: [{ ...auroraLayer(f, [960, 540, 372], 41.8), extend: { src: [960, 540, 159, 359], front: [960, 540, hw, hh] } }],
      bg: BG,
    },
    phone: {
      s: 1,
      bodyOpacity: 1 - ease.inOutSine(lift),
      bodyScale: lerp(1, 1.06, ease.outCubic(lift)),
      ui: 0,
      p: REELS.length - 1,
      glow: REELS[REELS.length - 1].glow,
      glowAmt: 1 - lift,
    },
    goggles: null,
  };
};

// ---------------------------------------------------------------- headset (311-349)
const gogglesShot = (f: number): Shot => {
  const slide = ease.outQuint(seg(f, T.inside, T.inside + 11));
  const pushT = seg(f, beat(17), beat(18));
  const push = ease.inOutCubic(pushT);
  const P: Vec2 = [lerp(LENS.cx, 960, push), lerp(LENS.cy, 540, push) + 900 * (1 - slide)];
  const s = elerp(1, 5.2, push);
  const r = LENS.r * s;
  // A lens shows a fixed ~106 degree cone, so it matches the full-frame view
  // exactly once r reaches 1300 px.
  const lens = (cx: number, cy: number): Layer => ({
    ...auroraLayer(f, [cx, cy, (540 * r) / 1300]),
    mask: [cx, cy, r + 2, r + 2],
    radius: r + 2,
  });
  const layers: Layer[] = [
    { ...auroraLayer(f), alpha: lerp(1, 0.3, ease.outCubic(seg(f, T.inside, T.inside + 11))) },
    lens(P[0], P[1]),
  ];
  const rx = P[0] + LENS.dx * s;
  if (rx - r < 1920) layers.push(lens(rx, P[1]));
  return {
    stage: {
      layers,
      bg: BG,
      post: { zoomBlur: 0.1 * Math.sin(Math.PI * pushT), zoomCenter: [P[0] / 1920, 1 - P[1] / 1080] },
    },
    phone: null,
    goggles: { P, s, blur: 24 * push, opacity: 1 },
  };
};

// ---------------------------------------------------------------- aurora + door (349-550)
const DOOR_UP = T.door + 13;

const doorPortal = (f: number): Portal | null => {
  if (f < T.door) return null;
  // A line of light rises out of the lake, then opens sideways into a door.
  const v = Math.max(0.02, 6.4 * ease.outCubic(seg(f, T.door, DOOR_UP)));
  const hw = lerp(0.04, 3.6, ease.outQuart(seg(f, DOOR_UP, 492)));
  return {
    layer: 0,
    c: [-4, v, 22],
    u: [hw, 0, 0],
    v: [0, v, 0],
    world: 'ocean',
    // The door centre always lands at [0, 5.1, -38] in the ocean.
    off: [4, 5.1 - v, -60],
    yaw: 0.3,
    time: 3 + f / 30,
    glow: seg(f, T.door, T.door + 3) * (1 + 0.3 * pulse(f, DOOR_UP, 6)),
  };
};

const FLIGHT = 550; // the camera crosses the door plane

const auroraShot = (f: number): Shot => ({
  stage: {
    layers: [auroraLayer(f)],
    portal: doorPortal(f),
    bg: BG,
    post: { zoomBlur: 0.12 * ease.inCubic(seg(f, T.through, FLIGHT)) },
  },
  phone: null,
  goggles: null,
});

// ---------------------------------------------------------------- flight (550-649)
const flightYaw = (f: number) => (0.3 + yawSway(FLIGHT)) * (1 - ease.inOutSine(seg(f, FLIGHT, 600)));
const SPEED_CRUISE = curve([
  [FLIGHT, 0.86],
  [590, 0.35],
]);
const flightSpeed = (f: number) => (f < T.rush ? SPEED_CRUISE(f) : 0.35 + 2.65 * ease.inCubic(seg(f, T.rush, T.drop)));
const flightY = (f: number) => lerp(2.7, 1.8, ease.inOutSine(seg(f, FLIGHT, 600)));

// Flight path in ocean coordinates, integrated once at quarter-frame steps.
const STEP = 0.25;
const PATH: Vec3[] = (() => {
  const out: Vec3[] = [];
  let x = 0;
  let z = -38;
  for (let f = FLIGHT; f <= T.drop + 2; f += STEP) {
    out.push([x, flightY(f), z]);
    const d = ahead(flightYaw(f + STEP / 2), flightSpeed(f + STEP / 2) * STEP);
    x += d[0];
    z += d[2];
  }
  return out;
})();

const flightPos = (f: number): Vec3 => {
  const i = (f - FLIGHT) / STEP;
  const i0 = Math.max(0, Math.min(PATH.length - 2, Math.floor(i)));
  return mix3(PATH[i0], PATH[i0 + 1], clamp01(i - i0));
};

/** Rush doors: crossing frame, destination world and where/how it lands. */
export const HOPS = [
  { fc: beat(32.5), world: 'dunes' as WorldName, dest: [0, 8, 0] as Vec3, yaw: -0.4, t0: 2, lead: 14 },
  { fc: beat(33), world: 'clouds' as WorldName, dest: [0, 80, 0] as Vec3, yaw: 1.2, t0: 4, lead: 9 },
  { fc: beat(33.5), world: 'cosmos' as WorldName, dest: [0, 0, 0] as Vec3, yaw: 0.4, t0: 6, lead: 9 },
];

// Leg k maps flight coordinates X into its world: dest + yawTurn(X - at, turn).
type Leg = { world: WorldName; t0: number; dest: Vec3; at: Vec3; turn: number };
const LEGS: Leg[] = [
  { world: 'ocean', t0: 3, dest: [0, 0, 0], at: [0, 0, 0], turn: 0 },
  ...HOPS.map((h) => ({ world: h.world, t0: h.t0, dest: h.dest, at: flightPos(h.fc), turn: h.yaw - flightYaw(h.fc) })),
];
const toLeg = (k: number, X: Vec3) => add(LEGS[k].dest, yawTurn(sub(X, LEGS[k].at), LEGS[k].turn));
const fromLeg = (k: number, Y: Vec3) => add(LEGS[k].at, yawTurn(sub(Y, LEGS[k].dest), -LEGS[k].turn));

const FLIGHT_PITCH = curve([
  [FLIGHT, 0.03],
  [T.rush, 0.03],
  [HOPS[0].fc, 0.05],
  [HOPS[1].fc, -0.12],
  [HOPS[2].fc, 0.08],
]);

const flightShot = (f: number): Shot => {
  const k = HOPS.filter((h) => f >= h.fc).length;
  const leg = LEGS[k];
  const dyaw = flightYaw(f + 0.5) - flightYaw(f - 0.5);
  const cam: Layer = {
    world: leg.world,
    pos: toLeg(k, flightPos(f)),
    rot: [flightYaw(f) + leg.turn, FLIGHT_PITCH(f), 12 * dyaw + rollSway(f)],
    fov: 58,
    time: leg.t0 + f / 30,
    anchor: [960, 540, 540],
    mask: FULL,
  };
  let portal: Portal | null = null;
  const next = HOPS[k];
  if (next && f >= next.fc - next.lead) {
    // The door stands half a frame before the crossing and maps its world
    // rigidly onto the next one, so the hand-over is seamless.
    const a = next.fc - next.lead;
    const size = 0.2 + 0.8 * ease.outBack(seg(f, a, a + 4));
    const C = add(toLeg(k, flightPos(next.fc - 0.5)), [0, 0.25, 0]);
    const head = flightYaw(next.fc - 0.5) + leg.turn;
    const landing = toLeg(k + 1, fromLeg(k, C));
    portal = {
      layer: 0,
      c: C,
      u: [Math.cos(head) * 0.9 * size, 0, -Math.sin(head) * 0.9 * size],
      v: [0, 1.6 * size, 0],
      world: next.world,
      off: sub(landing, C),
      yaw: LEGS[k + 1].turn - leg.turn,
      time: next.t0 + f / 30,
      glow: seg(f, a, a + 3),
    };
  }
  const rush = ease.inCubic(seg(f, T.rush, T.drop));
  return {
    stage: {
      layers: [cam],
      portal,
      bg: BG,
      post: {
        zoomBlur: Math.max(0.12 * (1 - ease.outCubic(seg(f, FLIGHT, 570))), 0.35 * rush),
        aberr: 10 * rush,
        flash: HOPS.reduce((acc, h) => acc + 0.25 * pulse(f, h.fc, 2), 0),
      },
    },
    phone: null,
    goggles: null,
  };
};

// ---------------------------------------------------------------- galaxy + end (649-900)
const CLAPS = [T.hit1, T.hit2, T.hit3];
export const END_CARD = 800;

const galaxyCam = (f: number): GalaxyState['cam'] => {
  if (f < T.hit1) {
    const t = ease.outCubic(seg(f, T.drop, T.hit1));
    return { pos: mix3([0, 70, 190], [0, 62, 170], t), target: [0, 0, 0], fov: 50 };
  }
  if (f < T.hit2) {
    const t = ease.inOutSine(seg(f, T.hit1, T.hit2));
    return { pos: mix3([60, 3, 95], [48, 4, 80], t), target: [0, 2, 0], fov: 55 };
  }
  if (f < T.hit3) {
    return { pos: [0, 220, 1], target: [0, 0, 0], fov: 50, roll: 0.4 * ease.inOutSine(seg(f, T.hit2, T.hit3)) };
  }
  if (f < T.end) {
    const t = ease.inOutCubic(seg(f, T.hit3, T.end));
    return { pos: mix3([30, 40, 120], [5, 6, 25], t), target: [0, 0, 0], fov: lerp(50, 60, t) };
  }
  if (f < END_CARD) {
    const t = ease.outCubic(seg(f, T.end, END_CARD));
    return { pos: mix3([5, 6, 25], [0, 25, 150], t), target: [0, 0, 0], fov: lerp(60, 50, t) };
  }
  return { pos: mix3([0, 25, 150], [0, 21, 132], ease.outCubic(seg(f, END_CARD, 900))), target: [0, 0, 0], fov: 50 };
};

const galaxyBurst = (f: number) => {
  if (f < T.hit1) return 0.45 * ease.outQuart(seg(f, T.drop, T.hit1));
  if (f < T.hit2) return lerp(0.45, 0.9, ease.outCubic(seg(f, T.hit1, T.hit2)));
  if (f < T.hit3) return lerp(0.9, 0.96, seg(f, T.hit2, T.hit3));
  if (f < T.end) return lerp(0.96, 1, seg(f, T.hit3, T.end));
  return 1 - ease.inCubic(seg(f, T.end, END_CARD));
};

const galaxyCore = (f: number) => {
  if (f < T.hit1) return lerp(1.5, 1, ease.outCubic(seg(f, T.drop, T.hit1)));
  if (f < T.end) return 1;
  if (f < END_CARD) return lerp(1, 5, ease.inCubic(seg(f, T.end, END_CARD)));
  return lerp(5, 0.9, ease.outCubic(seg(f, END_CARD, END_CARD + 12)));
};

const galaxyRing = (f: number): [number, number] => {
  if (f < T.hit1) {
    const t = seg(f, T.drop, T.hit1);
    return [120 * ease.outCubic(t), 1 - t];
  }
  if (f >= END_CARD && f < END_CARD + 40) {
    const t = seg(f, END_CARD, END_CARD + 40);
    return [150 * ease.outCubic(t), 1 - t];
  }
  return [0, 0];
};

/** Fade to black over the last bars; the audio uses the same curve. */
export const outroFade = (f: number) => ease.inOutSine(seg(f, T.fade, 900));

const galaxyShot = (f: number): Shot => {
  const cam = galaxyCam(f);
  const roll = cam.roll ?? 0;
  const B = lookBasis(cam.pos, cam.target, roll);
  const kick = CLAPS.reduce((acc, c) => acc + pulse(f, c, 5), 0);
  const drop = 1 - seg(f, T.drop, T.drop + 10);
  const endFlash = f >= END_CARD ? 0.6 * Math.pow(1 - seg(f, END_CARD, END_CARD + 8), 2) : 0;
  return {
    stage: {
      layers: [
        {
          world: 'cosmos',
          pos: [0, 0, 0],
          rot: [B.yaw, B.pitch, roll],
          fov: cam.fov,
          time: 6 + f / 30,
          anchor: [960, 540, 540],
          mask: FULL,
          alpha: f >= END_CARD ? 0.35 : 0.6,
        },
      ],
      bg: [0.004, 0.006, 0.012],
      galaxy: {
        cam,
        burst: galaxyBurst(f),
        spin: 0.0028 * (f - T.drop),
        pulse: CLAPS.reduce((acc, c) => acc + pulse(f, c, 6), 0),
        opacity: 1,
        core: galaxyCore(f),
        ring: galaxyRing(f),
      },
      post: {
        flash: drop * drop + endFlash,
        zoomBlur: 0.15 * kick,
        aberr: 8 * kick,
        fade: outroFade(f),
      },
    },
    phone: null,
    goggles: null,
  };
};

// ---------------------------------------------------------------- entry
export const direct = (f: number): Shot => {
  if (f < T.extend) return feedShot(f);
  if (f < T.inside) return extendShot(f);
  if (f < beat(18)) return gogglesShot(f);
  if (f < FLIGHT) return auroraShot(f);
  if (f < T.drop) return flightShot(f);
  return galaxyShot(f);
};
