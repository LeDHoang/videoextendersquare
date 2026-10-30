import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExplorePage from './ExplorePage.jsx';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  auth: { user: null },
  messaging: { openShare: vi.fn() },
}));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));
vi.mock('../hooks/MessagingContext.jsx', () => ({ useMessaging: () => mocks.messaging }));
vi.mock('../hooks/ConfigContext.jsx', () => ({ useConfigContext: () => ({ config: { features: {} } }) }));
vi.mock('../components/explore/ExploreTile.jsx', async () => {
  const actual = await vi.importActual('../components/explore/ExploreTile.jsx');
  return {
    ...actual,
    default: ({ video }) => <article data-testid="tile">{video.title}</article>,
  };
});

// Node's own `localStorage` shadows jsdom's and is unusable without a flag, so give tests a real one.
function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    clear: () => { data.clear(); },
  };
}

const reels = {
  total: 1,
  count: 1,
  folders: ['published'],
  videos: [{
    path: 'published/a.mp4',
    title: 'Reel A',
    tags: ['neon'],
    preview_url: '/preview-a.mp4',
    poster_url: '/poster-a.jpg',
  }],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/explore']}>
      <ExplorePage />
    </MemoryRouter>,
  );
}

describe('ExplorePage beta controls', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    mocks.api.get.mockImplementation(async (path) => (
      path === '/api/packs' ? { total: 0, items: [], next_offset: null } : reels
    ));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.auth = { user: null };
  });

  it('gives a regular user search, tabs, density, shuffle and trending, with unchanged list params', async () => {
    mocks.auth = { user: { id: 1, role: 'user' } };
    const { container } = renderPage();
    await screen.findByTestId('tile');

    expect(screen.getByLabelText('Search titles, creators, places, or tags')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Content type' })).toBeInTheDocument();
    expect(screen.getByLabelText('Compact square grid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /SHUFFLE/ })).toBeInTheDocument();
    expect(screen.getByText('MOST TRENDING:')).toBeInTheDocument();

    expect(container.querySelectorAll('[aria-haspopup="listbox"]')).toHaveLength(0);
    expect(screen.queryByRole('radiogroup', { name: 'Codec' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Refresh discovery')).not.toBeInTheDocument();
    const stats = within(screen.getByRole('group', { name: 'Summary statistics' }));
    expect(stats.queryByText('FOLDERS')).not.toBeInTheDocument();
    expect(stats.queryByText('CODEC')).not.toBeInTheDocument();

    await waitFor(() => expect(mocks.api.get).toHaveBeenCalledWith('/api/reels', expect.objectContaining({
      folder: 'ALL FOLDERS',
      codec: 'hevc',
    })));
  });

  it('keeps the folder, codec, refresh and stats for an admin', async () => {
    mocks.auth = { user: { id: 1, role: 'admin' } };
    const { container } = renderPage();
    await screen.findByTestId('tile');

    expect(container.querySelectorAll('[aria-haspopup="listbox"]')).toHaveLength(1);
    expect(screen.getByRole('radiogroup', { name: 'Codec' })).toBeInTheDocument();
    expect(screen.getByTitle('Refresh discovery')).toBeInTheDocument();
    const stats = within(screen.getByRole('group', { name: 'Summary statistics' }));
    expect(stats.getByText('FOLDERS')).toBeInTheDocument();
    expect(stats.getByText('CODEC')).toBeInTheDocument();
  });
});
