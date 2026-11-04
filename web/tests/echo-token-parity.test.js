import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const tokensCss = read('../src/styles/tokens.css');
const reelsHtml = read('../../ui/assets/reels.html');
const canvasSource = read('../../ui/assets/vr_ui_canvas.js');

function declarations(block) {
  const out = {};
  for (const m of block.matchAll(/(--sx-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].replace(/\/\*.*?\*\//g, '').trim();
  }
  return out;
}

const canonical = declarations(tokensCss.match(/:root\s*\{([\s\S]*?)\n\}/)[1]);
const reelsBlock = reelsHtml.match(/<style>\s*\/\*[\s\S]*?\*\/\s*html\s*\{([\s\S]*?)\n  \}/)[1];
const reels = declarations(reelsBlock);

const norm = (v) => v.toLowerCase().replace(/\s+/g, ' ');

test('reels.html token block matches tokens.css', () => {
  const names = Object.keys(reels);
  assert.ok(names.length > 20);
  for (const name of names) {
    assert.ok(name in canonical, `${name} is not defined in tokens.css`);
    assert.equal(norm(reels[name]), norm(canonical[name]), name);
  }
});

test('reels.html keeps its token block inside the first bare <style>', () => {
  const first = reelsHtml.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.ok(first.includes('--sx-accent: #ff3b1f'));
});

function block(selector) {
  const start = tokensCss.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `${selector} block not found`);
  return declarations(tokensCss.slice(start, tokensCss.indexOf('\n}', start)));
}

const lightCss = block(':root:root');
const darkCss = { ...lightCss, ...block(":root[data-theme='dark']") };
const camelToCss = (k) => '--sx-' + k.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/([a-z])(\d)/g, '$1-$2').toLowerCase();
const HEX_KEYS = [
  'bg', 'surface', 'surface2', 'surface3', 'surfaceHover', 'rule', 'ruleStrong',
  'ink', 'ink2', 'ink3', 'inkMuted', 'accent', 'accentHi', 'onAccent',
  'spot', 'spotSoft', 'onSpot', 'onMedia',
  'success', 'successHi', 'warn', 'warnHi', 'danger', 'dangerHi', 'info', 'infoHi',
];

function checkSet(set, css) {
  const { hex, rgba, font, radius } = set;
  assert.deepEqual(Object.keys(hex), HEX_KEYS);
  for (const key of HEX_KEYS) assert.equal(norm(hex[key]), norm(css[camelToCss(key)]), key);
  assert.equal(norm(rgba.mediaScrim), norm(css['--sx-media-scrim']), 'mediaScrim');
  for (const [key, value] of Object.entries(font)) {
    assert.equal(norm(value), norm(css[`--sx-font-${key}`]), `font.${key}`);
  }
  assert.deepEqual(Object.keys(font), ['display', 'sans', 'mono', 'brand']);
  assert.equal(`${radius}px`, css['--sx-radius']);
  assert.ok(Object.isFrozen(set));
  assert.ok(Object.isFrozen(hex));
}

function loadCanvas() {
  const window = {};
  vm.runInNewContext(canvasSource, { window }, { filename: 'vr_ui_canvas.js' });
  return window.VRUICanvas;
}

test('VRUICanvas light tokens match the :root:root block', () => {
  checkSet(loadCanvas().TOKEN_SETS.light, lightCss);
});

test('VRUICanvas dark tokens match the dark block over the light one', () => {
  checkSet(loadCanvas().TOKEN_SETS.dark, darkCss);
});
