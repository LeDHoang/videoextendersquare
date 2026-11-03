import { useCallback, useEffect, useRef, useState } from 'react';

// Light or dark Paper & Ink. The inline script in index.html sets <html data-theme>
// before first paint from the same key, so these two must stay in step with it.
export const THEME_KEY = 'sx.theme';
export const THEME_COLOR = { light: '#f2ede3', dark: '#0c0b09' };

export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

function savedTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null;
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState(currentTheme);
  // Until the viewer picks, the page follows the OS appearance.
  const picked = useRef(savedTheme() !== null);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event) => {
      if (picked.current) return;
      const next = event.matches ? 'dark' : 'light';
      applyTheme(next);
      setThemeState(next);
    };
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  // Another switch (the VR nav bar) changed the attribute: follow it. Never write
  // data-theme here, or the observer would loop.
  useEffect(() => {
    if (typeof MutationObserver !== 'function') return undefined;
    const observer = new MutationObserver(() => {
      const next = currentTheme();
      if (savedTheme() !== null) picked.current = true;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[next]);
      setThemeState(next);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const setTheme = useCallback((next) => {
    picked.current = true;
    applyTheme(next);
    setThemeState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable — the choice lasts for this visit only */
    }
  }, []);

  return [theme, setTheme];
}
