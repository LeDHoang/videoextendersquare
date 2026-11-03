import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import page from '../index.html?raw';
import { THEME_COLOR, THEME_KEY, applyTheme, useTheme } from './theme.js';

const html = document.documentElement;
let meta;

// Node's own `localStorage` shadows jsdom's and is unusable without a flag, so give tests a real one.
function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    clear: () => { data.clear(); },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  meta = document.createElement('meta');
  meta.name = 'theme-color';
  document.head.appendChild(meta);
});

afterEach(() => {
  meta.remove();
  localStorage.clear();
  delete html.dataset.theme;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('applyTheme', () => {
  it('sets the attribute and the browser colour', () => {
    applyTheme('dark');
    expect(html.dataset.theme).toBe('dark');
    expect(meta.getAttribute('content')).toBe('#0c0b09');
    applyTheme('light');
    expect(meta.getAttribute('content')).toBe('#f2ede3');
  });
});

describe('useTheme', () => {
  it('starts from the attribute the script set', () => {
    html.dataset.theme = 'dark';
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe('dark');
  });

  it('applies and remembers a choice', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current[1]('dark'));
    expect(html.dataset.theme).toBe('dark');
    expect(localStorage.getItem('sx.theme')).toBe('dark');
    expect(result.current[0]).toBe('dark');
  });

  it('still switches when storage throws', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useTheme());
    expect(() => act(() => result.current[1]('dark'))).not.toThrow();
    expect(html.dataset.theme).toBe('dark');
  });

  it('follows the OS until the viewer picks', () => {
    let onChange;
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: (_type, fn) => { onChange = fn; },
      removeEventListener: () => {},
    }));
    const { result } = renderHook(() => useTheme());
    act(() => onChange({ matches: true }));
    expect(result.current[0]).toBe('dark');
    expect(html.dataset.theme).toBe('dark');
    act(() => result.current[1]('light'));
    act(() => onChange({ matches: true }));
    expect(result.current[0]).toBe('light');
  });

  it('works without matchMedia', () => {
    expect(window.matchMedia).toBeUndefined();
    expect(() => renderHook(() => useTheme())).not.toThrow();
  });
});

it('index.html script uses the same key and colours', () => {
  expect(page).toContain(`getItem('${THEME_KEY}')`);
  expect(page).toContain(THEME_COLOR.light);
  expect(page).toContain(THEME_COLOR.dark);
  expect(page).toContain('<meta name="color-scheme" content="light dark" />');
});
