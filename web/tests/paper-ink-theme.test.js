import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const tokensCss = read('../src/styles/tokens.css');

function declarations(block) {
  const out = {};
  for (const m of block.matchAll(/(--sx-[a-z0-9-]+|color-scheme)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].replace(/\/\*.*?\*\//g, '').trim();
  }
  return out;
}

function block(selector) {
  const start = tokensCss.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `${selector} block not found`);
  return declarations(tokensCss.slice(start, tokensCss.indexOf('\n}', start)));
}

// Highlighter and media colours read the same on paper and on carbon.
const SHARED = ['--sx-spot', '--sx-spot-soft', '--sx-on-spot', '--sx-on-media', '--sx-media-scrim'];

test('dark block redeclares every light colour except the shared ones', () => {
  const light = block(':root:root');
  const dark = block(":root[data-theme='dark']");
  const colours = Object.keys(light).filter(
    (name) => /#|rgba\(/.test(light[name]) && !SHARED.includes(name),
  );
  assert.equal(colours.length, 40);
  for (const name of colours) assert.ok(name in dark, `${name} has no dark value`);
  assert.equal(dark['color-scheme'], 'dark');
  assert.deepEqual(Object.keys(dark).sort(), [...colours, 'color-scheme'].sort());
});

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('text tokens reach 4.5:1 on every surface in both modes', () => {
  const inks = ['ink', 'ink-2', 'ink-3', 'ink-muted', 'accent', 'success', 'warn', 'danger', 'info'];
  for (const selector of [':root:root', ":root[data-theme='dark']"]) {
    const tokens = block(selector);
    for (const surface of ['bg', 'surface', 'surface-2']) {
      for (const ink of inks) {
        const [hi, lo] = [luminance(tokens[`--sx-${ink}`]), luminance(tokens[`--sx-${surface}`])].sort((a, b) => b - a);
        const ratio = (hi + 0.05) / (lo + 0.05);
        assert.ok(ratio >= 4.5, `${selector} ${ink} on ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test('icon re-ink rules apply in light mode only', () => {
  const editorialCss = read('../src/styles/editorial.css');
  const rules = editorialCss.split('\n').filter((line) => line.includes('svg:not(.sx-echo-mark'));
  assert.equal(rules.length, 5);
  for (const rule of rules) {
    assert.ok(rule.startsWith(":root:not([data-theme='dark']) svg:not("), `${rule} is not scoped to light mode`);
  }
});
