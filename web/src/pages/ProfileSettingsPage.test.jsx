import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfileSettingsPage from './ProfileSettingsPage.jsx';

const mocks = vi.hoisted(() => ({
  hardRedirect: vi.fn(),
  auth: { user: null, loading: false, setUser: vi.fn() },
  api: { get: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), upload: vi.fn() },
  wallet: { falKey: { configured: true, hint: '••••9883' }, saveFalKey: vi.fn(), deleteFalKey: vi.fn() },
}));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));
vi.mock('../utils/hardRedirect.js', () => ({ hardRedirect: mocks.hardRedirect }));
vi.mock('../hooks/WalletContext.jsx', () => ({ useWallet: () => mocks.wallet }));

const OWNER = {
  id: 'u1',
  username: 'echodev',
  display_name: 'EchoDev',
  bio: 'hello',
  website: '',
  avatar_color: '#ff3b1f',
  avatar_url: null,
  can_moderate: false,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/profile']}>
      <Routes>
        <Route path="/settings/profile" element={<ProfileSettingsPage />} />
        <Route path="/login" element={<div>LOGIN SCREEN</div>} />
        <Route path="/reels" element={<div>REELS SCREEN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProfileSettingsPage', () => {
  afterEach(cleanup);

  beforeEach(() => {
    Object.values(mocks.api).forEach((fn) => fn.mockReset());
    mocks.auth.setUser.mockReset();
    mocks.hardRedirect.mockReset();
    mocks.auth.user = OWNER;
    mocks.auth.loading = false;
    mocks.api.get.mockResolvedValue({ users: [{ id: 'b1', username: 'spambot', display_name: 'Spam' }] });
  });

  it('sends signed-out visitors to login without rendering any editor', () => {
    mocks.auth.user = null;
    renderPage();
    expect(screen.getByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(screen.queryByLabelText('DISPLAY NAME')).not.toBeInTheDocument();
    expect(mocks.api.get).not.toHaveBeenCalled();
  });

  it('only edits the signed-in account, with the username locked', async () => {
    renderPage();
    const username = screen.getByLabelText('USERNAME');
    expect(username).toHaveValue('echodev');
    expect(username).toHaveAttribute('readonly');
    await screen.findByText('@spambot');
    expect(mocks.api.get).toHaveBeenCalledWith('/api/users/me/blocked');
  });

  it('saves display name, bio and a bare-domain website through PATCH /me', async () => {
    mocks.api.patch.mockResolvedValue({ user: { ...OWNER, bio: 'hi #test', website: 'test.com' } });
    renderPage();
    const save = screen.getByRole('button', { name: /UPDATE PROFILE/ });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('CREATOR BIO'), { target: { value: 'hi #test' } });
    fireEvent.change(screen.getByLabelText('WEBSITE / PORTFOLIO'), { target: { value: 'test.com' } });
    expect(screen.getByText('PREVIEW')).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() => expect(mocks.api.patch).toHaveBeenCalledWith('/api/users/me', {
      display_name: 'EchoDev', bio: 'hi #test', website: 'test.com',
    }));
    expect(await screen.findByText(/PROFILE UPDATED/)).toBeInTheDocument();
    expect(mocks.auth.setUser).toHaveBeenCalled();
  });

  it('shows a rejected save inline next to the button', async () => {
    mocks.api.patch.mockRejectedValue(new Error('Enter a valid website such as example.com or https://example.com.'));
    renderPage();
    fireEvent.change(screen.getByLabelText('WEBSITE / PORTFOLIO'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /UPDATE PROFILE/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid website/);
  });

  it('restricts a handle (stripping @) and refreshes the blocked list', async () => {
    mocks.api.put.mockResolvedValue({ blocked: true });
    renderPage();
    await screen.findByText('@spambot');
    fireEvent.change(screen.getByLabelText('RESTRICT A HANDLE'), { target: { value: '@troll' } });
    fireEvent.click(screen.getByRole('button', { name: 'RESTRICT' }));
    await waitFor(() => expect(mocks.api.put).toHaveBeenCalledWith('/api/users/troll/block'));
    expect(await screen.findByText(/@troll RESTRICTED/)).toBeInTheDocument();
  });

  it('keeps password change and account deletion locked until their rules pass', () => {
    renderPage();
    const change = screen.getByRole('button', { name: 'UPDATE PASSWORD' });
    expect(change).toBeDisabled();
    fireEvent.change(screen.getByLabelText('CURRENT PASSWORD', { selector: '#ps-current-password' }), { target: { value: 'old-password-1' } });
    fireEvent.change(screen.getByLabelText('NEW PASSWORD'), { target: { value: 'short' } });
    expect(change).toBeDisabled();
    fireEvent.change(screen.getByLabelText('NEW PASSWORD'), { target: { value: 'a-much-longer-1!' } });
    expect(change).toBeEnabled();

    const terminate = screen.getByRole('button', { name: /TERMINATE PROFILE/ });
    fireEvent.change(screen.getByLabelText('CURRENT PASSWORD', { selector: '#ps-delete-password' }), { target: { value: 'pw' } });
    expect(terminate).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/TO AUTHORIZE/), { target: { value: 'echodev' } });
    expect(terminate).toBeEnabled();
  });

  it('lets each password field be revealed independently, and hides them by default', () => {
    renderPage();
    const current = screen.getByLabelText('CURRENT PASSWORD', { selector: '#ps-current-password' });
    const fresh = screen.getByLabelText('NEW PASSWORD');
    expect(current).toHaveAttribute('type', 'password');
    expect(fresh).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show new password' }));
    expect(fresh).toHaveAttribute('type', 'text');
    expect(current).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Hide new password' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Show current password' }));
    expect(current).toHaveAttribute('type', 'text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide new password' }));
    expect(fresh).toHaveAttribute('type', 'password');
    // the account-deletion password stays masked
    expect(screen.getByLabelText('CURRENT PASSWORD', { selector: '#ps-delete-password' })).toHaveAttribute('type', 'password');
  });

  it('shows a live strength meter for the new password, using the server minimum', () => {
    renderPage();
    const meter = () => screen.getByRole('img', { name: /Password strength/ });
    expect(meter()).toHaveAccessibleName('Password strength: not started');
    const fresh = screen.getByLabelText('NEW PASSWORD');
    fireEvent.change(fresh, { target: { value: 'short' } });
    expect(meter()).toHaveAccessibleName('Password strength: TOO SHORT');
    fireEvent.change(fresh, { target: { value: 'abcdefghij' } });
    expect(meter()).toHaveAccessibleName('Password strength: MINIMUM MET');
    fireEvent.change(fresh, { target: { value: 'abcdefghijklm1!' } });
    expect(meter()).toHaveAccessibleName('Password strength: STRONG');
  });

  it('shows friendly errors for self-block and unknown handles and leaves the list alone', async () => {
    renderPage();
    await screen.findByText('@spambot');
    const apiError = (code, message) => Object.assign(new Error(message), { code });
    mocks.api.put.mockRejectedValueOnce(apiError('SELF_BLOCK', 'You cannot block yourself.'));
    fireEvent.change(screen.getByLabelText('RESTRICT A HANDLE'), { target: { value: 'echodev' } });
    fireEvent.click(screen.getByRole('button', { name: 'RESTRICT' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot restrict your own account.');
    mocks.api.put.mockRejectedValueOnce(apiError('USER_NOT_FOUND', 'Profile not found.'));
    fireEvent.change(screen.getByLabelText('RESTRICT A HANDLE'), { target: { value: 'ghost' } });
    fireEvent.click(screen.getByRole('button', { name: 'RESTRICT' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No active profile has that handle.'));
    expect(mocks.api.get).toHaveBeenCalledTimes(1); // list only fetched on mount, never refreshed after a failure
    expect(screen.getByText('@spambot')).toBeInTheDocument();
  });

  it('keeps the restrict button disabled for an empty or @-only handle', () => {
    renderPage();
    const restrict = screen.getByRole('button', { name: 'RESTRICT' });
    expect(restrict).toBeDisabled();
    fireEvent.change(screen.getByLabelText('RESTRICT A HANDLE'), { target: { value: '  @@ ' } });
    expect(restrict).toBeDisabled();
  });

  it('unblocks a handle and drops it from the list', async () => {
    mocks.api.delete.mockResolvedValue({ blocked: false });
    renderPage();
    await screen.findByText('@spambot');
    fireEvent.click(screen.getByRole('button', { name: 'UNBLOCK' }));
    await waitFor(() => expect(mocks.api.delete).toHaveBeenCalledWith('/api/users/spambot/block'));
    expect(await screen.findByText('NO BLOCKED PROFILES')).toBeInTheDocument();
    expect(screen.getByText(/@spambot UNBLOCKED/)).toBeInTheDocument();
  });

  it('is titled DELETE ACCOUNT and has no avatar SIGNED IN badge', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'DELETE ACCOUNT' })).toBeInTheDocument();
    expect(screen.queryByText('PURGE PROTOCOL', { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByText('● SIGNED IN')).not.toBeInTheDocument();
  });

  function armDelete(password = 'pw-correct-1', typed = 'echodev') {
    fireEvent.change(screen.getByLabelText('CURRENT PASSWORD', { selector: '#ps-delete-password' }), { target: { value: password } });
    fireEvent.change(screen.getByLabelText(/TO AUTHORIZE/), { target: { value: typed } });
    return screen.getByRole('button', { name: /TERMINATE PROFILE/ });
  }

  it('does not delete when the typed handle is wrong, even with a password', () => {
    renderPage();
    expect(armDelete('pw-correct-1', 'someone-else')).toBeDisabled();
    fireEvent.submit(screen.getByLabelText(/TO AUTHORIZE/).closest('form'));
    expect(mocks.api.delete).not.toHaveBeenCalled();
  });

  it('accepts the handle case-insensitively with a leading @ and deletes through DELETE /me', async () => {
    mocks.api.delete.mockResolvedValue({ ok: true });
    renderPage();
    fireEvent.click(armDelete('pw-correct-1', '@EchoDev'));
    await waitFor(() => expect(mocks.api.delete).toHaveBeenCalledWith('/api/users/me', {
      current_password: 'pw-correct-1', confirmation: 'DELETE',
    }));
    // Full reload to /reels — never the login page, and no half-signed-out client state.
    await waitFor(() => expect(mocks.hardRedirect).toHaveBeenCalledWith('/reels'));
  });

  it('stays on the page and explains a wrong password without signing the user out', async () => {
    mocks.api.delete.mockRejectedValue(new Error('Current password is incorrect.'));
    renderPage();
    fireEvent.click(armDelete());
    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect.');
    expect(mocks.hardRedirect).not.toHaveBeenCalled();
    expect(mocks.auth.setUser).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /TERMINATE PROFILE/ })).toBeEnabled();
  });
});
