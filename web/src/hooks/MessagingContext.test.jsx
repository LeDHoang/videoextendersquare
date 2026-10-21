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

describe('MessagingProvider send reconcile', () => {
  afterEach(cleanup);

  const mine = (id, extra = {}) => ({ id, conversation_id: 'c1', sender_id: 'me', kind: 'text', content: { text: id }, ...extra });
  let history;

  beforeEach(() => {
    Object.values(mocks.api).forEach((fn) => fn.mockReset());
    mocks.user = { id: 'me' };
    history = [];
    mocks.api.get.mockImplementation((path) => {
      if (path === '/api/messages/capabilities') return Promise.resolve({ curated_emotes: [] });
      if (path === '/api/messages/bootstrap') {
        return Promise.resolve({ conversations: [], unread: { inbox: 0, requests: 0, total: 0 }, event_cursor: 1, next_cursor: null });
      }
      if (path === '/api/messages/conversations/c1/messages') return Promise.resolve({ messages: history, next_before: null });
      return Promise.resolve({});
    });
  });

  const deferredPost = () => {
    let resolve;
    mocks.api.post.mockImplementation((path) => {
      if (path.endsWith('/read')) return Promise.resolve({});
      return new Promise((done) => { resolve = done; });
    });
    return (value) => resolve(value);
  };

  it('keeps one bubble when the message is already in the conversation before the POST resolves', async () => {
    mount();
    await waitFor(() => expect(latest.capabilities).not.toBeNull());
    const resolvePost = deferredPost();
    act(() => latest.composeTo('alice'));
    let sending;
    await act(async () => { sending = latest.send({ text: 'hello', client_id: 'client-hello-1' }); });
    history = [mine('m1', { content: { text: 'hello' } })];
    await act(async () => { await latest.loadConversation('c1'); });
    await act(async () => {
      resolvePost({ conversation: { id: 'c1' }, message: mine('m1', { content: { text: 'hello' } }) });
      await sending;
    });
    expect(latest.messages.c1.map((m) => m.id)).toEqual(['m1']);
    expect(latest.messages['user:alice']).toBeUndefined();
  });

  it('migrates a new compose into an existing conversation without dropping its history', async () => {
    history = [mine('old')];
    mount();
    await waitFor(() => expect(latest.capabilities).not.toBeNull());
    await act(async () => { await latest.loadConversation('c1'); });
    const resolvePost = deferredPost();
    act(() => latest.composeTo('alice'));
    let sending;
    await act(async () => { sending = latest.send({ text: 'again', client_id: 'client-again-1' }); });
    await act(async () => {
      resolvePost({ conversation: { id: 'c1' }, message: mine('m2') });
      await sending;
    });
    expect(latest.messages.c1.map((m) => m.id)).toEqual(['old', 'm2']);
    expect(latest.messages['user:alice']).toBeUndefined();
    expect(latest.selectedId).toBe('c1');
  });

  it('shows the GIF in the optimistic bubble before the server answers', async () => {
    mount();
    await waitFor(() => expect(latest.capabilities).not.toBeNull());
    deferredPost();
    act(() => latest.composeTo('alice'));
    await act(async () => {
      latest.send({ kind: 'gif', gif_url: 'https://media.tenor.com/a.gif', gif_preview_url: 'https://media.tenor.com/a-tiny.gif', gif_title: 'wave', client_id: 'client-gif-1' });
    });
    const [pending] = latest.messages['user:alice'];
    expect(pending.pending).toBe(true);
    expect(pending.content).toEqual({ url: 'https://media.tenor.com/a.gif', preview_url: 'https://media.tenor.com/a-tiny.gif', title: 'wave' });
  });
});
