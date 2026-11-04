import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');

test('the ECHO wordmark draws its outline echo from data-echo with empty alt text', () => {
  assert.match(css, /\.sx-wordmark::before \{[^}]*content: attr\(data-echo\) \/ "";/);
  assert.match(css, /\.sx-wordmark::before \{[^}]*-webkit-text-fill-color: transparent;/);
});

test('a single echo ripples out once each time the logo plays, so it shares its cooldown', () => {
  assert.match(css, /\.sx-echo-mark\.is-play ~ \.sx-wordmark::before \{\s*animation: sx-wordmark-pulse 950ms cubic-bezier\(0\.2, 0\.7, 0\.3, 1\);/);
  assert.doesNotMatch(css, /\.sx-wordmark::after/);
  assert.match(css, /@keyframes sx-wordmark-pulse \{\s*from \{ transform: scale\(1\); opacity: 0\.85; \}\s*to \{ transform: scale\(1\.4\); opacity: 0; \}/);
  assert.doesNotMatch(css, /:focus-visible\) \.sx-wordmark/);
});

test('the header logo stands as tall as the header controls, with the ECHO text grown to match', () => {
  assert.match(css, /\.sx-top-logo \{\s*height: var\(--sx-control-h-lg\);\s*width: var\(--sx-control-h-lg\);/);
  assert.match(css, /@media \(max-width: 640px\) \{[^@]*\.sx-top-logo \{\s*height: var\(--sx-control-h\);\s*width: var\(--sx-control-h\);/);
  assert.doesNotMatch(css, /\.sx-top-logo \{\s*height: \d+px;/);
  assert.match(css, /\.sx-top-brand \{\s*font-family: var\(--sx-font-brand\);\s*font-size: 2\.7rem;/);
  assert.match(css, /@media \(max-width: 640px\) \{[^@]*\.sx-top-brand \{\s*font-size: 2rem;/);
});
