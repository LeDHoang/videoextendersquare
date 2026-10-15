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

  it('shows estimates while ECHO credits are disabled, without the insufficient warning', () => {
    mocks.catalog = { credits_enabled: false };
    render(
      <MemoryRouter>
        <CloudFundingPanel
          required
          paymentSource="credits"
          onChange={() => {}}
          quoteState={{ ...quoteState, estimate: true, quotes: [{ quote_id: null, estimate: true }] }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/5 credits \(estimate only\)/)).toBeInTheDocument();
    expect(screen.getByText(/Estimated cost/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.0350 USD across 1 item\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/ECHO CREDITS ARE DISABLED/)).toBeInTheDocument();
    expect(screen.queryByText(/INSUFFICIENT ECHO CREDITS/)).toBeNull();
  });

  it('shows the provider estimate when paying with MY FAL KEY', () => {
    render(
      <MemoryRouter>
        <CloudFundingPanel
          required
          paymentSource="byok"
          onChange={() => {}}
          quoteState={quoteState}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/\$0\.0350 USD across 1 item\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/Charges go directly to your Fal account/)).toBeInTheDocument();
  });

  it('marks approximate estimates', () => {
    render(
      <MemoryRouter>
        <CloudFundingPanel
          required
          paymentSource="byok"
          onChange={() => {}}
          quoteState={{ ...quoteState, approximate: true }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/≈ \$0\.0350 USD across 1 item\(s\) \(approximate\)/)).toBeInTheDocument();
  });

  it('hides the provider estimate in BYOK mode when nothing was priced', () => {
    render(
      <MemoryRouter>
        <CloudFundingPanel
          required
          paymentSource="byok"
          onChange={() => {}}
          quoteState={{ ...quoteState, quotes: [], totalProviderUsd: 0 }}
          byokOnly
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/Provider estimate/)).toBeNull();
  });

  it('locks credit selection for BYOK-only models', () => {
    render(
      <MemoryRouter>
        <CloudFundingPanel
          required
          paymentSource="byok"
          onChange={() => {}}
          quoteState={quoteState}
          byokOnly
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('radio', { name: 'ECHO CREDITS' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'MY FAL KEY' })).not.toBeDisabled();
    expect(screen.getByText(/REQUIRES MY FAL KEY/)).toBeInTheDocument();
  });

  it('shows the BYOK notice even before the automatic switch lands on credits', () => {
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
    expect(screen.getByText(/REQUIRES MY FAL KEY/)).toBeInTheDocument();
  });
});
