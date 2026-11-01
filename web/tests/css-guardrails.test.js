import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import stylelint from 'stylelint';

// stylelint.config.mjs bans colour literals, !important, outline: none and z-index numbers
// off the --sx-z-* scale. global.css broke these rules before they existed; this baseline
// holds those counts so they can only go down. When you remove some, lower the number here.
const BASELINE = {
  'src/styles/global.css': {
    'color-no-hex': 53,
    'function-disallowed-list': 48,
    'declaration-no-important': 152,
    'declaration-property-value-allowed-list': 25,
    'declaration-property-value-disallowed-list': 14,
  },
};

const cwd = fileURLToPath(new URL('..', import.meta.url));

test('stylelint findings in web/src never exceed the baseline, and the baseline stays tight', async () => {
  const { results } = await stylelint.lint({ files: 'src/**/*.css', cwd });
  assert.ok(results.length >= 2, 'expected tokens.css and global.css');
  for (const result of results) {
    const file = result.source.slice(cwd.length);
    const counts = {};
    for (const w of result.warnings) counts[w.rule] = (counts[w.rule] || 0) + 1;
    const allowed = BASELINE[file] || {};
    for (const rule of new Set([...Object.keys(counts), ...Object.keys(allowed)])) {
      const found = counts[rule] || 0;
      const limit = allowed[rule] || 0;
      assert.ok(found <= limit, `${file}: ${found} × ${rule}, baseline ${limit}. New CSS must follow the rule; npx stylelint "${file}" lists them.`);
      assert.equal(found, limit, `${file}: ${rule} went down to ${found}. Lower its baseline in tests/css-guardrails.test.js to ${found}.`);
    }
  }
});
