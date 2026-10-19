// Procedural "reel worlds". Each world returns linear HDR colour (rgb) and
// hit distance (a, 1e4 for sky) for a ray. All of them are original
// raymarched scenes, written for this film:
//   0 AURORA  night lake between snow peaks under curtains of aurora
//   1 OCEAN   golden-hour open sea, sun on the horizon
//   2 DUNES   alien desert at dusk under a ringed planet
//   3 COSMOS  drifting through a nebula
//   4 CLOUDS  above a sea of cumulus by day
export const WORLD_IDS = { aurora: 0, ocean: 1, dunes: 2, cosmos: 3, clouds: 4 } as const;
export type WorldName = keyof typeof WORLD_IDS;

export const WORLDS = /* glsl */ `
// ---------------------------------------------------------------- AURORA
float aH(vec2 p, int oct) {
  vec2 q = p * 0.022;
  float h = 0.0, a = 0.5;
  vec2 d = vec2(0.0);
  for (int i = 0; i < 9; i++) {
    if (i >= oct) break;
    vec3 n = noised(q);
    d += n.yz;
    h += a * n.x / (1.0 + dot(d, d));
    a *= 0.5;
    q = M2 * q * 2.0;
  }
  float mount = h * 34.0 + 9.0;
  float vx = abs(p.x - 12.0 * sin(p.y * 0.011));
  float valley = smoothstep(7.0, 46.0, vx);
  return mix(-2.5 + h * 3.0, mount, valley);
}

float aMarch(vec3 ro, vec3 rd, float tmax) {
  float t = 0.1;
  for (int i = 0; i < 180; i++) {
    vec3 p = ro + rd * t;
    float h = p.y - aH(p.xz, 6);
    if (h < 0.0015 * t || t > tmax) break;
    t += 0.42 * h;
  }
  return t;
}

vec3 aNormal(vec3 p, float t) {
  float e = max(0.004 * t, 0.01);
  return normalize(vec3(aH(p.xz - vec2(e, 0.0), 9) - aH(p.xz + vec2(e, 0.0), 9), 2.0 * e,
                        aH(p.xz - vec2(0.0, e), 9) - aH(p.xz + vec2(0.0, e), 9)));
}

float aShadow(vec3 ro, vec3 l) {
  float res = 1.0, t = 0.6;
  for (int i = 0; i < 48; i++) {
    vec3 p = ro + l * t;
    float h = p.y - aH(p.xz, 5);
    res = min(res, 10.0 * h / t);
    t += clamp(h, 0.4, 9.0);
    if (res < 0.002 || p.y > 45.0) break;
  }
  return clamp(res, 0.0, 1.0);
}

vec3 auroraCurtains(vec3 rd, float t) {
  // Stacked horizontal sheets far above the valley share one wavy curtain
  // line; stacking them draws vertical rays. Green low, violet high.
  if (rd.y <= 0.0) return vec3(0.0);
  vec3 acc = vec3(0.0);
  float jit = hash12(gl_FragCoord.xy);
  float iy = 1.0 / (rd.y + 0.03);
  for (int i = 0; i < 40; i++) {
    float fi = float(i) + jit;
    vec2 p = rd.xz * ((0.8 + fi * 0.06) * iy);
    float warp = fbm(p * 0.2 + vec2(t * 0.015, 0.0), 3);
    float l1 = p.y + 5.0 + sin(p.x * 0.3 + warp * 2.4 + t * 0.05) * 1.6 + warp * 1.4;
    float l2 = p.y + 9.5 + sin(p.x * 0.2 - warp * 1.8 + 2.0 - t * 0.03) * 2.4;
    float cur = exp(-abs(l1) * 2.6) + exp(-abs(l2) * 2.0) * 0.6;
    float along = p.x + warp * 2.0;
    float rays = 0.12 + 0.88 * pow(0.5 + 0.5 * noise(vec2(along * 2.4, t * 0.1)), 3.0);
    rays *= 0.75 + 0.25 * noise(vec2(along * 8.0, 3.0 + t * 0.25));
    float fall = exp(-fi * 0.07) * smoothstep(0.0, 1.5, fi);
    vec3 c = mix(vec3(0.05, 1.0, 0.42), vec3(0.10, 0.80, 0.70), smoothstep(5.0, 14.0, fi));
    c = mix(c, vec3(0.55, 0.18, 1.0), smoothstep(12.0, 28.0, fi));
    c = mix(c, vec3(1.0, 0.22, 0.50), smoothstep(26.0, 40.0, fi) * 0.7);
    acc += c * cur * rays * fall;
  }
  return acc * 0.42 * smoothstep(0.0, 0.1, rd.y);
}

vec3 aSky(vec3 rd, float t) {
  float y = max(rd.y, 0.0);
  vec3 col = mix(vec3(0.008, 0.02, 0.035), vec3(0.001, 0.003, 0.010), pow(y, 0.45));
  col += vec3(0.01, 0.05, 0.04) * exp(-y * 12.0);
  col += stars(rd, 260.0, 0.07, t) * smoothstep(0.0, 0.25, y) * 1.6;
  col += auroraCurtains(rd, t);
  return col;
}

const vec3 A_FOG = vec3(0.008, 0.032, 0.036);

vec3 aShade(vec3 p, vec3 rd, float t, bool cheap) {
  vec3 n = aNormal(p, t);
  vec3 L = normalize(vec3(0.8, 0.35, -0.3));  // low moon from the right
  float dif = clamp(dot(n, L), 0.0, 1.0);
  float sh = cheap ? 1.0 : aShadow(p + n * 0.05, L);
  float snowN = noise(p.xz * 0.35) * 0.12 + noise(p.xz * 1.7) * 0.05;
  float snow = smoothstep(0.55, 0.8, n.y + snowN) * smoothstep(0.5, 4.0, p.y + snowN * 10.0);
  vec3 alb = mix(vec3(0.03, 0.032, 0.04), vec3(0.8, 0.88, 1.0), snow);
  vec3 lin = dif * sh * vec3(0.40, 0.50, 0.85) * 0.7;
  lin += clamp(0.6 * n.y - 0.4 * n.z, 0.0, 1.0) * vec3(0.03, 0.26, 0.14);  // aurora light from ahead
  lin += (0.5 + 0.5 * n.y) * vec3(0.01, 0.025, 0.04);
  return alb * lin;
}

vec4 wAurora(vec3 ro, vec3 rd, float t) {
  float tw = rd.y < 0.0 ? -ro.y / rd.y : 1e4;
  float tt = aMarch(ro, rd, min(tw, 700.0));
  vec3 col;
  float dist;
  if (tt < tw && tt < 700.0) {
    col = aShade(ro + rd * tt, rd, tt, false);
    dist = tt;
  } else if (tw < 1e3) {
    // near-still lake: a mirror with faint ripples
    vec3 p = ro + rd * tw;
    vec2 g = vec2(noise(p.xz * 0.9 + t * 0.12), noise(p.xz * 0.9 - t * 0.1 + 3.0)) * 0.012;
    g += vec2(noise(p.xz * 4.0 + t * 0.3), noise(p.xz * 4.0 - t * 0.28 + 7.0)) * 0.004;
    vec3 n = normalize(vec3(g.x, 1.0, g.y));
    vec3 rr = reflect(rd, n);
    float fre = 0.04 + 0.96 * pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
    float tr = aMarch(p + n * 0.02, rr, 500.0);
    vec3 refl;
    if (tr < 500.0) refl = mix(aShade(p + rr * tr, rr, tr, true), A_FOG, 1.0 - exp(-tr * 0.0022));
    else refl = aSky(rr, t);
    refl = portalOverlay(p, rr, refl, tr);
    col = mix(vec3(0.001, 0.004, 0.006), refl, clamp(fre * 1.2 + 0.45, 0.0, 1.0));
    dist = tw;
  } else {
    return vec4(aSky(rd, t), 1e4);
  }
  col = mix(col, A_FOG, 1.0 - exp(-dist * 0.0022));
  return vec4(col, dist);
}

// ---------------------------------------------------------------- OCEAN
const vec3 O_SUN = normalize(vec3(0.0, 0.045, -1.0));

float oH(vec2 p, float t, int oct) {
  float h = 0.0, a = 0.62, f = 0.16, ang = 0.35;
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    vec2 d = vec2(cos(ang), sin(ang));
    float x = dot(p, d) * f + t * (0.55 + 0.22 * float(i)) + noise(p * f * 0.5 + float(i) * 7.3) * 1.3;
    float w = 1.0 - abs(sin(x));
    w = w * w * (3.0 - 2.0 * w);
    h += a * (w - 0.45);
    a *= 0.5;
    f *= 1.92;
    ang += 1.37;
  }
  return h;
}

vec3 oSky(vec3 rd, float t) {
  float y = rd.y;
  float yy = max(y, 0.0);
  vec3 col = mix(vec3(1.25, 0.46, 0.14), vec3(0.58, 0.18, 0.16), smoothstep(0.0, 0.08, yy));
  col = mix(col, vec3(0.03, 0.04, 0.13), smoothstep(0.04, 0.38, yy));
  float sd = max(dot(rd, O_SUN), 0.0);
  col += vec3(1.0, 0.42, 0.12) * pow(sd, 6.0) * 0.9;
  col += vec3(1.0, 0.66, 0.30) * pow(sd, 64.0) * 2.2;
  col += vec3(1.0, 0.90, 0.72) * smoothstep(0.99955, 0.99975, sd) * 30.0;
  if (y > 0.0) {
    // sunset cloud deck: dark violet undersides, burning edges near the sun
    vec2 cp = rd.xz / (y + 0.05) * 1.6;
    float c = fbm(cp * 0.55 + vec2(t * 0.012, 0.0), 6);
    float cov = smoothstep(0.0, 0.32, c) * smoothstep(0.012, 0.07, y) * smoothstep(0.6, 0.18, y);
    float thin = 1.0 - smoothstep(0.0, 0.45, c);
    vec3 cc = mix(vec3(0.09, 0.035, 0.07), vec3(0.95, 0.34, 0.16), pow(sd, 7.0));
    cc += vec3(1.0, 0.55, 0.22) * pow(sd, 12.0) * (0.5 + 2.5 * thin);
    col = mix(col, cc, cov * 0.92);
  }
  return col;
}

float oTrace(vec3 ro, vec3 rd, float t) {
  // Rays that start under the swell (the bottom of a door that lands low in
  // the sea) are flagged with -1 and shaded as a cut through the water.
  float h = ro.y - oH(ro.xz, t, 4);
  if (h < 0.0) return -1.0;
  if (rd.y > -0.0005) return 1e4;
  // Skip to the top of the swell (|oH| < 0.66 at 4 octaves), then march the
  // slab in short steps so a near crest is never stepped over (a single
  // secant solve over the whole range tears grazing crests into lines).
  float ta = max(0.0, (ro.y - 0.66) / -rd.y);
  float tEnd = min(900.0, (ro.y + 0.56) / -rd.y);
  if (ta > 0.0) h = ro.y + rd.y * ta - oH(ro.xz + rd.xz * ta, t, 4);
  for (int i = 0; i < 72; i++) {
    float tb = ta + 0.22 + 0.016 * ta;
    vec3 q = ro + rd * tb;
    float hb = q.y - oH(q.xz, t, 4);
    if (hb < 0.0) {
      float tm = tb;
      for (int k = 0; k < 6; k++) {
        tm = mix(ta, tb, h / (h - hb));
        q = ro + rd * tm;
        float hm = q.y - oH(q.xz, t, 4);
        if (hm < 0.0) { tb = tm; hb = hm; } else { ta = tm; h = hm; }
      }
      return tm;
    }
    ta = tb;
    h = hb;
    if (ta > tEnd) return 1e4;
  }
  return tEnd >= 900.0 ? 1e4 : ta;
}

/** Cross-section of the sea where a door cuts below the waterline: a bright
 *  meniscus, caustics and light shafts under the surface, then deep water. */
vec3 oUnder(vec3 ro, vec3 rd, float t) {
  float depth = max(oH(ro.xz, t, 5) - ro.y, 0.0);
  vec3 col = mix(vec3(0.02, 0.1, 0.11), vec3(0.002, 0.01, 0.02), smoothstep(0.0, 1.6, depth));
  col += vec3(0.3, 0.13, 0.04) * pow(max(dot(rd, O_SUN), 0.0), 3.0) * exp(-depth * 2.2);
  // Shafts of low sun slanting down from the surface.
  float sh = noise(vec2(ro.x * 1.7 + ro.z + ro.y * 0.4, t * 0.25)) * 0.5 + 0.5;
  col += vec3(0.5, 0.3, 0.12) * pow(sh, 4.0) * exp(-depth * 1.3) * 0.4;
  vec2 cq = vec2(ro.x + ro.z, ro.y) * 2.4 + vec2(t * 0.35, -t * 0.2);
  float c = 1.0 - abs(noise(cq) + 0.5 * noise(cq * 2.1 + 3.7));
  col += vec3(0.9, 0.6, 0.3) * pow(max(c, 0.0), 10.0) * exp(-depth * 3.0) * 0.6;
  col += vec3(1.0, 0.7, 0.4) * exp(-depth * 30.0) * 1.2;
  return col;
}

vec4 wOcean(vec3 ro, vec3 rd, float t) {
  float d = oTrace(ro, rd, t);
  if (d < 0.0) return vec4(oUnder(ro, rd, t), 0.5);
  if (d > 1e3) return vec4(oSky(rd, t), 1e4);
  vec3 p = ro + rd * d;
  float e = max(0.003 * d, 0.01);
  float h0 = oH(p.xz, t, 7);
  vec3 n = normalize(vec3(h0 - oH(p.xz + vec2(e, 0.0), t, 7), e, h0 - oH(p.xz + vec2(0.0, e), t, 7)));
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), smoothstep(0.0, 700.0, d) * 0.6));
  vec3 rr = reflect(rd, n);
  rr.y = abs(rr.y);
  float fre = 0.02 + 0.98 * pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
  vec3 refl = portalOverlay(p, rr, oSky(rr, t), 1e4);
  vec3 deep = vec3(0.003, 0.016, 0.028);
  vec3 sss = vec3(0.05, 0.16, 0.15) * pow(max(h0 + 0.3, 0.0), 2.0) * (0.3 + 0.7 * pow(max(dot(rd, O_SUN), 0.0), 2.0));
  vec3 col = mix(deep + sss, refl, fre);
  float sp = pow(max(dot(rr, O_SUN), 0.0), 300.0);
  col += vec3(1.0, 0.72, 0.42) * sp * 9.0;
  col += vec3(1.0, 0.5, 0.2) * pow(max(dot(rr, O_SUN), 0.0), 20.0) * 0.15;
  col = mix(col, oSky(normalize(vec3(rd.x, 0.002, rd.z)), t), smoothstep(80.0, 900.0, d));
  return vec4(col, d);
}

// ---------------------------------------------------------------- DUNES
const vec3 D_SUN = normalize(vec3(-0.75, 0.10, -0.62));

float dH(vec2 p, int oct) {
  vec2 q = p * 0.045;
  float w = fbm(q * 0.6, 3) * 2.4;
  float a = 1.0 - abs(sin(q.x + q.y * 0.32 + w));
  float b = 1.0 - abs(sin(q.x * 1.85 - q.y * 0.75 + w * 1.4 + 1.3));
  float h = 6.0 * a * a + 2.0 * b * b + 1.8 * fbm(q * 1.5, 3);
  if (oct > 6) h += 0.035 * sin(dot(p, vec2(2.3, 0.9)) + 3.0 * noise(p * 0.35));
  return h - 4.0;
}

float dMarch(vec3 ro, vec3 rd, float tmax) {
  float t = 0.1;
  for (int i = 0; i < 160; i++) {
    vec3 p = ro + rd * t;
    float h = p.y - dH(p.xz, 4);
    if (h < 0.002 * t || t > tmax) break;
    t += 0.5 * h;
  }
  return t;
}

vec3 dSkyBase(vec3 rd) {
  float yy = max(rd.y, 0.0);
  vec3 col = mix(vec3(1.05, 0.46, 0.24), vec3(0.55, 0.22, 0.30), smoothstep(0.0, 0.12, yy));
  col = mix(col, vec3(0.04, 0.05, 0.15), smoothstep(0.08, 0.6, yy));
  float sd = max(dot(rd, D_SUN), 0.0);
  col += vec3(1.0, 0.5, 0.25) * pow(sd, 8.0) * 0.8;
  col += vec3(1.0, 0.9, 0.7) * smoothstep(0.9993, 0.9996, sd) * 25.0;
  return col;
}

vec3 dSky(vec3 rd, float t) {
  vec3 col = dSkyBase(rd);
  col += stars(rd, 200.0, 0.03, t) * smoothstep(0.25, 0.7, rd.y) * 0.6;
  // ringed planet, far away in direction PC
  vec3 PC = normalize(vec3(0.42, 0.30, -1.0));
  vec3 C = PC * 100.0;
  float R = 100.0 * sin(0.2);
  vec3 rn = normalize(vec3(0.25, 1.0, 0.35));
  float b = dot(rd, C);
  float c = dot(C, C) - R * R;
  float disc = b * b - c;
  float tPl = disc > 0.0 ? b - sqrt(disc) : 1e9;
  float tRing = dot(C, rn) / dot(rd, rn);
  vec3 rp = rd * tRing - C;
  float rr = length(rp) / R;
  float ring = smoothstep(1.35, 1.4, rr) * smoothstep(2.3, 2.2, rr);
  ring *= 0.55 + 0.45 * sin(rr * 38.0) * sin(rr * 11.0 + 1.0);
  ring *= 0.75;
  vec3 ringCol = vec3(0.95, 0.82, 0.70);
  if (tPl < 1e8) {
    vec3 n = normalize(rd * tPl - C);
    float lit = clamp(dot(n, D_SUN) * 0.9 + 0.15, 0.0, 1.0);
    float bands = fbm(vec2(dot(n, rn) * 9.0, 0.0) + noise(n.xz * 4.0) * 0.3, 4);
    vec3 pc = mix(vec3(0.55, 0.62, 0.85), vec3(0.95, 0.88, 0.82), 0.5 + 0.5 * bands);
    vec3 pl = pc * (lit * vec3(1.3, 1.0, 0.85) + vec3(0.02, 0.02, 0.05));
    // ring shadow band on the planet
    pl *= 1.0 - 0.35 * smoothstep(0.02, 0.0, abs(dot(n, rn)) - 0.04);
    float atm = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    pl += vec3(0.6, 0.45, 0.8) * atm * 0.5;
    col = mix(col, pl, 0.94);
    if (tRing > 0.0 && tRing < tPl) col = mix(col, ringCol * (0.5 + 0.6 * lit), ring);
  } else if (tRing > 0.0) {
    col = mix(col, ringCol, ring * 0.9);
  }
  return col;
}

float dShadow(vec3 ro) {
  float res = 1.0, t = 0.3;
  for (int i = 0; i < 40; i++) {
    vec3 p = ro + D_SUN * t;
    float h = p.y - dH(p.xz, 4);
    res = min(res, 8.0 * h / t);
    t += clamp(h, 0.3, 4.0);
    if (res < 0.002 || p.y > 12.0) break;
  }
  return clamp(res, 0.0, 1.0);
}

vec4 wDunes(vec3 ro, vec3 rd, float t) {
  float d = dMarch(ro, rd, 600.0);
  if (d >= 600.0) return vec4(dSky(rd, t), 1e4);
  vec3 p = ro + rd * d;
  float e = max(0.003 * d, 0.01);
  vec3 n = normalize(vec3(dH(p.xz - vec2(e, 0.0), 8) - dH(p.xz + vec2(e, 0.0), 8), 2.0 * e,
                          dH(p.xz - vec2(0.0, e), 8) - dH(p.xz + vec2(0.0, e), 8)));
  float dif = clamp(dot(n, D_SUN), 0.0, 1.0);
  float sh = dShadow(p + n * 0.05);
  vec3 alb = vec3(0.78, 0.36, 0.18) * (0.85 + 0.15 * noise(p.xz * 0.2));
  vec3 lin = dif * sh * vec3(2.6, 1.5, 0.9);
  lin += (0.5 + 0.5 * n.y) * vec3(0.10, 0.09, 0.22);
  lin += pow(clamp(1.0 + dot(rd, n), 0.0, 1.0), 3.0) * vec3(0.5, 0.3, 0.3) * 0.4;
  vec3 col = alb * lin;
  col += vec3(1.0, 0.7, 0.5) * pow(clamp(dot(reflect(rd, n), D_SUN), 0.0, 1.0), 30.0) * 0.12 * sh;
  col = mix(col, dSkyBase(normalize(vec3(rd.x, 0.03, rd.z))), 1.0 - exp(-d * 0.0025));
  return vec4(col, d);
}

// ---------------------------------------------------------------- COSMOS
float ridged3(vec3 p, int oct) {
  float s = 0.0, a = 0.5, prev = 1.0;
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(noise3(p) * 2.0 - 1.0);
    n *= n;
    s += a * n * (0.5 + 0.5 * prev);
    prev = n;
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}

// A few bright stars with diffraction spikes.
vec3 brightStars(vec3 rd) {
  vec3 col = vec3(0.0);
  for (int i = 0; i < 28; i++) {
    vec3 h = hash33(vec3(float(i) * 7.31, 3.17, 11.9));
    vec3 s = normalize(hash33(vec3(float(i) * 1.37, 8.1, 2.9)) * 2.0 - 1.0);
    if (dot(rd, s) < 0.995) continue;
    vec3 e1 = normalize(cross(s, vec3(0.0, 1.0, 0.0)));
    vec3 e2 = cross(e1, s);
    vec3 o = rd - s;
    float x = dot(o, e1), y = dot(o, e2);
    float r2 = x * x + y * y;
    float mag = 0.25 + 0.75 * h.x * h.x;
    float core = exp(-r2 * 6e5) * 25.0 + exp(-sqrt(r2) * 260.0) * 0.5;
    float spikes = exp(-abs(x) * 1400.0) * exp(-abs(y) * 22.0) + exp(-abs(y) * 1400.0) * exp(-abs(x) * 22.0);
    vec3 tint = mix(vec3(0.7, 0.82, 1.0), vec3(1.0, 0.78, 0.58), h.y);
    col += tint * mag * (core + spikes * 2.5);
  }
  return col;
}

// Crisp nebula painted on the sky sphere (detail at any resolution).
vec3 nebulaSky(vec3 rd) {
  vec3 q = rd * 2.2;
  vec3 w = vec3(fbm3(q, 4), fbm3(q + 3.7, 4), fbm3(q + 8.1, 4)) - 0.5;
  vec3 qw = q + w * 2.2;
  float n = fbm3(qw * 1.3, 7);
  float fil = ridged3(qw * 2.0, 6);
  float neb = smoothstep(0.46, 0.74, n);
  float dust = smoothstep(0.50, 0.64, fbm3(qw * 2.6 + 9.0, 6)) * smoothstep(0.35, 0.6, n);
  float hue = noise3(qw * 1.3 + 4.0);
  vec3 ec = mix(vec3(1.0, 0.18, 0.36), vec3(0.16, 0.40, 1.0), smoothstep(0.42, 0.58, hue));
  ec = mix(ec, vec3(0.10, 0.95, 0.80), smoothstep(0.60, 0.72, hue) * 0.75);
  vec3 col = ec * (neb * 0.10 + pow(fil, 3.0) * neb * 1.6);
  col += vec3(1.0, 0.62, 0.35) * pow(fil, 6.0) * neb * 1.4;   // hot ridges
  col += stars(rd, 240.0, 0.06, 0.0) * 1.2 + stars(rd, 110.0, 0.02, 0.0) * 1.6;
  return col * (1.0 - dust * 0.92);
}

vec4 wCosmos(vec3 ro, vec3 rd, float t) {
  vec3 col = nebulaSky(rd) + brightStars(rd);
  // near wisps for parallax when flying through
  vec3 acc = vec3(0.0);
  float T = 1.0;
  float s = 1.0 + hash12(gl_FragCoord.xy) * 1.2;
  for (int i = 0; i < 28; i++) {
    vec3 p = ro + rd * s;
    vec3 q = p * 0.05 + vec3(0.0, 0.0, t * 0.004);
    float big = fbm3(q * 0.7, 3);
    float fil = ridged3(q * 2.2 + big, 4);
    float dens = smoothstep(0.5, 0.66, big) * pow(fil, 2.5) * 1.5;
    float hue = noise3(q * 0.6 + 4.0);
    vec3 ec = mix(vec3(1.0, 0.25, 0.42), vec3(0.25, 0.5, 1.0), smoothstep(0.35, 0.65, hue));
    float ds = 0.9 + s * 0.06;
    acc += T * ec * dens * ds * 0.05;
    T *= exp(-dens * 0.04 * ds);
    s += ds;
  }
  return vec4(col * T + acc, 1e4);
}

// ---------------------------------------------------------------- CLOUDS
// Daytime sea of cumulus seen from above. Density follows Schneider's Nubis
// recipe: baked Perlin-Worley base shape (uNoise) cut by a coverage map and a
// height profile, then eroded by finer Worley detail. Lighting marches toward
// the sun (Beer-Lambert, powder) with a 3-octave multiple-scattering estimate.
const vec3 C_SUN = normalize(vec3(0.55, 0.95, -1.0));
const float C_TOP = 60.0, C_BOT = -60.0;  // cloud layer, world y
const float C_SIGMA = 1.4;                // extinction per unit at density 1
const float C_BASE = 260.0;               // world units per base-noise tile
const float C_DETAIL = 40.0;              // world units per detail-noise tile

float cRemap(float x, float a, float b, float c, float d) { return c + (x - a) / (b - a) * (d - c); }

// Weather from a non-tiling 2D fbm (so the 3D noise tile never shows):
// x = coverage, y = cloud-top height fraction. Towers rise where cover peaks.
vec2 cWeather(vec2 xz) {
  float c = fbm(xz * 0.0032 + vec2(3.1, 7.7), 4);
  return vec2(clamp(0.36 + 0.8 * c, 0.0, 0.82), mix(0.34, 1.0, smoothstep(0.1, 0.5, c)));
}

// ero = detail erosion strength (0 skips the detail fetch).
float cDensity(vec3 p, vec3 wind, vec2 wx, float lod, float lodD, float ero) {
  float hf = (p.y - C_BOT) / (C_TOP - C_BOT);
  float cov = wx.x;
  float prof = smoothstep(0.0, 0.07, hf) * (1.0 - smoothstep(wx.y * 0.55, wx.y, hf));
  if (prof < 1.0 - cov) return 0.0;
  vec4 n = textureLod(uNoise, (p + wind) / C_BASE, lod);
  float wf = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float base = cRemap(n.r, wf - 1.0, 1.0, 0.0, 1.0);
  base = cRemap(base * prof, 1.0 - cov, 1.0, 0.0, 1.0) * cov;
  if (base <= 0.0) return 0.0;
  if (ero > 0.0) {
    vec4 d = textureLod(uNoise, (p + wind * 1.6) / C_DETAIL, lodD);
    float df = d.g * 0.625 + d.b * 0.25 + d.a * 0.125;
    df = mix(df, 1.0 - df, clamp(hf * 6.0, 0.0, 1.0));  // wispy bases, billowy tops
    base = cRemap(base, df * ero, 1.0, 0.0, 1.0);
  }
  return clamp(base * 1.8, 0.0, 1.0);  // firm interiors, crisp sunlit edges
}

vec3 cSkyBase(vec3 rd) {
  float yy = max(rd.y, 0.0);
  vec3 col = mix(vec3(0.30, 0.42, 0.62), vec3(0.012, 0.05, 0.24), sqrt(smoothstep(0.0, 0.6, yy)));
  float sd = max(dot(rd, C_SUN), 0.0);
  col += vec3(1.0, 0.92, 0.8) * pow(sd, 8.0) * 0.28;
  return col;
}

vec3 cSky(vec3 rd) {
  vec3 col = cSkyBase(rd);
  float sd = max(dot(rd, C_SUN), 0.0);
  col += vec3(1.0, 0.9, 0.7) * pow(sd, 350.0) * 1.6;
  col += vec3(1.0, 0.97, 0.9) * smoothstep(0.99955, 0.99975, sd) * 16.0;
  return col;
}

float cHG(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

vec4 wClouds(vec3 ro, vec3 rd, float t) {
  vec3 wind = vec3(t * 3.0, 0.0, t * 1.2);
  vec3 haze = cSkyBase(normalize(vec3(rd.x, 0.025, rd.z)));
  // Beyond the layer: sky above, a deep sea far below seen through the gaps.
  vec3 bg = cSky(rd);
  if (rd.y < 0.0) {
    float dg = (C_BOT - 400.0 - ro.y) / rd.y;
    vec3 ps = ro + rd * dg;
    // Cloud shadows on the sea: weather cover where the sun ray crosses the layer.
    vec2 sh = cWeather(ps.xz + C_SUN.xz * ((C_BOT + 30.0 - ps.y) / C_SUN.y) + wind.xz);
    vec3 sea = vec3(0.004, 0.022, 0.06) * (1.0 - 0.6 * smoothstep(0.15, 0.45, sh.x));
    bg = mix(sea, haze, 1.0 - exp(-dg * 0.00022));
  }
  float t0 = 0.0, t1 = 4000.0;
  if (abs(rd.y) > 1e-5) {
    float ta = (C_TOP - ro.y) / rd.y, tb = (C_BOT - ro.y) / rd.y;
    t0 = max(min(ta, tb), 0.0);
    t1 = min(max(ta, tb), t1);
  } else if (ro.y > C_TOP || ro.y < C_BOT) {
    t1 = -1.0;
  }
  if (t1 <= t0) return vec4(bg, 1e4);

  float mu = dot(rd, C_SUN);
  float ph0 = mix(cHG(mu, 0.8), cHG(mu, -0.2), 0.35);
  float ph1 = mix(cHG(mu, 0.4), cHG(mu, -0.1), 0.35);
  float ph2 = mix(cHG(mu, 0.2), cHG(mu, -0.05), 0.35);
  float powderAmt = 0.4 * (1.0 - mu);  // dark crinkled edges only when back-lit by us
  vec3 sun = vec3(1.0, 0.94, 0.84) * 10.0;

  float T = 1.0, first = 1e4, depth = 0.0, wsum = 0.0;
  vec3 L = vec3(0.0);
  // Interleaved-gradient dither: smoother than white noise at large steps.
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float s = t0 + jit * max(0.9, t0 * 0.011);
  float fine = 0.0;  // > 0 while resolving a cloud: empty fine steps left before going coarse
  for (int i = 0; i < 300; i++) {
    if (s > t1 || T < 0.015) break;
    float big = max(0.9, s * 0.011);
    float dt = fine > 0.0 ? big * 0.3 : big;
    vec3 p = ro + rd * s;
    vec2 wx = cWeather(p.xz + wind.xz);
    float lod = max(0.0, log2(dt / 3.75));
    float lodD = max(0.0, log2(s * 0.0012 / 0.41));
    float ero = 0.38 * (1.0 - smoothstep(1100.0, 2600.0, s));
    float den = cDensity(p, wind, wx, lod, lodD, ero);
    if (den > 0.0 && fine <= 0.0) {
      // First contact on a coarse step: back up and cross the edge finely.
      fine = 6.0;
      s = max(t0, s - big * 0.85);
      continue;
    }
    fine = den > 0.0 ? 6.0 : fine - 1.0;
    if (den > 0.0) {
      float od = 0.0, ls = 2.0, lx = 0.0;
      for (int j = 0; j < 5; j++) {
        od += cDensity(p + C_SUN * (lx + ls * 0.5), wind, wx, lod + 0.5, lodD + 0.5, j < 2 ? ero : 0.0) * ls;
        lx += ls;
        ls *= 1.8;
      }
      float tau = od * C_SIGMA;
      float hf = (p.y - C_BOT) / (C_TOP - C_BOT);
      vec3 S = sun * (exp(-tau) * ph0 + 0.5 * exp(-tau * 0.5) * ph1 + 0.25 * exp(-tau * 0.25) * ph2);
      S *= mix(1.0, 1.0 - exp(-tau * 2.0 - den * 3.0), powderAmt);
      vec3 amb = mix(vec3(0.02, 0.035, 0.075), vec3(0.10, 0.15, 0.27), clamp(hf * 1.3, 0.0, 1.0));
      float a = 1.0 - exp(-den * C_SIGMA * dt);
      L += T * (S + amb) * a;
      depth += T * a * s;
      wsum += T * a;
      T *= 1.0 - a;
      if (first > 1e3 && T < 0.5) first = s;
    }
    s += dt;
  }
  if (wsum > 0.0) {
    float fog = 1.0 - exp(-pow(depth / wsum * 0.0006, 1.2));
    L = mix(L, haze * (1.0 - T), fog);
  }
  return vec4(L + bg * T, first);
}

// ---------------------------------------------------------------- dispatch
// Sky only (no geometry): cheap stand-in for a world seen in a reflection.
vec3 worldSky(int id, vec3 rd, float t) {
  if (id == 0) return aSky(rd, t);
  if (id == 1) return oSky(rd, t);
  if (id == 2) return dSky(rd, t);
  if (id == 3) return nebulaSky(rd);
  return cSky(rd);
}

vec4 renderWorld(int id, vec3 ro, vec3 rd, float t) {
  if (id == 0) return wAurora(ro, rd, t);
  if (id == 1) return wOcean(ro, rd, t);
  if (id == 2) return wDunes(ro, rd, t);
  if (id == 3) return wCosmos(ro, rd, t);
  return wClouds(ro, rd, t);
}
`;
