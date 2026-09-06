import { useEffect, useState } from 'react';
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
  const [isVrActive, setIsVrActive] = useState(false);
  const [isFsActive, setIsFsActive] = useState(false);

  // ── VR / Fullscreen immersive detection (Reels only) ──
  useEffect(() => {
    const onVrEnter = () => setIsVrActive(true);
    const onVrExit = () => setIsVrActive(false);
    const onVrChange = (e) => {
      if (e && e.detail && typeof e.detail.inVR === 'boolean') setIsVrActive(e.detail.inVR);
    };
    const onFsEnter = () => setIsFsActive(true);
    const onFsExit = () => setIsFsActive(false);
    const onFsChange = () => {
      const el = document.fullscreenElement || document.webkitFullscreenElement;
      const isReelsFs =
        !!el &&
        (el.id === 'reelsFrame' ||
          el.id === 'sxReelsRoot' ||
          (el.closest && (el.closest('#sxReelsRoot') || el.closest('#reelsFrame'))) ||
          (el.querySelector && (el.querySelector('#reelsFrame') || el.querySelector('#sxReelsRoot'))));
      setIsFsActive(isReelsFs);
    };
    window.addEventListener('echo:vr-enter', onVrEnter);
    window.addEventListener('echo:vr-exit', onVrExit);
    window.addEventListener('echo:vrchange', onVrChange);
    window.addEventListener('echo:fullscreen-enter', onFsEnter);
    window.addEventListener('echo:fullscreen-exit', onFsExit);
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return () => {
      window.removeEventListener('echo:vr-enter', onVrEnter);
      window.removeEventListener('echo:vr-exit', onVrExit);
      window.removeEventListener('echo:vrchange', onVrChange);
      window.removeEventListener('echo:fullscreen-enter', onFsEnter);
      window.removeEventListener('echo:fullscreen-exit', onFsExit);
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }, []);

  const isReelsRoute = location.pathname === '/reels';
  const immersive = isReelsRoute && (isVrActive || isFsActive);

  // Keep html/body class in sync so pure-CSS fallback also hides chrome
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    if (immersive) {
      root.classList.add('sx-vr-active');
      body.classList.add('sx-vr-active');
    } else {
      // Only clear if not in a transient VR state that webxr_vr.js also manages;
      // immersive already reflects the true state so safe to remove.
      root.classList.remove('sx-vr-active');
      body.classList.remove('sx-vr-active');
    }
  }, [immersive]);

  // Close immersive chrome when navigating away from /reels while fullscreen
  useEffect(() => {
    if (!isReelsRoute && document.fullscreenElement) {
      // Let fullscreen persist but header will re-appear via `immersive` flag
    }
  }, [isReelsRoute]);

  return (
    <>
      {/* Accessible Skip Link */}
      <a href="#main-content" className="sx-skip-link">
        Skip to main content
      </a>

      {/* Global High-Density Utility Top Bar — auto-hidden in Reels immersive VR / fullscreen */}
      <HeaderBar onToggleSidebar={() => setDrawerOpen((prev) => !prev)} hidden={immersive} />

      {/* Main Grid Shell */}
      <div
        className={`sx-shell ${drawerOpen ? 'sx-sidebar-open' : ''} ${immersive ? 'sx-immersive' : ''}`}
        style={{ minHeight: immersive ? '100dvh' : 'calc(100dvh - 64px)' }}
      >
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