import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client.js';

function respond(status, statusText, body) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    json: async () => body,
  })));
}

describe('api errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the first field error from a request validation list', async () => {
    respond(422, 'Unprocessable Content', {
      detail: [{
        type: 'value_error',
        loc: ['body', 'email'],
        msg: 'value is not a valid email address: The part after the @-sign is a special-use or reserved name that cannot be used with email.',
      }],
    });

    const error = await api.post('/api/auth/register', {}).catch((caught) => caught);

    expect(error.status).toBe(422);
    expect(error.message).toBe('value is not a valid email address: The part after the @-sign is a special-use or reserved name that cannot be used with email.');
    expect(error.detail.field).toBe('email');
  });

  it('keeps the message and field of a structured error', async () => {
    respond(409, 'Conflict', { detail: { code: 'EMAIL_TAKEN', message: 'An account already uses this email.', field: 'email' } });

    const error = await api.post('/api/auth/register', {}).catch((caught) => caught);

    expect(error.code).toBe('EMAIL_TAKEN');
    expect(error.message).toBe('An account already uses this email.');
    expect(error.detail.field).toBe('email');
  });
});
