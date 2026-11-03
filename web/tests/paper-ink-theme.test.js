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
