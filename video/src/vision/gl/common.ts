// Shared GLSL: hashes, value noise (with analytic derivatives), fbm, stars, tonemap.
export const COMMON = /* glsl */ `
#define PI 3.14159265359
#define TAU 6.28318530718

const mat2 M2 = mat2(0.80, 0.60, -0.60, 0.80);

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

// Value noise in [-1, 1] with derivatives: returns (value, d/dx, d/dy).
vec3 noised(vec2 x) {
  vec2 p = floor(x);
  vec2 f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = hash12(p);
  float b = hash12(p + vec2(1.0, 0.0));
  float c = hash12(p + vec2(0.0, 1.0));
  float d = hash12(p + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(-1.0 + 2.0 * (a + k1 * u.x + k2 * u.y + k4 * u.x * u.y),
              2.0 * du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}
float noise(vec2 x) { return noised(x).x; }

float noise3(vec3 x) {
  vec3 p = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(p), n100 = hash13(p + vec3(1, 0, 0));
  float n010 = hash13(p + vec3(0, 1, 0)), n110 = hash13(p + vec3(1, 1, 0));
  float n001 = hash13(p + vec3(0, 0, 1)), n101 = hash13(p + vec3(1, 0, 1));
  float n011 = hash13(p + vec3(0, 1, 1)), n111 = hash13(p + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float fbm(vec2 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * noise(p);
    p = M2 * p * 2.03;
    a *= 0.5;
  }
  return s;
}
float fbm3(vec3 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    s += a * noise3(p);
    p = p * 2.02 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}

// Point stars on the view sphere. density ~ fraction of cells that hold a star.
vec3 stars(vec3 rd, float scale, float density, float t) {
  vec3 col = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    float sc = scale * (k == 0 ? 1.0 : 2.3);
    vec3 p = rd * sc;
    vec3 id = floor(p);
    vec3 f = fract(p) - 0.5;
    vec3 h = hash33(id + float(k) * 17.0);
    if (h.x > 1.0 - density) {
      vec3 c = (h - 0.5) * 0.7;
      float d = length(f - c);
      float tw = 0.65 + 0.35 * sin(t * (1.5 + 3.0 * h.y) + h.z * 40.0);
      float b = exp(-d * d * (k == 0 ? 220.0 : 420.0)) * tw * (0.4 + 1.6 * h.y * h.y);
      col += b * mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.85, 0.7), h.z);
    }
  }
  return col;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

mat3 camBasis(vec3 rot) {
  // rot = (yaw, pitch, roll); yaw 0 looks down -z
  float cy = cos(rot.x), sy = sin(rot.x);
  float cp = cos(rot.y), sp = sin(rot.y);
  vec3 fw = normalize(vec3(-sy * cp, sp, -cy * cp));
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  float cr = cos(rot.z), sr = sin(rot.z);
  vec3 r2 = rt * cr + up * sr;
  vec3 u2 = up * cr - rt * sr;
  return mat3(r2, u2, fw);
}
`;
