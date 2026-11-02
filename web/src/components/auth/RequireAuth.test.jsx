import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RequireAuth from './RequireAuth.jsx';

const mocks = vi.hoisted(() => ({ auth: { user: null, loading: false } }));

vi.mock('../../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function renderAt(path, props = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tool" element={<RequireAuth {...props}><p>TOOL PAGE</p></RequireAuth>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  afterEach(() => {
    cleanup();
    mocks.auth = { user: null, loading: false };
  });

  it('sends a signed-out visitor to login with the page to return to', () => {
    renderAt('/tool?x=1', { adminOnly: true });
    expect(screen.getByTestId('where')).toHaveTextContent('/login?next=' + encodeURIComponent('/tool?x=1'));
  });

  it('lets any signed-in user through without adminOnly', () => {
    mocks.auth = { user: { id: 1, role: 'user' }, loading: false };
    renderAt('/tool');
    expect(screen.getByText('TOOL PAGE')).toBeInTheDocument();
  });

  it('sends a regular user away from an adminOnly page to /reels', () => {
    mocks.auth = { user: { id: 1, role: 'user' }, loading: false };
    renderAt('/tool', { adminOnly: true });
    expect(screen.queryByText('TOOL PAGE')).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/reels');
  });

  it('lets an admin into an adminOnly page', () => {
    mocks.auth = { user: { id: 1, role: 'admin' }, loading: false };
    renderAt('/tool', { adminOnly: true });
    expect(screen.getByText('TOOL PAGE')).toBeInTheDocument();
  });
});
