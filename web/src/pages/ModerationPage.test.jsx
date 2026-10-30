import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModerationPage from './ModerationPage.jsx';

const mocks = vi.hoisted(() => ({
  auth: { user: { username: 'mod', role: 'moderator', can_moderate: true }, loading: false },
  api: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));

const metric = (current, previous, spike = false) => ({ current, previous, spike });
const windowStats = (reportSpike) => ({
  reports: { ...metric(9, 2, reportSpike), by_reason: { spam: 9 }, by_status: { open: 9 } },
  registrations: { active: metric(4, 3), pending: metric(1, 0) },
  messages: { ...metric(20, 18), top_senders: [{ username: 'loud', sent: 12 }] },
  posts: metric(5, 4),
  credits_captured: metric(300, 100),
  support_requests: metric(1, 1),
});
const stats = (reportSpike) => ({
  spike_floor: 10,
  open_reports: 7,
  open_support_requests: 2,
  queue_limits: { open_reports: 20, open_support_requests: 10 },
  windows: { '24h': windowStats(reportSpike), '7d': windowStats(false) },
  disk: [{ volume: 'output', ok: true, free_gb: 42.5 }],
});

const SERIES_KEYS = ['reports', 'support_requests', 'posts', 'signups', 'unverified', 'messages', 'credits_captured'];
const hourly = {
  start: '2026-10-12T00:00:00+00:00',
  hours: 336,
  series: Object.fromEntries(SERIES_KEYS.map((key) => [key, Array.from({ length: 336 }, (_, i) => i % 5)])),
};

const limits = { min_requests: 20, error_rate: 0.05, p95_ms: 2000, failures: 3, disk_min_free_gb: 5, open_reports: 20, open_support_requests: 10 };
const ops = {
  window_s: 300,
  requests: {
    count: 120, errors_5xx: 3, error_rate: 0.025, p50_ms: 40, p95_ms: 310,
    status: { '2xx': 110, '429': 7, '5xx': 3 },
    routes: [
      { method: 'GET', route: '/api/reels/feed', count: 50, errors_5xx: 3, rate_limited: 0, p50_ms: 120, p95_ms: 900, max_ms: 1500 },
      { method: 'GET', route: '/{full_path:path}', count: 1, errors_5xx: 0, rate_limited: 2, p50_ms: 9, p95_ms: 9, max_ms: 9 },
    ],
  },
  events: { queue_full: 2, job_failed: 1 },
  jobs: { queued: 1, running: 2, active: 3, capacity: 6 },
  db_pool: { class: 'QueuePool', size: 5, checkedout: 2, overflow: -3, capacity: 15 },
  sse: { open_streams: 4 },
  disk: [{ volume: 'output', ok: true, free_gb: 42.5 }],
  limits,
};

const respond = ({ statsBody = stats(false), opsBody = ops, hourlyBody = hourly } = {}) => (path) => {
  if (path === '/api/moderation/stats') return Promise.resolve(statsBody);
  if (path === '/api/moderation/stats/hourly') return hourlyBody instanceof Error ? Promise.reject(hourlyBody) : Promise.resolve(hourlyBody);
  if (path === '/api/ops/metrics') return opsBody instanceof Error ? Promise.reject(opsBody) : Promise.resolve(opsBody);
  return Promise.resolve({ reports: [] });
};
const chip = (name) => screen.getByRole('button', { name: new RegExp('^' + name + ':') });

function renderOverview() {
  return render(
    <MemoryRouter initialEntries={['/moderation?tab=overview']}>
      <ModerationPage />
    </MemoryRouter>,
  );
}

describe('ModerationPage overview', () => {
  beforeEach(() => {
    mocks.api.get.mockReset();
    mocks.auth.user = { username: 'mod', role: 'moderator', can_moderate: true };
  });
  afterEach(cleanup);

  it('loads the stats and shows the counts with the previous period', async () => {
    mocks.api.get.mockImplementation(respond());
    renderOverview();
    await waitFor(() => expect(screen.getByText('OPEN REPORTS')).toBeTruthy());
    expect(mocks.api.get).toHaveBeenCalledWith('/api/moderation/stats');
    expect(mocks.api.get).toHaveBeenCalledWith('/api/moderation/stats/hourly');
    expect(screen.getByText('300')).toBeTruthy();
    expect(screen.getByRole('img', { name: '@loud 12' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'OPEN 9, RESOLVED 0, DISMISSED 0' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'SPAM 9' })).toBeTruthy();
    expect(screen.getByText('▲ +350% VS BEFORE')).toBeTruthy();
    expect(screen.getByText(/User reports about profiles, posts/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('draws the hourly charts and hides them when the hourly call fails', async () => {
    mocks.api.get.mockImplementation(respond());
    renderOverview();
    await waitFor(() => expect(screen.getByRole('img', { name: 'REPORTS FILED over time, now and before' })).toBeTruthy());
    expect(screen.getByRole('img', { name: 'REPORTS FILED by hour and day' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'DIRECT MESSAGES' }));
    expect(screen.getByRole('img', { name: 'DIRECT MESSAGES over time, now and before' })).toBeTruthy();
    cleanup();
    mocks.api.get.mockImplementation(respond({ hourlyBody: new Error('nope') }));
    renderOverview();
    await waitFor(() => expect(screen.getByText(/Hourly counts did not load/)).toBeTruthy());
    expect(screen.queryByRole('img', { name: /over time/ })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('colours the queue checks against the server backlog limits', async () => {
    mocks.api.get.mockImplementation(respond({ statsBody: { ...stats(false), open_reports: 20, open_support_requests: 0 } }));
    renderOverview();
    await waitFor(() => expect(chip('REPORT QUEUE').dataset.state).toBe('bad'));
    expect(chip('SUPPORT INBOX').dataset.state).toBe('ok');
    expect(screen.getByText(/1 problem\./)).toBeTruthy();
  });

  it('opens the reports queue from its tile', async () => {
    mocks.api.get.mockImplementation(respond());
    renderOverview();
    await waitFor(() => expect(screen.getByText('OPEN REPORTS')).toBeTruthy());
    fireEvent.click(screen.getByText('OPEN REPORTS'));
    await waitFor(() => expect(mocks.api.get).toHaveBeenCalledWith('/api/moderation/reports', expect.anything()));
  });

  it('flags a spiking metric', async () => {
    mocks.api.get.mockImplementation(respond({ statsBody: stats(true) }));
    renderOverview();
    await waitFor(() => expect(screen.getByText('SPIKE')).toBeTruthy());
    expect(chip('ACTIVITY SPIKES').dataset.state).toBe('bad');
    expect(chip('ACTIVITY SPIKES').textContent).toMatch(/REPORTS FILED/);
  });

  it('does not ask a moderator for the operations metrics', async () => {
    mocks.api.get.mockImplementation(respond());
    renderOverview();
    await waitFor(() => expect(screen.getByText('OPEN REPORTS')).toBeTruthy());
    expect(mocks.api.get).not.toHaveBeenCalledWith('/api/ops/metrics');
    expect(screen.queryByText(/SERVER HEALTH · LAST/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^SERVER ERRORS:/ })).toBeNull();
  });

  it('shows the operations block to an admin', async () => {
    mocks.auth.user = { username: 'boss', role: 'admin', can_moderate: true };
    mocks.api.get.mockImplementation(respond());
    renderOverview();
    await waitFor(() => expect(screen.getByText(/SERVER HEALTH · LAST 5 MIN/)).toBeTruthy());
    expect(screen.getAllByText('310 ms').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'AI JOB SLOTS 3 / 6' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'DATABASE CONNECTIONS 2 / 15' })).toBeTruthy();
    expect(screen.getByRole('img', { name: '2xx 110, 429 7, 5xx 3' })).toBeTruthy();
    expect(screen.getByText('429 RATE-LIMITED')).toBeTruthy();
    expect(screen.getByText('GET /api/reels/feed')).toBeTruthy();
    expect(screen.getByText('GET PAGES + STATIC FILES')).toBeTruthy();
    expect(chip('SERVER ERRORS').dataset.state).toBe('warn');
    expect(chip('DATABASE CONNECTIONS').dataset.state).toBe('ok');
    expect(chip('FAILED AI JOBS').dataset.state).toBe('warn');
  });

  it('keeps rate and latency checks amber below the request minimum', async () => {
    mocks.auth.user = { username: 'boss', role: 'admin', can_moderate: true };
    const quiet = { ...ops, requests: { ...ops.requests, count: 5, errors_5xx: 5, error_rate: 1, p95_ms: 9000 } };
    mocks.api.get.mockImplementation(respond({ opsBody: quiet }));
    renderOverview();
    await waitFor(() => expect(chip('SERVER ERRORS').dataset.state).toBe('warn'));
    expect(chip('SLOWEST 5% OF CALLS').dataset.state).toBe('warn');
    expect(chip('SERVER ERRORS').textContent).toMatch(/no alert under 20/);
  });

  it('turns the database check red when the pool is exhausted', async () => {
    mocks.auth.user = { username: 'boss', role: 'admin', can_moderate: true };
    mocks.api.get.mockImplementation(respond({ opsBody: { ...ops, db_pool: { ...ops.db_pool, checkedout: 15 } } }));
    renderOverview();
    await waitFor(() => expect(chip('DATABASE CONNECTIONS').dataset.state).toBe('bad'));
  });

  it('keeps the moderation overview when the operations call fails', async () => {
    mocks.auth.user = { username: 'boss', role: 'admin', can_moderate: true };
    mocks.api.get.mockImplementation(respond({ opsBody: new Error('nope') }));
    renderOverview();
    await waitFor(() => expect(screen.getByText('OPEN REPORTS')).toBeTruthy());
    expect(screen.queryByText(/SERVER HEALTH · LAST/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the error and no skeleton when the stats call fails', async () => {
    mocks.api.get.mockRejectedValue(new Error('boom'));
    renderOverview();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('boom'));
  });
});

describe('ModerationPage reports', () => {
  const report = (id, status, handledBy, claimedBy = null) => ({
    id, status, target_type: 'user', target_id: 'u-' + id, target: {}, reason: 'spam', details: '',
    reporter: 'alice', resolution: status === 'open' ? null : 'dismiss', created_at: '2026-10-22T10:00:00', handled_by: handledBy,
    claimed_by: claimedBy, claimed_at: claimedBy ? '2026-10-22T10:05:00' : null, history: [],
  });
  const renderReports = () => render(<MemoryRouter initialEntries={['/moderation']}><ModerationPage /></MemoryRouter>);

  beforeEach(() => {
    mocks.api.get.mockReset();
    mocks.api.patch.mockReset();
    mocks.api.post.mockReset();
    mocks.api.delete.mockReset();
    mocks.auth.user = { username: 'mod', role: 'moderator', can_moderate: true };
  });
  afterEach(cleanup);

  it('shows which moderator handled a reviewed report and none for an open one', async () => {
    mocks.api.get.mockResolvedValue({ reports: [report('r1', 'dismissed', 'alice'), report('r2', 'open', null)] });
    render(<MemoryRouter initialEntries={['/moderation']}><ModerationPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('HANDLED BY: @alice')).toBeTruthy());
    expect(screen.getAllByText(/HANDLED BY/)).toHaveLength(1);
  });

  it('claims an open report and shows who holds it', async () => {
    mocks.api.get.mockResolvedValue({ reports: [report('r1', 'open', null)] });
    mocks.api.post.mockResolvedValue({ report: { ...report('r1', 'open', null, 'mod'), history: [{ action: 'report.claim', actor: 'mod', reason: '', created_at: '2026-10-22T10:05:00' }] } });
    renderReports();
    await waitFor(() => expect(screen.getByText('CLAIM')).toBeTruthy());
    fireEvent.click(screen.getByText('CLAIM'));
    await waitFor(() => expect(screen.getByText(/CLAIMED BY: @mod/)).toBeTruthy());
    expect(mocks.api.post).toHaveBeenCalledWith('/api/moderation/reports/r1/claim', {});
    expect(screen.getByText(/@mod · REPORT.CLAIM/)).toBeTruthy();
    expect(screen.getByText('RELEASE')).toBeTruthy();
  });

  it('hides release from a moderator on another moderator\'s claim', async () => {
    mocks.api.get.mockResolvedValue({ reports: [report('r1', 'open', null, 'other')] });
    renderReports();
    await waitFor(() => expect(screen.getByText(/CLAIMED BY: @other/)).toBeTruthy());
    expect(screen.queryByText('CLAIM')).toBeNull();
    expect(screen.queryByText('RELEASE')).toBeNull();
    expect(screen.queryByText(/OVERRIDES/)).toBeNull();
  });

  it('sends force when an admin acts over another claim', async () => {
    mocks.auth.user = { username: 'boss', role: 'admin', can_moderate: true };
    mocks.api.get.mockResolvedValue({ reports: [report('r1', 'open', null, 'other')] });
    mocks.api.patch.mockResolvedValue({ report: report('r1', 'dismissed', 'boss') });
    renderReports();
    await waitFor(() => expect(screen.getByText(/OVERRIDES THIS CLAIM/)).toBeTruthy());
    fireEvent.click(screen.getByText('DISMISS'));
    await waitFor(() => expect(mocks.api.patch).toHaveBeenCalledWith('/api/moderation/reports/r1', { action: 'dismiss', resolution: 'dismiss', force: true }));
  });

  it('opens the reported user in the users tab', async () => {
    mocks.api.get.mockImplementation((path) => Promise.resolve(path === '/api/moderation/reports'
      ? { reports: [report('r1', 'open', null)] }
      : { user: { id: 'u-r1', username: 'target', email: '', role: 'user', env_role: 'user', status: 'active', created_at: null, last_seen_at: null, post_count: 0, follower_count: 0 }, active_sessions: 0, reports_against: [], reports_filed: [], posts: [], support_requests: [], history: [] }));
    renderReports();
    await waitFor(() => expect(screen.getByText('OPEN USER')).toBeTruthy());
    fireEvent.click(screen.getByText('OPEN USER'));
    await waitFor(() => expect(screen.getByText('@target')).toBeTruthy());
    expect(mocks.api.get).toHaveBeenCalledWith('/api/admin/users/u-r1');
    expect(screen.getByRole('radio', { name: 'USERS' }).getAttribute('aria-checked')).toBe('true');
  });

  it('shows the audit tab to admins only', async () => {
    mocks.api.get.mockResolvedValue({ reports: [] });
    renderReports();
    await waitFor(() => expect(screen.getByText('QUEUE CLEAR')).toBeTruthy());
    expect(screen.queryByRole('radio', { name: 'AUDIT' })).toBeNull();
    cleanup();
    mocks.auth.user = { username: 'boss', role: 'admin', can_moderate: true };
    renderReports();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'AUDIT' })).toBeTruthy());
  });

  it('shows the reported comment, its post and the reporter note with live links', async () => {
    mocks.api.get.mockResolvedValue({ reports: [{
      ...report('r1', 'open', null), target_type: 'comment', target_id: 'c1', details: 'Keeps insulting me',
      target: {
        text: 'you are awful', author: 'troll', author_id: 'u9', removed: false, deleted: false, link: '/reels?post=p1',
        post: { title: 'Beach day', media_type: 'video', link: '/reels?post=p1', removed: false, preview_url: '/m/p1.mp4', poster_url: '/m/p1.jpg' },
      },
    }] });
    renderReports();
    await waitFor(() => expect(screen.getByText('you are awful')).toBeTruthy());
    expect(screen.getByText('@troll COMMENTED')).toBeTruthy();
    expect(screen.getByText('Beach day')).toBeTruthy();
    expect(screen.getByText('Keeps insulting me')).toBeTruthy();
    expect(screen.getByText('REPORTED BY @alice')).toBeTruthy();
    expect(screen.getByText('2026-10-22 10:00')).toBeTruthy();
    const live = screen.getByText('OPEN POST ↗');
    expect(live.getAttribute('href')).toBe('/reels?post=p1');
    expect(live.getAttribute('target')).toBe('_blank');
    // The parent reel plays in place.
    const video = document.querySelector('video.sx-report-media');
    expect(video.getAttribute('src')).toBe('/m/p1.mp4');
    expect(video.hasAttribute('controls')).toBe(true);
  });

  it('previews a reported pack with its cover first and playable reels', async () => {
    mocks.api.get.mockResolvedValue({ reports: [{
      ...report('r1', 'open', null), target_type: 'pack', target_id: 'k1',
      target: {
        title: 'Alps trip', description: 'Five stops', owner: 'bob', status: 'published', visibility: 'public',
        link: '/packs/k1', removed: false, item_count: 6,
        items: [
          { id: 'p3', title: 'Summit', media_type: 'video', link: '/reels?post=p3', removed: false, preview_url: '/m/p3.mp4', poster_url: '/m/p3.jpg' },
          { id: 'p1', title: 'Lake', media_type: 'image', link: '/reels?post=p1', removed: false, preview_url: '/m/p1.webp', poster_url: '/m/p1.webp' },
          { id: 'p2', title: 'Gone', media_type: 'video', link: '/reels?post=p2', removed: true },
        ],
      },
    }] });
    renderReports();
    await waitFor(() => expect(screen.getByText('Alps trip')).toBeTruthy());
    expect(screen.getByText('Five stops')).toBeTruthy();
    expect(screen.getByText(/REEL PACK BY @bob · PUBLISHED · PUBLIC · 6 REELS/)).toBeTruthy();
    expect(screen.getByText('OPEN PACK ↗').getAttribute('href')).toBe('/packs/k1');
    const tiles = document.querySelectorAll('.sx-report-pack-items li');
    expect([...tiles].map((tile) => tile.textContent)).toEqual(['Summit', 'Lake', 'REMOVED · MEDIA UNPUBLISHEDGone']);
    expect(tiles[0].querySelector('video').getAttribute('src')).toBe('/m/p3.mp4');
    expect(tiles[1].querySelector('img').getAttribute('src')).toBe('/m/p1.webp');
  });

  it('shows a removed post without media and lets an admin restore it', async () => {
    mocks.auth.user = { username: 'boss', role: 'admin', can_moderate: true };
    const removed = {
      ...report('r1', 'resolved', 'boss'), target_type: 'post', target_id: 'p1',
      target: { title: 'Beach day', owner: 'bob', status: 'deleted', media_type: 'video', link: '/reels?post=p1', removed: true },
    };
    mocks.api.get.mockResolvedValue({ reports: [removed] });
    mocks.api.post.mockResolvedValue({ item: {} });
    renderReports();
    await waitFor(() => expect(screen.getByText('REMOVED · MEDIA UNPUBLISHED')).toBeTruthy());
    expect(screen.getByText('No note left.')).toBeTruthy();
    expect(screen.queryByText('VIEW LIVE ↗')).toBeNull();
    fireEvent.click(screen.getByText('RESTORE CONTENT'));
    expect(screen.getByText('The post is published again with its original media.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'appeal upheld' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'RESTORE' }));
    await waitFor(() => expect(mocks.api.post).toHaveBeenCalledWith('/api/admin/content/post/p1/restore', { reason: 'appeal upheld' }));
    await waitFor(() => expect(mocks.api.get).toHaveBeenCalledTimes(2));
  });

  it('does not offer restore to a moderator', async () => {
    mocks.api.get.mockResolvedValue({ reports: [{ ...report('r1', 'resolved', 'mod'), target_type: 'comment', target_id: 'c1', target: { text: 'gone', author: 'x', removed: true } }] });
    renderReports();
    await waitFor(() => expect(screen.getByText('gone')).toBeTruthy());
    expect(screen.queryByText('RESTORE CONTENT')).toBeNull();
  });
});
