// CSS guardrails. global.css still breaks these rules in places it did before they
// existed; tests/css-guardrails.test.js holds those counts as a baseline that can
// only go down, so new code has to follow the rules.
export default {
  rules: {
    'declaration-no-important': true,
    // Colours come from tokens.css.
    'color-no-hex': true,
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla'],
    // A focus style replaces the outline; it is never just removed.
    'declaration-property-value-disallowed-list': { outline: ['none', '0'] },
    // Page-level layers use the --sx-z-* scale; small numbers stack inside a component.
    'declaration-property-value-allowed-list': {
      'z-index': ['/^var\\(--sx-z-[a-z-]+\\)$/', '/^-?[0-9]$/', 'auto'],
    },
  },
  overrides: [
    {
      files: ['src/styles/tokens.css'],
      rules: { 'color-no-hex': null, 'function-disallowed-list': null },
    },
  ],
};
