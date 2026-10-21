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

function renderOverview() {
  return render(
    <MemoryRouter initialEntries={['/moderation?tab=overview']}>
      <ModerationPage />
    </MemoryRouter>,
  );
}

describe('ModerationPage overview', () => {
  beforeEach(() => { mocks.api.get.mockReset(); });
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

  it('shows the error and no skeleton when the stats call fails', async () => {
    mocks.api.get.mockRejectedValue(new Error('boom'));
    renderOverview();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('boom'));
  });
});
