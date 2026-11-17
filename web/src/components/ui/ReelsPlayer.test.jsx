import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReelsPlayer from './ReelsPlayer.jsx';

// By default the player markup never arrives: the preview canvas renders straight away.
const playerGet = vi.hoisted(() => vi.fn(() => new Promise(() => {})));
vi.mock('../../api/client.js', () => ({ api: { get: playerGet } }));
vi.mock('../../hooks/AuthContext.jsx', () => ({ useAuth: () => ({ user: null, setUser: vi.fn() }) }));
vi.mock('../../hooks/MessagingContext.jsx', () => ({ useMessaging: () => null }));

afterEach(cleanup);

describe('ReelsPlayer preview canvas', () => {
  it('is a focusable application described by the page’s keyboard help', () => {
    render(
      <MemoryRouter>
        <ReelsPlayer params={{}} previewMode previewDescribedBy="keys" />
        <div id="keys">ARROWS LOOK OR ORBIT · SPACE PLAY</div>
      </MemoryRouter>,
    );
    const canvas = screen.getByRole('application', { name: 'Interactive desktop preview of the immersive Reels scene' });
    expect(canvas).toHaveAttribute('tabindex', '0');
    expect(canvas).toHaveAccessibleDescription('ARROWS LOOK OR ORBIT · SPACE PLAY');
  });
});

describe('ReelsPlayer mounted styles', () => {
  afterEach(() => document.head.querySelector('meta[property="csp-nonce"]')?.remove());

  it('carries the page CSP nonce, so style-src-elem lets the player CSS apply', async () => {
    const meta = document.createElement('meta');
    meta.setAttribute('property', 'csp-nonce');
    meta.setAttribute('nonce', 'n1');
    document.head.appendChild(meta);
    playerGet.mockResolvedValueOnce({ css: '#sxReelsRoot{}', html: '', scripts: [] });
    const { container } = render(
      <MemoryRouter>
        <ReelsPlayer params={{}} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('style')).not.toBeNull());
    expect(container.querySelector('style').getAttribute('nonce')).toBe('n1');
  });
});
