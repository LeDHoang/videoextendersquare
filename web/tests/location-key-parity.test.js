import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every JS copy of the place-key slug must match tests/fixtures/location_keys.json.
// JS \w is ASCII-only, so an old copy turns "São Paulo" into "s-o-paulo" and the page shows nothing.
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/location_keys.json'), 'utf8'));

test('the 2D player side chip builds the same place keys as the server', () => {
  const html = readFileSync(join(root, 'ui/assets/reels.html'), 'utf8');
  const src = html.match(/function placeSlug\(value\) \{[\s\S]*?\n {4}\}\n {4}function placeKeyFor\(location\) \{[\s\S]*?\n {4}\}/);
  assert.ok(src, 'placeSlug/placeKeyFor not found in reels.html');
  const placeKeyFor = new Function(src[0] + '\nreturn placeKeyFor;')();
  for (const row of fixture.cases) {
    assert.equal(placeKeyFor({ city: row.city, country: row.country }), row.client_slug || row.slug, row.label);
  }
});

test('no JS slug builder uses the ASCII-only \\w class', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(js|jsx|html)$/.test(name) && !/\.test\.js$/.test(name)) files.push(path);
    }
  };
  walk(join(root, 'ui/assets'));
  walk(join(root, 'web/src'));
  const offenders = files.filter((path) => readFileSync(path, 'utf8').includes("replace(/[^\\w]+|_+/g, '-')"));
  assert.deepEqual(offenders, []);
});
