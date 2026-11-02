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
    // Only the exact route depth is a page; anything deeper is the 404 page.
    for (const path of ['/profile/ana/x', '/packs/p1/x', '/packs/p1/edit/x', '/explore/tag/a/b', '/explore/location/k/x', '/messages/c1/x']) {
      expect(routeTitle(path)).toBe('Page not found');
    }
    expect(routeTitle('/packs/p1')).toBe('Reel pack');
    expect(routeTitle('/packs/p1/edit')).toBe('Edit reel pack');
    expect(routeTitle('/messages/c1')).toBe('Messages');
    expect(routeTitle('/explore/location/k')).toBe('Location');
    expect(routeTitle('/explore/tag/a')).toBe('#a');
  });
});
