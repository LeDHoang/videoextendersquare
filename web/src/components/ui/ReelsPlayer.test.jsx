import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReelsPlayer from './ReelsPlayer.jsx';

// The player markup never arrives here: only the preview canvas, which renders straight away, is under test.
vi.mock('../../api/client.js', () => ({ api: { get: () => new Promise(() => {}) } }));
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
