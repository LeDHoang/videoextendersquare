import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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
    default: ({ video, onOpen }) => <article data-testid="tile" onClick={() => onOpen(video)}>{video.title}</article>,
  };
});

vi.mock('../components/packs/PackTile.jsx', () => ({
  default: ({ pack }) => <article data-testid="tile">{pack.title}</article>,
}));

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
    expect(screen.getByLabelText('Compact grid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /SHUFFLE/ })).toBeInTheDocument();
    expect(screen.getByText('MOST TRENDING:')).toBeInTheDocument();

    expect(container.querySelectorAll('[aria-haspopup="listbox"]')).toHaveLength(0);
    expect(screen.queryByRole('radiogroup', { name: 'Format' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('radiogroup', { name: 'Format' })).toBeInTheDocument();
    expect(screen.getByTitle('Refresh discovery')).toBeInTheDocument();
    const stats = within(screen.getByRole('group', { name: 'Summary statistics' }));
    expect(stats.getByText('FOLDERS')).toBeInTheDocument();
  });

  it('ranks reels for the viewer and puts each pack at its slot in the ALL grid', async () => {
    const reel = (name) => ({ path: 'published/' + name + '.mp4', title: 'Reel ' + name, preview_url: '/p.mp4', poster_url: '/p.jpg' });
    const pack = (name, slot) => ({ id: name, title: 'Pack ' + name, slot });
    mocks.api.get.mockImplementation(async (path, params) => {
      if (path === '/api/packs') return { total: 3, items: [], next_offset: null };
      return params.cursor === 'page-2'
        ? { ...reels, count: 4, videos: [reel('C'), reel('D')], packs: [pack('Y', 3), pack('Z', 9)], next_cursor: null }
        : { ...reels, count: 4, videos: [reel('A'), reel('B')], packs: [pack('X', 1)], next_cursor: 'page-2' };
    });
    renderPage();
    await screen.findByText('Reel A');

    expect(mocks.api.get).toHaveBeenCalledWith('/api/reels', expect.objectContaining({ sort: 'for_you', packs: true }));
    expect(screen.getAllByTestId('tile').map((tile) => tile.textContent)).toEqual(['Reel A', 'Pack X', 'Reel B']);

    fireEvent.click(screen.getByRole('button', { name: 'LOAD MORE REELS' }));

    await screen.findByText('Reel D');
    expect(screen.getAllByTestId('tile').map((tile) => tile.textContent))
      .toEqual(['Reel A', 'Pack X', 'Reel B', 'Reel C', 'Pack Y', 'Reel D', 'Pack Z']);
  });

  it('loads reels a page at a time and appends the next page', async () => {
    const reel = (name) => ({ path: 'published/' + name + '.mp4', title: 'Reel ' + name, preview_url: '/p.mp4', poster_url: '/p.jpg' });
    mocks.api.get.mockImplementation(async (path, params) => {
      if (path === '/api/packs') return { total: 0, items: [], next_offset: null };
      return params.cursor === 'page-2'
        ? { ...reels, count: 3, videos: [reel('B'), reel('C')], next_cursor: null }
        : { ...reels, count: 3, videos: [reel('A')], next_cursor: 'page-2' };
    });
    renderPage();
    await screen.findByText('Reel A');

    expect(mocks.api.get).toHaveBeenCalledWith('/api/reels', expect.objectContaining({ limit: 48 }));
    expect(mocks.api.get.mock.calls.find(([path]) => path === '/api/reels')[1]).not.toHaveProperty('cursor');
    expect(within(screen.getByRole('group', { name: 'Summary statistics' })).getByText('3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'LOAD MORE REELS' }));

    await screen.findByText('Reel C');
    expect(screen.getAllByTestId('tile').map((tile) => tile.textContent)).toEqual(['Reel A', 'Reel B', 'Reel C']);
    expect(mocks.api.get).toHaveBeenCalledWith('/api/reels', expect.objectContaining({ cursor: 'page-2', limit: 48, sort: 'for_you' }));
    expect(screen.queryByRole('button', { name: 'LOAD MORE REELS' })).not.toBeInTheDocument();
  });

  it('loads the next page of reels on its own when the load-more row nears the viewport', async () => {
    const observers = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback, options) { this.callback = callback; this.options = options; this.targets = []; observers.push(this); }
      observe(target) { this.targets.push(target); }
      disconnect() { this.targets = []; }
    });
    const near = () => {
      const observer = observers.filter((row) => row.targets.length).at(-1);
      act(() => observer.callback([{ isIntersecting: true, target: observer.targets[0] }]));
    };
    const reel = (name) => ({ path: 'published/' + name + '.mp4', title: 'Reel ' + name, preview_url: '/p.mp4', poster_url: '/p.jpg' });
    let releaseSecond;
    mocks.api.get.mockImplementation((path, params) => {
      if (path === '/api/packs') return Promise.resolve({ total: 0, items: [], next_offset: null });
      if (params.cursor === 'page-2') return new Promise((resolve) => { releaseSecond = () => resolve({ ...reels, count: 3, videos: [reel('B')], next_cursor: 'page-3' }); });
      if (params.cursor === 'page-3') return Promise.reject(new Error('offline'));
      return Promise.resolve({ ...reels, count: 3, videos: [reel('A')], next_cursor: 'page-2' });
    });
    const reelCalls = () => mocks.api.get.mock.calls.filter(([path]) => path === '/api/reels');
    renderPage();
    await screen.findByText('Reel A');
    expect(observers.at(-1).options.rootMargin).toBe('800px 0px');

    near();
    near();
    expect(reelCalls().filter(([, params]) => params.cursor === 'page-2')).toHaveLength(1);
    await act(async () => releaseSecond());
    await screen.findByText('Reel B');

    // The row is still in view after a short page: a fresh observer asks for the next one.
    near();
    await waitFor(() => expect(reelCalls().filter(([, params]) => params.cursor === 'page-3')).toHaveLength(1));
    // A failed load leaves the button to retry, and the observer does not loop.
    expect(await screen.findByRole('button', { name: 'LOAD MORE REELS' })).toBeEnabled();
    expect(reelCalls().filter(([, params]) => params.cursor === 'page-3')).toHaveLength(1);
  });

  it('loads the next page of packs on its own in the PACKS tab', async () => {
    const observers = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
      observe(target) { this.targets.push(target); }
      disconnect() { this.targets = []; }
    });
    mocks.api.get.mockImplementation(async (path, params) => {
      if (path !== '/api/packs') return reels;
      return params.offset === 24
        ? { total: 2, items: [{ id: 'q', title: 'Pack Q' }], next_offset: null }
        : { total: 2, items: [{ id: 'p', title: 'Pack P' }], next_offset: 24 };
    });
    render(
      <MemoryRouter initialEntries={['/explore?type=packs']}>
        <ExplorePage />
      </MemoryRouter>,
    );
    await screen.findByText('Pack P');
    const observer = observers.filter((row) => row.targets.length).at(-1);
    expect(observer.targets[0]).toContainElement(screen.getByRole('button', { name: 'LOAD MORE PACKS' }));
    act(() => observer.callback([{ isIntersecting: true }]));

    await screen.findByText('Pack Q');
    expect(mocks.api.get).toHaveBeenCalledWith('/api/packs', expect.objectContaining({ offset: 24, limit: 24 }));
    expect(screen.queryByRole('button', { name: 'LOAD MORE PACKS' })).not.toBeInTheDocument();
  });

  it('opens a posted reel by its post id, and a file with no post by its path', async () => {
    mocks.api.get.mockImplementation(async (path) => (
      path === '/api/packs' ? { total: 0, items: [], next_offset: null } : {
        ...reels,
        total: 2,
        count: 2,
        videos: [{ ...reels.videos[0], post_id: 'p1' }, { ...reels.videos[0], path: 'uploads/b.mp4', title: 'Reel B' }],
      }
    ));
    function Where() {
      const location = useLocation();
      return <output data-testid="where">{location.pathname + location.search}</output>;
    }
    render(
      <MemoryRouter initialEntries={['/explore']}>
        <Routes>
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/reels" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByText('Reel A'));
    expect(screen.getByTestId('where').textContent).toBe('/reels?post=p1');
    cleanup();

    render(
      <MemoryRouter initialEntries={['/explore']}>
        <Routes>
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/reels" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByText('Reel B'));
    expect(screen.getByTestId('where').textContent).toBe(
      '/reels?folder=ALL+FOLDERS&codec=hevc&sort=for_you&play=uploads%2Fb.mp4',
    );
  });
});
