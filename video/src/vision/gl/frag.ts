import { COMMON } from './common';
import { WORLDS } from './worlds';

export const MAX_LAYERS = 4;

// One oversized triangle that covers the viewport; no vertex buffers needed.
export const FULLSCREEN_VERT = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Scene pass: composites up to MAX_LAYERS world "views" into an HDR target.
// Layout coordinates are 1920x1080 with y pointing down, like the DOM, so
// rectangles line up with the React overlays drawn on top.
export const SCENE_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
out vec4 outColor;

uniform vec2 uRes;       // render target size, px
uniform vec2 uView;      // layout size (1920, 1080)
uniform float uFrame;
uniform int uMode;       // 0 = composite layers, 1 = equirect panorama of layer 0

uniform int uCount;
uniform int uWorld[${MAX_LAYERS}];
uniform vec3 uPos[${MAX_LAYERS}];
uniform vec3 uRot[${MAX_LAYERS}];     // yaw, pitch, roll
uniform float uFov[${MAX_LAYERS}];    // vertical field of view across the anchor height
uniform float uTime[${MAX_LAYERS}];
uniform vec3 uAnchor[${MAX_LAYERS}];  // projection anchor: centre x, y, half height
uniform vec4 uMask[${MAX_LAYERS}];    // visible rect: centre x, y, half w, half h
uniform float uRadius[${MAX_LAYERS}];
uniform float uAlpha[${MAX_LAYERS}];
uniform vec4 uSrc[${MAX_LAYERS}];     // extend: rect the world grows out of
uniform vec4 uFront[${MAX_LAYERS}];   // extend: reveal front rect, off when z = 0

uniform int uPortalLayer;  // layer holding the door, -1 = none
uniform vec3 uPortalC;     // door centre, world units
uniform vec3 uPortalU;     // half-width axis
uniform vec3 uPortalV;     // half-height axis
uniform int uPortalWorld;
uniform vec3 uPortalOff;   // door centre + offset = its position in the destination world
uniform float uPortalYaw;  // destination turn about y (camera yaw convention)
uniform float uPortalTime;
uniform float uPortalGlow;

uniform vec3 uBg;
uniform sampler3D uNoise;  // cloud noise, see noise.ts

bool gPortal = false;  // portal visible in the world currently being traced
vec3 gRo, gRd;         // last ray traced by shadeLayer (after any portal)
float gDist;           // and its hit distance (1e4 = sky)
vec3 portalOverlay(vec3 ro, vec3 rd, vec3 col, float tmax);

${COMMON}
${WORLDS}

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float sdRound(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

const vec3 ORANGE = vec3(1.0, 0.231, 0.122);

// Turns v about y the way adding a to a camera's yaw does (see camBasis).
vec3 yawTurn(vec3 v, float a) {
  float c = cos(a), s = sin(a);
  return vec3(v.x * c + v.z * s, v.y, v.z * c - v.x * s);
}

// Ray vs door rectangle. Returns (t, signed distance to the door edge in
// world units, half width). t < 0 when the plane is not hit.
vec3 portalHit(vec3 ro, vec3 rd) {
  vec3 n = cross(uPortalU, uPortalV);
  float dn = dot(rd, n);
  if (abs(dn) < 1e-6) return vec3(-1.0, 1e9, 1.0);
  float t = dot(uPortalC - ro, n) / dn;
  vec3 h = ro + rd * t - uPortalC;
  float hw = length(uPortalU), hh = length(uPortalV);
  vec2 lp = vec2(dot(h, uPortalU) / hw, dot(h, uPortalV) / hh);
  float d = sdRound(lp, vec2(hw, hh), 0.08 * hw);
  return vec3(t, d, hw);
}

vec3 portalGlow(float d, float hw, float t) {
  float px = 0.0012 * t + 0.002;
  float rim = exp(-abs(d) / (0.012 * hw + px));
  float halo = exp(-max(d, 0.0) / (0.55 * hw)) * step(0.0, d);
  float inner = exp(min(d, 0.0) / (0.06 * hw)) * step(d, 0.0);
  vec3 g = vec3(1.0, 0.72, 0.58) * rim * 7.0 + ORANGE * (halo * 0.45 + inner * 0.35);
  return g * uPortalGlow;
}

vec3 portalOverlay(vec3 ro, vec3 rd, vec3 col, float tmax) {
  if (!gPortal || uPortalGlow <= 0.0) return col;
  vec3 h = portalHit(ro, rd);
  if (h.x <= 0.0 || h.x > tmax) return col;
  if (h.y < 0.0) col = worldSky(uPortalWorld, yawTurn(rd, uPortalYaw), uPortalTime) * 0.85;
  return col + portalGlow(h.y, h.z, h.x) * 0.8;
}

vec3 shadeLayer(int i, vec2 q) {
  vec2 uv = (q - uAnchor[i].xy) / uAnchor[i].z;
  uv.y = -uv.y;
  mat3 B = camBasis(uRot[i]);
  vec3 ro = uPos[i];
  vec3 rd = normalize(B * vec3(uv * tan(0.5 * uFov[i]), 1.0));
  int wid = uWorld[i];
  float wt = uTime[i];
  vec3 add = vec3(0.0);
  bool through = false;
  gPortal = false;
  if (i == uPortalLayer && uPortalGlow > 0.0) {
    vec3 h = portalHit(ro, rd);
    if (h.x > 0.0) {
      add = portalGlow(h.y, h.z, h.x);
      if (h.y < 0.0) {
        ro = uPortalC + uPortalOff + yawTurn(ro + rd * h.x - uPortalC, uPortalYaw);
        rd = yawTurn(rd, uPortalYaw);
        wid = uPortalWorld;
        wt = uPortalTime;
        through = true;
      }
    }
    gPortal = !through;
  }
  vec4 r = renderWorld(wid, ro, rd, wt);
  gRo = ro;
  gRd = rd;
  gDist = r.a;
  if (gPortal && r.a < 1e3) {
    // light spill from the door onto nearby surfaces
    float dd = length(ro + rd * r.a - uPortalC) / length(uPortalV);
    add += ORANGE * uPortalGlow * 0.35 / (1.0 + dd * dd * 1.5);
  }
  return r.rgb + add;
}

// Grid lines of a 3D lattice with 'cell' spacing, antialiased and faded out
// where cells shrink below a few pixels.
float lattice(vec3 p, float cell) {
  vec3 gp = p / cell + vec3(0.0, 0.5, 0.0);  // keep the y = 0 water plane between lines
  vec3 w = max(fwidth(gp), vec3(1e-4));
  vec3 g = abs(fract(gp - 0.5) - 0.5) / w;
  float l = 1.0 - clamp(min(min(g.x, g.y), g.z) - 0.1, 0.0, 1.0);
  return l * (1.0 - smoothstep(0.12, 0.4, max(max(w.x, w.y), w.z)));
}

// Outpaint reveal. Behind a crisp front the new world first shows as a 3D
// scan (surface lattice, sky dome grid over a dim blueprint of the image),
// then fills in with full colour.
vec3 extendLook(vec3 c, float age, float px) {
  float line;
  if (gDist < 1e3) {
    vec3 p = gRo + gRd * gDist;
    line = max(lattice(p, 0.8), lattice(p, 6.4) * 0.8);
  } else {
    vec2 ang = vec2(atan(gRd.x, -gRd.z), asin(clamp(gRd.y, -1.0, 1.0))) * (18.0 / PI);
    vec2 w = max(fwidth(ang), vec2(1e-4));
    vec2 g = abs(fract(ang - 0.5) - 0.5) / w;
    line = (1.0 - clamp(min(g.x, g.y) - 0.1, 0.0, 1.0)) * (1.0 - smoothstep(0.12, 0.4, max(w.x, w.y))) * 0.5;
  }
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 blue = vec3(0.3, 0.62, 1.0) * (0.006 + 0.4 * pow(lum, 0.8));
  vec3 holo = blue + mix(ORANGE, vec3(1.0, 0.8, 0.66), 0.35) * line * 1.8;
  float fill = smoothstep(50.0, 190.0, age);
  vec3 o = mix(holo, c * (1.0 + 0.5 * exp(-pow((age - 120.0) / 45.0, 2.0))), fill);
  // the front itself: a hot hairline with a short orange wake
  o += vec3(1.0, 0.82, 0.7) * exp(-age / (1.4 * px)) * 6.0 + ORANGE * exp(-age / 22.0) * 0.6;
  return o;
}

void main() {
  if (uMode == 1) {
    vec2 uv = gl_FragCoord.xy / uRes;
    float lon = (uv.x - 0.5) * TAU;
    float lat = (uv.y - 0.5) * PI;
    vec3 rd = vec3(sin(lon) * cos(lat), sin(lat), -cos(lon) * cos(lat));
    float cy = cos(uRot[0].x), sy = sin(uRot[0].x);
    rd.xz = vec2(cy * rd.x - sy * rd.z, sy * rd.x + cy * rd.z);
    outColor = vec4(renderWorld(uWorld[0], uPos[0], rd, uTime[0]).rgb, 1.0);
    return;
  }

  float px = uView.x / uRes.x;  // layout px per target px
  vec2 q = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) * px;
  vec3 col = vec3(0.0);
  float T = 1.0;
  for (int i = ${MAX_LAYERS - 1}; i >= 0; i--) {
    if (i >= uCount) continue;
    float a = clamp(0.5 - sdRound(q - uMask[i].xy, uMask[i].zw, uRadius[i]) / px, 0.0, 1.0) * uAlpha[i];
    if (a <= 0.0) continue;
    float age = 1e4;  // extend: layout px since the reveal front passed
    if (uFront[i].z > 0.0 && sdBox(q - uSrc[i].xy, uSrc[i].zw) > 0.0) {
      age = -sdRound(q - uFront[i].xy, uFront[i].zw, 40.0);
      a *= clamp(age / px + 0.5, 0.0, 1.0);
      if (a <= 0.0) continue;
    }
    vec3 c = shadeLayer(i, q);
    if (age < 400.0) c = extendLook(c, age, px);
    col += T * a * c;
    T *= 1.0 - a;
    if (T < 0.002) break;
  }
  col += T * uBg;
  outColor = vec4(col, 1.0);
}
`;

// Post pass: SSAA resolve, zoom blur + chromatic aberration, mip bloom,
// tonemap, grade, vignette, grain, flash and fade.
export const POST_FRAG = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uFrame;
uniform float uExposure;
uniform float uBloom;
uniform float uGrain;
uniform float uVignette;
uniform float uAberr;     // aberration at the frame edge, output px
uniform float uZoomBlur;  // 0..~0.3
uniform vec2 uZoomCenter; // uv
uniform float uFlash;
uniform float uFade;
uniform vec3 uTint;
uniform float uSat;
uniform float uContrast;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
// Luminance soft-knee threshold (hue-preserving).
vec3 bright(vec3 c, float th) {
  float l = max(max(c.r, c.g), c.b);
  float k = clamp(l - th + 0.25, 0.0, 0.5);
  float w = max(l - th, k * k * 2.0) / max(l, 1e-4);
  return c * w;
}
vec3 blurLod(vec2 uv, float lod) {
  vec2 ts = 1.0 / vec2(textureSize(uTex, int(lod)));
  vec3 s = textureLod(uTex, uv, lod).rgb * 4.0;
  s += textureLod(uTex, uv + vec2(ts.x, 0.0), lod).rgb * 2.0;
  s += textureLod(uTex, uv - vec2(ts.x, 0.0), lod).rgb * 2.0;
  s += textureLod(uTex, uv + vec2(0.0, ts.y), lod).rgb * 2.0;
  s += textureLod(uTex, uv - vec2(0.0, ts.y), lod).rgb * 2.0;
  s += textureLod(uTex, uv + ts, lod).rgb;
  s += textureLod(uTex, uv - ts, lod).rgb;
  s += textureLod(uTex, uv + vec2(ts.x, -ts.y), lod).rgb;
  s += textureLod(uTex, uv + vec2(-ts.x, ts.y), lod).rgb;
  return s / 16.0;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 col;
  if (uZoomBlur > 0.0005 || uAberr > 0.05) {
    vec2 dir = uv - 0.5;
    vec2 ab = dir * (uAberr / uRes.x) * 2.0;
    vec3 acc = vec3(0.0);
    // Each tap reads a mip as wide as the gap between taps, so the streak is
    // a continuous smear instead of 16 stacked copies of every highlight.
    // Taps fade with distance, so trails taper instead of ending in a hard
    // edge; the longer reach keeps the same apparent streak length.
    vec2 smear = (uv - uZoomCenter) * uZoomBlur * 1.3;
    float lod = log2(max(length(smear * vec2(textureSize(uTex, 0))) / 16.0, 1.0));
    float wsum = 0.0;
    for (int k = 0; k < 16; k++) {
      float s = (float(k) + hash12(gl_FragCoord.xy) ) / 16.0;
      vec2 z = uv - smear * s;
      float w = 1.0 - s;
      acc.r += textureLod(uTex, z + ab, lod).r * w;
      acc.g += textureLod(uTex, z, lod).g * w;
      acc.b += textureLod(uTex, z - ab, lod).b * w;
      wsum += w;
    }
    col = acc / wsum;
  } else {
    col = textureLod(uTex, uv, 0.0).rgb;
  }
  if (uBloom > 0.0) {
    // Only light well above white blooms, so skies stay clean and only
    // suns, speculars, rims and glows halo.
    vec3 b = vec3(0.0);
    b += bright(blurLod(uv, 2.0), 1.4) * 0.22;
    b += bright(blurLod(uv, 3.0), 1.2) * 0.22;
    b += bright(blurLod(uv, 4.0), 1.0) * 0.18;
    b += bright(blurLod(uv, 5.0), 0.9) * 0.14;
    b += bright(blurLod(uv, 6.0), 0.8) * 0.12;
    col += b * uBloom;
  }
  col = aces(col * uExposure);
  col = pow(col, vec3(1.0 / 2.2));
  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat) * uTint;
  // gentle split tone: teal shadows, warm highlights
  col += vec3(-0.012, 0.004, 0.018) * (1.0 - l) + vec3(0.015, 0.006, -0.012) * l;
  vec2 c = (uv - 0.5) * vec2(1.0, 0.82);
  col *= 1.0 - uVignette * smoothstep(0.25, 0.85, length(c) * 1.3);
  col += (hash12(gl_FragCoord.xy + fract(uFrame * 0.6180339) * 971.0) - 0.5) * uGrain;
  col = mix(col, vec3(1.0), uFlash);
  col *= 1.0 - uFade;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
