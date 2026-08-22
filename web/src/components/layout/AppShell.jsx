import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import HeaderBar from './HeaderBar.jsx';
import Sidebar from './Sidebar.jsx';
import ErrorBoundary from '../ErrorBoundary.jsx';
import { HealthProvider, useHealthContext } from '../../hooks/HealthContext.jsx';
import { ConfigProvider, useConfigContext } from '../../hooks/ConfigContext.jsx';

function Shell() {
  const health = useHealthContext();
  const { config, setFalKey, setModels } = useConfigContext();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      {/* Accessible Skip Link */}
      <a href="#main-content" className="sx-skip-link">
        Skip to main content
      </a>

      {/* Global High-Density Utility Top Bar */}
      <HeaderBar onOpenSettings={() => setDrawerOpen((prev) => !prev)} />

      {/* Main Grid Shell */}
      <div className={`sx-shell ${drawerOpen ? 'sx-sidebar-open' : ''}`} style={{ minHeight: 'calc(100vh - 64px)' }}>
        {/* Backdrop for Settings Drawer on mobile */}
        <div
          className={`sx-drawer-backdrop ${drawerOpen ? 'sx-open' : ''}`}
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />

        {/* Settings / Diagnostics Drawer */}
        <Sidebar
          health={health}
          config={config}
          setFalKey={setFalKey}
          setModels={setModels}
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
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