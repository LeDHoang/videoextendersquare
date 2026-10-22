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

test('VRUICanvas.TOKENS matches tokens.css', () => {
  const window = {};
  vm.runInNewContext(canvasSource, { window }, { filename: 'vr_ui_canvas.js' });
  const { hex, font, radius } = window.VRUICanvas.TOKENS;
  assert.equal(radius, 0);
  assert.ok(Object.isFrozen(window.VRUICanvas.TOKENS));
  const camelToCss = (k) => '--sx-' + k.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/([a-z])(\d)/g, '$1-$2').toLowerCase();
  for (const [key, value] of Object.entries(hex)) {
    const css = camelToCss(key);
    assert.ok(css in canonical, `${key} -> ${css} missing in tokens.css`);
    assert.equal(norm(value), norm(canonical[css]), key);
  }
  for (const [key, value] of Object.entries(font)) {
    assert.equal(norm(value), norm(canonical[`--sx-font-${key}`]), `font.${key}`);
  }
});
