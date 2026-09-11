import test from 'node:test';
import assert from 'node:assert/strict';
import { profilePostUrl } from '../src/utils/profileLinks.js';

test('regular profile posts stay scoped to their creator', () => {
  const url = new URL(profilePostUrl({ path: 'uploads/a.mp4' }, 'alice', 'all'), 'https://echo.test');
  assert.equal(url.searchParams.get('author'), 'alice');
  assert.equal(url.searchParams.get('play'), 'uploads/a.mp4');
});

test('saved posts are not incorrectly scoped to the profile owner', () => {
  const url = new URL(profilePostUrl({ path: 'uploads/b.mp4' }, 'alice', 'saved'), 'https://echo.test');
  assert.equal(url.searchParams.has('author'), false);
  assert.equal(url.searchParams.get('play'), 'uploads/b.mp4');
});
