import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModerationPage from './ModerationPage.jsx';

const mocks = vi.hoisted(() => ({
  auth: { user: { username: 'mod', role: 'moderator', can_moderate: true }, loading: false },
  api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
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
  windows: { '24h': windowStats(reportSpike), '7d': windowStats(false) },
  disk: [{ volume: 'output', ok: true, free_gb: 42.5 }],
});

const ops = {
  window_s: 300,
  requests: {
    count: 120, errors_5xx: 3, error_rate: 0.025, p50_ms: 40, p95_ms: 310,
    status: { '2xx': 110, '429': 7, '5xx': 3 },
    routes: [{ route: '/api/reels/feed', count: 50, errors_5xx: 3, rate_limited: 0, p95_ms: 900 }],
  },
  events: { queue_full: 2, job_failed: 1 },
  jobs: { queued: 1, running: 2, active: 3, capacity: 6 },
  db_pool: { class: 'QueuePool', size: 5, checkedout: 2, overflow: -3, capacity: 15 },
  sse: { open_streams: 4 },
  disk: [],
};

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
    mocks.api.get.mockResolvedValue(stats(false));
    renderOverview();
    await waitFor(() => expect(screen.getByText('OPEN REPORTS')).toBeTruthy());
    expect(mocks.api.get).toHaveBeenCalledWith('/api/moderation/stats');
    expect(screen.getByText('300')).toBeTruthy();
    expect(screen.getByText(/top: @loud 12/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('flags a spiking metric', async () => {
    mocks.api.get.mockResolvedValue(stats(true));
    renderOverview();
    await waitFor(() => expect(screen.getByText('REPORTS · SPIKE')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/SPIKE: REPORTS/);
  });

  it('does not ask a moderator for the operations metrics', async () => {
    mocks.api.get.mockResolvedValue(stats(false));
    renderOverview();
    await waitFor(() => expect(screen.getByText('OPEN REPORTS')).toBeTruthy());
    expect(mocks.api.get).not.toHaveBeenCalledWith('/api/ops/metrics');
    expect(screen.queryByText(/OPERATIONS · LAST/)).toBeNull();
  });

  it('shows the operations block to an admin', async () => {
    mocks.auth.user = { username: 'boss', role: 'admin', can_moderate: true };
    mocks.api.get.mockImplementation((path) => Promise.resolve(path === '/api/ops/metrics' ? ops : stats(false)));
    renderOverview();
    await waitFor(() => expect(screen.getByText(/OPERATIONS · LAST 5 MIN/)).toBeTruthy());
    expect(screen.getByText('310 ms')).toBeTruthy();
    expect(screen.getByText('3 / 6')).toBeTruthy();
    expect(screen.getByText('2 / 15')).toBeTruthy();
    expect(screen.getByText(/SLOWEST ROUTES: \/api\/reels\/feed 900 ms · 5xx 3/)).toBeTruthy();
  });

  it('keeps the moderation overview when the operations call fails', async () => {
    mocks.auth.user = { username: 'boss', role: 'admin', can_moderate: true };
    mocks.api.get.mockImplementation((path) => (path === '/api/ops/metrics' ? Promise.reject(new Error('nope')) : Promise.resolve(stats(false))));
    renderOverview();
    await waitFor(() => expect(screen.getByText('OPEN REPORTS')).toBeTruthy());
    expect(screen.queryByText(/OPERATIONS · LAST/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the error and no skeleton when the stats call fails', async () => {
    mocks.api.get.mockRejectedValue(new Error('boom'));
    renderOverview();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('boom'));
  });
});
