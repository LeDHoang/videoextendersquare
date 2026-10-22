import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuditPanel from './AuditPanel.jsx';
import ContentPanel from './ContentPanel.jsx';
import UserDetail from './UserDetail.jsx';
import UsersPanel from './UsersPanel.jsx';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));

const MOD = { id: 'm1', username: 'mod', role: 'moderator' };
const ADMIN = { id: 'a1', username: 'boss', role: 'admin' };

const detail = (overrides = {}) => ({
  user: {
    id: 'u1', username: 'bob', email: 'bob@example.com', role: 'user', env_role: 'user', status: 'active',
    created_at: '2026-10-01T10:00:00', last_seen_at: null, post_count: 2, follower_count: 3, ...overrides,
  },
  active_sessions: 1,
  reports_against: [],
  reports_filed: [],
  posts: [],
  support_requests: [],
  history: [{ id: 'h1', action: 'user.suspend', actor: 'mod', target_type: 'user', reason: 'spam wave', created_at: '2026-10-20T10:00:00' }],
});

const reasonAndSubmit = (label) => {
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'test reason' } });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: label }));
};

beforeEach(() => {
  Object.values(mocks.api).forEach((fn) => fn.mockReset());
});
afterEach(cleanup);

describe('UsersPanel', () => {
  it('searches and opens a user', async () => {
    mocks.api.get.mockResolvedValue({ items: [{ id: 'u1', username: 'bob', email: 'bob@example.com', status: 'active', role: 'user', created_at: '2026-10-01T10:00:00' }], next_cursor: null });
    const onOpen = vi.fn();
    render(<UsersPanel onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText('@bob')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: ' bob ' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(mocks.api.get).toHaveBeenLastCalledWith('/api/admin/users', { q: 'bob', status: '', role: '', limit: 25 }));
    fireEvent.click(screen.getByText('@bob'));
    expect(onOpen).toHaveBeenCalledWith('u1');
  });
});

describe('UserDetail', () => {
  it('gives a moderator suspend and sign-out only', async () => {
    mocks.api.get.mockResolvedValue(detail());
    render(<UserDetail userId="u1" viewer={MOD} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('SUSPEND')).toBeTruthy());
    expect(screen.getByText('SIGN OUT EVERYWHERE')).toBeTruthy();
    for (const label of ['REINSTATE', 'CHANGE ROLE', 'ADJUST CREDITS', 'DELETE ACCOUNT']) {
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(screen.queryByText('CREDITS')).toBeNull();
    expect(screen.getByText(/USER.SUSPEND · spam wave/)).toBeTruthy();
  });

  it('gives a moderator no actions on another staff account', async () => {
    mocks.api.get.mockResolvedValue(detail({ role: 'moderator' }));
    render(<UserDetail userId="u1" viewer={MOD} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('@bob')).toBeTruthy());
    expect(screen.queryByText('SUSPEND')).toBeNull();
    expect(screen.queryByText('SIGN OUT EVERYWHERE')).toBeNull();
  });

  it('gives an admin every action and the credits section', async () => {
    mocks.api.get.mockResolvedValue({
      ...detail({ status: 'suspended' }),
      credits: {
        wallet: { available_credits: 40, reserved_credits: 0, lifetime_purchased: 100, lifetime_spent: 60 },
        ledger: [{ id: 'l1', type: 'grant', source: 'admin', delta_available: 50, balance_available: 40, created_at: '2026-10-21T10:00:00' }],
        purchases: [{ id: 'p1', credits: 100, amount_total_cents: 999, currency: 'usd', status: 'paid', created_at: '2026-10-02T10:00:00', stripe_url: 'https://dashboard.stripe.com/payments/pi_1' }],
      },
    });
    render(<UserDetail userId="u1" viewer={ADMIN} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('REINSTATE')).toBeTruthy());
    for (const label of ['SIGN OUT EVERYWHERE', 'CHANGE ROLE', 'ADJUST CREDITS', 'DELETE ACCOUNT']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.queryByText('SUSPEND')).toBeNull();
    expect(screen.getByText('STRIPE').getAttribute('href')).toBe('https://dashboard.stripe.com/payments/pi_1');
    expect(screen.getByText(/GRANT · ADMIN · \+50/)).toBeTruthy();
  });

  it('sends a credit adjustment with a reason and a request id, then reloads', async () => {
    mocks.api.get.mockResolvedValue({ ...detail(), credits: { wallet: { available_credits: 0, reserved_credits: 0, lifetime_purchased: 0, lifetime_spent: 0 }, ledger: [], purchases: [] } });
    mocks.api.post.mockResolvedValue({ applied: true });
    render(<UserDetail userId="u1" viewer={ADMIN} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('ADJUST CREDITS')).toBeTruthy());
    fireEvent.click(screen.getByText('ADJUST CREDITS'));
    fireEvent.change(screen.getByLabelText('Credit amount'), { target: { value: '-50' } });
    reasonAndSubmit('APPLY');
    await waitFor(() => expect(mocks.api.post).toHaveBeenCalled());
    const [path, body] = mocks.api.post.mock.calls[0];
    expect(path).toBe('/api/admin/users/u1/credits');
    expect(body).toMatchObject({ amount: -50, reason: 'test reason' });
    expect(body.request_id.length).toBeGreaterThanOrEqual(8);
    await waitFor(() => expect(mocks.api.get).toHaveBeenCalledTimes(2));
  });

  it('keeps delete disabled until the username is typed', async () => {
    mocks.api.get.mockResolvedValue(detail());
    render(<UserDetail userId="u1" viewer={ADMIN} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('DELETE ACCOUNT')).toBeTruthy());
    fireEvent.click(screen.getByText('DELETE ACCOUNT'));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'test reason' } });
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'DELETE FOREVER' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Confirm username'), { target: { value: '@BOB' } });
    expect(confirm.disabled).toBe(false);
  });

  it('shows the server error and keeps the dialog open', async () => {
    mocks.api.get.mockResolvedValue(detail());
    mocks.api.post.mockRejectedValue(new Error('Moderators cannot suspend other staff.'));
    render(<UserDetail userId="u1" viewer={MOD} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('SUSPEND')).toBeTruthy());
    fireEvent.click(screen.getByText('SUSPEND'));
    reasonAndSubmit('SUSPEND');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Moderators cannot suspend other staff.'));
  });
});

describe('ContentPanel', () => {
  const comment = (removed) => ({
    type: 'comment', id: 'c1', owner: 'bob', owner_id: 'u1', removed, created_at: '2026-10-21T10:00:00',
    text: 'rude words', status: removed ? 'removed' : 'live', link: '/reels?post=p1',
  });

  it('removes a comment and swaps the row in place', async () => {
    mocks.api.get.mockResolvedValue({ items: [comment(false)], next_cursor: null });
    mocks.api.post.mockResolvedValue({ item: comment(true) });
    render(<ContentPanel viewer={MOD} onOpenUser={() => {}} />);
    await waitFor(() => expect(screen.getByText('REMOVE')).toBeTruthy());
    fireEvent.click(screen.getByText('REMOVE'));
    reasonAndSubmit('REMOVE');
    await waitFor(() => expect(mocks.api.post).toHaveBeenCalledWith('/api/admin/content/comment/c1/remove', { reason: 'test reason' }));
    await waitFor(() => expect(screen.getByText(/COMMENT · REMOVED/)).toBeTruthy());
    expect(screen.queryByText('RESTORE')).toBeNull();
  });

  it('offers restore to an admin, not for posts', async () => {
    mocks.api.get.mockImplementation((path, params) => Promise.resolve({
      items: [params.type === 'post' ? { ...comment(true), type: 'post', id: 'p1' } : comment(true)],
      next_cursor: null,
    }));
    render(<ContentPanel viewer={ADMIN} onOpenUser={() => {}} />);
    await waitFor(() => expect(screen.getByText(/POST · REMOVED/)).toBeTruthy());
    expect(screen.queryByText('RESTORE')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'COMMENTS' }));
    await waitFor(() => expect(screen.getByText('RESTORE')).toBeTruthy());
  });
});

describe('AuditPanel', () => {
  it('lists staff actions and opens a user target', async () => {
    mocks.api.get.mockResolvedValue({
      items: [{ id: 's1', action: 'user.credits', actor: 'boss', target_type: 'user', target_id: 'u1', target_label: 'bob', report_id: null, reason: 'goodwill', details: { amount: 50 }, created_at: '2026-10-22T09:00:00' }],
      next_cursor: 'next',
    });
    const onOpenUser = vi.fn();
    render(<AuditPanel onOpenUser={onOpenUser} />);
    await waitFor(() => expect(screen.getByText('user.credits')).toBeTruthy());
    expect(screen.getByText('goodwill')).toBeTruthy();
    expect(screen.getByText('amount=50')).toBeTruthy();
    fireEvent.click(screen.getByText('@bob'));
    expect(onOpenUser).toHaveBeenCalledWith('u1');
    fireEvent.click(screen.getByText('LOAD MORE'));
    await waitFor(() => expect(mocks.api.get).toHaveBeenLastCalledWith('/api/admin/audit', { actor: '', target_id: '', action: '', limit: 50, cursor: 'next' }));
  });
});
