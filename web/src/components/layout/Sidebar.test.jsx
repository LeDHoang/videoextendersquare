import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';

afterEach(() => {
  cleanup();
});

const mockUseAuth = vi.fn();
const mockUseWallet = vi.fn();

vi.mock('../../hooks/AuthContext.jsx', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../../hooks/WalletContext.jsx', () => ({
  useWallet: () => mockUseWallet(),
}));

describe('Sidebar Account Billing Module', () => {
  it('renders guest state when no user is logged in', () => {
    mockUseAuth.mockReturnValue({ user: null });
    mockUseWallet.mockReturnValue({
      wallet: null,
      falKey: { configured: false, hint: '' },
    });

    render(
      <MemoryRouter>
        <Sidebar isOpen={true} onClose={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.getByText('ECHO CREDITS & KEY')).toBeInTheDocument();
    expect(screen.getByText('SIGN IN TO TOP UP')).toBeInTheDocument();
    expect(screen.getByText('SHARED POOL')).toBeInTheDocument();
  });

  it('renders authenticated state with credits balance', () => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'alex', display_name: 'Alex' },
    });
    mockUseWallet.mockReturnValue({
      wallet: { available_credits: 450 },
      falKey: { configured: false, hint: '' },
    });

    render(
      <MemoryRouter>
        <Sidebar isOpen={true} onClose={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.getByText('450')).toBeInTheDocument();
    expect(screen.getByText('MANAGE CREDITS / KEY')).toBeInTheDocument();
  });

  it('renders personal FAL key badge when configured', () => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'alex', display_name: 'Alex' },
    });
    mockUseWallet.mockReturnValue({
      wallet: { available_credits: 0 },
      falKey: { configured: true, hint: '••••9876' },
    });

    render(
      <MemoryRouter>
        <Sidebar isOpen={true} onClose={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.queryByText('SHARED POOL')).not.toBeInTheDocument();
    expect(screen.getByText(/••••9876/)).toBeInTheDocument();
  });

  it('invokes onClose when the manage button is clicked', () => {
    const onClose = vi.fn();
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'alex', display_name: 'Alex' },
    });
    mockUseWallet.mockReturnValue({
      wallet: { available_credits: 100 },
      falKey: { configured: false, hint: '' },
    });

    render(
      <MemoryRouter>
        <Sidebar isOpen={true} onClose={onClose} />
      </MemoryRouter>
    );

    const btn = screen.getByText('MANAGE CREDITS / KEY').closest('a');
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Sidebar beta navigation', () => {
  const navLabels = () => {
    render(
      <MemoryRouter>
        <Sidebar isOpen={true} onClose={vi.fn()} />
      </MemoryRouter>
    );
    const nav = screen.getByRole('navigation', { name: 'Main App Navigation' });
    return Array.from(nav.querySelectorAll('.sx-sidebar-nav-label')).map((node) => node.textContent);
  };

  it('hides Image, Video and Compare from a regular user', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'u1', username: 'alex', role: 'user' } });
    mockUseWallet.mockReturnValue({ wallet: null, falKey: { configured: false, hint: '' } });
    expect(navLabels()).toEqual(['Reels', 'Explore', 'Messages', 'Upload']);
  });

  it('shows Image, Video and Compare to an admin', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'u1', username: 'boss', role: 'admin' } });
    mockUseWallet.mockReturnValue({ wallet: null, falKey: { configured: false, hint: '' } });
    expect(navLabels()).toEqual(['Reels', 'Explore', 'Messages', 'Upload', 'Image', 'Video', 'Compare']);
  });
});

// Node's own `localStorage` shadows jsdom's and is unusable without a flag, so give tests a real one.
function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    clear: () => { data.clear(); },
  };
}

describe('Sidebar colour theme switch', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.theme;
  });

  const renderGuest = () => {
    mockUseAuth.mockReturnValue({ user: null });
    mockUseWallet.mockReturnValue({ wallet: null, falKey: { configured: false, hint: '' } });
    render(
      <MemoryRouter>
        <Sidebar isOpen={true} onClose={vi.fn()} />
      </MemoryRouter>
    );
  };

  it('shows the dark switch off by default', () => {
    renderGuest();
    expect(screen.getByRole('switch', { name: 'Dark theme' })).toHaveAttribute('aria-checked', 'false');
  });

  it('the switch applies and remembers the theme both ways', () => {
    renderGuest();
    const toggle = screen.getByRole('switch', { name: 'Dark theme' });
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('sx.theme')).toBe('dark');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('sx.theme')).toBe('light');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
