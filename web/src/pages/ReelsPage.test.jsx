import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReelsPage from './ReelsPage.jsx';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  auth: { user: null, loading: false, setUser: vi.fn() },
}));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));
vi.mock('../components/ui/ReelsPlayer.jsx', () => ({
  default: () => <div data-testid="player">PLAYER</div>,
}));

const reels = {
  total: 1,
  count: 1,
  folders: ['published'],
  videos: [{ path: 'published/a.mp4', post_id: 'post-1', media_type: 'video', codec: 'HEVC', is_proxy: false }],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/reels']}>
      <ReelsPage />
    </MemoryRouter>,
  );
}

describe('ReelsPage beta controls', () => {
  beforeEach(() => {
    mocks.api.get.mockResolvedValue(reels);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.auth = { user: null, loading: false, setUser: vi.fn() };
  });

  it('gives a regular user only the feed switch and search, with unchanged list params', async () => {
    mocks.auth = { ...mocks.auth, user: { id: 1, role: 'user' } };
    const { container } = renderPage();
    await screen.findByTestId('player');

    expect(screen.getByRole('radio', { name: 'FOR YOU' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'FOLLOWING' })).toBeInTheDocument();
    expect(screen.getByLabelText('Search reels')).toBeInTheDocument();

    expect(container.querySelectorAll('[aria-haspopup="listbox"]')).toHaveLength(0);
    expect(screen.queryByRole('radio', { name: /HEVC 4K/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '3D' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Rescan video library')).not.toBeInTheDocument();
    expect(screen.queryByText(/Quest & Tools/)).not.toBeInTheDocument();
    expect(screen.queryByText(/IMMERSIVE PREVIEW/)).not.toBeInTheDocument();
    expect(screen.queryByText(/FOLDERS:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/CODEC:/)).not.toBeInTheDocument();

    await waitFor(() => expect(mocks.api.get).toHaveBeenCalledWith('/api/reels', expect.objectContaining({
      folder: 'ALL FOLDERS',
      codec: 'hevc',
      sort: 'for_you',
    })));
  });

  it('keeps the full control rail for an admin', async () => {
    mocks.auth = { ...mocks.auth, user: { id: 1, role: 'admin' } };
    const { container } = renderPage();
    await screen.findByTestId('player');

    expect(container.querySelectorAll('[aria-haspopup="listbox"]')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /HEVC 4K/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3D' })).toBeInTheDocument();
    expect(screen.getByTitle('Rescan video library')).toBeInTheDocument();
    expect(screen.getByText(/Quest & Tools/)).toBeInTheDocument();
    expect(screen.getByText(/IMMERSIVE PREVIEW/)).toBeInTheDocument();
    expect(screen.getByText(/FOLDERS:/)).toBeInTheDocument();
  });

  it('shows a plain empty state without the debug hint to a regular user', async () => {
    mocks.auth = { ...mocks.auth, user: { id: 1, role: 'user' } };
    mocks.api.get.mockResolvedValue({ total: 0, count: 0, folders: [], videos: [] });
    renderPage();

    expect(await screen.findByText('NO REELS FOUND')).toBeInTheDocument();
    expect(screen.queryByText(/codec="/)).not.toBeInTheDocument();
  });
});
