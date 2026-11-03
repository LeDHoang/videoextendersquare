import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TagExplorePage from './TagExplorePage.jsx';
import LocationExplorePage from './LocationExplorePage.jsx';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  auth: { user: null },
}));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));
vi.mock('../hooks/MessagingContext.jsx', () => ({ useMessaging: () => ({ openShare: vi.fn() }) }));
vi.mock('../hooks/ConfigContext.jsx', () => ({ useConfigContext: () => ({ config: { features: {} } }) }));

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

const PAGES = [
  { name: 'tag', path: '/explore/tag/neon', route: '/explore/tag/:tag', Page: TagExplorePage, feed: '/api/reels/tags/neon' },
  { name: 'location', path: '/explore/location/hanoi', route: '/explore/location/:key', Page: LocationExplorePage, feed: '/api/reels/locations/hanoi' },
];

function renderPage({ path, route, Page }) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={<Page />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe.each(PAGES)('$name explore page beta controls', (page) => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    mocks.api.get.mockImplementation(async (path) => (
      path === '/api/packs' ? { total: 0, items: [], next_offset: null } : { videos: [], count: 0 }
    ));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.auth = { user: null };
  });

  it('hides RANK and FORMAT from a regular user and keeps tabs and density', async () => {
    mocks.auth = { user: { id: 1, role: 'user' } };
    renderPage(page);
    await waitFor(() => expect(mocks.api.get).toHaveBeenCalledWith(page.feed, expect.objectContaining({ codec: 'hevc', sort: 'trending' })));

    expect(screen.getByRole('radiogroup', { name: 'Content type' })).toBeInTheDocument();
    expect(screen.getByLabelText('Compact square grid')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'RANK:' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'FORMAT:' })).not.toBeInTheDocument();
  });

  it('shows RANK and FORMAT to an admin', async () => {
    mocks.auth = { user: { id: 1, role: 'admin' } };
    renderPage(page);

    expect(await screen.findByRole('radiogroup', { name: 'RANK:' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'FORMAT:' })).toBeInTheDocument();
  });
});
