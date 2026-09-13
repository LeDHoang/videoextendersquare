import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
