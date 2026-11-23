import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReelShareDialog from './ReelShareDialog.jsx';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  auth: { user: { id: 'me', username: 'me' } },
  messaging: { shareTarget: null, closeShare: vi.fn(), refreshAll: vi.fn() },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));
vi.mock('../../hooks/MessagingContext.jsx', () => ({
  useMessaging: () => mocks.messaging,
  clientId: (prefix) => prefix + '-test',
}));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,AAAA') } }));

const LINK = 'https://echo.test/packs/pack-1';

function setClipboard(writeText) {
  Object.defineProperty(navigator, 'clipboard', { value: writeText ? { writeText } : undefined, configurable: true });
}

function setNativeShare(share) {
  Object.defineProperty(navigator, 'share', { value: share, configurable: true });
}

async function openDialog(target = { kind: 'pack', id: 'pack-1', title: 'Neon Collection' }) {
  mocks.messaging.shareTarget = target;
  render(<MemoryRouter><ReelShareDialog /></MemoryRouter>);
  await screen.findByDisplayValue(LINK);
}

describe('ReelShareDialog copy link', () => {
  afterEach(() => {
    cleanup();
    setClipboard(undefined);
    setNativeShare(undefined);
  });

  beforeEach(() => {
    Object.values(mocks.api).forEach((fn) => fn.mockReset());
    mocks.messaging.closeShare.mockReset();
    mocks.api.get.mockResolvedValue({ canonical_url: LINK, title: 'Neon Collection', share_text: 'Watch this', playable_count: 3 });
    setNativeShare(undefined);
  });

  it('copies the canonical link for a pack', async () => {
    const writeText = vi.fn().mockResolvedValue();
    setClipboard(writeText);
    await openDialog();
    expect(mocks.api.get).toHaveBeenCalledWith('/api/packs/pack-1/share');
    fireEvent.click(screen.getByRole('button', { name: 'COPY LINK' }));
    expect(await screen.findByText('Link copied.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(LINK);
  });

  it('copies the canonical link for a single reel too', async () => {
    const writeText = vi.fn().mockResolvedValue();
    setClipboard(writeText);
    mocks.api.get.mockResolvedValue({ canonical_url: 'https://echo.test/reels/p1', title: 'Reel' });
    mocks.messaging.shareTarget = { kind: 'reel', id: 'p1', title: 'Reel' };
    render(<MemoryRouter><ReelShareDialog /></MemoryRouter>);
    await screen.findByDisplayValue('https://echo.test/reels/p1');
    expect(mocks.api.get).toHaveBeenCalledWith('/api/posts/p1/share');
    fireEvent.click(screen.getByRole('button', { name: 'COPY LINK' }));
    await screen.findByText('Link copied.');
    expect(writeText).toHaveBeenCalledWith('https://echo.test/reels/p1');
  });

  it('describes the pack without a stray plural', async () => {
    await openDialog();
    expect(screen.getByRole('status', { name: 'Reel Pack preview: Neon Collection' })).toHaveTextContent('REEL PACK · 3 AVAILABLE');
    expect(screen.queryByText(/AVAILABLES/)).not.toBeInTheDocument();
  });

  it('is disabled until the link is ready', async () => {
    let finish;
    mocks.api.get.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mocks.messaging.shareTarget = { kind: 'pack', id: 'pack-1', title: 'Neon Collection' };
    render(<MemoryRouter><ReelShareDialog /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'COPY LINK' })).toBeDisabled();
    finish({ canonical_url: LINK, title: 'Neon Collection' });
    await screen.findByDisplayValue(LINK);
    expect(screen.getByRole('button', { name: 'COPY LINK' })).toBeEnabled();
  });

  it('selects the visible link instead of opening a browser prompt when the clipboard is blocked', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null);
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    await openDialog();
    const input = screen.getByLabelText('Canonical Reel Pack link');
    const select = vi.spyOn(input, 'select');
    fireEvent.click(screen.getByRole('button', { name: 'COPY LINK' }));
    expect(await screen.findByText(/link is selected/)).toBeInTheDocument();
    expect(select).toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it('survives a browser with no clipboard API at all', async () => {
    setClipboard(undefined);
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'COPY LINK' }));
    expect(await screen.findByText(/link is selected/)).toBeInTheDocument();
  });

  it('shows one copy button, and a native SHARE button only where the browser supports it', async () => {
    await openDialog();
    expect(screen.getAllByRole('button', { name: /copy/i })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'SHARE' })).not.toBeInTheDocument();
    cleanup();

    const share = vi.fn().mockResolvedValue();
    setNativeShare(share);
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'SHARE' }));
    expect(share).toHaveBeenCalledWith({ title: 'Neon Collection', text: 'Watch this', url: LINK });
    expect(screen.getAllByRole('button', { name: /copy/i })).toHaveLength(1);
  });

  it('does not report an error when the native share sheet is dismissed', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    setNativeShare(vi.fn().mockRejectedValue(abort));
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'SHARE' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  });

  it('lists every account type in recipient search, including the system archive, but never me', async () => {
    mocks.api.get.mockImplementation((path) => Promise.resolve(path === '/api/search/suggestions'
      ? { users: [
        { id: 'sys', username: 'echo_archive', display_name: 'ECHO Archive', account_type: 'system' },
        { id: 'demo', username: 'demo_neon', display_name: 'Neon Demo', account_type: 'demo' },
        { id: 'real', username: 'alice', display_name: 'Alice', account_type: 'real' },
        { id: 'me', username: 'me', display_name: 'Me', account_type: 'real', is_me: true },
      ] }
      : { canonical_url: LINK, title: 'Neon Collection', share_text: 'Watch this', playable_count: 3 }));
    await openDialog();
    fireEvent.change(screen.getByLabelText('Search people to share with'), { target: { value: 'e' } });
    expect(await screen.findByText('@echo_archive')).toBeInTheDocument();
    expect(screen.getByText('@demo_neon')).toBeInTheDocument();
    expect(screen.getByText('@alice')).toBeInTheDocument();
    expect(screen.queryByText('@me')).not.toBeInTheDocument();
  });
});

describe('ReelShareDialog starts clean for each share', () => {
  const PEOPLE = { users: [{ id: 'u1', username: 'alice', display_name: 'Alice', account_type: 'real' }] };

  beforeEach(() => {
    Object.values(mocks.api).forEach((fn) => fn.mockReset());
    mocks.messaging.refreshAll.mockReset();
    mocks.api.get.mockImplementation((path) => Promise.resolve(path === '/api/search/suggestions'
      ? PEOPLE
      : { canonical_url: `https://echo.test${path}`, title: 'Reel' }));
  });

  afterEach(() => cleanup());

  const tree = () => <MemoryRouter><ReelShareDialog /></MemoryRouter>;

  async function fillDialog() {
    await screen.findByDisplayValue('https://echo.test/api/posts/p1/share');
    fireEvent.change(screen.getByLabelText('Search people to share with'), { target: { value: 'ali' } });
    fireEvent.click(await screen.findByRole('button', { name: /@alice/ }));
    fireEvent.change(screen.getByLabelText('Optional note'), { target: { value: 'look at this' } });
    expect(screen.getByRole('button', { name: 'SEND TO 1' })).toBeEnabled();
  }

  function expectClean() {
    expect(screen.getByLabelText('Search people to share with')).toHaveValue('');
    expect(screen.queryByRole('button', { name: /@alice/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Optional note')).toHaveValue('');
    expect(screen.getByText('0/10')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SEND TO 0' })).toBeDisabled();
    expect(screen.queryByText(/DELIVERED/)).not.toBeInTheDocument();
    expect(document.querySelector('.sx-share-status')).toBeNull();
  }

  it('resets search, results, recipients, note, delivery and status when the target changes', async () => {
    mocks.messaging.shareTarget = { kind: 'reel', id: 'p1' };
    const { rerender } = render(tree());
    await fillDialog();
    mocks.api.post.mockResolvedValue({ succeeded: 1, failed: 0, results: [{ username: 'alice', ok: true }] });
    fireEvent.click(screen.getByRole('button', { name: 'SEND TO 1' }));
    expect(await screen.findByText('1 delivered.')).toBeInTheDocument();

    mocks.messaging.shareTarget = { kind: 'reel', id: 'p2' };
    rerender(tree());
    await screen.findByDisplayValue('https://echo.test/api/posts/p2/share');
    expectClean();
    expect(screen.queryByText('1 delivered.')).not.toBeInTheDocument();
  });

  it('starts clean when the same target is closed and reopened (dialog stays mounted)', async () => {
    mocks.messaging.shareTarget = { kind: 'reel', id: 'p1' };
    const { rerender } = render(tree());
    await fillDialog();

    mocks.messaging.shareTarget = null;
    rerender(tree());
    mocks.messaging.shareTarget = { kind: 'reel', id: 'p1' };
    rerender(tree());
    await screen.findByDisplayValue('https://echo.test/api/posts/p1/share');
    expectClean();
  });

  it('lets a send from an earlier open finish without leaking into the next one', async () => {
    let finish;
    mocks.api.post.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mocks.messaging.shareTarget = { kind: 'reel', id: 'p1' };
    const { rerender } = render(tree());
    await fillDialog();
    fireEvent.click(screen.getByRole('button', { name: 'SEND TO 1' }));
    expect(screen.getByRole('button', { name: 'SENDING…' })).toBeDisabled();

    mocks.messaging.shareTarget = { kind: 'reel', id: 'p2' };
    rerender(tree());
    await screen.findByDisplayValue('https://echo.test/api/posts/p2/share');
    expect(screen.getByRole('button', { name: 'SEND TO 0' })).toBeInTheDocument();

    finish({ succeeded: 1, failed: 0, results: [{ username: 'alice', ok: true }] });
    await vi.waitFor(() => expect(mocks.messaging.refreshAll).toHaveBeenCalled());
    expect(mocks.api.post).toHaveBeenCalledWith('/api/messages/share-content', expect.objectContaining({ target_id: 'p1', note: 'look at this', usernames: ['alice'] }));
    expectClean();
    expect(screen.queryByText('1 delivered.')).not.toBeInTheDocument();
  });
});
