import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../ui/assets/vr_ui_canvas.js', import.meta.url), 'utf8');

function load() {
  const window = {};
  vm.runInNewContext(source, { window }, { filename: 'vr_ui_canvas.js' });
  return window.VRUICanvas;
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// rgba(r, g, b, a) composited over white, as #rrggbb.
function overWhite(rgba) {
  const [r, g, b, a] = rgba.match(/[\d.]+/g).map(Number);
  return '#' + [r, g, b].map((c) => Math.round(c * a + 255 * (1 - a)).toString(16).padStart(2, '0')).join('');
}

test('setTheme swaps the active set', () => {
  const api = load();
  assert.equal(api.getTheme(), 'light');
  assert.equal(api.TOKENS, api.TOKEN_SETS.light);
  assert.equal(api.setTheme('dark'), true);
  assert.equal(api.TOKENS, api.TOKEN_SETS.dark);
  assert.equal(api.getTheme(), 'dark');
  assert.equal(api.setTheme('dark'), false);
  assert.equal(api.setTheme('sepia'), true);
  assert.equal(api.getTheme(), 'light');
  assert.equal(api.TOKENS, api.TOKEN_SETS.light);
});

test('VR text pairs reach 4.5:1 in both modes', () => {
  const api = load();
  for (const mode of ['light', 'dark']) {
    const { hex, rgba } = api.TOKEN_SETS[mode];
    const pairs = [];
    for (const fg of ['ink', 'ink2', 'ink3', 'inkMuted', 'success', 'warn']) {
      for (const bg of ['surface3', 'surfaceHover']) pairs.push([fg, hex[fg], bg, hex[bg]]);
    }
    for (const bg of ['accent', 'accentHi']) pairs.push(['onAccent', hex.onAccent, bg, hex[bg]]);
    pairs.push(['onSpot', hex.onSpot, 'spot', hex.spot]);
    pairs.push(['onMedia', hex.onMedia, 'mediaScrim over white', overWhite(rgba.mediaScrim)]);
    for (const [fg, fgHex, bg, bgHex] of pairs) {
      const r = ratio(fgHex, bgHex);
      assert.ok(r >= 4.5, `${mode} ${fg} on ${bg} is ${r.toFixed(2)}:1`);
    }
  }
});

// ─── Task 2: the 2D canvas panels ───────────────────────────────────

const CARBON = [
  '#08090a', '#101214', '#16191c', '#1d2126', '#24282d', '#3a4047', '#f2f3f5', '#a4abb3',
  '#8e959e', '#646b74', '#0a0a0a', 'JetBrains Mono', 'Archivo', 'Orbitron', '#39D7FF', '#4FE3C1',
  '#FFC857', '#FF8A5B', '#121315', '#1c1d1f', '#ff6a52', '#061D37', 'rgba(13, 14, 15', 'rgba(2,6,14',
  '0x020612', '0x0d2a3f', '0x39d7ff',
];

// Records every fill, fillRect and fillText with the fillStyle and font in force.
function recordingCtx() {
  const fills = [];
  const texts = [];
  const fonts = new Set();
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop === 'fill') return () => fills.push({ style: target.fillStyle });
      if (prop === 'fillRect') return () => fills.push({ style: target.fillStyle });
      if (prop === 'fillText') {
        return (text) => {
          texts.push({ text: String(text), style: target.fillStyle, font: target.font, before: fills.length ? fills[fills.length - 1].style : null });
        };
      }
      if (prop === 'measureText') return (value) => ({ width: String(value).length * 8 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (!(prop in target)) target[prop] = () => {};
      return target[prop];
    },
    set(target, prop, value) {
      if (prop === 'font') fonts.add(value);
      target[prop] = value;
      return true;
    },
  });
  return { ctx, fills, texts, fonts };
}

const PLAYLIST = [{
  title: 'Neon rain over the Shibuya crossing at midnight',
  caption: 'Shot handheld from the window as the lights changed.',
  creator: { username: 'echo_archive', display_name: 'echo_archive' },
  created_at: new Date(Date.now() - 64 * 86400000).toISOString(),
  tags: ['tokyo', 'night'],
  location: { city: 'Tokyo', country: 'Japan' },
  duration_ms: 15000, likes: 1840, views: 42200,
}];
const COMMENTS = [
  { id: 'c1', author_name: 'mika', avatar_color: '#ff3b1f', text: 'The lantern reflections', timestamp: 1, likes: 3, liked_by_me: false },
  { id: 'c2', author_name: 'dev ray', avatar_color: '#3b82f6', text: 'Is this stitched?', timestamp: null, likes: 0, liked_by_me: true },
];

function dockArgs(earth, extra = {}) {
  return {
    source: { paused: true, muted: true, currentTime: 5, duration: 42, kind: 'video' },
    itemState: { available: true, liked: false, saved: false, following: false },
    sceneMode: earth ? 'earth' : 'reels',
    packMode: false,
    playlist: PLAYLIST, idx: 0, item: PLAYLIST[0], comments: COMMENTS,
    hoveredButton: -1, pressedButton: -1, isCurved: true, curvatureMode: 1, lockToViewer: false, autoNext: true,
    earth: earth ? { tier: 'CITY', tierColor: '#ffc857', zoomPct: 72, scaleCaption: '5 KM', mapStatus: 'STREAMING 60%', mapOffline: false, location: 'HANOI', northUp: true, canOpenFeed: true } : null,
    stereo: 'mono',
    ...extra,
  };
}

const PANELS = {
  'controls dock': (api, ctx) => api.renderControlsCanvas(ctx, dockArgs(false)),
  'earth dock': (api, ctx) => api.renderControlsCanvas(ctx, dockArgs(true)),
  'comments panel': (api, ctx) => api.renderCommentsPanelCanvas(ctx, { comments: COMMENTS, cPanelTab: 'all', cPanelScrollY: 0, cPanelHover: '', cPanelHighlightId: null, user: null, currentTime: 3, item: PLAYLIST[0], itemState: { available: true, following: false } }),
  guide: (api, ctx) => api.renderGuideCanvas(ctx),
  'earth label': (api, ctx) => api.renderEarthLabelCanvas(ctx, { title: 'WORLD · 72%', detail: '24 ZONES', zoomed: true, zoomPct: 72, featured: false, offline: false, scaleBar: { pixels: 120, caption: '5 KM' }, scale: 60, streaming: 0.6, hint: '', resetEnabled: true, resetHot: false }),
  'earth card': (api, ctx) => api.renderEarthPreviewCanvas(ctx, { location: { name: 'Hanoi', slug: 'hanoi', heat: 0.72, active_reel_count: 18 }, earthPreviewStatus: 'ready', earthPreviewItems: PLAYLIST, earthPreviewIndex: 0, earthPreviewPosters: [], earthPreviewHover: '', reducedMotion: false, time: 0 }),
  overlay: (api, ctx) => api.renderOverlayCanvas(ctx, { comments: COMMENTS, currentTime: 1, overlayHoverId: null }),
};

test('vr_ui_canvas.js paints no carbon literal', () => {
  const start = source.indexOf('function drawQuestController');
  assert.ok(start > 0);
  // The controller art ends at the next top-level function in the module.
  const end = source.indexOf('\n  function ', start + 10);
  const rest = (source.slice(0, start) + source.slice(end)).toLowerCase();
  for (const lit of CARBON) assert.ok(!rest.includes(lit.toLowerCase()), `carbon literal ${lit} remains`);
});

test('VR panels use the paper fonts', () => {
  for (const mode of ['light', 'dark']) {
    for (const [name, render] of Object.entries(PANELS)) {
      const api = load();
      api.setTheme(mode);
      const rec = recordingCtx();
      render(api, rec.ctx);
      for (const font of rec.fonts) {
        assert.ok(!/JetBrains Mono|Archivo|Orbitron/.test(font), `${mode} ${name}: ${font}`);
        if (/IBM Plex Mono/.test(font)) {
          const w = /^\s*(?:italic\s+)?(bold|\d{3})\b/.exec(font);
          const weight = w ? (w[1] === 'bold' ? 700 : Number(w[1])) : 400;
          assert.ok(weight <= 600, `${mode} ${name}: mono weight ${weight} in ${font}`);
        }
      }
    }
  }
});

test('panels paint their base in the mode\'s surface', () => {
  for (const mode of ['light', 'dark']) {
    const other = mode === 'light' ? 'dark' : 'light';
    for (const [name, render] of Object.entries(PANELS)) {
      if (name === 'overlay') continue;
      const api = load();
      api.setTheme(mode);
      const rec = recordingCtx();
      render(api, rec.ctx);
      const styles = rec.fills.map((f) => f.style);
      assert.ok(styles.includes(api.TOKEN_SETS[mode].hex.surface), `${mode} ${name} has no surface fill`);
      assert.ok(!styles.includes(api.TOKEN_SETS[other].hex.surface), `${mode} ${name} paints ${other} surface`);
    }
  }
});

test('hover and pressed fills carry ink text only', () => {
  for (const mode of ['light', 'dark']) {
    const api = load();
    api.setTheme(mode);
    const { hex } = api.TOKEN_SETS[mode];
    const allowed = [hex.ink, hex.ink2, hex.ink3, hex.inkMuted, hex.success, hex.warn];
    const buttons = api.CTRL_BUTTONS;
    for (const earth of [false, true]) {
      for (let i = 0; i < buttons.length; i++) {
        const rec = recordingCtx();
        api.renderControlsCanvas(rec.ctx, dockArgs(earth, { hoveredButton: i, pressedButton: i }));
        for (const t of rec.texts) {
          if (t.before === hex.surface3 || t.before === hex.surfaceHover) {
            assert.ok(allowed.includes(t.style), `${mode} dock ${earth ? 'earth' : 'reels'} btn ${buttons[i].label}: "${t.text}" ${t.style} on ${t.before}`);
          }
        }
      }
    }
    for (const hover of ['close', 'sync', 'follow', 'seek:c1', 'like:c1', 'add']) {
      const rec = recordingCtx();
      api.renderCommentsPanelCanvas(rec.ctx, { comments: COMMENTS, cPanelHover: hover, currentTime: 3, item: PLAYLIST[0], itemState: { available: true, following: false } });
      for (const t of rec.texts) {
        if (t.before === hex.surface3 || t.before === hex.surfaceHover) {
          assert.ok(allowed.includes(t.style), `${mode} comments hover ${hover}: "${t.text}" ${t.style}`);
        }
      }
    }
  }
});

test('roundRectPath builds a path without filling or stroking', () => {
  const api = load();
  const calls = [];
  const ctx = new Proxy({}, { get: (_, p) => (...a) => calls.push([p, ...a]) });
  api.roundRectPath(ctx, 0, 0, 100, 40, 8);
  assert.ok(calls.some((c) => c[0] === 'beginPath' || c[0] === 'roundRect' || c[0] === 'moveTo'));
  assert.ok(!calls.some((c) => c[0] === 'fill' || c[0] === 'stroke'));
});

test('EARTH_TIERS carry tone, not colour', () => {
  const api = load();
  assert.deepEqual([...api.EARTH_TIERS.map((t) => `${t.name}|${t.tone}`)], ['ORBIT|info', 'REGION|success', 'CITY|warn', 'STREET|accent']);
  for (const t of api.EARTH_TIERS) assert.equal(t.color, undefined);
});

// ─── Task 4: the font gate ──────────────────────────────────────────

// The module sees the (mockable) global setTimeout through the context.
function loadWithTimers() {
  const window = {};
  vm.runInNewContext(source, {
    window,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  }, { filename: 'vr_ui_canvas.js' });
  return window.VRUICanvas;
}

// A font set whose load settles when the test says so.
function deferredFonts() {
  const loads = [];
  let settle;
  const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  return {
    loads,
    settle,
    fontSet: { load(font) { loads.push(font); return done; } },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('fonts: no font set paints at once', () => {
  const api = load();
  let calls = 0;
  api.waitForFonts(undefined, 3000, () => { calls += 1; });
  assert.equal(calls, 1);
  api.waitForFonts({}, 3000, () => { calls += 1; });
  assert.equal(calls, 2);
});

test('fonts: a fast load paints once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = loadWithTimers();
  const { loads, settle, fontSet } = deferredFonts();
  let calls = 0;
  api.waitForFonts(fontSet, 3000, () => { calls += 1; });
  assert.deepEqual(loads, ['16px Fraunces', "16px 'Instrument Sans'", "600 16px 'IBM Plex Mono'"]);
  assert.equal(calls, 0);
  settle.resolve([]);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(3000);
  assert.equal(calls, 1);
});

test('fonts: a slow load paints at the timeout and again on arrival', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = loadWithTimers();
  const { settle, fontSet } = deferredFonts();
  let calls = 0;
  api.waitForFonts(fontSet, 3000, () => { calls += 1; });
  t.mock.timers.tick(2999);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
  settle.resolve([]);
  await flush();
  assert.equal(calls, 2);
});

test('fonts: a rejected load paints once and does not throw', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = loadWithTimers();
  const { settle, fontSet } = deferredFonts();
  let calls = 0;
  assert.doesNotThrow(() => api.waitForFonts(fontSet, 3000, () => { calls += 1; }));
  settle.reject(new Error('font blocked'));
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(3000);
  assert.equal(calls, 1);
});
