import { createElement } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../tests/fixtures/location_keys.json';
import { locationKey } from './ExploreTile.jsx';
import LocationExplorePage from '../../pages/LocationExplorePage.jsx';

// Same rows as tests/test_location_names.py, so the web link and the server key cannot drift apart.
const CASES = fixture.cases.map((row) => ({ ...row, linkKey: row.client_slug || row.slug }));

const mocks = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../hooks/AuthContext.jsx', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../../hooks/MessagingContext.jsx', () => ({ useMessaging: () => ({ openShare: vi.fn() }) }));
vi.mock('../../hooks/ConfigContext.jsx', () => ({ useConfigContext: () => ({ config: { features: {} } }) }));

describe.each(CASES)('location key for $label', ({ city, country, linkKey }) => {
  beforeEach(() => {
    mocks.api.get.mockImplementation(async (path) => (
      path === '/api/packs' ? { total: 0, items: [], next_offset: null } : { videos: [], count: 0 }
    ));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('builds the key the server expects', () => {
    expect(locationKey(city, country)).toBe(linkKey);
  });

  it('round-trips through the link, the route and the feed request', async () => {
    const link = '/explore/location/' + encodeURIComponent(locationKey(city, country));
    render(createElement(
      MemoryRouter,
      { initialEntries: [link] },
      createElement(Routes, null, createElement(Route, { path: '/explore/location/:key', element: createElement(LocationExplorePage) })),
    ));
    await waitFor(() => expect(mocks.api.get).toHaveBeenCalledWith(
      '/api/reels/locations/' + encodeURIComponent(linkKey),
      expect.anything(),
    ));
    expect(mocks.api.get).toHaveBeenCalledWith('/api/packs', expect.objectContaining({ location: linkKey }));
  });
});
