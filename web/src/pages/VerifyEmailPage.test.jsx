import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VerifyEmailPage from './VerifyEmailPage.jsx';

const mocks = vi.hoisted(() => ({
  auth: { setUser: vi.fn() },
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('VerifyEmailPage', () => {
  beforeEach(() => {
    Object.values(mocks.api).forEach((fn) => fn.mockReset());
    mocks.auth.setUser.mockReset();
  });
  afterEach(cleanup);

  it('posts the token once, signs the user in and lands on /reels', async () => {
    mocks.api.post.mockResolvedValue({ user: { id: 'u1', username: 'new_maker' } });
    renderAt('/verify-email?token=abc123');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/reels'));
    expect(mocks.api.post).toHaveBeenCalledTimes(1);
    expect(mocks.api.post).toHaveBeenCalledWith('/api/auth/verify-email', { token: 'abc123' });
    expect(mocks.auth.setUser).toHaveBeenCalledWith({ id: 'u1', username: 'new_maker' });
  });

  it('shows the expired state for a rejected token and offers a way out', async () => {
    mocks.api.post.mockRejectedValue(Object.assign(new Error('bad'), { code: 'INVALID_VERIFICATION_TOKEN', status: 400 }));
    renderAt('/verify-email?token=old');
    expect(await screen.findByRole('heading', { level: 1, name: 'LINK EXPIRED' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'SIGN IN' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'CREATE ACCOUNT' })).toHaveAttribute('href', '/signup');
    expect(mocks.auth.setUser).not.toHaveBeenCalled();
  });

  it('does not call the API when the link has no token', () => {
    renderAt('/verify-email');
    expect(screen.getByRole('heading', { level: 1, name: 'LINK EXPIRED' })).toBeInTheDocument();
    expect(mocks.api.post).not.toHaveBeenCalled();
  });
});
