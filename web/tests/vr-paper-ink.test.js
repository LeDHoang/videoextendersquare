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
