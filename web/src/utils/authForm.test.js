import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PENDING_ACTION_KEY,
  describePending,
  normalizeUsername,
  passwordChecks,
  passwordStrength,
  readPendingAction,
  safeNext,
  validateEmail,
  validateNewPassword,
  validateUsername,
} from './authForm.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

describe('safeNext', () => {
  it('keeps same-site paths, including query strings', () => {
    expect(safeNext('/explore')).toBe('/explore');
    expect(safeNext('/profile/maker?tab=packs')).toBe('/profile/maker?tab=packs');
  });

  it('falls back to /reels for anything that is not a plain local path', () => {
    for (const bad of [undefined, null, '', 'explore', 'https://evil.test', '//evil.test', '/\\evil.test', '/ok\nbad', 42]) {
      expect(safeNext(bad)).toBe('/reels');
    }
  });

  it('never returns to an auth screen (that would bounce straight back)', () => {
    for (const path of ['/login', '/signup?next=/x', '/forgot-password', '/reset-password?token=abc', '/login#frag']) {
      expect(safeNext(path)).toBe('/reels');
    }
    // a path that merely starts with the same letters is fine
    expect(safeNext('/login-help')).toBe('/login-help');
  });
});

describe('normalizeUsername', () => {
  it('lowercases and drops whitespace but leaves other characters to the validator', () => {
    expect(normalizeUsername(' Echo Dev_1 ')).toBe('echodev_1');
    expect(normalizeUsername('A-B')).toBe('a-b');
    expect(normalizeUsername(undefined)).toBe('');
  });
});

describe('validators', () => {
  it('validateEmail', () => {
    expect(validateEmail('')).toMatch(/Enter your email/);
    expect(validateEmail('   ')).toMatch(/Enter your email/);
    expect(validateEmail('nope')).toMatch(/valid email/);
    expect(validateEmail('a@b')).toMatch(/valid email/);
    expect(validateEmail('a b@c.com')).toMatch(/valid email/);
    expect(validateEmail('  name@example.com ')).toBe('');
  });

  it('validateUsername mirrors the server rule (3–30 of a-z 0-9 _)', () => {
    expect(validateUsername('')).toMatch(/Choose/);
    expect(validateUsername('ab')).toMatch(/at least 3/);
    expect(validateUsername('abc')).toBe('');
    expect(validateUsername('a'.repeat(30))).toBe('');
    expect(validateUsername('a'.repeat(31))).toMatch(/at most 30/);
    expect(validateUsername('has-dash')).toMatch(/lowercase letters/);
    expect(validateUsername('Upper')).toMatch(/lowercase letters/);
    expect(validateUsername('ok_name_9')).toBe('');
  });

  it('validateNewPassword mirrors the server rule (10–128)', () => {
    expect(validateNewPassword('')).toMatch(/Choose/);
    expect(validateNewPassword('123456789')).toMatch(/at least 10/);
    expect(validateNewPassword('1234567890')).toBe('');
    expect(validateNewPassword('x'.repeat(128))).toBe('');
    expect(validateNewPassword('x'.repeat(129))).toMatch(/at most 128/);
  });
});

describe('password strength', () => {
  it('reports each rule independently', () => {
    expect(passwordChecks('short')).toEqual({ length: false, long: false, mixed: false });
    expect(passwordChecks('abcdefghij')).toEqual({ length: true, long: false, mixed: false });
    expect(passwordChecks('abcdefghij1!')).toEqual({ length: true, long: false, mixed: true });
    expect(passwordChecks('abcdefghijklmn')).toEqual({ length: true, long: true, mixed: false });
    expect(passwordChecks('x'.repeat(129)).length).toBe(false);
  });

  it('scores 0 until the server minimum is met, then up to 3', () => {
    expect(passwordStrength('')).toEqual({ score: 0, label: '' });
    expect(passwordStrength('short')).toEqual({ score: 0, label: 'TOO SHORT' });
    expect(passwordStrength('abcdefghij')).toEqual({ score: 1, label: 'MINIMUM MET' });
    expect(passwordStrength('abcdefghij1!')).toEqual({ score: 2, label: 'GOOD' });
    expect(passwordStrength('abcdefghijklm1!')).toEqual({ score: 3, label: 'STRONG' });
  });
});

describe('pending action', () => {
  beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  const store = (value) => sessionStorage.setItem(PENDING_ACTION_KEY, JSON.stringify(value));

  it('reads a fresh action and ignores expired, malformed or missing ones', () => {
    expect(readPendingAction()).toBeNull();
    store({ kind: 'like', post_id: 'p1', created_at: 1000 });
    expect(readPendingAction(1000 + 60_000)).toMatchObject({ kind: 'like' });
    expect(readPendingAction(1000 + 11 * 60_000)).toBeNull();
    sessionStorage.setItem(PENDING_ACTION_KEY, '{not json');
    expect(readPendingAction()).toBeNull();
    store({ created_at: Date.now() });
    expect(readPendingAction()).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(readPendingAction()).toBeNull();
  });

  it('describes only what the replay can actually perform', () => {
    expect(describePending(null)).toBeNull();
    expect(describePending({ kind: 'like', post_id: 'p' })).toBe('LIKE THAT POST');
    expect(describePending({ kind: 'save', post_id: 'p' })).toBe('SAVE THAT POST');
    expect(describePending({ kind: 'follow', username: 'maker' })).toBe('FOLLOW @MAKER');
    expect(describePending({ kind: 'comment', post_id: 'p', text: 'hi' })).toBe('POST YOUR COMMENT');
    expect(describePending({ kind: 'comment-like', comment_id: 'c' })).toBe('LIKE THAT COMMENT');
    // missing the field the replay needs, or an unknown kind: nothing will happen, so say nothing
    expect(describePending({ kind: 'like' })).toBeNull();
    expect(describePending({ kind: 'comment', post_id: 'p' })).toBeNull();
    expect(describePending({ kind: 'teleport' })).toBeNull();
  });
});
