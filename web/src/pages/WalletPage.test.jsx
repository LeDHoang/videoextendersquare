import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WalletPage from './WalletPage.jsx';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  saveFalKey: vi.fn(),
  deleteFalKey: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  auth: { user: null, loading: false },
  wallet: null,
}));

vi.mock('../api/client.js', () => ({
  api: {
    get: (...args) => mocks.apiGet(...args),
    post: (...args) => mocks.apiPost(...args),
  },
}));

vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));

vi.mock('../hooks/WalletContext.jsx', () => ({
  useWallet: () => mocks.wallet,
}));

const OWNER = { id: 'u1', username: 'echodev' };

const PACKS = [
  { id: 'starter', label: '500 Credits', amount_cents: 500, currency: 'usd', credits: 500, configured: true },
  { id: 'plus', label: '1,050 Credits', amount_cents: 1000, currency: 'usd', credits: 1050, configured: true },
  { id: 'creator', label: '2,750 Credits', amount_cents: 2500, currency: 'usd', credits: 2750, configured: false },
];

function makeWallet(overrides = {}) {
  return {
    wallet: { available_credits: 500, reserved_credits: 20, lifetime_purchased: 600, lifetime_earned: 15, lifetime_spent: 80 },
    catalog: { credits_enabled: true, stripe_enabled: true, packs: PACKS },
    catalogStatus: 'ready',
    falKey: { configured: false, hint: '' },
    refresh: mocks.refresh,
    saveFalKey: mocks.saveFalKey,
    deleteFalKey: mocks.deleteFalKey,
    ...overrides,
  };
}

function ledgerRow(i, extra = {}) {
  return {
    id: 'tx' + i,
    type: 'credit',
    source: 'purchase',
    delta_available: 500,
    delta_reserved: 0,
    balance_available: 500 + i,
    created_at: '2026-10-01T10:00:00Z',
    ...extra,
  };
}

function renderPage(path = '/wallet') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/wallet" element={<WalletPage />} />
        <Route path="/login" element={<div>LOGIN SCREEN</div>} />
        <Route path="/profile/:username" element={<div>PROFILE SCREEN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WalletPage', () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.refresh.mockReset().mockResolvedValue(null);
    mocks.saveFalKey.mockReset().mockResolvedValue({ configured: true, hint: '••••1234' });
    mocks.deleteFalKey.mockReset().mockResolvedValue({ configured: false, hint: '' });
    mocks.apiGet.mockReset().mockResolvedValue({ transactions: [] });
    mocks.apiPost.mockReset();
    mocks.auth.user = OWNER;
    mocks.auth.loading = false;
    mocks.wallet = makeWallet();
    window.history.replaceState({}, '', '/wallet');
  });

  describe('owner-only access', () => {
    it('sends signed-out visitors to login without requesting any wallet data', () => {
      mocks.auth.user = null;
      renderPage();
      expect(screen.getByText('LOGIN SCREEN')).toBeInTheDocument();
      expect(screen.queryByText('ADD CREDITS')).not.toBeInTheDocument();
      expect(mocks.apiGet).not.toHaveBeenCalled();
    });

    it('shows only the signed-in account and a link back to its own profile', async () => {
      renderPage();
      expect(screen.getByText(/SIGNED IN AS @echodev/)).toBeInTheDocument();
      await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith('/api/billing/transactions', { limit: 25, before: undefined }));
      fireEvent.click(screen.getByRole('link', { name: /VIEW PROFILE/ }));
      expect(screen.getByText('PROFILE SCREEN')).toBeInTheDocument();
    });
  });

  describe('balance', () => {
    it('renders every balance with a USD equivalent for available credits', () => {
      renderPage();
      const balance = screen.getByRole('region', { name: 'Balance' });
      expect(within(balance).getByText('$5.00 USD')).toBeInTheDocument();
      expect(within(balance).getByText('PURCHASED')).toBeInTheDocument();
      expect(within(balance).getByText('RESERVED')).toBeInTheDocument();
      expect(within(balance).getByText('HELD')).toBeInTheDocument();
    });

    it('shows a loading state, not zeros, until the wallet arrives', () => {
      mocks.wallet = makeWallet({ wallet: null });
      renderPage();
      expect(screen.getByText('Loading your balance…')).toBeInTheDocument();
      expect(screen.queryByText('$0.00 USD')).not.toBeInTheDocument();
    });

    it('flags a negative balance', () => {
      mocks.wallet = makeWallet({ wallet: { available_credits: -12, reserved_credits: 0, lifetime_purchased: 0, lifetime_earned: 0, lifetime_spent: 12 } });
      renderPage();
      expect(screen.getByRole('alert')).toHaveTextContent('NEGATIVE BALANCE');
    });
  });

  describe('checkout return', () => {
    it('refreshes webhook-owned wallet state without granting credits client-side', async () => {
      window.history.replaceState({}, '', '/wallet?checkout=success&session_id=cs_test');
      renderPage('/wallet?checkout=success&session_id=cs_test');

      expect(screen.getByText(/credits appear after Stripe confirms the webhook/i)).toBeInTheDocument();
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
      expect(mocks.refresh).toHaveBeenCalledWith({ silent: true });
      expect(mocks.apiGet).toHaveBeenCalledWith('/api/billing/transactions', expect.objectContaining({ limit: 25 }));
      expect(window.location.search).toBe('');
      expect(mocks.apiPost).not.toHaveBeenCalled();
    });

    it('tells the user a cancelled checkout was not charged and does not poll', async () => {
      window.history.replaceState({}, '', '/wallet?checkout=cancelled');
      renderPage('/wallet?checkout=cancelled');
      expect(await screen.findByText(/Checkout cancelled/)).toBeInTheDocument();
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(window.location.search).toBe('');
    });
  });

  describe('credit packs', () => {
    it('lists packs with price, bonus and a featured middle tier', () => {
      renderPage();
      expect(screen.getByText('$5.00')).toBeInTheDocument();
      expect(screen.getByText('$10.00')).toBeInTheDocument();
      expect(screen.getByText('+50 BONUS')).toBeInTheDocument();
      expect(screen.getByText('+250 BONUS')).toBeInTheDocument();
      expect(screen.getByText('★ MOST POPULAR')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Buy 500 credits for $5.00' })).toBeEnabled();
    });

    it('disables packs without a configured Stripe price', () => {
      renderPage();
      expect(screen.getByRole('button', { name: /Buy 2,750 credits/ })).toBeDisabled();
      expect(screen.getByText('NOT CONFIGURED')).toBeInTheDocument();
    });

    it('disables purchases and explains why when Stripe is off', () => {
      mocks.wallet = makeWallet({ catalog: { credits_enabled: true, stripe_enabled: false, packs: PACKS } });
      renderPage();
      expect(screen.getByText(/STRIPE CHECKOUT IS DISABLED/)).toBeInTheDocument();
      screen.getAllByRole('button', { name: /^Buy / }).forEach((button) => expect(button).toBeDisabled());
    });

    it('disables purchases when credits are disabled', () => {
      mocks.wallet = makeWallet({ catalog: { credits_enabled: false, stripe_enabled: true, packs: PACKS } });
      renderPage();
      expect(screen.getByText(/ECHO CREDITS ARE DISABLED/)).toBeInTheDocument();
      screen.getAllByRole('button', { name: /^Buy / }).forEach((button) => expect(button).toBeDisabled());
    });

    it('surfaces a catalog load failure', () => {
      mocks.wallet = makeWallet({ catalog: null, catalogStatus: 'failed' });
      renderPage();
      expect(screen.getByText(/CREDIT PACKS UNAVAILABLE/)).toBeInTheDocument();
    });

    it('creates a checkout session for the chosen pack only and rejects non-Stripe URLs', async () => {
      mocks.apiPost.mockResolvedValue({ checkout_url: 'https://evil.example.com/pay' });
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Buy 1,050 credits for $10.00' }));
      expect(await screen.findByText(/Checkout is temporarily unavailable/)).toBeInTheDocument();
      expect(mocks.apiPost).toHaveBeenCalledTimes(1);
      expect(mocks.apiPost).toHaveBeenCalledWith('/api/billing/checkout-session', { pack_id: 'plus' });
      // Buttons recover so the user can retry.
      expect(screen.getByRole('button', { name: 'Buy 1,050 credits for $10.00' })).toBeEnabled();
    });

    it('maps checkout API errors to friendly copy', async () => {
      const error = Object.assign(new Error('raw stripe internals'), { code: 'CHECKOUT_MISCONFIGURED', status: 503 });
      mocks.apiPost.mockRejectedValue(error);
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Buy 500 credits for $5.00' }));
      expect(await screen.findByText('Checkout is not configured right now. Try again later.')).toBeInTheDocument();
      expect(screen.queryByText(/raw stripe internals/)).not.toBeInTheDocument();
    });

    it('blocks a second purchase while one is opening', async () => {
      mocks.apiPost.mockReturnValue(new Promise(() => {}));
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Buy 500 credits for $5.00' }));
      await screen.findByText('OPENING CHECKOUT…');
      expect(screen.getByRole('button', { name: 'Buy 1,050 credits for $10.00' })).toBeDisabled();
    });
  });

  describe('my fal key', () => {
    const keyInput = () => screen.getByLabelText('PERSONAL FAL API KEY');

    it('keeps save disabled until the key reaches the server minimum', () => {
      renderPage();
      const save = screen.getByRole('button', { name: 'SAVE ENCRYPTED KEY' });
      expect(save).toBeDisabled();
      fireEvent.change(keyInput(), { target: { value: 'short' } });
      expect(save).toBeDisabled();
      expect(screen.getByText(/at least 8 characters/)).toBeInTheDocument();
      fireEvent.change(keyInput(), { target: { value: '  fal-12345678  ' } });
      expect(save).toBeEnabled();
    });

    it('does not submit a too-short key when Enter is pressed', () => {
      renderPage();
      fireEvent.change(keyInput(), { target: { value: 'short' } });
      fireEvent.submit(keyInput().closest('form'));
      expect(mocks.saveFalKey).not.toHaveBeenCalled();
    });

    it('saves the trimmed key, clears the field and never echoes it back', async () => {
      renderPage();
      fireEvent.change(keyInput(), { target: { value: '  fal-12345678  ' } });
      fireEvent.click(screen.getByRole('button', { name: 'SAVE ENCRYPTED KEY' }));
      expect(await screen.findByText(/PERSONAL FAL KEY SAVED ENCRYPTED/)).toBeInTheDocument();
      expect(mocks.saveFalKey).toHaveBeenCalledWith('fal-12345678');
      expect(keyInput()).toHaveValue('');
    });

    it('reports a save failure with mapped copy', async () => {
      mocks.saveFalKey.mockRejectedValue(Object.assign(new Error('boom'), { status: 503 }));
      renderPage();
      fireEvent.change(keyInput(), { target: { value: 'fal-12345678' } });
      fireEvent.click(screen.getByRole('button', { name: 'SAVE ENCRYPTED KEY' }));
      expect(await screen.findByText('Something went wrong on our side. Try again shortly.')).toBeInTheDocument();
      // The typed key stays so the user can retry.
      expect(keyInput()).toHaveValue('fal-12345678');
    });

    it('toggles key visibility', () => {
      renderPage();
      expect(keyInput()).toHaveAttribute('type', 'password');
      fireEvent.click(screen.getByRole('button', { name: 'SHOW' }));
      expect(keyInput()).toHaveAttribute('type', 'text');
      fireEvent.click(screen.getByRole('button', { name: 'HIDE' }));
      expect(keyInput()).toHaveAttribute('type', 'password');
    });

    it('only enables removal when a key is saved, and removes it', async () => {
      const { unmount } = renderPage();
      expect(screen.getByRole('button', { name: 'REMOVE KEY' })).toBeDisabled();
      unmount();

      mocks.wallet = makeWallet({ falKey: { configured: true, hint: '••••9883' } });
      renderPage();
      expect(screen.getByText('••••9883')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'REMOVE KEY' }));
      expect(await screen.findByText(/PERSONAL FAL KEY REMOVED/)).toBeInTheDocument();
      expect(mocks.deleteFalKey).toHaveBeenCalledTimes(1);
    });
  });

  describe('transaction history', () => {
    it('shows an empty state', async () => {
      renderPage();
      expect(await screen.findByText(/No credit transactions yet/)).toBeInTheDocument();
    });

    it('renders friendly labels, signed deltas and reserved changes', async () => {
      mocks.apiGet.mockResolvedValue({
        transactions: [
          ledgerRow(1),
          ledgerRow(2, { type: 'reserve', source: 'generation', delta_available: -40, delta_reserved: 40 }),
          ledgerRow(3, { type: 'credit', source: 'earned', delta_available: 15 }),
        ],
      });
      renderPage();
      const list = await screen.findByRole('list', { name: 'Credit transactions' });
      expect(within(list).getByText('PURCHASE')).toBeInTheDocument();
      expect(within(list).getByText('CLOUD JOB')).toBeInTheDocument();
      expect(within(list).getByText('REEL REWARD')).toBeInTheDocument();
      expect(within(list).getByText('+500 CR')).toBeInTheDocument();
      expect(within(list).getByText('-40 CR')).toBeInTheDocument();
      expect(within(list).getByText('+40 reserved')).toBeInTheDocument();
      expect(screen.getByText('END OF LEDGER · 3 ENTRIES')).toBeInTheDocument();
    });

    it('survives malformed rows without crashing', async () => {
      mocks.apiGet.mockResolvedValue({ transactions: [{ id: 'bad', created_at: 'nope' }] });
      renderPage();
      expect(await screen.findByText('Date unavailable')).toBeInTheDocument();
      expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    });

    it('offers a retry after a load failure', async () => {
      mocks.apiGet.mockRejectedValueOnce(new Error('down')).mockResolvedValue({ transactions: [ledgerRow(1)] });
      renderPage();
      expect(await screen.findByText('COULD NOT LOAD TRANSACTIONS')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'RETRY' }));
      expect(await screen.findByText('PURCHASE')).toBeInTheDocument();
    });

    it('pages with the last row id as the cursor and appends', async () => {
      const first = Array.from({ length: 25 }, (_, i) => ledgerRow(i));
      mocks.apiGet.mockResolvedValueOnce({ transactions: first }).mockResolvedValueOnce({ transactions: [ledgerRow(99)] });
      renderPage();
      const more = await screen.findByRole('button', { name: 'LOAD MORE' });
      fireEvent.click(more);
      await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(26));
      expect(mocks.apiGet).toHaveBeenLastCalledWith('/api/billing/transactions', { limit: 25, before: 'tx24' });
      expect(screen.queryByRole('button', { name: 'LOAD MORE' })).not.toBeInTheDocument();
    });

    it('keeps the loaded rows when a later page fails', async () => {
      const first = Array.from({ length: 25 }, (_, i) => ledgerRow(i));
      mocks.apiGet.mockResolvedValueOnce({ transactions: first }).mockRejectedValueOnce(new Error('down'));
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'LOAD MORE' }));
      expect(await screen.findByText('Could not load more transactions.')).toBeInTheDocument();
      expect(screen.getAllByRole('listitem')).toHaveLength(25);
    });

    it('refresh reloads wallet and ledger together', async () => {
      renderPage();
      await screen.findByText(/No credit transactions yet/);
      fireEvent.click(screen.getByRole('button', { name: /REFRESH/ }));
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith({ silent: true }));
      await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(2));
    });
  });
});
