import { describe, expect, it } from 'vitest';
import { profilePostUrl } from './profileLinks.js';

describe('profilePostUrl', () => {
  it('opens a public post by its path in the author scope', () => {
    expect(profilePostUrl({ id: 'p1', path: 'a/b.mp4', visibility: 'public' }, 'alice', 'posts'))
      .toBe('/reels?folder=ALL+FOLDERS&codec=all&sort=newest&play=a%2Fb.mp4&author=alice');
  });

  it('opens a private post by its id so the address-bar link works for others', () => {
    expect(profilePostUrl({ id: 'p2', path: 'a/c.mp4', visibility: 'private' }, 'alice', 'posts'))
      .toBe('/reels?folder=ALL+FOLDERS&codec=all&sort=newest&post=p2&author=alice');
  });
});
