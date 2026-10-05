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
});
