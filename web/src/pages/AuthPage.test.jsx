import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuthPage from './AuthPage.jsx';

const mocks = vi.hoisted(() => ({
  auth: { user: null, loading: false, login: vi.fn(), register: vi.fn() },
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));
// The real widget loads Cloudflare's script; this stand-in just hands out a token on click.
vi.mock('../components/auth/Turnstile.jsx', () => ({
  default: ({ siteKey, onToken }) => (siteKey
    ? <button type="button" onClick={() => onToken('cf-token')}>SOLVE BOT CHECK</button>
    : null),
}));

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

class FakeApiError extends Error {
  constructor(message, { code, field, status = 400 } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = { code, message, field };
  }
}

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/signup" element={<AuthPage mode="register" />} />
        <Route path="/forgot-password" element={<div>FORGOT SCREEN</div>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: /^(SIGN IN|CREATE ACCOUNT)$/ }));
const where = () => screen.getByTestId('where').textContent;

describe('AuthPage — sign in', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    Object.values(mocks.api).forEach((fn) => fn.mockReset());
    mocks.auth.user = null;
    mocks.auth.loading = false;
    mocks.auth.login.mockReset().mockResolvedValue({ id: 'u1' });
    mocks.auth.register.mockReset().mockResolvedValue({ id: 'u1' });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the sign-in form with recovery and sign-up routes that keep the destination', () => {
    renderAt('/login?next=%2Fwallet');
    expect(screen.getByRole('heading', { level: 1, name: 'SIGN IN' })).toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL OR USERNAME')).toBeInTheDocument();
    expect(screen.getByLabelText('PASSWORD')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('link', { name: 'FORGOT PASSWORD?' })).toHaveAttribute('href', '/forgot-password');
    expect(screen.getByRole('link', { name: 'CREATE ACCOUNT' })).toHaveAttribute('href', '/signup?next=%2Fwallet');
    expect(screen.getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/signup?next=%2Fwallet');
    expect(screen.getByRole('link', { name: 'SIGN IN' })).toHaveAttribute('aria-current', 'page');
  });

  it('tabs identifier → password → show/hide → forgot password → submit', () => {
    renderAt('/login');
    const order = [
      screen.getByLabelText('EMAIL OR USERNAME'),
      screen.getByLabelText('PASSWORD'),
      screen.getByRole('button', { name: 'Show password' }),
      screen.getByRole('link', { name: 'FORGOT PASSWORD?' }),
      screen.getByRole('button', { name: 'SIGN IN' }),
    ];
    order.slice(1).forEach((element, index) => {
      expect(order[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it('does not call the API for an empty form, shows inline errors and focuses the first bad field', () => {
    renderAt('/login');
    submit();
    expect(mocks.auth.login).not.toHaveBeenCalled();
    expect(screen.getByText('Enter your email or username.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL OR USERNAME')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('EMAIL OR USERNAME')).toHaveFocus();
  });

  it('does not impose the new-password length rule on existing accounts', async () => {
    renderAt('/login');
    type('EMAIL OR USERNAME', 'maker');
    type('PASSWORD', 'short');
    submit();
    await waitFor(() => expect(mocks.auth.login).toHaveBeenCalledWith({ identifier: 'maker', password: 'short' }));
  });

  it('signs in with a trimmed identifier and lands on next', async () => {
    renderAt('/login?next=%2Fexplore');
    type('EMAIL OR USERNAME', '  maker@example.com ');
    type('PASSWORD', 'correct horse');
    submit();
    await waitFor(() => expect(where()).toBe('/explore'));
    expect(mocks.auth.login).toHaveBeenCalledWith({ identifier: 'maker@example.com', password: 'correct horse' });
  });

  it('falls back to /reels for an unsafe next', async () => {
    renderAt('/login?next=%2F%2Fevil.test');
    type('EMAIL OR USERNAME', 'maker');
    type('PASSWORD', 'correct horse');
    submit();
    await waitFor(() => expect(where()).toBe('/reels'));
  });

  it('never redirects back to the login screen itself', async () => {
    renderAt('/login?next=%2Flogin');
    type('EMAIL OR USERNAME', 'maker');
    type('PASSWORD', 'correct horse');
    submit();
    await waitFor(() => expect(where()).toBe('/reels'));
  });

  it('shows a rejected sign-in as an alert, clears the password and refocuses it', async () => {
    mocks.auth.login.mockRejectedValue(new FakeApiError('Email/username or password is incorrect.', { code: 'INVALID_CREDENTIALS', status: 401 }));
    renderAt('/login');
    type('EMAIL OR USERNAME', 'maker');
    type('PASSWORD', 'wrong password');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Email/username or password is incorrect.');
    expect(screen.getByLabelText('PASSWORD')).toHaveValue('');
    expect(screen.getByLabelText('PASSWORD')).toHaveFocus();
    expect(screen.queryByText('Enter your password.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('PASSWORD')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('EMAIL OR USERNAME')).toHaveValue('maker');
    expect(screen.getByRole('button', { name: 'SIGN IN' })).toBeEnabled();
  });

  it('shows rate-limit and network failures without clearing what was typed', async () => {
    mocks.auth.login.mockRejectedValue(new FakeApiError('Too many requests. Try again shortly.', { code: 'RATE_LIMITED', status: 429 }));
    renderAt('/login');
    type('EMAIL OR USERNAME', 'maker');
    type('PASSWORD', 'wrong password');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
    expect(screen.getByLabelText('PASSWORD')).toHaveValue('wrong password');
  });

  it('clears the alert as soon as the user edits a field', async () => {
    mocks.auth.login.mockRejectedValue(new FakeApiError('Email/username or password is incorrect.', { code: 'INVALID_CREDENTIALS' }));
    renderAt('/login');
    type('EMAIL OR USERNAME', 'maker');
    type('PASSWORD', 'x');
    submit();
    await screen.findByRole('alert');
    type('PASSWORD', 'xy');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores a second submit while the first is in flight and disables the button', async () => {
    let finish;
    mocks.auth.login.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderAt('/login');
    type('EMAIL OR USERNAME', 'maker');
    type('PASSWORD', 'correct horse');
    const form = screen.getByLabelText('PASSWORD').closest('form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(mocks.auth.login).toHaveBeenCalledTimes(1);
    const busyButton = screen.getByRole('button', { name: /WORKING/ });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finish({ id: 'u1' }); });
    await waitFor(() => expect(where()).toBe('/reels'));
  });

  it('toggles password visibility', () => {
    renderAt('/login');
    const input = screen.getByLabelText('PASSWORD');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('warns while caps lock is on and stops warning on blur', () => {
    renderAt('/login');
    const input = screen.getByLabelText('PASSWORD');
    type('PASSWORD', 'x'); // non-empty, so blurring raises no "required" error that would also hide the warning
    fireEvent.keyDown(input, { key: 'A', modifierCapsLock: true });
    expect(screen.getByText('CAPS LOCK IS ON')).toBeInTheDocument();
    fireEvent.keyUp(input, { key: 'a', modifierCapsLock: false });
    expect(screen.queryByText('CAPS LOCK IS ON')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'A', modifierCapsLock: true });
    fireEvent.blur(input);
    expect(screen.queryByText('CAPS LOCK IS ON')).not.toBeInTheDocument();
  });

  it('redirects an already signed-in visitor straight to next', async () => {
    mocks.auth.user = { id: 'u1' };
    renderAt('/login?next=%2Fexplore');
    await waitFor(() => expect(where()).toBe('/explore'));
  });

  it('waits for the session check before redirecting', () => {
    mocks.auth.user = { id: 'u1' };
    mocks.auth.loading = true;
    renderAt('/login');
    expect(screen.getByRole('heading', { name: 'SIGN IN' })).toBeInTheDocument();
  });

  describe('pending action from a signed-out like/follow', () => {
    const stash = (value) => sessionStorage.setItem('echo:pending-action', JSON.stringify(value));

    it('tells the visitor what will happen, then replays it once and clears it', async () => {
      stash({ kind: 'like', post_id: 'p 1', created_at: Date.now() });
      mocks.api.put.mockResolvedValue({});
      renderAt('/login?next=%2Fexplore');
      expect(screen.getByText(/WE'LL LIKE THAT POST/)).toBeInTheDocument();
      type('EMAIL OR USERNAME', 'maker');
      type('PASSWORD', 'correct horse');
      submit();
      await waitFor(() => expect(where()).toBe('/explore'));
      expect(mocks.api.put).toHaveBeenCalledTimes(1);
      expect(mocks.api.put).toHaveBeenCalledWith('/api/posts/p%201/like');
      expect(sessionStorage.getItem('echo:pending-action')).toBeNull();
    });

    it('replays a follow', async () => {
      stash({ kind: 'follow', username: 'maker', created_at: Date.now() });
      mocks.api.put.mockResolvedValue({});
      renderAt('/login');
      expect(screen.getByText(/FOLLOW @MAKER/)).toBeInTheDocument();
      type('EMAIL OR USERNAME', 'maker');
      type('PASSWORD', 'correct horse');
      submit();
      await waitFor(() => expect(mocks.api.put).toHaveBeenCalledWith('/api/users/maker/follow'));
    });

    it('still lands on next when the replayed action fails', async () => {
      stash({ kind: 'save', post_id: 'gone', created_at: Date.now() });
      mocks.api.put.mockRejectedValue(new Error('404'));
      renderAt('/login?next=%2Fexplore');
      type('EMAIL OR USERNAME', 'maker');
      type('PASSWORD', 'correct horse');
      submit();
      await waitFor(() => expect(where()).toBe('/explore'));
    });

    it('does not advertise or replay an expired action', async () => {
      stash({ kind: 'like', post_id: 'p1', created_at: Date.now() - 11 * 60 * 1000 });
      renderAt('/login');
      expect(screen.queryByText(/WE'LL/)).not.toBeInTheDocument();
      type('EMAIL OR USERNAME', 'maker');
      type('PASSWORD', 'correct horse');
      submit();
      await waitFor(() => expect(where()).toBe('/reels'));
      expect(mocks.api.put).not.toHaveBeenCalled();
    });

    it('shows no notice when nothing is pending', () => {
      renderAt('/login');
      expect(screen.queryByText(/WE'LL/)).not.toBeInTheDocument();
    });
  });
});

describe('AuthPage — unverified sign-in hint', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    Object.values(mocks.api).forEach((fn) => fn.mockReset());
    mocks.auth.user = null;
    mocks.auth.loading = false;
    mocks.auth.login.mockReset().mockRejectedValue(new FakeApiError('Incorrect email/username or password.', { code: 'INVALID_CREDENTIALS', status: 401 }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('appears after a failed sign-in and resends to an email identifier', async () => {
    mocks.api.post.mockResolvedValue({ verification_sent: true });
    renderAt('/login');
    type('EMAIL OR USERNAME', 'me@example.com');
    type('PASSWORD', 'whatever-123');
    submit();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Resend the link' }));
    await waitFor(() => expect(mocks.api.post).toHaveBeenCalledWith('/api/auth/resend-verification', { email: 'me@example.com' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'CHECK YOUR EMAIL' })).toBeInTheDocument();
  });

  it('asks for the email when the identifier is a username', async () => {
    renderAt('/login');
    type('EMAIL OR USERNAME', 'someone');
    type('PASSWORD', 'whatever-123');
    submit();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Resend the link' }));
    expect(await screen.findByText(/Enter the email you signed up with/)).toBeInTheDocument();
    expect(mocks.api.post).not.toHaveBeenCalled();
  });

  it('is not shown before any failed attempt', () => {
    renderAt('/login');
    expect(screen.queryByRole('button', { name: 'Resend the link' })).not.toBeInTheDocument();
  });
});

describe('AuthPage — create account', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    Object.values(mocks.api).forEach((fn) => fn.mockReset());
    mocks.auth.user = null;
    mocks.auth.loading = false;
    mocks.auth.login.mockReset().mockResolvedValue({ id: 'u1' });
    mocks.auth.register.mockReset().mockResolvedValue({ verification_sent: true });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const fillValid = () => {
    type('EMAIL', ' New@Example.com ');
    type('USERNAME', 'new_maker');
    type('PASSWORD', 'a-long-password-1');
    fireEvent.click(terms());
  };
  const terms = () => screen.getByRole('checkbox', { name: /I agree to the Terms of Service and Privacy Policy/ });

  it('renders every field with the right autofill hints', () => {
    renderAt('/signup');
    expect(screen.getByRole('heading', { level: 1, name: 'CREATE PROFILE' })).toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('USERNAME')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('DISPLAY NAME')).toHaveAttribute('autocomplete', 'name');
    expect(screen.getByLabelText('PASSWORD')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByText('OPTIONAL')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'FORGOT PASSWORD?' })).not.toBeInTheDocument();
  });

  it('lowercases the username as you type, drops spaces and shows a live counter', () => {
    renderAt('/signup');
    type('USERNAME', 'Echo Dev_1');
    expect(screen.getByLabelText('USERNAME')).toHaveValue('echodev_1');
    expect(screen.getByText('9/30')).toBeInTheDocument();
  });

  it('validates on blur, not while the field is still untouched', () => {
    renderAt('/signup');
    expect(screen.queryByText(/valid email/)).not.toBeInTheDocument();
    type('EMAIL', 'nope');
    expect(screen.queryByText(/valid email/)).not.toBeInTheDocument();
    fireEvent.blur(screen.getByLabelText('EMAIL'));
    expect(screen.getByText(/valid email/)).toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL')).toHaveAttribute('aria-invalid', 'true');
    type('EMAIL', 'ok@example.com');
    expect(screen.queryByText(/valid email/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL')).not.toHaveAttribute('aria-invalid');
  });

  it('flags characters the server would reject, and short passwords', () => {
    renderAt('/signup');
    type('USERNAME', 'has-dash');
    fireEvent.blur(screen.getByLabelText('USERNAME'));
    expect(screen.getByText('Use lowercase letters, numbers and underscores only.')).toBeInTheDocument();
    type('PASSWORD', 'short');
    fireEvent.blur(screen.getByLabelText('PASSWORD'));
    expect(screen.getByText('Password must be at least 10 characters.')).toBeInTheDocument();
  });

  it('blocks submit, shows every problem and focuses the first invalid field', () => {
    renderAt('/signup');
    type('USERNAME', 'ab');
    submit();
    expect(mocks.auth.register).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter your email/)).toBeInTheDocument();
    expect(screen.getByText(/at least 3 characters/)).toBeInTheDocument();
    expect(screen.getByText('Choose a password.')).toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL')).toHaveFocus();
  });

  it('shows live password rules and strength', () => {
    renderAt('/signup');
    expect(screen.getByRole('img', { name: 'Password strength: not started' })).toBeInTheDocument();
    type('PASSWORD', 'short');
    expect(screen.getByRole('img', { name: 'Password strength: TOO SHORT' })).toBeInTheDocument();
    type('PASSWORD', 'abcdefghij');
    expect(screen.getByRole('img', { name: 'Password strength: MINIMUM MET' })).toBeInTheDocument();
    type('PASSWORD', 'abcdefghijklm1!');
    expect(screen.getByRole('img', { name: 'Password strength: STRONG' })).toBeInTheDocument();
    const rules = screen.getByRole('list', { name: 'Password requirements' });
    expect(rules.querySelectorAll('.is-pass')).toHaveLength(3);
  });

  it('registers with trimmed values and shows the check-your-email screen instead of signing in', async () => {
    renderAt('/signup?next=%2Fupload');
    fillValid();
    type('DISPLAY NAME', '  New Maker ');
    submit();
    expect(await screen.findByRole('heading', { level: 1, name: 'CHECK YOUR EMAIL' })).toBeInTheDocument();
    expect(mocks.auth.register).toHaveBeenCalledWith({
      email: 'New@Example.com',
      username: 'new_maker',
      display_name: 'New Maker',
      password: 'a-long-password-1',
      accept_terms: true,
      website: '',
    });
    expect(screen.getByText('New@Example.com')).toBeInTheDocument();
    expect(screen.queryByTestId('where')).not.toBeInTheDocument();
  });

  it('keeps a hidden honeypot field out of the tab order', () => {
    renderAt('/signup');
    const trap = document.querySelector('input[name="website"]');
    expect(trap).toHaveAttribute('tabindex', '-1');
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('offers a resend with a cooldown and posts to resend-verification', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.api.post.mockResolvedValue({ verification_sent: true });
      renderAt('/signup');
      fillValid();
      submit();
      await screen.findByRole('heading', { name: 'CHECK YOUR EMAIL' });
      const button = screen.getByRole('button', { name: /RESEND IN 30S/ });
      expect(button).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(31000); });
      fireEvent.click(screen.getByRole('button', { name: 'RESEND EMAIL' }));
      await waitFor(() => expect(mocks.api.post).toHaveBeenCalledWith('/api/auth/resend-verification', { email: 'New@Example.com' }));
      expect(await screen.findByText(/new link was sent/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('links the development verification token when the server exposes it', async () => {
    mocks.auth.register.mockResolvedValue({ verification_sent: true, debug_token: 'dev tok' });
    renderAt('/signup');
    fillValid();
    submit();
    const link = await screen.findByRole('link', { name: /OPEN THE VERIFICATION LINK/ });
    expect(link).toHaveAttribute('href', '/verify-email?token=dev%20tok');
  });

  it('lets the user go back and fix the email', async () => {
    renderAt('/signup');
    fillValid();
    submit();
    fireEvent.click(await screen.findByRole('button', { name: 'USE A DIFFERENT EMAIL' }));
    expect(screen.getByRole('heading', { level: 1, name: 'CREATE PROFILE' })).toBeInTheDocument();
  });

  describe('Turnstile', () => {
    it('blocks submit until the bot check is solved, then sends its token', async () => {
      mocks.api.get.mockResolvedValue({ turnstile_site_key: '0xSITE' });
      renderAt('/signup');
      fillValid();
      const solve = await screen.findByRole('button', { name: 'SOLVE BOT CHECK' });
      submit();
      expect(mocks.auth.register).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Complete the bot check');
      fireEvent.click(solve);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      submit();
      await waitFor(() => expect(mocks.auth.register).toHaveBeenCalled());
      expect(mocks.auth.register.mock.calls[0][0].turnstile_token).toBe('cf-token');
    });

    it('does not require or send a token when no site key is configured', async () => {
      mocks.api.get.mockResolvedValue({ turnstile_site_key: '' });
      renderAt('/signup');
      fillValid();
      submit();
      await waitFor(() => expect(mocks.auth.register).toHaveBeenCalled());
      expect(mocks.auth.register.mock.calls[0][0]).not.toHaveProperty('turnstile_token');
    });

    it('shows a server BOT_CHECK_FAILED as a form alert', async () => {
      mocks.api.get.mockResolvedValue({ turnstile_site_key: '0xSITE' });
      mocks.auth.register.mockRejectedValue(new FakeApiError('Bot check failed. Try again.', { code: 'BOT_CHECK_FAILED', field: 'turnstile_token' }));
      renderAt('/signup');
      fillValid();
      fireEvent.click(await screen.findByRole('button', { name: 'SOLVE BOT CHECK' }));
      submit();
      expect(await screen.findByRole('alert')).toHaveTextContent('Bot check failed');
    });
  });

  it('requires the Terms checkbox, links both policies, and focuses it when it is the only problem', () => {
    renderAt('/signup');
    expect(terms()).not.toBeChecked();
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    fillValid();
    fireEvent.click(terms()); // untick again
    submit();
    expect(mocks.auth.register).not.toHaveBeenCalled();
    expect(screen.getByText(/Agree to the Terms of Service and Privacy Policy/)).toBeInTheDocument();
    expect(terms()).toHaveAttribute('aria-invalid', 'true');
    expect(terms()).toHaveFocus();
    fireEvent.click(terms());
    expect(screen.queryByText(/Agree to the Terms of Service and Privacy Policy/)).not.toBeInTheDocument();
  });

  it('puts a server TERMS_NOT_ACCEPTED error on the checkbox', async () => {
    mocks.auth.register.mockRejectedValue(new FakeApiError('You must agree to the Terms of Service and Privacy Policy.', { code: 'TERMS_NOT_ACCEPTED', field: 'accept_terms', status: 400 }));
    renderAt('/signup');
    fillValid();
    submit();
    expect(await screen.findByText('You must agree to the Terms of Service and Privacy Policy.')).toBeInTheDocument();
    expect(terms()).toHaveFocus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sends an empty display name through (the server defaults it to the username)', async () => {
    renderAt('/signup');
    fillValid();
    submit();
    await waitFor(() => expect(mocks.auth.register).toHaveBeenCalled());
    expect(mocks.auth.register.mock.calls[0][0].display_name).toBe('');
  });

  it('puts a server "username taken" error on the username field and focuses it', async () => {
    mocks.auth.register.mockRejectedValue(new FakeApiError('This username is already taken.', { code: 'USERNAME_TAKEN', field: 'username', status: 409 }));
    renderAt('/signup');
    fillValid();
    submit();
    expect(await screen.findByText('This username is already taken.')).toBeInTheDocument();
    expect(screen.getByLabelText('USERNAME')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('USERNAME')).toHaveFocus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // editing the field clears the server message
    type('USERNAME', 'new_maker2');
    expect(screen.queryByText('This username is already taken.')).not.toBeInTheDocument();
  });

  it('puts a server "email taken" error on the email field', async () => {
    mocks.auth.register.mockRejectedValue(new FakeApiError('An account already uses this email.', { code: 'EMAIL_TAKEN', field: 'email', status: 409 }));
    renderAt('/signup');
    fillValid();
    submit();
    expect(await screen.findByText('An account already uses this email.')).toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL')).toHaveFocus();
  });

  it('shows an invite-only / rate-limit style rejection as a form alert and keeps the input', async () => {
    mocks.auth.register.mockRejectedValue(new FakeApiError('New account registration is disabled.', { code: 'REGISTRATION_DISABLED', status: 403 }));
    renderAt('/signup');
    fillValid();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('New account registration is disabled.');
    expect(screen.getByLabelText('USERNAME')).toHaveValue('new_maker');
    expect(screen.getByLabelText('PASSWORD')).toHaveValue('a-long-password-1');
  });

  it('does not wipe the password on a non-credential failure', async () => {
    mocks.auth.register.mockRejectedValue(new FakeApiError('Too many requests.', { code: 'RATE_LIMITED', status: 429 }));
    renderAt('/signup');
    fillValid();
    submit();
    await screen.findByRole('alert');
    expect(screen.getByLabelText('PASSWORD')).toHaveValue('a-long-password-1');
  });

  it('switching tabs between sign in and create account starts a clean form and keeps next', () => {
    renderAt('/login?next=%2Fexplore');
    type('EMAIL OR USERNAME', 'someone');
    submit(); // raises a password error
    fireEvent.click(screen.getByRole('link', { name: 'CREATE ACCOUNT' }));
    expect(screen.getByRole('heading', { level: 1, name: 'CREATE PROFILE' })).toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL')).toHaveValue('');
    expect(screen.queryByText('Enter your password.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL')).toHaveFocus();
    expect(screen.getByRole('link', { name: 'SIGN IN' })).toHaveAttribute('href', '/login?next=%2Fexplore');
    fireEvent.click(screen.getByRole('link', { name: 'SIGN IN' }));
    expect(screen.getByLabelText('EMAIL OR USERNAME')).toHaveValue('');
  });

  it('announces what will happen after a pending action, in registration wording', () => {
    sessionStorage.setItem('echo:pending-action', JSON.stringify({ kind: 'follow', username: 'maker', created_at: Date.now() }));
    renderAt('/signup');
    expect(screen.getByText(/ONCE YOU'RE SET UP, WE'LL FOLLOW @MAKER/)).toBeInTheDocument();
  });
});
