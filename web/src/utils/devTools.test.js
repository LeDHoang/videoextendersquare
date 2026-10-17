import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideDevTools } from './devTools.js';

afterEach(() => vi.unstubAllEnvs());

describe('hideDevTools', () => {
  it('is off by default', () => {
    expect(hideDevTools()).toBe(false);
  });

  it('is on only for the exact string "true"', () => {
    vi.stubEnv('VITE_SX_HIDE_DEV_TOOLS', 'true');
    expect(hideDevTools()).toBe(true);
    vi.stubEnv('VITE_SX_HIDE_DEV_TOOLS', '1');
    expect(hideDevTools()).toBe(false);
    vi.stubEnv('VITE_SX_HIDE_DEV_TOOLS', 'false');
    expect(hideDevTools()).toBe(false);
  });
});
