// Tileable 3D cloud noise baked on the GPU once per context, after the
// Perlin-Worley recipe from Schneider's "Real-time volumetric cloudscapes":
//   r = billowy Perlin fbm reshaped by Worley fbm, gba = Worley fbm at 1x/2x/4x.
// Sampled by the CLOUDS world through `uNoise` (texture unit 2).
import { COMMON } from './common';
import { FULLSCREEN_VERT } from './frag';

export const NOISE_N = 128;
export const NOISE_UNIT = 2;

const NOISE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform float uZ;
uniform float uN;
out vec4 outColor;

${COMMON}

float remap(float x, float a, float b, float c, float d) { return c + (x - a) / (b - a) * (d - c); }

// Gradient noise that repeats every 'per' lattice cells.
float perlinT(vec3 p, float per) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n[8];
  for (int k = 0; k < 8; k++) {
    vec3 o = vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
    vec3 g = normalize(hash33(mod(i + o, per)) * 2.0 - 1.0);
    n[k] = dot(g, f - o);
  }
  return mix(mix(mix(n[0], n[1], u.x), mix(n[2], n[3], u.x), u.y),
             mix(mix(n[4], n[5], u.x), mix(n[6], n[7], u.x), u.y), u.z);
}

float perlinFbm(vec3 p, float freq, int oct) {
  float g = exp2(-0.85), amp = 1.0, n = 0.0;
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    n += amp * perlinT(p * freq, freq);
    freq *= 2.0;
    amp *= g;
  }
  return n;
}

// Inverted cellular noise: 1 at feature points, falling off between them.
float worleyT(vec3 p, float per) {
  vec3 id = floor(p), f = fract(p);
  float d = 1e4;
  for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec3 o = vec3(x, y, z);
        vec3 r = o + hash33(mod(id + o, per)) - f;
        d = min(d, dot(r, r));
      }
  return clamp(1.0 - sqrt(d), 0.0, 1.0);
}

float worleyFbm(vec3 p, float freq) {
  return worleyT(p * freq, freq) * 0.625 + worleyT(p * freq * 2.0, freq * 2.0) * 0.25 +
         worleyT(p * freq * 4.0, freq * 4.0) * 0.125;
}

void main() {
  vec3 p = vec3(gl_FragCoord.xy, uZ + 0.5) / uN;
  const float freq = 4.0;
  float pfbm = mix(1.0, perlinFbm(p, freq, 7), 0.5);
  pfbm = abs(pfbm * 2.0 - 1.0);
  float g = worleyFbm(p, freq);
  float b = worleyFbm(p, freq * 2.0);
  float a = worleyFbm(p, freq * 4.0);
  outColor = vec4(clamp(remap(pfbm, 0.0, 1.0, g, 1.0), 0.0, 1.0), g, b, a);
}`;

type Link = (gl: WebGL2RenderingContext, vs: string, fs: string, name: string) => WebGLProgram;

/** Bakes the NOISE_N^3 RGBA8 cloud noise (mipmapped, repeating) one slice per draw. */
export const bakeNoise = (gl: WebGL2RenderingContext, link: Link, vao: WebGLVertexArrayObject) => {
  const prog = link(gl, FULLSCREEN_VERT, NOISE_FRAG, 'noise');
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.texStorage3D(gl.TEXTURE_3D, Math.log2(NOISE_N) + 1, gl.RGBA8, NOISE_N, NOISE_N, NOISE_N);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
    gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);
  }
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, NOISE_N, NOISE_N);
  gl.useProgram(prog);
  gl.bindVertexArray(vao);
  gl.uniform1f(gl.getUniformLocation(prog, 'uN'), NOISE_N);
  const uZ = gl.getUniformLocation(prog, 'uZ');
  for (let z = 0; z < NOISE_N; z++) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, z);
    gl.uniform1f(uZ, z);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteProgram(prog);
  gl.generateMipmap(gl.TEXTURE_3D);
  gl.bindTexture(gl.TEXTURE_3D, null);
  return tex;
};
