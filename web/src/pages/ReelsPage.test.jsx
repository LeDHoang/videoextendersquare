import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReelsPage from './ReelsPage.jsx';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  auth: { user: null, loading: false, setUser: vi.fn() },
  playerProps: null,
}));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));
vi.mock('../components/ui/ReelsPlayer.jsx', () => ({
  default: (props) => {
    mocks.playerProps = props;
    return <div data-testid="player" />;
  },
}));

function renderAt(url) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/reels" element={<ReelsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ReelsPage ?play= deep link', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.playerProps = null;
  });

  it('asks the player for a post-less file by path, not by its index in the page list', async () => {
    mocks.api.get.mockResolvedValue({
      total: 2,
      count: 2,
      folders: [],
      videos: [
        { path: 'white_frame_reel.mp4', filename: 'white_frame_reel.mp4', title: 'White frame', post_id: 'post-1' },
        { path: 'bright_test_reel.mp4', filename: 'bright_test_reel.mp4' },
      ],
    });
    renderAt('/reels?play=bright_test_reel.mp4');

    // The player's feed is not the page list, so an index into the page list starts the wrong reel.
    await waitFor(() => expect(mocks.playerProps?.params.play).toBe('bright_test_reel.mp4'));
    // The player already shows the reel's title, so the page adds no label of its own.
    expect(screen.queryByText(/PLAYING/)).toBeNull();
    expect(mocks.playerProps.initialIndex ?? 0).toBe(0);
  });

  it('fetches one page and still sends a ?play= path that is past it', async () => {
    mocks.api.get.mockResolvedValue({
      total: 90,
      count: 90,
      folders: [],
      videos: [{ path: 'first.mp4', filename: 'first.mp4', post_id: 'post-1' }],
      next_cursor: 'c1',
    });
    renderAt('/reels?play=later/deep.mp4');

    await waitFor(() => expect(mocks.playerProps?.params.play).toBe('later/deep.mp4'));
    expect(mocks.api.get).toHaveBeenCalledWith('/api/reels', expect.objectContaining({ limit: 60 }));
    expect(mocks.playerProps.params.post).toBeUndefined();
  });
});

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
    expect(screen.queryByRole('radio', { name: 'BEST QUALITY' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('radio', { name: 'BEST QUALITY' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3D' })).toBeInTheDocument();
    expect(screen.getByTitle('Rescan video library')).toBeInTheDocument();
    expect(screen.getByText(/Quest & Tools/)).toBeInTheDocument();
    expect(screen.getByText(/IMMERSIVE PREVIEW/)).toBeInTheDocument();
  });

  it('shows a plain empty state without the debug hint to a regular user', async () => {
    mocks.auth = { ...mocks.auth, user: { id: 1, role: 'user' } };
    mocks.api.get.mockResolvedValue({ total: 0, count: 0, folders: [], videos: [] });
    renderPage();

    expect(await screen.findByText('NO REELS FOUND')).toBeInTheDocument();
    expect(screen.queryByText(/codec="/)).not.toBeInTheDocument();
  });
});
