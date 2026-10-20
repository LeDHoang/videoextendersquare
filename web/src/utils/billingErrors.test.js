import { describe, expect, it } from 'vitest';
import { ApiError, parseRetryAfter } from '../api/client.js';
import { billingErrorMessage } from './billingErrors.js';

describe('billingErrorMessage', () => {
  it('asks the user to sign in on 401 / AUTH_REQUIRED', () => {
    expect(billingErrorMessage(new ApiError('Not authenticated', 401, 'AUTH_REQUIRED'))).toBe('Sign in to continue.');
    expect(billingErrorMessage(new ApiError('Not authenticated', 401, null))).toBe('Sign in to continue.');
  });

  it('explains QUEUE_FULL with the Retry-After wait', () => {
    expect(billingErrorMessage(new ApiError('queue full', 429, 'QUEUE_FULL', null, 30))).toBe(
      'Too many jobs are running — wait for one to finish. Try again in 30 seconds.',
    );
    expect(billingErrorMessage(new ApiError('queue full', 429, 'QUEUE_FULL', null, 120))).toBe(
      'Too many jobs are running — wait for one to finish. Try again in 2 minutes.',
    );
    expect(billingErrorMessage(new ApiError('queue full', 429, 'QUEUE_FULL'))).toBe(
      'Too many jobs are running — wait for one to finish. Try again shortly.',
    );
  });

  it('maps 507 / STORAGE_FULL to readable copy, not the raw server text', () => {
    const copy = 'The server is out of upload space right now. Try again later.';
    expect(billingErrorMessage(new ApiError('disk full: /data 99%', 507, 'STORAGE_FULL'))).toBe(copy);
    expect(billingErrorMessage(new ApiError('Insufficient Storage', 507, null))).toBe(copy);
  });

  it('uses Retry-After on a generic 429', () => {
    expect(billingErrorMessage(new ApiError('slow down', 429, null, null, 1))).toBe('Too many requests. Try again in 1 second.');
    expect(billingErrorMessage(new ApiError('slow down', 429, null))).toBe('Too many requests — wait a moment and retry.');
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('45')).toBe(45);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    const inOneMinute = new Date(Date.now() + 60_000).toUTCString();
    expect(parseRetryAfter(inOneMinute)).toBeGreaterThanOrEqual(59);
    expect(parseRetryAfter(inOneMinute)).toBeLessThanOrEqual(61);
  });
});
