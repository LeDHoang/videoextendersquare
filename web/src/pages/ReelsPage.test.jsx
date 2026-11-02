import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

    expect(await screen.findByText(/PLAYING bright_test_reel\.mp4/)).toBeTruthy();
    // The player's feed is not the page list, so an index into the page list starts the wrong reel.
    expect(mocks.playerProps.params.play).toBe('bright_test_reel.mp4');
    expect(mocks.playerProps.initialIndex ?? 0).toBe(0);
  });
});
