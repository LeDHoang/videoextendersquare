import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MobileBottomNav from './MobileBottomNav.jsx';

const mockUseAuth = vi.fn();
const mockUseMessaging = vi.fn();

vi.mock('../../hooks/AuthContext.jsx', () => ({ useAuth: () => mockUseAuth() }));
vi.mock('../../hooks/MessagingContext.jsx', () => ({ useMessaging: () => mockUseMessaging() }));

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('style');
});

const renderNav = (path = '/reels') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <MobileBottomNav />
    </MemoryRouter>,
  );

describe('MobileBottomNav', () => {
  it('links to reels, explore, upload, messages and the signed-in profile', () => {
    mockUseAuth.mockReturnValue({ user: { username: 'maker', display_name: 'Maker One' } });
    mockUseMessaging.mockReturnValue({ unread: { total: 0 } });
    renderNav();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/reels', '/explore', '/upload', '/messages', '/profile/maker']);
    expect(screen.getByRole('link', { name: 'Reels' })).toHaveClass('sx-active');
    expect(screen.getByRole('link', { name: 'Explore' })).not.toHaveClass('sx-active');
    expect(screen.getByRole('link', { name: 'Profile' })).toHaveTextContent('MA');
    // icon-only: no text labels under the glyphs
    expect(screen.getByRole('link', { name: 'Reels' })).toHaveTextContent('');
    expect(document.querySelector('.sx-bottom-nav-label')).toBeNull();
  });

  it('keeps Explore lit while a Reel Pack plays', () => {
    mockUseAuth.mockReturnValue({ user: { username: 'maker' } });
    mockUseMessaging.mockReturnValue({ unread: { total: 0 } });
    renderNav('/packs/abc?play=1');
    expect(screen.getByRole('link', { name: 'Explore' })).toHaveClass('sx-active');
    expect(screen.getByRole('link', { name: 'Reels' })).not.toHaveClass('sx-active');
  });

  it('shows the unread count on Messages', () => {
    mockUseAuth.mockReturnValue({ user: { username: 'maker' } });
    mockUseMessaging.mockReturnValue({ unread: { total: 120 } });
    renderNav();
    const link = screen.getByRole('link', { name: 'Messages, 120 unread' });
    expect(link).toHaveTextContent('99+');
  });

  it('offers sign in, returning to the player, when logged out', () => {
    mockUseAuth.mockReturnValue({ user: null });
    mockUseMessaging.mockReturnValue({ unread: { total: 0 } });
    renderNav('/packs/abc?play=1');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?next=%2Fpacks%2Fabc%3Fplay%3D1');
  });

  it('tells the player how much room to leave while mounted, and cleans up', () => {
    mockUseAuth.mockReturnValue({ user: null });
    mockUseMessaging.mockReturnValue({ unread: { total: 0 } });
    const { unmount } = renderNav();
    expect(document.documentElement.style.getPropertyValue('--sx-bottom-nav')).toContain('56px');
    expect(document.documentElement.style.getPropertyValue('--sx-fs-safe-bottom')).toBe('0px');
    unmount();
    expect(document.documentElement.style.getPropertyValue('--sx-bottom-nav')).toBe('');
  });
});
