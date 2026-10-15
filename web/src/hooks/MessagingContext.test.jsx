import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagingProvider, mergeFirstPage, useMessaging } from './MessagingContext.jsx';

const mocks = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() }, user: { id: 'me' } }));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('./AuthContext.jsx', () => ({ useAuth: () => ({ user: mocks.user }) }));

const row = (id, updated) => ({ id, updated_at: updated, participant: { username: id } });
const ts = (n) => `2026-10-${String(30 - n).padStart(2, '0')}T00:00:00+00:00`; // n=0 newest

let latest;
function Probe() {
  latest = useMessaging();
  return null;
}

function mount() {
  return render(<MemoryRouter><MessagingProvider><Probe /></MessagingProvider></MemoryRouter>);
}

describe('mergeFirstPage', () => {
  it('returns the fresh page when nothing was paged in', () => {
    expect(mergeFirstPage([row('a', ts(1))], [row('b', ts(0))], false)).toEqual([row('b', ts(0))]);
  });

  it('keeps older rows paged in earlier and drops ones that moved into the fresh page', () => {
    const previous = [row('a', ts(1)), row('b', ts(2)), row('c', ts(3)), row('d', ts(4))];
    const fresh = [row('c', ts(0)), row('a', ts(1))];
    // c moved to the top; b and d are older than the fresh floor and stay once each.
    expect(mergeFirstPage(previous, fresh, true).map((r) => r.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('does not resurrect rows newer than the fresh page floor (they were removed)', () => {
    const previous = [row('gone', ts(1).replace('T00', 'T05')), row('old', ts(5))];
    const fresh = [row('n', ts(0)), row('m', ts(1))];
    expect(mergeFirstPage(previous, fresh, true).map((r) => r.id)).toEqual(['n', 'm', 'old']);
  });

  it('returns an empty fresh page as-is', () => {
    expect(mergeFirstPage([row('a', ts(1))], [], true)).toEqual([]);
  });
});

describe('MessagingProvider conversation paging', () => {
  afterEach(cleanup);

  beforeEach(() => {
    Object.values(mocks.api).forEach((fn) => fn.mockReset());
    mocks.user = { id: 'me' };
    mocks.api.get.mockImplementation((path, params) => {
      if (path === '/api/messages/capabilities') return Promise.resolve({ curated_emotes: [] });
      if (path === '/api/messages/bootstrap') {
        const { box, cursor } = params;
        if (box === 'requests') return Promise.resolve({ conversations: [], unread: { inbox: 0, requests: 0, total: 0 }, event_cursor: 1, next_cursor: null });
        if (!cursor) {
          return Promise.resolve({ conversations: [row('a', ts(0)), row('b', ts(1))], unread: { inbox: 0, requests: 0, total: 0 }, event_cursor: 1, next_cursor: 'page-2' });
        }
        if (cursor === 'page-2') {
          return Promise.resolve({ conversations: [row('b', ts(1)), row('c', ts(2))], unread: { inbox: 0, requests: 0, total: 0 }, event_cursor: 1, next_cursor: 'page-3' });
        }
        return Promise.resolve({ conversations: [row('d', ts(3))], unread: { inbox: 0, requests: 0, total: 0 }, event_cursor: 1, next_cursor: null });
      }
      return Promise.resolve({});
    });
  });

  it('exposes the first page and its next cursor', async () => {
    mount();
    await waitFor(() => expect(latest.inbox.map((r) => r.id)).toEqual(['a', 'b']));
    expect(latest.boxCursors).toEqual({ inbox: 'page-2', requests: null });
  });

  it('appends later pages without duplicates and ends when there is no cursor', async () => {
    mount();
    await waitFor(() => expect(latest.boxCursors.inbox).toBe('page-2'));
    await act(async () => { await latest.loadMoreBox('inbox'); });
    expect(latest.inbox.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(latest.boxCursors.inbox).toBe('page-3');
    await act(async () => { await latest.loadMoreBox('inbox'); });
    expect(latest.inbox.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(latest.boxCursors.inbox).toBeNull();
    const before = mocks.api.get.mock.calls.length;
    await act(async () => { await latest.loadMoreBox('inbox'); });
    expect(mocks.api.get.mock.calls.length).toBe(before); // nothing left to fetch
  });

  it('keeps paged-in conversations (and the cursor) when a live event refreshes the first page', async () => {
    mount();
    await waitFor(() => expect(latest.boxCursors.inbox).toBe('page-2'));
    await act(async () => { await latest.loadMoreBox('inbox'); });
    expect(latest.inbox.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    await act(async () => { await latest.refreshAll(); });
    expect(latest.inbox.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(latest.boxCursors.inbox).toBe('page-3');
  });

  it('ignores a second request while one is in flight', async () => {
    mount();
    await waitFor(() => expect(latest.boxCursors.inbox).toBe('page-2'));
    const calls = () => mocks.api.get.mock.calls.filter(([, p]) => p?.cursor === 'page-2').length;
    await act(async () => {
      await Promise.all([latest.loadMoreBox('inbox'), latest.loadMoreBox('inbox'), latest.loadMoreBox('inbox')]);
    });
    expect(calls()).toBe(1);
    expect(latest.inbox.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('surfaces a failed page request and allows a retry', async () => {
    mount();
    await waitFor(() => expect(latest.boxCursors.inbox).toBe('page-2'));
    const original = mocks.api.get.getMockImplementation();
    mocks.api.get.mockImplementation((path, params) => (params?.cursor === 'page-2' ? Promise.reject(new Error('down')) : original(path, params)));
    await act(async () => { await expect(latest.loadMoreBox('inbox')).rejects.toThrow('down'); });
    expect(latest.boxLoadingMore.inbox).toBe(false);
    expect(latest.boxCursors.inbox).toBe('page-2');
    mocks.api.get.mockImplementation(original);
    await act(async () => { await latest.loadMoreBox('inbox'); });
    expect(latest.inbox.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('does nothing when signed out', async () => {
    mocks.user = null;
    mount();
    await act(async () => { expect(await latest.loadMoreBox('inbox')).toBeNull(); });
    expect(mocks.api.get).not.toHaveBeenCalledWith('/api/messages/bootstrap', expect.anything());
  });
});
