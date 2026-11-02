import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HeaderBar from './HeaderBar.jsx';
import MobileBottomNav from './MobileBottomNav.jsx';
import Sidebar from './Sidebar.jsx';
import { NAV } from './nav.js';

const user = { id: 'usr-1', username: 'ana', display_name: 'Ana', can_moderate: true };

vi.mock('../../hooks/AuthContext.jsx', () => ({ useAuth: () => ({ user, loading: false, logout: vi.fn() }) }));
vi.mock('../../hooks/HealthContext.jsx', () => ({ useHealthContext: () => ({ probes: {}, fal_key: { ok: true } }) }));
vi.mock('../../hooks/MessagingContext.jsx', () => ({ useMessaging: () => ({ unread: { total: 0 } }) }));
vi.mock('../../hooks/WalletContext.jsx', () => ({ useWallet: () => ({ wallet: null, falKey: { configured: false } }) }));

afterEach(cleanup);

// The visible text, or the accessible name of an icon-only link.
const name = (link) => (link.textContent.trim() || link.getAttribute('aria-label') || '').trim();

describe('one navigation source', () => {
  it('gives each destination the same label in the header, account menu, sidebar and tab bar', () => {
    render(
      <MemoryRouter initialEntries={['/explore']}>
        <HeaderBar onToggleSidebar={vi.fn()} />
        <Sidebar isOpen onClose={vi.fn()} />
        <MobileBottomNav />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open account menu' }));
    const places = [
      screen.getByRole('navigation', { name: 'Global Routes' }),
      document.querySelector('.sx-account-popover'),
      screen.getByRole('navigation', { name: 'Main App Navigation' }),
      screen.getByRole('navigation', { name: 'Main navigation' }),
    ];
    const labels = {};
    for (const place of places) {
      for (const link of within(place).getAllByRole('link')) {
        const href = link.getAttribute('href');
        (labels[href] ||= new Set()).add(name(link));
      }
    }
    for (const item of Object.values(NAV)) {
      if (labels[item.to]) expect([...labels[item.to]], item.to).toEqual([item.label]);
    }
    // Every destination in the list is reachable from at least one of these places
    // (the admin-only tools only for admins; Sidebar.test.jsx covers those).
    expect(Object.values(NAV).filter((item) => !item.adminOnly && !labels[item.to]).map((item) => item.to)).toEqual([]);
    expect(within(places[1]).getAllByRole('link').map(name)).toEqual(['Profile', 'Saved', 'Settings', 'Credits', 'Staff']);
  });
});
