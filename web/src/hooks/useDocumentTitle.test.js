import { describe, expect, it } from 'vitest';
import { routeTitle } from './useDocumentTitle.js';

describe('routeTitle', () => {
  it('names known pages', () => {
    expect(routeTitle('/explore')).toBe('Explore');
    expect(routeTitle('/profile/ana')).toBe('@ana');
  });

  it('keeps the bare brand for the root redirect', () => {
    expect(routeTitle('/')).toBe('');
  });

  it('calls an unknown address "Page not found", as the 404 page does', () => {
    expect(routeTitle('/no-such-page')).toBe('Page not found');
    expect(routeTitle('/explore/tag')).toBe('Page not found');
  });
});
