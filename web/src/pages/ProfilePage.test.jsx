import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePage from './ProfilePage.jsx';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  auth: { user: null },
}));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));
vi.mock('../hooks/MessagingContext.jsx', () => ({ useMessaging: () => ({ openShare: vi.fn() }) }));
vi.mock('../hooks/ConfigContext.jsx', () => ({ useConfigContext: () => ({ config: { features: {} } }) }));
vi.mock('../hooks/useExplorePreviews.js', () => ({ default: (items) => ({ items, previewMessage: '' }) }));

const profile = {
  id: 'user-9', username: 'maker', display_name: 'Maker', is_me: false, is_following: false,
  post_count: 0, followers: 0, following: 0, created_at: '2026-01-01T00:00:00Z',
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/profile/maker']}>
      <Routes>
        <Route path="/profile/:username" element={<ProfilePage />} />
        <Route path="/login" element={<div>LOGIN SCREEN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProfilePage report', () => {
  let promptSpy;
  beforeEach(() => {
    Object.values(mocks.api).forEach((fn) => fn.mockReset());
    mocks.auth.user = { id: 'viewer', username: 'viewer' };
    mocks.api.get.mockImplementation(async (url) => {
      if (url === '/api/users/maker') return { user: profile };
      return { items: [], next_cursor: null };
    });
    promptSpy = vi.spyOn(window, 'prompt');
  });
  afterEach(() => {
    cleanup();
    promptSpy.mockRestore();
  });

  it('reports a user through the in-app dialog, not window.prompt', async () => {
    mocks.api.post.mockResolvedValue({});
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'REPORT' }));
    const dialog = screen.getByRole('dialog', { name: 'REPORT @MAKER' });
    fireEvent.change(within(dialog).getByLabelText('Report reason'), { target: { value: 'impersonation' } });
    fireEvent.change(within(dialog).getByLabelText('Report details'), { target: { value: 'fake account' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'SUBMIT REPORT' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocks.api.post).toHaveBeenCalledWith('/api/reports', {
      target_type: 'user', target_id: 'user-9', reason: 'impersonation', details: 'fake account',
    });
    expect(screen.getByRole('status')).toHaveTextContent('Report submitted');
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with the error when the report fails', async () => {
    mocks.api.post.mockRejectedValue(new Error('Too many reports'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'REPORT' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'SUBMIT REPORT' }));
    expect(await screen.findByText('Too many reports')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('sends signed-out visitors to login instead of opening the dialog', async () => {
    mocks.auth.user = null;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'REPORT' }));
    expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(promptSpy).not.toHaveBeenCalled();
  });
});
