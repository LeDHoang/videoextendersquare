// Dev-only palette preview. `?palette=violet` (or the picker in the corner) swaps the colour
// tokens for one of the test palettes in palettes.css; `?palette=current` goes back.
// Not wired to the backend or user settings: the choice lives in sessionStorage only.
import './palettes.css';

const PALETTES = ['current', 'violet', 'plum', 'lavender', 'periwinkle', 'wine', 'mulberry', 'indigo', 'slate', 'oxblood', 'cocoa', 'graphite'];
const KEY = 'sx-palette-preview';
const VERMILION = /rgba?\(\s*255,\s*59,\s*31(\s*,\s*([\d.]+))?\s*\)/g;

function apply(name) {
  const root = document.documentElement;
  if (name === 'current') delete root.dataset.palette;
  else root.dataset.palette = name;
  try { sessionStorage.setItem(KEY, name); } catch { /* private mode */ }
}

// global.css still has ~40 hard-coded vermilion rgba() glows and borders. Point them at
// --sx-accent-rgb so they follow whichever palette is active.
function retintHardcodedAccent() {
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.cssRules) walk(rule.cssRules);
      if (!rule.style || !rule.style.cssText.includes('255, 59, 31')) continue;
      // A shorthand that already holds a var() keeps its value on the shorthand only, so check those too.
      for (const prop of [...Array.from(rule.style), 'background', 'border']) {
        const value = rule.style.getPropertyValue(prop);
        if (!value.includes('255, 59, 31')) continue;
        const next = value.replace(VERMILION, (_, __, alpha) =>
          alpha ? `rgba(var(--sx-accent-rgb), ${alpha})` : 'rgb(var(--sx-accent-rgb))');
        rule.style.setProperty(prop, next, rule.style.getPropertyPriority(prop));
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules); } catch { /* cross-origin font sheets */ }
  }
}

function mountPicker(current) {
  const select = document.createElement('select');
  select.className = 'sx-palette-picker';
  select.setAttribute('aria-label', 'Preview palette');
  for (const name of PALETTES) select.add(new Option(name, name, false, name === current));
  select.addEventListener('change', () => apply(select.value));
  document.body.appendChild(select);
}

let stored = null;
try { stored = sessionStorage.getItem(KEY); } catch { /* private mode */ }
const requested = new URLSearchParams(window.location.search).get('palette') || stored || 'current';
const initial = PALETTES.includes(requested) ? requested : 'current';

retintHardcodedAccent();
apply(initial);
mountPicker(initial);
