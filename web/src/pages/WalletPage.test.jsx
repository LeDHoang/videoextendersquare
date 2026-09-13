import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WalletPage from './WalletPage.jsx';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  apiGet: vi.fn(),
}));

vi.mock('../api/client.js', () => ({
  api: {
    get: (...args) => mocks.apiGet(...args),
    post: vi.fn(),
  },
}));

vi.mock('../hooks/WalletContext.jsx', () => ({
  useWallet: () => ({
    wallet: {
      available_credits: 500,
      reserved_credits: 0,
      lifetime_earned: 0,
      lifetime_spent: 0,
    },
    catalog: { stripe_enabled: true, packs: [] },
    falKey: { configured: false, hint: '' },
    refresh: mocks.refresh,
    saveFalKey: vi.fn(),
    deleteFalKey: vi.fn(),
  }),
}));

describe('WalletPage checkout return', () => {
  beforeEach(() => {
    mocks.refresh.mockReset().mockResolvedValue(null);
    mocks.apiGet.mockReset().mockResolvedValue({ transactions: [] });
    window.history.replaceState({}, '', '/wallet');
  });

  it('refreshes webhook-owned wallet state without granting credits client-side', async () => {
    window.history.replaceState({}, '', '/wallet?checkout=success&session_id=cs_test');
    render(<WalletPage />);

    expect(screen.getByText(/credits appear after Stripe confirms the webhook/i)).toBeInTheDocument();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.apiGet).toHaveBeenCalledWith('/api/billing/transactions');
    expect(mocks.apiGet).not.toHaveBeenCalledWith(expect.stringContaining('session_id'));
  });
});
