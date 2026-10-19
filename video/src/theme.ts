// Design tokens copied from web/src/styles/tokens.css so the video looks like the app.
import { loadFont as loadArchivoBlack } from '@remotion/google-fonts/ArchivoBlack';
import { loadFont as loadArchivo } from '@remotion/google-fonts/Archivo';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { loadFont as loadOrbitron } from '@remotion/google-fonts/Orbitron';
import { loadFont as loadSerif } from '@remotion/google-fonts/InstrumentSerif';

const display = loadArchivoBlack('normal', { weights: ['400'], subsets: ['latin'] });
const sans = loadArchivo('normal', { weights: ['400', '600'], subsets: ['latin'] });
const mono = loadMono('normal', { weights: ['400', '700'], subsets: ['latin'] });
const brand = loadOrbitron('normal', { weights: ['700', '900'], subsets: ['latin'] });
// Vision cut: italic serif for the poetic lines.
const serif = loadSerif('normal', { weights: ['400'], subsets: ['latin'] });
loadSerif('italic', { weights: ['400'], subsets: ['latin'] });

export const C = {
  bg: '#08090a',
  surface: '#101214',
  surface2: '#16191c',
  rule: '#24282d',
  ruleStrong: '#3a4047',
  ink: '#f2f3f5',
  ink2: '#a4abb3',
  ink3: '#8e959e',
  accent: '#ff3b1f',
  accentHi: '#ff5c42',
  accentGlow: 'rgba(255, 59, 31, 0.35)',
  accentDim: 'rgba(255, 59, 31, 0.12)',
  cyan: '#2ee6ff',
  navy: '#050a1a',
  navy2: '#0b1530',
} as const;

export const F = {
  display: display.fontFamily,
  sans: sans.fontFamily,
  mono: mono.fontFamily,
  brand: brand.fontFamily,
  serif: serif.fontFamily,
} as const;

// Placeholder contact line. Replace before public use.
export const CONTACT = 'echo.example  ·  hello@echo.example';
