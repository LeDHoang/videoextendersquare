import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PackPage from './PackPage.jsx';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  auth: { user: null },
  messaging: { openShare: vi.fn() },
  playerProps: null,
}));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));
vi.mock('../hooks/MessagingContext.jsx', () => ({
  useMessaging: () => mocks.messaging,
  clientId: (prefix) => prefix + '-test',
}));
vi.mock('../components/ui/ReelsPlayer.jsx', () => ({
  default: (props) => {
    mocks.playerProps = props;
    return <div data-testid="player">PLAYER {props.initialIndex}</div>;
  },
}));
vi.mock('../components/explore/ExploreTile.jsx', async () => {
  const actual = await vi.importActual('../components/explore/ExploreTile.jsx');
  return {
    ...actual,
    default: ({ video, onOpen, onShare, orderLabel }) => (
      <article data-testid="tile" data-order={orderLabel}>
        <button type="button" onClick={() => onOpen(video)}>OPEN {video.title}</button>
        <button type="button" onClick={() => onShare(video)}>SHARE {video.title}</button>
      </article>
    ),
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

const post = (n, extra = {}) => ({
  id: 'post-' + n,
  title: 'Reel ' + n,
  media_type: 'video',
  poster_url: `/poster-${n}.jpg`,
  creator: { username: 'maker' },
  likes: 1200,
  views: 3400,
  comments_count: 5,
  location: n === 1 ? { city: 'Hanoi', country: 'Vietnam' } : {},
  duration_ms: n * 29000,
  width: 3840,
  height: 3840,
  ...extra,
});

const item = (n, extra = {}) => ({ id: 'item-' + n, position: n, available: true, post: post(n), ...extra });

function makePack(overrides = {}) {
  return {
    id: 'pack-1',
    title: 'Neon Collection',
    description: 'Curated spatial reels',
    status: 'published',
    visibility: 'public',
    creator: { username: 'maker' },
    tags: ['neon', 'vr'],
    location: { city: 'Hanoi', country: 'Vietnam' },
    reel_count: 3,
    playable_count: 3,
    likes: 1500,
    views: 20,
    comments: 7,
    saves: 2,
    liked_by_me: false,
    saved_by_me: false,
    viewer_state: { can_edit: false, liked: false, saved: false },
    revision: 4,
    updated_at: '2026-10-01T10:00:00Z',
    cover_items: [],
    items: [item(1), item(2), item(3)],
    progress: null,
    ...overrides,
  };
}

function Where() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="where">{location.pathname + location.search}</div>
      <button type="button" onClick={() => navigate('/packs/fast')}>GO FAST</button>
    </>
  );
}

function renderPage(path = '/packs/pack-1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/packs/:packId" element={<PackPage />} />
        <Route path="/login" element={<div>LOGIN SCREEN</div>} />
        <Route path="/profile/:name" element={<div>PROFILE SCREEN</div>} />
        <Route path="/packs/:packId/edit" element={<div>EDITOR SCREEN</div>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

const loaded = async (path) => {
  const view = renderPage(path);
  await screen.findByRole('heading', { name: 'Neon Collection', level: 1 });
  return view;
};

const where = () => screen.getByTestId('where').textContent;

describe('PackPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    Object.values(mocks.api).forEach((fn) => fn.mockReset());
    mocks.messaging.openShare.mockReset();
    mocks.auth.user = { id: 'viewer', username: 'viewer' };
    mocks.playerProps = null;
    mocks.api.get.mockImplementation(async () => ({ pack: makePack() }));
    mocks.api.post.mockResolvedValue({});
  });

  describe('details', () => {
    it('shows the title, curator, description, tags, place and stats', async () => {
      await loaded();
      expect(screen.getByRole('link', { name: '@maker' })).toHaveAttribute('href', '/profile/maker');
      expect(screen.getByText('Curated spatial reels')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: '#neon' })).toHaveAttribute('href', '/explore?search=%23neon');
      expect(document.querySelector('.sx-pack-location')).toHaveTextContent('Hanoi, Vietnam');
      const stats = screen.getByLabelText('Pack statistics');
      expect(within(stats).getByText('LIKES').previousSibling).toHaveTextContent('1.5K');
      expect(within(stats).getByText('REELS').previousSibling).toHaveTextContent('3');
      expect(within(stats).getByText('SAVES').previousSibling).toHaveTextContent('2');
      expect(screen.getByText('PUBLIC')).toBeInTheDocument();
      expect(screen.getByText('3 OF 3 REELS AVAILABLE')).toBeInTheDocument();
    });

    it('records one pack_open event on load, not on later reloads', async () => {
      await loaded();
      expect(mocks.api.post).toHaveBeenCalledWith('/api/events', expect.objectContaining({
        event_type: 'pack_open', pack_id: 'pack-1', source: 'pack_detail',
      }));
      expect(mocks.api.post.mock.calls.filter(([url]) => url === '/api/events')).toHaveLength(1);
    });

    it('explains an unavailable pack instead of a broken page', async () => {
      mocks.api.get.mockRejectedValue(new Error('Reel Pack not found.'));
      renderPage();
      expect(await screen.findByText('REEL PACK UNAVAILABLE')).toBeInTheDocument();
      expect(screen.getByText('Reel Pack not found.')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    });

    it('warns when a pack was hidden from discovery for lack of reels', async () => {
      mocks.api.get.mockResolvedValue({ pack: makePack({ needs_repair: true }) });
      await loaded();
      expect(screen.getByText(/hidden from discovery until it has at least three available reels/)).toBeInTheDocument();
    });

    it('shows a draft badge for unpublished packs', async () => {
      mocks.api.get.mockResolvedValue({ pack: makePack({ status: 'draft' }) });
      await loaded();
      expect(screen.getByText('DRAFT')).toBeInTheDocument();
      expect(screen.getByText('▦ COLLECTION')).toBeInTheDocument();
    });

    it('says so when a pack has no reels', async () => {
      mocks.api.get.mockResolvedValue({ pack: makePack({ items: [], reel_count: 0, playable_count: 0 }) });
      await loaded();
      expect(screen.getByRole('status')).toHaveTextContent('This pack has no reels yet.');
      expect(screen.getByRole('button', { name: 'Play Neon Collection' })).toBeDisabled();
    });

    it('does not apply a stale response after navigating to another pack', async () => {
      let release;
      mocks.api.get.mockImplementation((path) => {
        if (path.endsWith('/slow')) return new Promise((resolve) => { release = resolve; });
        return Promise.resolve({ pack: makePack({ id: 'fast', title: 'Fast Pack' }) });
      });
      renderPage('/packs/slow');
      fireEvent.click(screen.getByRole('button', { name: 'GO FAST' }));
      expect(await screen.findByRole('heading', { name: 'Fast Pack', level: 1 })).toBeInTheDocument();
      release({ pack: makePack({ id: 'slow', title: 'Slow Pack' }) });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.getByRole('heading', { name: 'Fast Pack', level: 1 })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Slow Pack' })).not.toBeInTheDocument();
    });
  });

  describe('list and gallery views', () => {
    it('lists every reel in order with creator, kind and counts', async () => {
      localStorage.setItem('sx.pack.view', 'list');
      await loaded();
      const rows = screen.getAllByRole('button', { name: /^Play Reel \d, reel \d$/ });
      expect(rows).toHaveLength(3);
      expect(rows[0]).toHaveTextContent('01');
      expect(rows[0]).toHaveTextContent('Reel 1');
      expect(rows[0]).toHaveTextContent('@maker');
      expect(rows[0]).not.toHaveTextContent('VIDEO');
      expect(rows[0]).toHaveTextContent('Hanoi, Vietnam');
      expect(rows[0]).toHaveTextContent('1.2K');
      expect(screen.getByRole('radio', { name: 'LIST' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.queryByTestId('tile')).not.toBeInTheDocument();
    });

    it('shows removed reels as disabled rows', async () => {
      localStorage.setItem('sx.pack.view', 'list');
      mocks.api.get.mockResolvedValue({
        pack: makePack({ items: [item(1), item(2, { available: false, post: null }), item(3)], playable_count: 2 }),
      });
      await loaded();
      const gone = screen.getByText('Reel unavailable').closest('button');
      expect(gone).toBeDisabled();
      expect(gone).toHaveTextContent('REMOVED OR HIDDEN');
      expect(screen.getByText('2 OF 3 REELS AVAILABLE')).toBeInTheDocument();
    });

    it('opens on the gallery of Explore tiles by default', async () => {
      await loaded();
      expect(screen.getAllByTestId('tile')).toHaveLength(3);
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'GALLERY' })).toHaveAttribute('aria-checked', 'true');
      expect(document.querySelector('.sx-pk-gallery.sx-explore-grid')).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Compact square grid' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('lists Gallery before List in the view switch', async () => {
      await loaded();
      const labels = screen.getAllByRole('radio', { name: /^(GALLERY|LIST)$/ }).map((r) => r.textContent);
      expect(labels).toEqual(['GALLERY', 'LIST']);
    });

    it('switches to the list and remembers the choice', async () => {
      const { unmount } = await loaded();
      fireEvent.click(screen.getByRole('radio', { name: 'LIST' }));
      expect(screen.queryByTestId('tile')).not.toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'LIST' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.queryByRole('button', { name: 'Large tiles' })).not.toBeInTheDocument();
      expect(localStorage.getItem('sx.pack.view')).toBe('list');
      unmount();

      renderPage();
      await screen.findByRole('heading', { name: 'Neon Collection', level: 1 });
      expect(screen.queryByTestId('tile')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('radio', { name: 'GALLERY' }));
      expect(screen.getAllByTestId('tile')).toHaveLength(3);
      expect(localStorage.getItem('sx.pack.view')).toBe('gallery');
    });

    it('offers the same density control as Explore in gallery view', async () => {
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'Large tiles' }));
      expect(document.querySelector('.sx-explore-grid--stack.sx-pk-gallery')).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Compact square grid' }));
      expect(document.querySelector('.sx-explore-grid--stack')).toBeNull();
    });

    it('numbers gallery tiles by pack order and keeps removed reels as placeholders', async () => {
      localStorage.setItem('sx.pack.view', 'gallery');
      mocks.api.get.mockResolvedValue({
        pack: makePack({ items: [item(1), item(2, { available: false, post: null }), item(3)], playable_count: 2 }),
      });
      await loaded();
      expect(screen.getAllByTestId('tile')).toHaveLength(2);
      expect(screen.getByRole('img', { name: 'Reel 2 is unavailable' })).toBeInTheDocument();
      expect(screen.getAllByTestId('tile').map((tile) => tile.dataset.order)).toEqual(['01', '03']);
    });

    it('shows each reel\'s resolution and runtime, and the pack total', async () => {
      localStorage.setItem('sx.pack.view', 'list');
      await loaded();
      const rows = screen.getAllByRole('button', { name: /^Play Reel \d, reel \d$/ });
      expect(rows[0]).toHaveTextContent('3840×3840');
      expect(rows[0]).toHaveTextContent('0:29');
      expect(rows[1]).toHaveTextContent('0:58');
      expect(rows[2]).toHaveTextContent('1:27');
      expect(screen.getByText(/TOTAL RUNTIME/)).toHaveTextContent('TOTAL RUNTIME: 2:54');
    });

    it('leaves out runtime and size when the API does not know them, and marks a partial total', async () => {
      localStorage.setItem('sx.pack.view', 'list');
      mocks.api.get.mockResolvedValue({
        pack: makePack({
          items: [item(1), { ...item(2), post: post(2, { duration_ms: null, width: null, height: null }) }, item(3)],
        }),
      });
      await loaded();
      const row = screen.getByRole('button', { name: 'Play Reel 2, reel 2' });
      expect(row).not.toHaveTextContent('×');
      expect(row).not.toHaveTextContent(/\d:\d\d/);
      expect(screen.getByText(/TOTAL RUNTIME/)).toHaveTextContent('TOTAL RUNTIME: 1:56+');
    });

    it('omits the total entirely when no runtime is known', async () => {
      localStorage.setItem('sx.pack.view', 'list');
      mocks.api.get.mockResolvedValue({
        pack: makePack({ items: [1, 2, 3].map((n) => ({ ...item(n), post: post(n, { duration_ms: null }) })) }),
      });
      await loaded();
      expect(screen.queryByText(/TOTAL RUNTIME/)).not.toBeInTheDocument();
    });

    it('shows no runtime for image reels', async () => {
      localStorage.setItem('sx.pack.view', 'list');
      mocks.api.get.mockResolvedValue({
        pack: makePack({ items: [{ ...item(1), post: post(1, { media_type: 'image', duration_ms: 40 }) }, item(2), item(3)] }),
      });
      await loaded();
      const row = screen.getByRole('button', { name: 'Play Reel 1, reel 1' });
      expect(row).toHaveTextContent('IMAGE');
      expect(row).not.toHaveTextContent('0:01');
      expect(screen.getByText(/TOTAL RUNTIME/)).toHaveTextContent('TOTAL RUNTIME: 2:25');
    });

    it('falls back to the gallery when stored data is garbage', async () => {
      localStorage.setItem('sx.pack.view', 'banana');
      await loaded();
      expect(screen.getByRole('radio', { name: 'GALLERY' })).toHaveAttribute('aria-checked', 'true');
    });
  });

  describe('playback', () => {
    it('plays from a list row at that reel and restarts the sequence', async () => {
      localStorage.setItem('sx.pack.view', 'list');
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'Play Reel 3, reel 3' }));
      expect(where()).toBe('/packs/pack-1?play=1&item=2&restart=1');
      expect(await screen.findByTestId('player')).toHaveTextContent('PLAYER 2');
      expect(mocks.playerProps.params).toEqual({ pack_id: 'pack-1', restart: true });
      expect(screen.getByText('3 AVAILABLE')).toBeInTheDocument();
    });

    it('plays from a gallery tile at that reel', async () => {
      localStorage.setItem('sx.pack.view', 'gallery');
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'OPEN Reel 2' }));
      expect(where()).toBe('/packs/pack-1?play=1&item=1&restart=1');
      expect(await screen.findByTestId('player')).toHaveTextContent('PLAYER 1');
    });

    it('lays the player out on the same full-width page as the main Reels player', async () => {
      renderPage('/packs/pack-1?play=1&item=0');
      const player = await screen.findByTestId('player');
      expect(player.closest('.sx-pack-player-page')).toHaveClass('sx-wide-page');
    });

    it('clamps an out-of-range item in the URL', async () => {
      renderPage('/packs/pack-1?play=1&item=99');
      expect(await screen.findByTestId('player')).toHaveTextContent('PLAYER 2');
    });

    it('treats a junk item param as the first reel', async () => {
      renderPage('/packs/pack-1?play=1&item=abc');
      expect(await screen.findByTestId('player')).toHaveTextContent('PLAYER 0');
    });

    it('returns to the details without counting another open', async () => {
      localStorage.setItem('sx.pack.view', 'list');
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'Play Reel 1, reel 1' }));
      await screen.findByTestId('player');
      mocks.api.post.mockClear();
      fireEvent.click(screen.getByRole('button', { name: '← PACK DETAILS' }));
      await screen.findByRole('heading', { name: 'Neon Collection', level: 1 });
      expect(where()).toBe('/packs/pack-1');
      expect(mocks.api.post).not.toHaveBeenCalledWith('/api/events', expect.anything());
    });

    it('starts the collection from the cover', async () => {
      await loaded();
      expect(screen.getByText('▶ PLAY COLLECTION')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Play Neon Collection' }));
      expect(where()).toBe('/packs/pack-1?play=1&item=0');
      expect(await screen.findByTestId('player')).toHaveTextContent('PLAYER 0');
      expect(mocks.playerProps.params.restart).toBe(false);
    });

    it('resumes where the viewer left off and can start over', async () => {
      mocks.api.get.mockResolvedValue({
        pack: makePack({ progress: { phase: 'playing', current_item_id: 'item-2', item_index: 1 } }),
      });
      await loaded();
      expect(screen.getByText('▶ RESUME')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Resume Neon Collection' }));
      expect(where()).toBe('/packs/pack-1?play=1&item=1');
      cleanup();

      renderPage();
      await screen.findByRole('heading', { name: 'Neon Collection', level: 1 });
      fireEvent.click(screen.getByRole('button', { name: 'START OVER' }));
      expect(where()).toBe('/packs/pack-1?play=1&item=0&restart=1');
    });
  });

  describe('like and save', () => {
    it('likes and unlikes with the server count', async () => {
      mocks.api.put.mockResolvedValue({ pack_id: 'pack-1', likes: 1501, liked_by_me: true });
      mocks.api.delete.mockResolvedValue({ pack_id: 'pack-1', likes: 1500, liked_by_me: false });
      await loaded();
      const like = screen.getByRole('button', { name: 'LIKE' });
      expect(like).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(like);
      const liked = await screen.findByRole('button', { name: 'LIKED' });
      expect(mocks.api.put).toHaveBeenCalledWith('/api/packs/pack-1/like');
      expect(liked).toHaveAttribute('aria-pressed', 'true');
      expect(within(screen.getByLabelText('Pack statistics')).getByText('LIKES').previousSibling).toHaveTextContent('1.5K');

      fireEvent.click(liked);
      await screen.findByRole('button', { name: 'LIKE' });
      expect(mocks.api.delete).toHaveBeenCalledWith('/api/packs/pack-1/like');
    });

    it('keeps the old state and shows the error when liking fails', async () => {
      mocks.api.put.mockRejectedValue(new Error('Too many requests'));
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'LIKE' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
      expect(screen.getByRole('button', { name: 'LIKE' })).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(screen.getByRole('button', { name: 'DISMISS' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('saves and unsaves, updating the count', async () => {
      mocks.api.put.mockResolvedValue({ saved: true, saves: 3 });
      mocks.api.delete.mockResolvedValue({ saved: false, saves: 2 });
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'SAVE PACK' }));
      const saved = await screen.findByRole('button', { name: 'SAVED PACK' });
      expect(mocks.api.put).toHaveBeenCalledWith('/api/packs/pack-1/save');
      expect(within(screen.getByLabelText('Pack statistics')).getByText('SAVES').previousSibling).toHaveTextContent('3');
      fireEvent.click(saved);
      await screen.findByRole('button', { name: 'SAVE PACK' });
      expect(mocks.api.delete).toHaveBeenCalledWith('/api/packs/pack-1/save');
    });

    it('ignores a second click while a like is in flight', async () => {
      let finish;
      mocks.api.put.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      await loaded();
      const like = screen.getByRole('button', { name: 'LIKE' });
      fireEvent.click(like);
      await waitFor(() => expect(like).toBeDisabled());
      fireEvent.click(like);
      expect(mocks.api.put).toHaveBeenCalledTimes(1);
      finish({ likes: 1501, liked_by_me: true });
      await screen.findByRole('button', { name: 'LIKED' });
    });

    it.each([['LIKE'], ['SAVE PACK'], ['REPORT']])('sends signed-out visitors to log in before %s', async (label) => {
      mocks.auth.user = null;
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(await screen.findByText('LOGIN SCREEN')).toBeInTheDocument();
      expect(where()).toBe('/login?next=%2Fpacks%2Fpack-1');
      expect(mocks.api.put).not.toHaveBeenCalled();
    });
  });

  describe('share and copy link', () => {
    it('shares the pack through messages', async () => {
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'SHARE PACK' }));
      expect(mocks.messaging.openShare).toHaveBeenCalledWith({ kind: 'pack', id: 'pack-1', title: 'Neon Collection' });
    });

    it('shares a single reel from a gallery tile', async () => {
      localStorage.setItem('sx.pack.view', 'gallery');
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'SHARE Reel 1' }));
      expect(mocks.messaging.openShare).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reel', id: 'post-1' }));
    });

    it('has no standalone copy button — copying the link lives in the share panel', async () => {
      await loaded();
      expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    });
  });

  describe('report', () => {
    it('submits the chosen reason and details through an in-app dialog', async () => {
      const promptSpy = vi.spyOn(window, 'prompt');
      mocks.api.post.mockResolvedValue({});
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'REPORT' }));
      const dialog = screen.getByRole('dialog', { name: 'REPORT REEL PACK' });
      expect(within(dialog).getByLabelText('Report reason')).toHaveFocus();
      fireEvent.change(within(dialog).getByLabelText('Report reason'), { target: { value: 'harassment' } });
      fireEvent.change(within(dialog).getByLabelText('Report details'), { target: { value: '  rude title  ' } });
      expect(within(dialog).getByText('14/500')).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'SUBMIT REPORT' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mocks.api.post).toHaveBeenCalledWith('/api/reports', {
        target_type: 'pack', target_id: 'pack-1', reason: 'harassment', details: 'rude title',
      });
      expect(screen.getByRole('status')).toHaveTextContent('Report submitted');
      expect(promptSpy).not.toHaveBeenCalled();
      promptSpy.mockRestore();
    });

    it('keeps the dialog open and shows the error when the report fails', async () => {
      mocks.api.post.mockImplementation(async (url) => {
        if (url === '/api/reports') throw new Error('Report limit reached');
        return {};
      });
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'REPORT' }));
      fireEvent.click(screen.getByRole('button', { name: 'SUBMIT REPORT' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Report limit reached');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'SUBMIT REPORT' })).not.toBeDisabled();
    });

    it('closes with Escape, Cancel, the × button or the backdrop, and resets the form', async () => {
      await loaded();
      const open = () => fireEvent.click(screen.getByRole('button', { name: 'REPORT' }));
      open();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      open();
      fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      open();
      fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      open();
      fireEvent.mouseDown(document.querySelector('.sx-pk-modal'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      open();
      fireEvent.mouseDown(screen.getByRole('dialog'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Report details'), { target: { value: 'draft text' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      open();
      expect(screen.getByLabelText('Report details')).toHaveValue('');
      expect(screen.getByLabelText('Report reason')).toHaveValue('spam');
    });

    it('cannot be dismissed while the report is sending', async () => {
      let finish;
      mocks.api.post.mockImplementation((url) => (url === '/api/reports' ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({})));
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'REPORT' }));
      fireEvent.click(screen.getByRole('button', { name: 'SUBMIT REPORT' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled());
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      finish({});
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });
  });

  describe('owner controls', () => {
    const ownerPack = (overrides = {}) => makePack({ viewer_state: { can_edit: true }, ...overrides });

    it('are never shown to other people', async () => {
      await loaded();
      expect(screen.queryByLabelText('Owner controls')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'DELETE' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'EDIT PACK' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'REPORT' })).toBeInTheDocument();
    });

    it('replace Report for the owner and show the revision', async () => {
      mocks.api.get.mockResolvedValue({ pack: ownerPack() });
      await loaded();
      const panel = screen.getByLabelText('Owner controls');
      expect(within(panel).getByText('REV 4')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'REPORT' })).not.toBeInTheDocument();
      fireEvent.click(within(panel).getByRole('button', { name: 'EDIT PACK' }));
      expect(where()).toBe('/packs/pack-1/edit');
    });

    it('block publishing until three reels are available', async () => {
      mocks.api.get.mockResolvedValue({ pack: ownerPack({ status: 'draft', playable_count: 2 }) });
      await loaded();
      expect(screen.getByText('2/3 AVAILABLE')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'PUBLISH COLLECTION' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'MOVE TO DRAFT' })).not.toBeInTheDocument();
    });

    it('publish a ready draft with the current revision', async () => {
      mocks.api.get.mockResolvedValue({ pack: ownerPack({ status: 'draft' }) });
      mocks.api.post.mockImplementation(async (url) => (
        url.endsWith('/publish') ? { pack: ownerPack({ status: 'published', revision: 5 }) } : {}
      ));
      await loaded();
      expect(screen.getByText('3/3 READY')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'PUBLISH COLLECTION' }));
      expect(await screen.findByText('Collection published.')).toBeInTheDocument();
      expect(mocks.api.post).toHaveBeenCalledWith('/api/packs/pack-1/publish', { expected_revision: 4 });
      expect(screen.getByText('REV 5')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'MOVE TO DRAFT' })).toBeInTheDocument();
    });

    it('move a published pack back to draft', async () => {
      mocks.api.get.mockResolvedValue({ pack: ownerPack() });
      mocks.api.post.mockImplementation(async (url) => (
        url.endsWith('/unpublish') ? { pack: ownerPack({ status: 'draft', revision: 5 }) } : {}
      ));
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'MOVE TO DRAFT' }));
      expect(await screen.findByText(/Moved back to draft/)).toBeInTheDocument();
      expect(mocks.api.post).toHaveBeenCalledWith('/api/packs/pack-1/unpublish', { expected_revision: 4 });
      expect(screen.getByText('DRAFT')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'PUBLISH COLLECTION' })).toBeInTheDocument();
    });

    it('reload and report a revision conflict instead of overwriting', async () => {
      mocks.api.get.mockResolvedValue({ pack: ownerPack({ status: 'draft' }) });
      mocks.api.post.mockImplementation(async (url) => {
        if (url.endsWith('/publish')) throw new Error('This Reel Pack changed. Reload and retry.');
        return {};
      });
      await loaded();
      mocks.api.get.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'PUBLISH COLLECTION' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('changed. Reload and retry.');
      await waitFor(() => expect(mocks.api.get).toHaveBeenCalledWith('/api/packs/pack-1'));
    });

    it('change visibility on a published pack, sending the revision', async () => {
      mocks.api.get.mockResolvedValue({ pack: ownerPack() });
      mocks.api.patch.mockResolvedValue({ pack: ownerPack({ visibility: 'unlisted', revision: 5 }) });
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'VISIBILITY' }));
      fireEvent.click(screen.getByRole('option', { name: 'UNLISTED · LINK ONLY' }));
      await waitFor(() => expect(screen.getByText('UNLISTED')).toBeInTheDocument());
      expect(mocks.api.patch).toHaveBeenCalledWith('/api/packs/pack-1', { visibility: 'unlisted', expected_revision: 4 });
      expect(screen.getByText('REV 5')).toBeInTheDocument();
    });

    it('do nothing when the same visibility is picked again', async () => {
      mocks.api.get.mockResolvedValue({ pack: ownerPack() });
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'VISIBILITY' }));
      fireEvent.click(screen.getByRole('option', { name: 'PUBLIC · DISCOVERABLE' }));
      expect(mocks.api.patch).not.toHaveBeenCalled();
    });

    it('delete only after confirming in the dialog, then go to the profile packs', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm');
      mocks.api.get.mockResolvedValue({ pack: ownerPack() });
      mocks.api.delete.mockResolvedValue({ ok: true });
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'DELETE' }));
      const dialog = screen.getByRole('dialog', { name: 'DELETE THIS REEL PACK?' });
      expect(mocks.api.delete).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'CANCEL' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mocks.api.delete).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'DELETE' }));
      fireEvent.click(screen.getByRole('button', { name: 'DELETE PACK' }));
      expect(await screen.findByText('PROFILE SCREEN')).toBeInTheDocument();
      expect(mocks.api.delete).toHaveBeenCalledWith('/api/packs/pack-1?expected_revision=4', { expected_revision: 4 });
      expect(where()).toBe('/profile/maker?tab=packs');
      expect(confirmSpy).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('keep the pack and explain when delete fails', async () => {
      mocks.api.get.mockResolvedValue({ pack: ownerPack() });
      mocks.api.delete.mockRejectedValue(new Error('This Reel Pack changed. Reload and retry.'));
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'DELETE' }));
      fireEvent.click(screen.getByRole('button', { name: 'DELETE PACK' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('changed. Reload and retry.');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'DELETE PACK' })).not.toBeDisabled();
      expect(where()).toBe('/packs/pack-1');
    });
  });
});
