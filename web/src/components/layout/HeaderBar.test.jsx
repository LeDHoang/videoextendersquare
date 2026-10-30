import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HeaderBar from './HeaderBar.jsx';

const mocks = vi.hoisted(() => ({
  user: null,
  health: { probes: {}, fal_key: { ok: true } },
  messaging: { unread: { total: 3 } },
  wallet: { available_credits: 42 },
}));

vi.mock('../../hooks/AuthContext.jsx', () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));

vi.mock('../../hooks/HealthContext.jsx', () => ({
  useHealthContext: () => mocks.health,
}));

vi.mock('../../hooks/MessagingContext.jsx', () => ({
  useMessaging: () => mocks.messaging,
}));

vi.mock('../../hooks/WalletContext.jsx', () => ({
  useWallet: () => ({ wallet: mocks.wallet }),
}));

describe('HeaderBar responsive behavior', () => {
  beforeEach(() => {
    mocks.user = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders brand and guest sign-in button when logged out', () => {
    render(
      <MemoryRouter>
        <HeaderBar onToggleSidebar={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.getByText('ECHO')).toBeInTheDocument();
    expect(screen.getByText('SIGN IN')).toBeInTheDocument();
  });

  it('renders action buttons and unread count badge when authenticated', () => {
    mocks.user = { id: 'usr-1', username: 'testcreator', display_name: 'Creator' };

    render(
      <MemoryRouter>
        <HeaderBar onToggleSidebar={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.getAllByText('UPLOAD').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1); // Unread badge
    expect(screen.getByLabelText('Open account menu')).toBeInTheDocument();
  });

  it('activates and deactivates mobile search mode', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HeaderBar onToggleSidebar={vi.fn()} />
      </MemoryRouter>
    );

    const searchTrigger = screen.getByLabelText('Open Search');
    await user.click(searchTrigger);

    // Search bar should now have the Back / Close button
    const backBtn = screen.getByLabelText('Close search');
    expect(backBtn).toBeInTheDocument();

    // Closing search returns to normal header
    await user.click(backBtn);
    expect(screen.queryByLabelText('Close search')).not.toBeInTheDocument();
  });
});

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

describe('HeaderBar beta navigation', () => {
  afterEach(() => {
    cleanup();
    mocks.user = null;
  });

  const searchFor = async (query) => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/reels']}>
        <HeaderBar onToggleSidebar={vi.fn()} />
        <Where />
      </MemoryRouter>
    );
    await user.type(screen.getByRole('combobox', { name: 'Search people, tags, and reels' }), query + '{Enter}');
    return screen.getByTestId('where').textContent;
  };

  it('hides COMPARE from a regular user and sends tool shortcuts to an Explore search', async () => {
    mocks.user = { id: 'usr-1', username: 'viewer', role: 'user' };
    expect(await searchFor('compare')).toBe('/explore?search=compare');
    expect(screen.queryByRole('link', { name: 'COMPARE' })).not.toBeInTheDocument();
    cleanup();
    expect(await searchFor('video')).toBe('/explore?search=video');
    cleanup();
    expect(await searchFor('image')).toBe('/explore?search=image');
  });

  it('keeps COMPARE and the tool shortcuts for an admin', async () => {
    mocks.user = { id: 'usr-1', username: 'boss', role: 'admin' };
    expect(await searchFor('compare')).toBe('/compare');
    expect(screen.getByRole('link', { name: 'COMPARE' })).toBeInTheDocument();
  });
});
