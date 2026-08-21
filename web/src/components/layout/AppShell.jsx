import { useState } from 'react';
import { Outlet, useLocation, Link } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import ErrorBoundary from '../ErrorBoundary.jsx';
import { HealthProvider, useHealthContext } from '../../hooks/HealthContext.jsx';
import { ConfigProvider, useConfigContext } from '../../hooks/ConfigContext.jsx';

const ROUTE_NAMES = {
  '/image': 'IMAGE EXTENDER',
  '/video': 'VIDEO EXTENDER',
  '/compare': 'FAST vs STUDIO',
  '/reels': 'REELS / VR',
};

function Shell() {
  const health = useHealthContext();
  const { config, setFalKey, setModels } = useConfigContext();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const currentTitle = ROUTE_NAMES[location.pathname] || 'ECHO';
  const falOk = health?.fal_key?.ok;
  const probes = Object.values(health?.probes || {});
  const systemOk = probes.length > 0 && probes.every((p) => p.ok);

  return (
    <>
      {/* Accessible Skip to Content Link */}
      <a href="#main-content" className="sx-skip-link">
        Skip to main content
      </a>

      {/* Mobile Top App Bar (only shown on screens < 900px) */}
      <header className="sx-mobile-header">
        <Link to="/image" className="sx-mobile-brand" onClick={() => setMobileOpen(false)}>
          <img src="/logo.png" alt="ECHO Logo" className="sx-brand-logo sx-brand-logo-sm" />
          <span className="sx-brand-title" style={{ fontSize: '0.85rem' }}>
            {currentTitle}
          </span>
        </Link>
        <div className="sx-mobile-actions">
          <button
            type="button"
            className="sx-btn"
            style={{ padding: '6px 12px', fontSize: '0.75rem' }}
            onClick={() => setMobileOpen((o) => !o)}
            aria-label="Toggle Navigation & Settings Menu"
            aria-expanded={mobileOpen}
          >
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: systemOk && falOk ? 'var(--sx-success)' : !systemOk ? 'var(--sx-danger)' : 'var(--sx-warn)',
                marginRight: 6,
              }}
            />
            MENU ☰
          </button>
        </div>
      </header>

      {/* Main Grid Shell */}
      <div className="sx-shell">
        {/* Backdrop for Mobile Drawer */}
        <div
          className={`sx-drawer-backdrop ${mobileOpen ? 'sx-open' : ''}`}
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />

        {/* Sidebar Component */}
        <Sidebar
          health={health}
          config={config}
          setFalKey={setFalKey}
          setModels={setModels}
          isOpen={mobileOpen}
          onClose={() => setMobileOpen(false)}
        />

        {/* Main Content Area */}
        <main id="main-content" className="sx-main" tabIndex="-1">
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </>
  );
}

export default function AppShell() {
  return (
    <HealthProvider>
      <ConfigProvider>
        <Shell />
      </ConfigProvider>
    </HealthProvider>
  );
}