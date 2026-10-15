import { describe, it, expect, vi, afterEach } from 'vitest';
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
    expect(screen.getByText('GUEST')).toBeInTheDocument();
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
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
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

    expect(screen.getByText('BYOK ACTIVE')).toBeInTheDocument();
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
