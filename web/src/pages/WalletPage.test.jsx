import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WalletPage from './WalletPage.jsx';
import { ToastProvider } from '../components/ui/Toast.jsx';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  saveFalKey: vi.fn(),
  deleteFalKey: vi.fn(),
  apiGet: vi.fn(),
  rewardStatus: vi.fn(),
  apiPost: vi.fn(),
  auth: { user: null, loading: false },
  wallet: null,
}));

vi.mock('../api/client.js', () => ({
  api: {
    // Reel-reward status has its own mock so ledger tests can queue replies in order.
    get: (path, ...rest) => (path === '/api/rewards/reels/status' ? mocks.rewardStatus() : mocks.apiGet(path, ...rest)),
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
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/login" element={<div>LOGIN SCREEN</div>} />
          <Route path="/profile/:username" element={<div>PROFILE SCREEN</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('WalletPage', () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.refresh.mockReset().mockResolvedValue(null);
    mocks.saveFalKey.mockReset().mockResolvedValue({ configured: true, hint: '••••1234' });
    mocks.deleteFalKey.mockReset().mockResolvedValue({ configured: false, hint: '' });
    mocks.apiGet.mockReset().mockResolvedValue({ transactions: [] });
    mocks.rewardStatus.mockReset().mockResolvedValue({ enabled: false });
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
      expect(screen.queryByText('Buy credits')).not.toBeInTheDocument();
      expect(mocks.apiGet).not.toHaveBeenCalled();
    });

    it('shows only the signed-in account and a link back to its own profile', async () => {
      renderPage();
      expect(screen.getByText(/Signed in as @echodev/)).toBeInTheDocument();
      await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith('/api/billing/transactions', { limit: 25, before: undefined }));
      fireEvent.click(screen.getByRole('link', { name: /View profile/ }));
      expect(screen.getByText('PROFILE SCREEN')).toBeInTheDocument();
    });
  });

  describe('balance', () => {
    it('leads with the available balance, its USD value and any held credits', () => {
      renderPage();
      const balance = screen.getByRole('region', { name: 'Balance' });
      expect(within(balance).getByText('500')).toBeInTheDocument();
      expect(within(balance).getByText(/≈ \$5\.00 of cloud work/)).toBeInTheDocument();
      expect(within(balance).getByText(/held for a running job/)).toBeInTheDocument();
      expect(within(balance).getByRole('link', { name: 'Buy credits' })).toHaveAttribute('href', '#add-credits');
    });

    it('hides the held line when nothing is reserved', () => {
      mocks.wallet = makeWallet({ wallet: { available_credits: 500, reserved_credits: 0 } });
      renderPage();
      expect(screen.queryByText(/held for a running job/)).not.toBeInTheDocument();
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
      expect(screen.getByRole('alert')).toHaveTextContent('Negative balance');
    });
  });

  describe('checkout return', () => {
    it('refreshes webhook-owned wallet state without granting credits client-side', async () => {
      window.history.replaceState({}, '', '/wallet?checkout=success&session_id=cs_test');
      renderPage('/wallet?checkout=success&session_id=cs_test');

      expect(screen.getByText(/credits appear as soon as Stripe confirms/i)).toBeInTheDocument();
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
      expect(screen.getByText('+50 bonus')).toBeInTheDocument();
      expect(screen.getByText('+250 bonus')).toBeInTheDocument();
      expect(screen.getByText('Most popular')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Buy 500 credits for $5.00' })).toBeEnabled();
    });

    it('disables packs without a configured Stripe price', () => {
      renderPage();
      expect(screen.getByRole('button', { name: /Buy 2,750 credits/ })).toBeDisabled();
      expect(screen.getByText('Not available yet')).toBeInTheDocument();
    });

    it('disables purchases and explains why when Stripe is off', () => {
      mocks.wallet = makeWallet({ catalog: { credits_enabled: true, stripe_enabled: false, packs: PACKS } });
      renderPage();
      expect(screen.getByText(/Card checkout is turned off/)).toBeInTheDocument();
      screen.getAllByRole('button', { name: /^Buy / }).forEach((button) => expect(button).toBeDisabled());
    });

    it('replaces the packs with one explanation when credits are disabled', () => {
      mocks.wallet = makeWallet({ catalog: { credits_enabled: false, stripe_enabled: true, packs: PACKS } });
      renderPage();
      expect(screen.getByText("Buying credits isn't available yet. You can still use free tools.")).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Buy / })).not.toBeInTheDocument();
      expect(screen.queryByText('Most popular')).not.toBeInTheDocument();
    });

    it('surfaces a catalog load failure', () => {
      mocks.wallet = makeWallet({ catalog: null, catalogStatus: 'failed' });
      renderPage();
      expect(screen.getByText(/Credit packs couldn't load/)).toBeInTheDocument();
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
      await screen.findByText('Opening checkout…');
      expect(screen.getByRole('button', { name: 'Buy 1,050 credits for $10.00' })).toBeDisabled();
    });
  });

  describe('my fal key', () => {
    const keyInput = () => screen.getByLabelText('Fal.ai API key');

    it('keeps save disabled until the key reaches the server minimum', () => {
      renderPage();
      const save = screen.getByRole('button', { name: 'Save key' });
      expect(save).toBeDisabled();
      fireEvent.change(keyInput(), { target: { value: 'short' } });
      expect(save).toBeDisabled();
      expect(screen.getByText(/at least 8 characters/)).toBeInTheDocument();
      expect(keyInput()).toHaveAccessibleDescription('Keys are at least 8 characters.');
      expect(keyInput()).toHaveAttribute('aria-invalid', 'true');
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
      fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
      expect(await screen.findByText('Personal fal key saved, encrypted.')).toBeInTheDocument();
      expect(mocks.saveFalKey).toHaveBeenCalledWith('fal-12345678');
      expect(keyInput()).toHaveValue('');
    });

    it('reports a save failure with mapped copy', async () => {
      mocks.saveFalKey.mockRejectedValue(Object.assign(new Error('boom'), { status: 503 }));
      renderPage();
      fireEvent.change(keyInput(), { target: { value: 'fal-12345678' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
      expect(await screen.findByText('Something went wrong on our side. Try again shortly.')).toBeInTheDocument();
      // The typed key stays so the user can retry.
      expect(keyInput()).toHaveValue('fal-12345678');
    });

    it('toggles key visibility', () => {
      renderPage();
      expect(keyInput()).toHaveAttribute('type', 'password');
      fireEvent.click(screen.getByRole('button', { name: 'Show' }));
      expect(keyInput()).toHaveAttribute('type', 'text');
      fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
      expect(keyInput()).toHaveAttribute('type', 'password');
    });

    it('only offers removal when a key is saved, and removes it', async () => {
      const { unmount } = renderPage();
      expect(screen.queryByRole('button', { name: 'Remove key' })).not.toBeInTheDocument();
      expect(screen.getByText(/Not set · jobs use your credits/)).toBeInTheDocument();
      unmount();

      mocks.wallet = makeWallet({ falKey: { configured: true, hint: '••••9883' } });
      renderPage();
      expect(screen.getByText('••••9883')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
      expect(await screen.findByText('Personal fal key removed.')).toBeInTheDocument();
      expect(mocks.deleteFalKey).toHaveBeenCalledTimes(1);
    });
  });

  describe('transaction history', () => {
    it('shows an empty state', async () => {
      renderPage();
      expect(await screen.findByText(/No usage yet/)).toBeInTheDocument();
    });

    it('splits usage from payments, with friendly labels, signed deltas and held changes', async () => {
      mocks.apiGet.mockResolvedValue({
        transactions: [
          ledgerRow(1),
          ledgerRow(2, { type: 'reserve', source: 'generation', delta_available: -40, delta_reserved: 40 }),
          ledgerRow(3, { type: 'credit', source: 'earned', delta_available: 15 }),
        ],
      });
      renderPage();
      const usage = await screen.findByRole('list', { name: 'Credit usage' });
      expect(within(usage).getByText('Cloud job')).toBeInTheDocument();
      expect(within(usage).getByText(/credits held/)).toBeInTheDocument();
      expect(within(usage).getByText('Reel reward')).toBeInTheDocument();
      expect(within(usage).getByText('-40')).toBeInTheDocument();
      expect(within(usage).getByText('+40 held')).toBeInTheDocument();
      expect(within(usage).queryByText('Credit purchase')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Payments' }));
      const payments = screen.getByRole('list', { name: 'Payments' });
      expect(within(payments).getByText('Credit purchase')).toBeInTheDocument();
      expect(within(payments).getByText('+500')).toBeInTheDocument();
      expect(within(payments).queryByText('Cloud job')).not.toBeInTheDocument();
    });

    it('shows a per-view empty state', async () => {
      mocks.apiGet.mockResolvedValue({ transactions: [ledgerRow(1, { source: 'generation', delta_available: -10 })] });
      renderPage();
      await screen.findByRole('list', { name: 'Credit usage' });
      fireEvent.click(screen.getByRole('button', { name: 'Payments' }));
      expect(screen.getByText(/No payments yet/)).toBeInTheDocument();
    });

    it('survives malformed rows without crashing', async () => {
      mocks.apiGet.mockResolvedValue({ transactions: [{ id: 'bad', created_at: 'nope' }] });
      renderPage();
      expect(await screen.findByText('Date unavailable')).toBeInTheDocument();
      expect(screen.getByText('Unknown')).toBeInTheDocument();
    });

    it('offers a retry after a load failure', async () => {
      mocks.apiGet.mockRejectedValueOnce(new Error('down')).mockResolvedValue({ transactions: [ledgerRow(1, { source: 'generation' })] });
      renderPage();
      expect(await screen.findByText("Couldn't load your history.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('Cloud job')).toBeInTheDocument();
    });

    it('pages with the last row id as the cursor and appends', async () => {
      const first = Array.from({ length: 25 }, (_, i) => ledgerRow(i, { source: 'generation' }));
      mocks.apiGet.mockResolvedValueOnce({ transactions: first }).mockResolvedValueOnce({ transactions: [ledgerRow(99, { source: 'generation' })] });
      renderPage();
      const more = await screen.findByRole('button', { name: 'Load more' });
      fireEvent.click(more);
      await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(26));
      expect(mocks.apiGet).toHaveBeenLastCalledWith('/api/billing/transactions', { limit: 25, before: 'tx24' });
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });

    it('keeps the loaded rows when a later page fails', async () => {
      const first = Array.from({ length: 25 }, (_, i) => ledgerRow(i, { source: 'generation' }));
      mocks.apiGet.mockResolvedValueOnce({ transactions: first }).mockRejectedValueOnce(new Error('down'));
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
      expect(await screen.findByText('Could not load more history.')).toBeInTheDocument();
      expect(screen.getAllByRole('listitem')).toHaveLength(25);
    });

    it('refresh reloads wallet and ledger together', async () => {
      renderPage();
      await screen.findByText(/No usage yet/);
      fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith({ silent: true }));
      await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(2));
    });
  });

  describe('reel reward progress', () => {
    const status = (extra) => ({
      enabled: true, eligible_reels_today: 6, credits_earned_today: 2, credit_awarded: false,
      progress: 6, target: 10, remaining: 4, daily_cap_reached: false, ...extra,
    });
    const answer = (reply) => mocks.rewardStatus.mockImplementation(() => Promise.resolve(reply()));

    it('shows today\'s progress on open, before any claim', async () => {
      answer(() => status());
      renderPage();
      const line = await screen.findByTestId('reel-reward-progress');
      expect(line).toHaveTextContent('6/10 reels to your next credit · 2/5 earned today');
    });

    it('shows the daily cap once reached', async () => {
      answer(() => status({ progress: 10, remaining: 0, credits_earned_today: 5, daily_cap_reached: true }));
      renderPage();
      expect(await screen.findByTestId('reel-reward-progress')).toHaveTextContent('daily cap reached · 5/5 earned today');
    });

    it('hides the line while reel rewards are off', async () => {
      answer(() => ({ enabled: false }));
      renderPage();
      await waitFor(() => expect(mocks.rewardStatus).toHaveBeenCalled());
      expect(screen.queryByTestId('reel-reward-progress')).not.toBeInTheDocument();
    });
  });
});
