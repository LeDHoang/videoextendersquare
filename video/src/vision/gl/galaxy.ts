// "Galaxy of reels": hundreds of 9:16 cards in a spiral galaxy, each a
// window into one of the procedural worlds. Worlds are baked once per
// context into an HDR equirect texture array, then sampled per card.
import { drawSceneTo, link, type GLCtx, type Vec3 } from './GLStage';
import type { WorldName } from './worlds';

export type GalaxyState = {
  cam: { pos: Vec3; target: Vec3; fov: number; roll?: number };
  /** 0..1: cards fly out from the core to their orbits. */
  burst: number;
  /** Galactic rotation, radians at the reference radius. */
  spin: number;
  /** 0..1 extra rim brightness (clap hits). */
  pulse: number;
  opacity: number;
  /** Core glow intensity. */
  core: number;
  /** Shockwave ring radius in world units (0 = off) and its strength. */
  ring: [number, number];
};

type Pano = { world: WorldName; pos: Vec3; yaw: number; time: number; hero: number; pitch: number };

// hero = yaw (radians) of the most striking direction; cards look around it.
const PANOS: Pano[] = [
  { world: 'ocean', pos: [0, 2.2, 0], yaw: 0, time: 3, hero: 0, pitch: 0.02 },
  { world: 'aurora', pos: [-4, 3.5, 60], yaw: 0, time: 9, hero: 0, pitch: 0.12 },
  { world: 'dunes', pos: [0, 6, 0], yaw: 0, time: 2, hero: -0.55, pitch: 0.12 },
  { world: 'clouds', pos: [0, 85, 0], yaw: 0, time: 4, hero: 1.2, pitch: -0.22 },
  { world: 'cosmos', pos: [0, 0, 0], yaw: 0, time: 6, hero: 0.4, pitch: 0.1 },
  { world: 'dunes', pos: [40, 4.5, -30], yaw: 0, time: 5, hero: 0.35, pitch: 0.22 },
];

const PANO_W = 1536;
const PANO_H = 768;
const CARD_N = 560;
const FLOATS = 12; // center3 half2 param4 misc3

const CARD_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aCenter;
layout(location = 2) in vec2 aHalf;
layout(location = 3) in vec4 aParam;  // pano layer, view yaw, roll, card yaw
layout(location = 4) in vec3 aMisc;   // alpha, gain, view pitch
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform vec3 uCamUp;
uniform int uKind;  // 0 card, 1 core glow billboard, 2 ring in the galaxy plane
out vec2 vLocal;
out vec2 vHalf;
out vec4 vParam;
out vec3 vMisc;
out vec2 vPar;
void main() {
  vec3 toCam = normalize(uCamPos - aCenter);
  vec3 right = normalize(cross(uCamUp, toCam));
  vec3 up = cross(toCam, right);
  vec3 r2, u2;
  vec2 m;
  if (uKind == 2) {
    r2 = vec3(1.0, 0.0, 0.0);
    u2 = vec3(0.0, 0.0, 1.0);
    m = aHalf;
  } else {
    float cy = cos(aParam.w), sy = sin(aParam.w);
    vec3 rr = right * cy + toCam * sy;
    float cr = cos(aParam.z), sr = sin(aParam.z);
    r2 = rr * cr + up * sr;
    u2 = up * cr - rr * sr;
    m = uKind == 0 ? aHalf + vec2(0.9 * aHalf.x) : aHalf;
  }
  vec2 lp = aCorner * m;
  vec3 wp = aCenter + r2 * lp.x + u2 * lp.y;
  vLocal = lp;
  vHalf = aHalf;
  vParam = aParam;
  vMisc = aMisc;
  // parallax: where the camera sits relative to the card face
  vPar = vec2(dot(-toCam, r2), dot(-toCam, u2));
  gl_Position = uViewProj * vec4(wp, 1.0);
}`;

const CARD_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
in vec2 vLocal;
in vec2 vHalf;
in vec4 vParam;
in vec3 vMisc;
in vec2 vPar;
uniform sampler2DArray uPanos;
uniform int uKind;
uniform float uPulse;
uniform float uOpacity;
uniform vec2 uRing;
out vec4 outColor;
const vec3 ORANGE = vec3(1.0, 0.231, 0.122);
float sdRound(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
void main() {
  if (uKind == 1) {
    float r = length(vLocal) / vHalf.x;
    // small hot centre, warm bulge, faint violet haze; windowed to zero
    // well inside the quad so its edge never shows
    vec3 g = vec3(1.0, 0.8, 0.62) * exp(-r * r * 60.0) * 2.4 + ORANGE * exp(-r * 6.0) * 0.9
           + vec3(0.45, 0.38, 1.0) * exp(-r * 2.6) * 0.18;
    g *= 1.0 - smoothstep(0.55, 1.0, r);
    outColor = vec4(g * vMisc.y * uOpacity, 0.0);
    return;
  }
  if (uKind == 2) {
    float r = length(vLocal);
    float w = 1.5 + uRing.x * 0.06;
    float band = exp(-pow((r - uRing.x) / w, 2.0));
    vec3 g = mix(ORANGE, vec3(1.0, 0.8, 0.7), band) * band * uRing.y * 2.5;
    outColor = vec4(g * uOpacity, 0.0);
    return;
  }
  float rad = 0.09 * vHalf.x;
  float d = sdRound(vLocal, vHalf, rad);
  float aa = max(fwidth(d), 1e-4);
  float inside = clamp(0.5 - d / aa, 0.0, 1.0);
  float alpha = vMisc.x * uOpacity;
  // window into the baked world: fixed reel framing plus a little parallax
  vec2 lu = vLocal / vHalf;
  vec3 dir = normalize(vec3(lu.x * 0.43 + vPar.x * 0.35, lu.y * 0.76 + vPar.y * 0.25, -1.0));
  // same yaw/pitch convention as camBasis: positive pitch looks up, yaw 0 looks down -z
  float cp = cos(vMisc.z), sp = sin(vMisc.z);
  dir.yz = vec2(cp * dir.y - sp * dir.z, sp * dir.y + cp * dir.z);
  float cy = cos(vParam.y), sy = sin(vParam.y);
  dir.xz = vec2(cy * dir.x + sy * dir.z, -sy * dir.x + cy * dir.z);
  vec2 uv = vec2(atan(dir.x, -dir.z) / 6.2831853 + 0.5, asin(clamp(dir.y, -1.0, 1.0)) / 3.1415927 + 0.5);
  vec3 img = texture(uPanos, vec3(uv, vParam.x)).rgb * vMisc.y;
  float edge = exp(-abs(d) / (0.035 * vHalf.x + aa));
  float halo = exp(-max(d, 0.0) / (0.35 * vHalf.x)) * step(0.0, d);
  vec3 rim = vec3(1.0, 0.86, 0.78) * edge * (0.9 + 2.5 * uPulse) + ORANGE * halo * (0.25 + 0.9 * uPulse);
  vec3 col = img * inside + rim * vMisc.y;
  outColor = vec4(col * alpha, inside * alpha);
}`;

export type Galaxy = {
  prog: WebGLProgram;
  vao: WebGLVertexArrayObject;
  inst: WebGLBuffer;
  spriteBuf: WebGLBuffer;
  spriteVao: WebGLVertexArrayObject;
  panos: WebGLTexture;
  cards: Card[];
  data: Float32Array;
  loc: Map<string, WebGLUniformLocation | null>;
};

type Card = {
  r: number;
  theta: number;
  y: number;
  hh: number;
  pano: number;
  yaw: number;
  pitch: number;
  roll: number;
  swing: number;
  phase: number;
  delay: number;
  halo: boolean;
  dir: Vec3;
};

const mulberry = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const makeCards = (): Card[] => {
  const rnd = mulberry(20261018);
  const gauss = () => {
    let s = 0;
    for (let k = 0; k < 4; k++) s += rnd();
    return (s - 2) / 0.577;
  };
  const cards: Card[] = [];
  for (let i = 0; i < CARD_N; i++) {
    const halo = i % 9 === 0;
    const t = Math.pow(rnd(), 0.75);
    const r = halo ? 30 + rnd() * 150 : 7 + t * 120;
    const arm = i % 3;
    const theta = halo ? rnd() * Math.PI * 2 : (arm * Math.PI * 2) / 3 + Math.log(r / 7) * 1.35 + gauss() * 0.28;
    const y = halo ? (rnd() - 0.5) * 120 : gauss() * (3 * Math.exp(-r / 35) + 0.9);
    const pano = Math.floor(rnd() * PANOS.length);
    const p = PANOS[pano];
    const u = rnd() * 2 - 1;
    const a = rnd() * Math.PI * 2;
    cards.push({
      r,
      theta,
      y,
      hh: 1.5 + rnd() * 1.4 + (r > 90 ? 0.8 : 0),
      pano,
      yaw: p.hero + (rnd() - 0.5) * 1.1,
      pitch: p.pitch + (rnd() - 0.5) * 0.15,
      roll: (rnd() - 0.5) * 0.35,
      swing: 0.15 + rnd() * 0.45,
      phase: rnd() * Math.PI * 2,
      delay: Math.min(0.55, r / 260 + rnd() * 0.08),
      halo,
      dir: [Math.sqrt(1 - u * u) * Math.cos(a), u, Math.sqrt(1 - u * u) * Math.sin(a)],
    });
  }
  return cards;
};

const bake = (c: GLCtx, tex: WebGLTexture) => {
  const { gl } = c;
  const fbo = gl.createFramebuffer()!;
  const t0 = performance.now();
  PANOS.forEach((p, i) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, i);
    drawSceneTo(
      c,
      {
        layers: [
          {
            world: p.world,
            pos: p.pos,
            rot: [p.yaw, 0, 0],
            fov: 60,
            time: p.time,
            anchor: [960, 540, 540],
            mask: [960, 540, 960, 540],
          },
        ],
      },
      0,
      { fbo, w: PANO_W, h: PANO_H },
      1,
    );
    gl.finish();
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  console.log(`[galaxy] baked ${PANOS.length} panoramas in ${Math.round(performance.now() - t0)} ms`);
};

export const createGalaxy = (c: GLCtx, _s: GalaxyState): Galaxy => {
  const { gl } = c;
  const prog = link(gl, CARD_VERT, CARD_FRAG, 'galaxy');
  const panos = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, panos);
  const levels = Math.floor(Math.log2(PANO_W)) + 1;
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA16F, PANO_W, PANO_H, PANOS.length);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  bake(c, panos);

  const corner = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, corner);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const setup = (buf: WebGLBuffer) => {
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const stride = FLOATS * 4;
    const attrs: [number, number, number][] = [
      [1, 3, 0],
      [2, 2, 3],
      [3, 4, 5],
      [4, 3, 9],
    ];
    for (const [loc, size, off] of attrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    return vao;
  };
  const inst = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  gl.bufferData(gl.ARRAY_BUFFER, CARD_N * FLOATS * 4, gl.DYNAMIC_DRAW);
  const spriteBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuf);
  gl.bufferData(gl.ARRAY_BUFFER, FLOATS * 4, gl.DYNAMIC_DRAW);
  return {
    prog,
    vao: setup(inst),
    inst,
    spriteBuf,
    spriteVao: setup(spriteBuf),
    panos,
    cards: makeCards(),
    data: new Float32Array(CARD_N * FLOATS),
    loc: new Map(),
  };
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Camera basis for a look-at camera, shared with the background layer. */
export const lookBasis = (pos: Vec3, target: Vec3, roll = 0) => {
  const f = norm(sub(target, pos));
  let r = norm(cross(f, [0, 1, 0]));
  let u = cross(r, f);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  [r, u] = [
    [r[0] * cr + u[0] * sr, r[1] * cr + u[1] * sr, r[2] * cr + u[2] * sr],
    [u[0] * cr - r[0] * sr, u[1] * cr - r[1] * sr, u[2] * cr - r[2] * sr],
  ];
  return { f, r, u, yaw: Math.atan2(-f[0], -f[2]), pitch: Math.asin(Math.max(-1, Math.min(1, f[1]))) };
};

const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 4);

export const drawGalaxy = (c: GLCtx, g: Galaxy, s: GalaxyState, frame: number) => {
  const { gl } = c;
  const { pos, target, fov, roll = 0 } = s.cam;
  const B = lookBasis(pos, target, roll);
  const aspect = 1920 / 1080;
  const near = 0.05, far = 3000;
  const fy = 1 / Math.tan((fov * Math.PI) / 360);
  // column-major view-projection
  const P = [fy / aspect, 0, 0, 0, 0, fy, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
  const V = [
    B.r[0], B.u[0], -B.f[0], 0,
    B.r[1], B.u[1], -B.f[1], 0,
    B.r[2], B.u[2], -B.f[2], 0,
    -dot(B.r, pos), -dot(B.u, pos), dot(B.f, pos), 1,
  ];
  const VP = new Float32Array(16);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let acc = 0;
      for (let k = 0; k < 4; k++) acc += P[k * 4 + row] * V[col * 4 + k];
      VP[col * 4 + row] = acc;
    }

  const t = frame / 30;
  const items: { depth: number; i: number; ctr: Vec3; a: number }[] = [];
  g.cards.forEach((card, i) => {
    const k = easeOut((s.burst - card.delay) / (1 - card.delay));
    if (k <= 0) return;
    const w = s.spin * Math.sqrt(40 / (card.r + 10));
    const th = card.theta + w;
    let ctr: Vec3 = [Math.cos(th) * card.r, card.y, Math.sin(th) * card.r];
    if (card.halo) ctr = [card.dir[0] * card.r, card.dir[1] * card.r * 0.6, card.dir[2] * card.r];
    // fly out from the core along a slightly curved path
    const out: Vec3 = [ctr[0] * k, ctr[1] * k + (1 - k) * (1 - k) * card.y * 3, ctr[2] * k];
    const rel = sub(out, pos);
    const depth = dot(rel, B.f);
    if (depth < 0.2) return;
    const dist = Math.hypot(...rel);
    const a = Math.min(1, k * 1.5) * Math.min(1, Math.max(0, (dist - 0.6) / 2.5));
    if (a <= 0.001) return;
    items.push({ depth, i, ctr: out, a });
  });
  items.sort((x, y) => y.depth - x.depth);
  const d = g.data;
  items.forEach((it, n) => {
    const card = g.cards[it.i];
    const o = n * FLOATS;
    const k = easeOut((s.burst - card.delay) / (1 - card.delay));
    const hh = card.hh * (0.25 + 0.75 * k);
    d[o] = it.ctr[0];
    d[o + 1] = it.ctr[1];
    d[o + 2] = it.ctr[2];
    d[o + 3] = (hh * 9) / 16;
    d[o + 4] = hh;
    d[o + 5] = card.pano;
    d[o + 6] = card.yaw + Math.sin(t * 0.4 + card.phase) * 0.12;
    d[o + 7] = card.roll;
    d[o + 8] = Math.sin(t * 0.7 + card.phase) * card.swing;
    d[o + 9] = it.a;
    d[o + 10] = 1.0;
    d[o + 11] = card.pitch;
  });

  gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
  gl.viewport(0, 0, c.w, c.h);
  gl.useProgram(g.prog);
  const u = (name: string) => {
    if (!g.loc.has(name)) g.loc.set(name, gl.getUniformLocation(g.prog, name));
    return g.loc.get(name)!;
  };
  gl.uniformMatrix4fv(u('uViewProj'), false, VP);
  gl.uniform3fv(u('uCamPos'), pos);
  gl.uniform3fv(u('uCamUp'), B.u);
  gl.uniform1f(u('uPulse'), s.pulse);
  gl.uniform1f(u('uOpacity'), s.opacity);
  gl.uniform2f(u('uRing'), s.ring[0], s.ring[1]);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, g.panos);
  gl.uniform1i(u('uPanos'), 1);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const sprite = (kind: number, half: number, gain: number) => {
    const sd = new Float32Array(FLOATS);
    sd[3] = half;
    sd[4] = half;
    sd[9] = 1;
    sd[10] = gain;
    gl.bindBuffer(gl.ARRAY_BUFFER, g.spriteBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sd);
    gl.uniform1i(u('uKind'), kind);
    gl.bindVertexArray(g.spriteVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
  };
  const cards = (from: number, to: number) => {
    if (to <= from) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, g.inst);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(from * FLOATS, to * FLOATS));
    gl.uniform1i(u('uKind'), 0);
    gl.bindVertexArray(g.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, to - from);
  };
  // cards behind the core, then the core glow, then the cards in front of it
  const coreDepth = -dot(pos, B.f);
  let split = items.findIndex((it) => it.depth < coreDepth);
  if (split < 0) split = items.length;
  if (s.ring[1] > 0) sprite(2, s.ring[0] * 1.4 + 10, 1);
  cards(0, split);
  if (s.core > 0) sprite(1, 70, s.core);
  cards(split, items.length);
  gl.bindVertexArray(null);
  gl.disable(gl.BLEND);
};
