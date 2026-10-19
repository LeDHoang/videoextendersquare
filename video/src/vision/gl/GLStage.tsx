import { useLayoutEffect, useRef } from 'react';
import { getRemotionEnvironment, useCurrentFrame, useDelayRender } from 'remotion';
import { FULLSCREEN_VERT, MAX_LAYERS, POST_FRAG, SCENE_FRAG } from './frag';
import { WORLD_IDS, type WorldName } from './worlds';
import { createGalaxy, drawGalaxy, type Galaxy, type GalaxyState } from './galaxy';
import { bakeNoise, NOISE_UNIT } from './noise';

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Layout rect: centre x, centre y, half width, half height (1920x1080 px, y down). */
export type Rect = [number, number, number, number];

export type Layer = {
  world: WorldName;
  pos: Vec3;
  /** yaw, pitch, roll in radians; yaw 0 looks down -z. */
  rot: Vec3;
  /** Vertical field of view in degrees, spanning the anchor's full height. */
  fov: number;
  time: number;
  /** Projection anchor: centre x, centre y, half height. */
  anchor: Vec3;
  mask: Rect;
  radius?: number;
  alpha?: number;
  /** Outpaint reveal: the world grows out of `src` (the reel) up to the
   *  rounded `front` rect, built as a 3D scan just behind the front. */
  extend?: { src: Rect; front: Rect };
};

export type Portal = {
  layer: number;
  c: Vec3;
  u: Vec3;
  v: Vec3;
  world: WorldName;
  /** Where the door centre lands in the destination world, relative to `c`. */
  off: Vec3;
  /** Destination turn about y, added to a camera's yaw as it passes through. */
  yaw?: number;
  time: number;
  glow: number;
};

export type Post = {
  exposure: number;
  bloom: number;
  grain: number;
  vignette: number;
  aberr: number;
  zoomBlur: number;
  zoomCenter: Vec2;
  flash: number;
  fade: number;
  tint: Vec3;
  sat: number;
  /** 0..1 blend toward an S-curve after tonemapping. */
  contrast: number;
};

export type Stage = {
  layers: Layer[];
  portal?: Portal | null;
  bg?: Vec3;
  post?: Partial<Post>;
  galaxy?: GalaxyState | null;
};

export const DEFAULT_POST: Post = {
  exposure: 1,
  bloom: 1,
  grain: 0.035,
  vignette: 0.35,
  aberr: 0,
  zoomBlur: 0,
  zoomCenter: [0.5, 0.5],
  flash: 0,
  fade: 0,
  tint: [1, 1, 1],
  sat: 1,
  contrast: 0.25,
};

const OUT_W = 1920;
const OUT_H = 1080;

type GL = WebGL2RenderingContext;

type Ctx = {
  gl: GL;
  scene: WebGLProgram;
  post: WebGLProgram;
  vao: WebGLVertexArrayObject;
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  noise: WebGLTexture;
  w: number;
  h: number;
  loc: Map<string, WebGLUniformLocation | null>;
  galaxy: Galaxy | null;
};

const compile = (gl: GL, type: number, src: string, name: string) => {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    const lines = src.split('\n');
    const ctx = [...log.matchAll(/ERROR: 0:(\d+)/g)]
      .slice(0, 3)
      .map((m) => `${m[1]}: ${lines[Number(m[1]) - 1]}`)
      .join('\n');
    throw new Error(`${name} shader failed:\n${log}\n${ctx}`);
  }
  return sh;
};

export const link = (gl: GL, vs: string, fs: string, name: string) => {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, name));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`${name} link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
};

const init = (canvas: HTMLCanvasElement, scale: number): Ctx => {
  const gl = canvas.getContext('webgl2', {
    preserveDrawingBuffer: true,
    antialias: false,
    alpha: false,
    depth: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 unavailable');
  if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float unavailable');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) console.log('[GLStage] renderer:', gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));

  const t0 = performance.now();
  const scene = link(gl, FULLSCREEN_VERT, SCENE_FRAG, 'scene');
  const post = link(gl, FULLSCREEN_VERT, POST_FRAG, 'post');
  const vao = gl.createVertexArray()!;
  const noise = bakeNoise(gl, link, vao);
  console.log(`[GLStage] programs linked, noise baked in ${Math.round(performance.now() - t0)} ms`);

  const w = Math.round(OUT_W * scale);
  const h = Math.round(OUT_H * scale);
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('HDR framebuffer incomplete');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    gl,
    scene,
    post,
    vao,
    fbo,
    tex,
    noise,
    w,
    h,
    loc: new Map(),
    galaxy: null,
  };
};

const uni = (c: Ctx, p: WebGLProgram, name: string) => {
  const key = `${p === c.scene ? 's' : 'p'}:${name}`;
  if (!c.loc.has(key)) c.loc.set(key, c.gl.getUniformLocation(p, name));
  return c.loc.get(key)!;
};

const pad = <T,>(arr: T[], fill: T) => [...arr, ...Array(MAX_LAYERS - arr.length).fill(fill)].slice(0, MAX_LAYERS);

/** Renders the scene into the HDR target (layers + optional galaxy). Exposed for panorama baking. */
export const drawSceneTo = (
  c: Ctx,
  stage: Stage,
  frame: number,
  target: { fbo: WebGLFramebuffer | null; w: number; h: number },
  mode = 0,
) => {
  const { gl, scene } = c;
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  gl.viewport(0, 0, target.w, target.h);
  gl.useProgram(scene);
  gl.bindVertexArray(c.vao);
  const L = stage.layers.slice(0, MAX_LAYERS);
  const u = (n: string) => uni(c, scene, n);
  gl.uniform2f(u('uRes'), target.w, target.h);
  gl.uniform2f(u('uView'), OUT_W, OUT_H);
  gl.uniform1f(u('uFrame'), frame);
  gl.uniform1i(u('uMode'), mode);
  gl.uniform1i(u('uCount'), L.length);
  gl.uniform1iv(u('uWorld'), pad(L.map((l) => WORLD_IDS[l.world]), 0));
  gl.uniform3fv(u('uPos'), pad(L.map((l) => l.pos), [0, 0, 0] as Vec3).flat());
  gl.uniform3fv(u('uRot'), pad(L.map((l) => l.rot), [0, 0, 0] as Vec3).flat());
  gl.uniform1fv(u('uFov'), pad(L.map((l) => (l.fov * Math.PI) / 180), 1));
  gl.uniform1fv(u('uTime'), pad(L.map((l) => l.time), 0));
  gl.uniform3fv(u('uAnchor'), pad(L.map((l) => l.anchor), [960, 540, 540] as Vec3).flat());
  gl.uniform4fv(u('uMask'), pad(L.map((l) => l.mask), [0, 0, 0, 0] as Rect).flat());
  gl.uniform1fv(u('uRadius'), pad(L.map((l) => l.radius ?? 0), 0));
  gl.uniform1fv(u('uAlpha'), pad(L.map((l) => l.alpha ?? 1), 0));
  gl.uniform4fv(u('uSrc'), pad(L.map((l) => l.extend?.src ?? [0, 0, 0, 0]), [0, 0, 0, 0] as Rect).flat());
  gl.uniform4fv(u('uFront'), pad(L.map((l) => l.extend?.front ?? [0, 0, 0, 0]), [0, 0, 0, 0] as Rect).flat());
  const P = stage.portal;
  gl.uniform1i(u('uPortalLayer'), P ? P.layer : -1);
  if (P) {
    gl.uniform3fv(u('uPortalC'), P.c);
    gl.uniform3fv(u('uPortalU'), P.u);
    gl.uniform3fv(u('uPortalV'), P.v);
    gl.uniform1i(u('uPortalWorld'), WORLD_IDS[P.world]);
    gl.uniform3fv(u('uPortalOff'), P.off);
    gl.uniform1f(u('uPortalYaw'), P.yaw ?? 0);
    gl.uniform1f(u('uPortalTime'), P.time);
    gl.uniform1f(u('uPortalGlow'), P.glow);
  } else {
    gl.uniform1f(u('uPortalGlow'), 0);
  }
  gl.uniform3fv(u('uBg'), stage.bg ?? [0, 0, 0]);
  gl.activeTexture(gl.TEXTURE0 + NOISE_UNIT);
  gl.bindTexture(gl.TEXTURE_3D, c.noise);
  gl.uniform1i(u('uNoise'), NOISE_UNIT);
  gl.activeTexture(gl.TEXTURE0);

  // Draw in horizontal bands so no single GPU command runs long enough to
  // trip the watchdog on heavy raymarching frames.
  const band = Math.max(64, Math.ceil(target.h / 8));
  gl.enable(gl.SCISSOR_TEST);
  for (let y = 0; y < target.h; y += band) {
    gl.scissor(0, y, target.w, Math.min(band, target.h - y));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.flush();
  }
  gl.disable(gl.SCISSOR_TEST);
};

const drawFrame = (c: Ctx, stage: Stage, frame: number) => {
  const { gl } = c;
  drawSceneTo(c, stage, frame, { fbo: c.fbo, w: c.w, h: c.h });
  if (stage.galaxy) {
    if (!c.galaxy) c.galaxy = createGalaxy(c, stage.galaxy);
    drawGalaxy(c, c.galaxy, stage.galaxy, frame);
  }
  gl.bindTexture(gl.TEXTURE_2D, c.tex);
  gl.generateMipmap(gl.TEXTURE_2D);

  const post = { ...DEFAULT_POST, ...stage.post };
  const p = c.post;
  const u = (n: string) => uni(c, p, n);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, OUT_W, OUT_H);
  gl.useProgram(p);
  gl.bindVertexArray(c.vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, c.tex);
  gl.uniform1i(u('uTex'), 0);
  gl.uniform2f(u('uRes'), OUT_W, OUT_H);
  gl.uniform1f(u('uFrame'), frame);
  gl.uniform1f(u('uExposure'), post.exposure);
  gl.uniform1f(u('uBloom'), post.bloom);
  gl.uniform1f(u('uGrain'), post.grain);
  gl.uniform1f(u('uVignette'), post.vignette);
  gl.uniform1f(u('uAberr'), post.aberr);
  gl.uniform1f(u('uZoomBlur'), post.zoomBlur);
  gl.uniform2fv(u('uZoomCenter'), post.zoomCenter);
  gl.uniform1f(u('uFlash'), post.flash);
  gl.uniform1f(u('uFade'), post.fade);
  gl.uniform3fv(u('uTint'), post.tint);
  gl.uniform1f(u('uSat'), post.sat);
  gl.uniform1f(u('uContrast'), post.contrast);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.finish();
};

export type GLCtx = Ctx;

/**
 * Full-frame WebGL2 canvas that redraws deterministically from `stage` on
 * every frame. `ssaa` is the internal render scale (2 = 4 samples per pixel).
 */
export const GLStage: React.FC<{ stage: Stage; ssaa?: number }> = ({ stage, ssaa = 1 }) => {
  const frame = useCurrentFrame();
  const ref = useRef<HTMLCanvasElement>(null);
  const ctx = useRef<Ctx | null>(null);
  const { delayRender, continueRender } = useDelayRender();
  const scale = getRemotionEnvironment().isStudio ? Math.min(ssaa, 0.5) : ssaa;

  useLayoutEffect(() => {
    const canvas = ref.current!;
    ctx.current = init(canvas, scale);
    return () => {
      ctx.current?.gl.getExtension('WEBGL_lose_context')?.loseContext();
      ctx.current = null;
    };
  }, [scale]);

  useLayoutEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const handle = delayRender(`GLStage frame ${frame}`);
    const t0 = performance.now();
    drawFrame(c, stage, frame);
    const ms = Math.round(performance.now() - t0);
    if (ms > 1500) console.log(`[GLStage] frame ${frame}: ${ms} ms`);
    requestAnimationFrame(() => continueRender(handle));
  }, [stage, frame, delayRender, continueRender]);

  return <canvas ref={ref} width={OUT_W} height={OUT_H} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
};
