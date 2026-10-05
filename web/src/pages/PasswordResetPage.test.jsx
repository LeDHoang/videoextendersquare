import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PasswordResetPage from './PasswordResetPage.jsx';

const mocks = vi.hoisted(() => ({
  auth: { refresh: vi.fn() },
  api: { post: vi.fn() },
}));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));

class FakeApiError extends Error {
  constructor(message, { code, field, status = 400 } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = { code, message, field };
  }
}

const SENT = { ok: true, message: 'If that email belongs to an active account, a reset link has been sent.' };

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

function renderAt(entry) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/forgot-password" element={<PasswordResetPage requestOnly />} />
        <Route path="/reset-password" element={<PasswordResetPage />} />
        <Route path="/login" element={<div>LOGIN SCREEN</div>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name) => fireEvent.click(screen.getByRole('button', { name }));

describe('PasswordResetPage — request a link', () => {
  beforeEach(() => {
    mocks.api.post.mockReset().mockResolvedValue(SENT);
    mocks.auth.refresh.mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows the email form at step 1 of 3 with a way back', () => {
    renderAt('/forgot-password');
    expect(screen.getByRole('heading', { level: 1, name: 'RESET PASSWORD' })).toBeInTheDocument();
    expect(screen.getByText('STEP 1 OF 3')).toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByRole('link', { name: '← BACK TO SIGN IN' })).toHaveAttribute('href', '/login');
    expect(screen.queryByText(/MISSING ITS RESET TOKEN/)).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Recovery steps' }).querySelector('[aria-current="step"]')).toHaveTextContent('ENTER YOUR EMAIL');
  });

  it('rejects an empty or malformed email without calling the API', () => {
    renderAt('/forgot-password');
    click('SEND RESET LINK');
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL')).toHaveFocus();
    type('EMAIL', 'not-an-email');
    click('SEND RESET LINK');
    expect(screen.getByText(/valid email/)).toBeInTheDocument();
    expect(mocks.api.post).not.toHaveBeenCalled();
  });

  it('requests a link for the trimmed email and moves to the "check your inbox" step', async () => {
    renderAt('/forgot-password');
    type('EMAIL', '  maker@example.com ');
    click('SEND RESET LINK');
    expect(await screen.findByRole('heading', { level: 1, name: 'CHECK YOUR INBOX' })).toBeInTheDocument();
    expect(mocks.api.post).toHaveBeenCalledWith('/api/auth/password-reset/request', { email: 'maker@example.com' });
    expect(screen.getByText(SENT.message)).toBeInTheDocument();
    expect(screen.getByText('maker@example.com')).toBeInTheDocument();
    expect(screen.getByText('30 MINUTES · ONE USE')).toBeInTheDocument();
    expect(screen.getByText('STEP 2 OF 3')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Recovery steps' }).querySelector('[aria-current="step"]')).toHaveTextContent('OPEN THE LINK');
    expect(screen.queryByText(/DEVELOPMENT MODE/)).not.toBeInTheDocument();
  });

  it('shows the same confirmation whether or not the account exists (no enumeration from the UI)', async () => {
    // The server answers identically; the page must not add anything account-specific.
    renderAt('/forgot-password');
    type('EMAIL', 'ghost@example.com');
    click('SEND RESET LINK');
    await screen.findByText('CHECK YOUR INBOX', { selector: 'h1' });
    expect(screen.queryByText(/not found|no account|unknown/i)).not.toBeInTheDocument();
  });

  it('in development mode offers the reset link directly', async () => {
    mocks.api.post.mockResolvedValue({ ...SENT, debug_token: 'tok/en+1' });
    renderAt('/forgot-password');
    type('EMAIL', 'maker@example.com');
    click('SEND RESET LINK');
    const link = await screen.findByRole('link', { name: /^OPEN THE RESET LINK\s→$/ });
    expect(link).toHaveAttribute('href', '/reset-password?token=tok%2Fen%2B1');
    expect(screen.getByText(/DEVELOPMENT MODE/)).toBeInTheDocument();
  });

  it('shows a failed request (rate limit) as an alert and stays on the form', async () => {
    mocks.api.post.mockRejectedValue(new FakeApiError('Too many requests. Try again shortly.', { status: 429, code: 'RATE_LIMITED' }));
    renderAt('/forgot-password');
    type('EMAIL', 'maker@example.com');
    click('SEND RESET LINK');
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
    expect(screen.getByLabelText('EMAIL')).toHaveValue('maker@example.com');
    expect(screen.getByRole('button', { name: 'SEND RESET LINK' })).toBeEnabled();
  });

  it('ignores a double submit', async () => {
    let finish;
    mocks.api.post.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderAt('/forgot-password');
    type('EMAIL', 'maker@example.com');
    const form = screen.getByLabelText('EMAIL').closest('form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(mocks.api.post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /WORKING/ })).toBeDisabled();
    await act(async () => { finish(SENT); });
    await screen.findByText('CHECK YOUR INBOX', { selector: 'h1' });
  });

  describe('resend and change email', () => {
    const toSent = async () => {
      renderAt('/forgot-password');
      type('EMAIL', 'maker@example.com');
      click('SEND RESET LINK');
      await screen.findByText('CHECK YOUR INBOX', { selector: 'h1' });
    };

    it('locks resend behind a 30s countdown, then requests another link', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await toSent();
      const button = screen.getByRole('button', { name: 'RESEND IN 30S' });
      expect(button).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(screen.getByRole('button', { name: 'RESEND IN 20S' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'RESEND IN 20S' }));
      expect(mocks.api.post).toHaveBeenCalledTimes(1); // still only the original request

      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      const ready = screen.getByRole('button', { name: 'RESEND LINK' });
      expect(ready).toBeEnabled();
      await act(async () => { fireEvent.click(ready); });
      expect(mocks.api.post).toHaveBeenCalledTimes(2);
      expect(mocks.api.post).toHaveBeenLastCalledWith('/api/auth/password-reset/request', { email: 'maker@example.com' });
      expect(await screen.findByText(/new link was requested/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'RESEND IN 30S' })).toBeDisabled();
    });

    it('shows a failed resend and lets the user try again', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await toSent();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      mocks.api.post.mockRejectedValueOnce(new FakeApiError('Too many requests.', { status: 429 }));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'RESEND LINK' })); });
      expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests.');
      expect(screen.getByRole('button', { name: 'RESEND LINK' })).toBeEnabled();
    });

    it('"use a different email" returns to an empty form at step 1', async () => {
      await toSent();
      click('USE A DIFFERENT EMAIL');
      expect(screen.getByRole('heading', { level: 1, name: 'RESET PASSWORD' })).toBeInTheDocument();
      expect(screen.getByLabelText('EMAIL')).toHaveValue('');
      expect(screen.getByText('STEP 1 OF 3')).toBeInTheDocument();
    });
  });
});

describe('PasswordResetPage — choose a new password', () => {
  beforeEach(() => {
    mocks.api.post.mockReset().mockResolvedValue({ ok: true });
    mocks.auth.refresh.mockReset().mockResolvedValue(null);
  });
  afterEach(cleanup);

  const open = () => renderAt('/reset-password?token=abc123');
  const fill = (password = 'a-new-password-1', confirmation = password) => {
    type('NEW PASSWORD', password);
    type('CONFIRM PASSWORD', confirmation);
  };

  it('shows the choose form at step 3 of 3', () => {
    open();
    expect(screen.getByRole('heading', { level: 1, name: 'CHOOSE PASSWORD' })).toBeInTheDocument();
    expect(screen.getByText('STEP 3 OF 3')).toBeInTheDocument();
    expect(screen.getByLabelText('NEW PASSWORD')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('CONFIRM PASSWORD')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByRole('list', { name: 'Recovery steps' }).querySelector('[aria-current="step"]')).toHaveTextContent('CHOOSE A NEW PASSWORD');
  });

  it('a requestOnly route ignores a token in the URL', () => {
    render(
      <MemoryRouter initialEntries={['/forgot-password?token=abc']}>
        <Routes><Route path="/forgot-password" element={<PasswordResetPage requestOnly />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'RESET PASSWORD' })).toBeInTheDocument();
    expect(screen.queryByLabelText('NEW PASSWORD')).not.toBeInTheDocument();
  });

  it('/reset-password without a token falls back to requesting a link, and says why', () => {
    renderAt('/reset-password');
    expect(screen.getByRole('heading', { name: 'RESET PASSWORD' })).toBeInTheDocument();
    expect(screen.getByText(/MISSING ITS RESET TOKEN/)).toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL')).toBeInTheDocument();
  });

  it('refuses a short password and a mismatch locally, without spending the token', () => {
    open();
    fill('short', 'short');
    click('UPDATE PASSWORD');
    expect(screen.getByText('Password must be at least 10 characters.')).toBeInTheDocument();
    expect(screen.getByLabelText('NEW PASSWORD')).toHaveFocus();
    fill('a-new-password-1', 'a-new-password-2');
    click('UPDATE PASSWORD');
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    expect(screen.getByLabelText('CONFIRM PASSWORD')).toHaveFocus();
    expect(mocks.api.post).not.toHaveBeenCalled();
  });

  it('requires the confirmation to be filled in', () => {
    open();
    type('NEW PASSWORD', 'a-new-password-1');
    click('UPDATE PASSWORD');
    expect(screen.getByText('Type the new password again.')).toBeInTheDocument();
  });

  it('confirms live that the two passwords match', () => {
    open();
    fill('a-new-password-1', 'a-new-password-');
    expect(screen.queryByText('✓ PASSWORDS MATCH')).not.toBeInTheDocument();
    type('CONFIRM PASSWORD', 'a-new-password-1');
    expect(screen.getByText('✓ PASSWORDS MATCH')).toBeInTheDocument();
  });

  it('shows rules and strength for the new password', () => {
    open();
    type('NEW PASSWORD', 'abcdefghijklm1!');
    expect(screen.getByRole('img', { name: 'Password strength: STRONG' })).toBeInTheDocument();
  });

  it('sends the token and password, then shows success and re-reads the session', async () => {
    open();
    fill();
    click('UPDATE PASSWORD');
    expect(await screen.findByRole('heading', { level: 1, name: 'PASSWORD UPDATED' })).toBeInTheDocument();
    expect(mocks.api.post).toHaveBeenCalledWith('/api/auth/password-reset/confirm', { token: 'abc123', new_password: 'a-new-password-1' });
    expect(screen.getByRole('link', { name: 'SIGN IN' })).toHaveAttribute('href', '/login');
    expect(mocks.auth.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/reset-password$/); // one-time token is gone from the URL
    expect(screen.queryByLabelText('NEW PASSWORD')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Recovery steps' }).querySelectorAll('.is-done')).toHaveLength(3);
  });

  it('the success screen is driven by history state, so it survives the app shell remounting the page', () => {
    // Refreshing the session flips the user, and AppShell then remounts the whole page.
    renderAt({ pathname: '/reset-password', state: { passwordUpdated: true } });
    expect(screen.getByRole('heading', { level: 1, name: 'PASSWORD UPDATED' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'SIGN IN' })).toHaveAttribute('href', '/login');
  });

  it('a forged ?status in the URL (no history state) never shows the success screen', () => {
    renderAt('/reset-password?status=updated');
    expect(screen.queryByText('PASSWORD UPDATED')).not.toBeInTheDocument();
  });

  it('an expired or used link shows a dedicated screen that leads to a fresh request', async () => {
    mocks.api.post.mockRejectedValue(new FakeApiError('This password reset link is invalid or expired.', { code: 'INVALID_RESET_TOKEN' }));
    open();
    fill();
    click('UPDATE PASSWORD');
    expect(await screen.findByRole('heading', { level: 1, name: 'LINK EXPIRED' })).toBeInTheDocument();
    expect(mocks.auth.refresh).not.toHaveBeenCalled();
    const request = screen.getByRole('link', { name: 'REQUEST A NEW LINK' });
    expect(request).toHaveAttribute('href', '/forgot-password');
    fireEvent.click(request);
    // landing on /forgot-password must start a fresh request form, not stay on "expired"
    expect(await screen.findByRole('heading', { level: 1, name: 'RESET PASSWORD' })).toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL')).toBeInTheDocument();
  });

  it('maps a server password complaint onto the password field and keeps the form', async () => {
    mocks.api.post.mockRejectedValue(new FakeApiError('Password must be 10–128 characters.', { code: 'INVALID_PASSWORD', field: 'password', status: 422 }));
    open();
    fill();
    click('UPDATE PASSWORD');
    expect(await screen.findByText('Password must be 10–128 characters.')).toBeInTheDocument();
    expect(screen.getByLabelText('NEW PASSWORD')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('NEW PASSWORD')).toHaveFocus();
    type('NEW PASSWORD', 'a-new-password-12');
    expect(screen.queryByText('Password must be 10–128 characters.')).not.toBeInTheDocument();
  });

  it('shows other failures (rate limit) as an alert without losing the typed passwords', async () => {
    mocks.api.post.mockRejectedValue(new FakeApiError('Too many requests. Try again shortly.', { status: 429 }));
    open();
    fill();
    click('UPDATE PASSWORD');
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
    expect(screen.getByLabelText('NEW PASSWORD')).toHaveValue('a-new-password-1');
    expect(screen.getByRole('button', { name: 'UPDATE PASSWORD' })).toBeEnabled();
  });

  it('ignores a double submit', async () => {
    let finish;
    mocks.api.post.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    open();
    fill();
    const form = screen.getByLabelText('NEW PASSWORD').closest('form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(mocks.api.post).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: true }); });
    await waitFor(() => expect(mocks.auth.refresh).toHaveBeenCalledTimes(1));
  });

  it('each password field has its own show/hide toggle', () => {
    open();
    const [first, second] = screen.getAllByRole('button', { name: 'Show password' });
    fireEvent.click(first);
    expect(screen.getByLabelText('NEW PASSWORD')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('CONFIRM PASSWORD')).toHaveAttribute('type', 'password');
    fireEvent.click(second);
    expect(screen.getByLabelText('CONFIRM PASSWORD')).toHaveAttribute('type', 'text');
  });
});
