import { act, render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HeaderBar from './HeaderBar.jsx';

const mocks = vi.hoisted(() => ({
  user: null,
  health: { probes: {}, fal_key: { ok: true } },
  messaging: { unread: { total: 3 } },
  wallet: { available_credits: 42 },
  lastAward: null,
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
  useWallet: () => ({ wallet: mocks.wallet, lastAward: mocks.lastAward }),
}));

describe('HeaderBar responsive behavior', () => {
  beforeEach(() => {
    mocks.user = null;
    mocks.lastAward = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders brand and one SIGN IN action, with no Upload, when logged out', () => {
    render(
      <MemoryRouter>
        <HeaderBar onToggleSidebar={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.getByText('ECHO')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SIGN IN' })).toBeInTheDocument();
    expect(screen.queryByText('Upload')).not.toBeInTheDocument();
  });

  it('opens the sign-in page, keeping the current page as next, when SIGN IN is pressed', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/explore?search=cats']}>
        <HeaderBar onToggleSidebar={vi.fn()} />
        <Where />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'SIGN IN' }));

    expect(screen.getByTestId('where').textContent).toBe('/login?next=%2Fexplore%3Fsearch%3Dcats');
  });

  it('flashes a +N bubble on the credits pill after a reel reward', () => {
    mocks.user = { id: 'usr-1', username: 'testcreator', display_name: 'Creator' };
    mocks.lastAward = { amount: 1, jackpot: null, at: 1 };
    render(
      <MemoryRouter>
        <HeaderBar onToggleSidebar={vi.fn()} />
      </MemoryRouter>
    );

    const pill = screen.getByRole('link', { name: '42 credits' });
    expect(screen.getByTestId('credits-award-bubble').textContent).toBe('+1');
    expect(pill).toHaveClass('is-awarded');
    expect(pill).not.toHaveClass('is-jackpot');
  });

  it('marks a jackpot on the credits pill and clears it after a few seconds', () => {
    vi.useFakeTimers();
    try {
      mocks.user = { id: 'usr-1', username: 'testcreator', display_name: 'Creator' };
      mocks.lastAward = { amount: 20, jackpot: 'big', at: 2 };
      render(
        <MemoryRouter>
          <HeaderBar onToggleSidebar={vi.fn()} />
        </MemoryRouter>
      );

      expect(screen.getByTestId('credits-award-bubble').textContent).toBe('JACKPOT +20');
      expect(screen.getByRole('link', { name: '42 credits' })).toHaveClass('is-jackpot');
      expect(screen.getByRole('link', { name: '42 credits' })).not.toHaveClass('is-mega');
      act(() => { vi.advanceTimersByTime(4600); });
      expect(screen.queryByTestId('credits-award-bubble')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: '42 credits' })).not.toHaveClass('is-jackpot');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a +50 mega jackpot apart from a +20 one', () => {
    mocks.user = { id: 'usr-1', username: 'testcreator', display_name: 'Creator' };
    mocks.lastAward = { amount: 50, jackpot: 'mega', at: 3 };
    render(
      <MemoryRouter>
        <HeaderBar onToggleSidebar={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.getByTestId('credits-award-bubble').textContent).toBe('JACKPOT +50');
    expect(screen.getByRole('link', { name: '42 credits' })).toHaveClass('is-jackpot', 'is-mega');
  });

  it('marks the ECHO wordmark to pulse like the logo on hover', () => {
    render(
      <MemoryRouter>
        <HeaderBar onToggleSidebar={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.getByText('ECHO')).toHaveClass('sx-wordmark');
    expect(screen.getByText('ECHO')).toHaveAttribute('data-echo', 'ECHO');
    expect(screen.getByText('ECHO').previousElementSibling).toHaveClass('sx-echo-mark');
  });

  it('renders action buttons and unread count badge when authenticated', () => {
    mocks.user = { id: 'usr-1', username: 'testcreator', display_name: 'Creator' };

    render(
      <MemoryRouter>
        <HeaderBar onToggleSidebar={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.getAllByText('Upload').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1); // Unread badge
    expect(screen.getByLabelText('Open account menu')).toBeInTheDocument();
  });

  it('orders the right-side actions UPLOAD, credits, messages, and keeps the nav to REELS and EXPLORE', () => {
    mocks.user = { id: 'usr-1', username: 'testcreator', display_name: 'Creator' };

    const { container } = render(
      <MemoryRouter>
        <HeaderBar onToggleSidebar={vi.fn()} />
      </MemoryRouter>
    );

    const nav = screen.getByRole('navigation', { name: 'Global Routes' });
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Reels', 'Explore']);

    const hrefs = [...container.querySelectorAll('.sx-top-right a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/upload', '/upload', '/wallet', '/messages']);
    expect(screen.getByRole('link', { name: '42 credits' })).toHaveAttribute('href', '/wallet');
    expect(screen.getByRole('link', { name: 'Messages, 3 unread' })).toHaveAttribute('href', '/messages');
  });

  it('Enter VR presses the player VR button on Reels', async () => {
    const user = userEvent.setup();
    const playerVr = document.createElement('button');
    playerVr.id = 'vrBtn';
    const pressed = vi.fn();
    playerVr.addEventListener('click', pressed);
    document.body.appendChild(playerVr);
    render(
      <MemoryRouter initialEntries={['/reels']}>
        <HeaderBar onToggleSidebar={vi.fn()} />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Enter VR' }));

    expect(pressed).toHaveBeenCalledTimes(1);
    playerVr.remove();
  });

  it('Enter VR opens Reels from another page', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/explore']}>
        <HeaderBar onToggleSidebar={vi.fn()} />
        <Where />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Enter VR' }));

    expect(screen.getByTestId('where').textContent).toBe('/reels');
  });

  it('centres the avatar initials by their ink once the font is ready', async () => {
    mocks.user = { id: 'usr-1', username: 'testcreator', display_name: 'Wendy' };
    // "WE" at 100× size: 1440 wide, ink ends 64 short on the right, so it shifts 0.32px right.
    const measureText = vi.fn(() => ({ width: 1440, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 1376 }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText });
    Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });

    try {
      const { container } = render(
        <MemoryRouter>
          <HeaderBar onToggleSidebar={vi.fn()} />
        </MemoryRouter>
      );
      const initials = container.querySelector('.sx-account-trigger .sx-account-avatar > span');
      expect(initials).toHaveTextContent('WE');
      await waitFor(() => expect(initials.style.left).toBe('0.32px'));
      expect(measureText).toHaveBeenCalledWith('WE');
    } finally {
      delete document.fonts;
      vi.restoreAllMocks();
    }
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

  it('keeps the tool shortcuts for an admin', async () => {
    mocks.user = { id: 'usr-1', username: 'boss', role: 'admin' };
    expect(await searchFor('compare')).toBe('/compare');
  });
});
