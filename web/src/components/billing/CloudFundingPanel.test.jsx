import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CloudFundingPanel from './CloudFundingPanel.jsx';

const mocks = vi.hoisted(() => ({
  user: { id: 'viewer-id' },
  wallet: { available_credits: 3 },
  catalog: { credits_enabled: true },
  falKey: { configured: true, hint: '••••1234' },
}));

vi.mock('../../hooks/AuthContext.jsx', () => ({
  useAuth: () => ({ user: mocks.user }),
}));

vi.mock('../../hooks/WalletContext.jsx', () => ({
  useWallet: () => ({ wallet: mocks.wallet, catalog: mocks.catalog, falKey: mocks.falKey }),
}));

const quoteState = {
  loading: false,
  error: '',
  totalCredits: 5,
  totalProviderUsd: 0.035,
  quotes: [{ quote_id: 'quote-1' }],
};

describe('CloudFundingPanel', () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.user = { id: 'viewer-id' };
    mocks.wallet = { available_credits: 3 };
    mocks.catalog = { credits_enabled: true };
    mocks.falKey = { configured: true, hint: '••••1234' };
  });

  it('shows insufficient balance and switches to the personal Fal key', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CloudFundingPanel
          required
          paymentSource="credits"
          onChange={onChange}
          quoteState={quoteState}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/INSUFFICIENT ECHO CREDITS/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'MY FAL KEY' }));
    expect(onChange).toHaveBeenCalledWith('byok');
  });

  it('locks credit selection for BYOK-only models', () => {
    render(
      <MemoryRouter>
        <CloudFundingPanel
          required
          paymentSource="credits"
          onChange={() => {}}
          quoteState={quoteState}
          byokOnly
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('radio', { name: 'ECHO CREDITS' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'MY FAL KEY' })).toBeDisabled();
    expect(screen.getByText(/REQUIRES MY FAL KEY/)).toBeInTheDocument();
  });
});
