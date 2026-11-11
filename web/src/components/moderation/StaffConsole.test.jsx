import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuditPanel from './AuditPanel.jsx';
import ContentPanel from './ContentPanel.jsx';
import SensitivityCard from './SensitivityCard.jsx';
import TagsPanel from './TagsPanel.jsx';
import UploadLogsPanel from './UploadLogsPanel.jsx';
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

  it('offers restore to an admin, posts included', async () => {
    const post = (removed) => ({ ...comment(removed), type: 'post', id: 'p1' });
    mocks.api.get.mockResolvedValue({ items: [post(true)], next_cursor: null });
    mocks.api.post.mockResolvedValue({ item: post(false) });
    render(<ContentPanel viewer={ADMIN} onOpenUser={() => {}} />);
    await waitFor(() => expect(screen.getByText(/POST · REMOVED/)).toBeTruthy());
    fireEvent.click(screen.getByText('RESTORE'));
    expect(screen.getByText('The post is published again with its original media.')).toBeTruthy();
    reasonAndSubmit('RESTORE');
    await waitFor(() => expect(mocks.api.post).toHaveBeenCalledWith('/api/admin/content/post/p1/restore', { reason: 'test reason' }));
    await waitFor(() => expect(screen.queryByText('RESTORE')).toBeNull());
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

describe('UploadLogsPanel', () => {
  const row = {
    id: 'stage1', user_id: 'u1', username: 'bob', kind: 'video', filename: 'beach.mp4', status: 'failed',
    job_id: 'job1', post_id: null, size_bytes: 3 * 1024 * 1024, process_ms: 41200, cost: 0.35, error: 'Fal timed out',
    event_count: 3, file_count: 1, created_at: '2026-11-09T10:00:00.000+00:00', updated_at: '2026-11-09T10:01:00.000+00:00',
  };
  const trace = {
    summary: row,
    trace: { events: [
      { event: 'upload', at: '2026-11-09T10:00:00.120+00:00', ms: 120, filename: 'beach.mp4' },
      { event: 'process_failed', at: '2026-11-09T10:01:00.000+00:00', ms: 41200, error: { headline: 'Fal timed out' } },
    ] },
    files: [
      { role: 'source', filename: 'beach.mp4', size_bytes: 3145728, content_type: 'video/mp4', url: 'https://signed.example/a', expired: false },
      { role: 'result', filename: 'result_preview.mp4', size_bytes: null, content_type: 'video/mp4', url: null, expired: true },
    ],
  };

  it('filters, sorts and opens one upload with its files and timeline', async () => {
    mocks.api.get.mockImplementation((path) => Promise.resolve(path.includes('/trace/') ? trace : { items: [row], next_cursor: null }));
    const onOpenUser = vi.fn();
    render(<UploadLogsPanel onOpenUser={onOpenUser} />);
    await waitFor(() => expect(screen.getByText('beach.mp4')).toBeTruthy());
    expect(screen.getByText('Fal timed out')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'cost' } });
    fireEvent.click(screen.getByLabelText('Sort order'));
    fireEvent.change(screen.getByLabelText('Uploader'), { target: { value: ' @bob ' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(mocks.api.get).toHaveBeenLastCalledWith('/api/admin/upload-logs', {
      q: '', user: '@bob', status: 'failed', kind: '', sort: 'cost', order: 'asc', limit: 25,
    }));

    await waitFor(() => expect(screen.getByText('beach.mp4')).toBeTruthy());
    fireEvent.click(screen.getByText('@bob'));
    expect(onOpenUser).toHaveBeenCalledWith('u1');
    fireEvent.click(screen.getByRole('button', { name: 'beach.mp4' }));
    await waitFor(() => expect(screen.getByText('DOWNLOAD')).toBeTruthy());
    expect(screen.getByText(/EXPIRED \(JOB RESULTS ARE DELETED AFTER 30 DAYS\)/)).toBeTruthy();
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(mocks.api.get).toHaveBeenLastCalledWith('/api/admin/upload-logs/trace/stage1');
    expect(document.querySelector('video').getAttribute('src')).toBe('https://signed.example/a');
    expect(screen.getByText('process_failed')).toBeTruthy();
  });
});

describe('ContentPanel purge', () => {
  const removed = { type: 'post', id: 'p1', text: 'Bad clip', status: 'deleted', removed: true, owner: 'bob', owner_id: 'u1', created_at: '2026-10-20T10:00:00', link: '/reels?post=p1' };

  it('lets only an admin purge a removed post and lists the URLs to purge at the edge', async () => {
    mocks.api.get.mockResolvedValue({ items: [removed], next_cursor: null });
    mocks.api.post.mockResolvedValue({ item: { ...removed, purged: true }, deleted: 2, urls: ['https://media.example.com/uploads/a.mp4', 'https://media.example.com/uploads/a-poster.jpg'] });
    const { unmount } = render(<ContentPanel viewer={MOD} onOpenUser={() => {}} />);
    await waitFor(() => expect(screen.getByText('Bad clip')).toBeTruthy());
    expect(screen.queryByText('PURGE MEDIA')).toBeNull();
    unmount();

    render(<ContentPanel viewer={ADMIN} onOpenUser={() => {}} />);
    await waitFor(() => expect(screen.getByText('PURGE MEDIA')).toBeTruthy());
    fireEvent.click(screen.getByText('PURGE MEDIA'));
    reasonAndSubmit('PURGE FOREVER');
    await waitFor(() => expect(mocks.api.post).toHaveBeenCalledWith('/api/admin/content/post/p1/purge', { reason: 'test reason' }));
    await waitFor(() => expect(screen.getByLabelText('URLs to purge').value).toContain('uploads/a-poster.jpg'));
    // A purged post has nothing left to restore.
    expect(screen.getByText(/REMOVED · MEDIA PURGED/)).toBeTruthy();
    expect(screen.queryByText('RESTORE')).toBeNull();
  });
});

describe('TagsPanel', () => {
  const tag = (overrides = {}) => ({ slug: 'badword', name: 'badword', blocked: false, blocked_at: null, post_count: 3, pack_count: 1, created_at: '2026-10-01T10:00:00', ...overrides });

  it('lets a moderator block a tag but not unblock one', async () => {
    mocks.api.get.mockResolvedValue({ items: [tag(), tag({ slug: 'old', name: 'old', blocked: true, blocked_at: '2026-10-02T10:00:00' })], next_cursor: null });
    mocks.api.post.mockResolvedValue({ tag: tag({ blocked: true }) });
    render(<TagsPanel viewer={MOD} />);
    await waitFor(() => expect(screen.getByText('#badword')).toBeTruthy());
    expect(screen.queryByText('UNBLOCK')).toBeNull();
    fireEvent.click(screen.getByText('BLOCK'));
    reasonAndSubmit('BLOCK');
    await waitFor(() => expect(mocks.api.post).toHaveBeenCalledWith('/api/admin/tags/badword/block', { reason: 'test reason' }));
  });

  it('lets an admin unblock, and block a tag nobody used yet', async () => {
    mocks.api.get.mockResolvedValue({ items: [tag({ blocked: true, blocked_at: '2026-10-02T10:00:00' })], next_cursor: null });
    mocks.api.post.mockResolvedValue({});
    render(<TagsPanel viewer={ADMIN} />);
    await waitFor(() => expect(screen.getByText('UNBLOCK')).toBeTruthy());
    fireEvent.click(screen.getByText('UNBLOCK'));
    reasonAndSubmit('UNBLOCK');
    await waitFor(() => expect(mocks.api.post).toHaveBeenCalledWith('/api/admin/tags/badword/unblock', { reason: 'test reason' }));

    mocks.api.get.mockResolvedValue({ items: [], next_cursor: null });
    fireEvent.change(screen.getByLabelText('Search tags'), { target: { value: '#newbad' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(screen.getByText('BLOCK #newbad')).toBeTruthy());
    fireEvent.click(screen.getByText('BLOCK #newbad'));
    reasonAndSubmit('BLOCK');
    await waitFor(() => expect(mocks.api.post).toHaveBeenCalledWith('/api/admin/tags/newbad/block', { reason: 'test reason' }));
  });
});

describe('SensitivityCard', () => {
  const body = (community = 2) => ({
    sensitivity: { community, abuse: 2 },
    labels: ['VERY RELAXED', 'RELAXED', 'NORMAL', 'STRICT', 'VERY STRICT'],
    limits: { spike_min: 10, open_reports: 20, reporters_per_target: 3, reporters_per_account: 5, new_account_activity: 30, accounts_per_ip: 5, accounts_per_device: 3, user_spend_hourly: 300, new_account_spend: 100 },
  });

  it('shows a moderator the sliders read-only', async () => {
    mocks.api.get.mockResolvedValue(body());
    render(<SensitivityCard viewer={MOD} />);
    await waitFor(() => expect(screen.getByLabelText('COMMUNITY SAFETY')).toBeTruthy());
    expect(screen.getByLabelText('COMMUNITY SAFETY').disabled).toBe(true);
    expect(screen.queryByText('SAVE SENSITIVITY')).toBeNull();
    expect(screen.getByText(/REPORTERS \/ TARGET 3/)).toBeTruthy();
  });

  it('lets an admin move a slider and save it with a reason', async () => {
    mocks.api.get.mockResolvedValue(body());
    mocks.api.put.mockResolvedValue(body(4));
    const onSaved = vi.fn();
    render(<SensitivityCard viewer={ADMIN} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText('SAVE SENSITIVITY')).toBeTruthy());
    expect(screen.getByText('SAVE SENSITIVITY').closest('button').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('COMMUNITY SAFETY'), { target: { value: '4' } });
    expect(screen.getByText('VERY STRICT')).toBeTruthy();
    fireEvent.click(screen.getByText('SAVE SENSITIVITY'));
    reasonAndSubmit('SAVE');
    await waitFor(() => expect(mocks.api.put).toHaveBeenCalledWith('/api/admin/alert-sensitivity', { community: 4, abuse: 2, reason: 'test reason' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
