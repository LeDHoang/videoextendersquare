import { useState, useEffect, useRef } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useHealthContext } from '../../hooks/HealthContext.jsx';

export default function HeaderBar({ onOpenSettings }) {
  const health = useHealthContext();
  const location = useLocation();
  const navigate = useNavigate();
  const searchInputRef = useRef(null);
  const [searchVal, setSearchVal] = useState('');

  // Global CMD+K / CTRL+K keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSearchSubmit = (e) => {
    if (e.key === 'Enter' && searchVal.trim()) {
      const q = searchVal.trim().toLowerCase();
      if (q.includes('comp') || q.includes('ab') || q.includes('diff')) {
        navigate('/compare');
      } else if (q.includes('reel') || q.includes('vr') || q.includes('quest') || q.includes('3d')) {
        navigate('/reels');
      } else if (q.includes('vid') || q.includes('ext')) {
        navigate('/video');
      } else if (q.includes('img') || q.includes('photo') || q.includes('pic')) {
        navigate('/image');
      }
      setSearchVal('');
      searchInputRef.current?.blur();
    }
  };

  const probes = Object.values(health?.probes || {});
  const systemOk = probes.length > 0 && probes.every((p) => p.ok);
  const falOk = health?.fal_key?.ok;

  return (
    <header className="sx-top-bar">
      {/* ─── Left: Branding & Routes ──────────────────────── */}
      <div className="sx-top-left">
        <NavLink to="/image" className="sx-top-brand" title="ECHO 4K Engine">
          <img src="/logo.png" alt="ECHO Logo" className="sx-top-logo" />
          <span>ECHO</span>
        </NavLink>

        <nav className="sx-top-nav" aria-label="Global Routes">
          <NavLink
            to="/video"
            className={({ isActive }) => `sx-top-link ${isActive ? 'sx-active' : ''}`}
          >
            EXTENDER
          </NavLink>
          <NavLink
            to="/image"
            className={({ isActive }) => `sx-top-link ${isActive ? 'sx-active' : ''}`}
          >
            STUDIO
          </NavLink>
          <NavLink
            to="/compare"
            className={({ isActive }) => `sx-top-link ${isActive ? 'sx-active' : ''}`}
          >
            COMPARE
          </NavLink>
          <NavLink
            to="/reels"
            className={({ isActive }) => `sx-top-link ${isActive ? 'sx-active' : ''}`}
          >
            REELS
          </NavLink>
        </nav>
      </div>

      {/* ─── Center: Command Search Bar ───────────────────── */}
      <div className="sx-top-center">
        <div className="sx-command-box">
          <span className="sx-command-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={searchInputRef}
            type="text"
            className="sx-command-input"
            placeholder="CMD+K TO SEARCH..."
            value={searchVal}
            onChange={(e) => setSearchVal(e.target.value)}
            onKeyDown={handleSearchSubmit}
            aria-label="Global quick search command input"
          />
          <div className="sx-command-kbd">
            <span>⌘</span>
            <span>K</span>
          </div>
        </div>
      </div>

      {/* ─── Right: Telemetry & Actions ───────────────────── */}
      <div className="sx-top-right">
        {/* Telemetry Pill */}
        <div className="sx-top-telemetry">
          <div className="sx-telemetry-item">
            <span className="sx-tel-k">FPS</span>
            <span className="sx-tel-v" style={{ color: 'var(--sx-accent)' }}>
              120
            </span>
          </div>
          <div className="sx-telemetry-item">
            <span className="sx-tel-k">ENG</span>
            <span
              className="sx-tel-v"
              style={{ color: systemOk ? 'var(--sx-ink)' : 'var(--sx-danger)' }}
            >
              {systemOk ? 'ONLINE' : 'ALERT'}
            </span>
          </div>
          <div className="sx-telemetry-item">
            <span className="sx-tel-k">VRAM</span>
            <span className="sx-tel-v">14.2GB</span>
          </div>
        </div>

        {/* Primary Action Button */}
        <button
          type="button"
          className="sx-top-action-btn"
          onClick={() => {
            if (location.pathname === '/compare') {
              window.dispatchEvent(new CustomEvent('echo:trigger-action', { detail: 'compare' }));
            } else if (location.pathname === '/reels') {
              window.dispatchEvent(new CustomEvent('echo:trigger-action', { detail: 'reels' }));
            } else {
              window.dispatchEvent(new CustomEvent('echo:trigger-action', { detail: 'process' }));
            }
          }}
          title="Trigger Pipeline Process / Execution"
        >
          PROCESS
        </button>

        {/* Settings / Config Drawer Toggle */}
        <div className="sx-top-icons">
          <button
            type="button"
            className="sx-icon-btn"
            onClick={onOpenSettings}
            title="System Settings & Hardware Diagnostics"
            aria-label="Open Hardware Diagnostics & Configuration"
          >
            ⚙
          </button>
          <button
            type="button"
            className="sx-icon-btn"
            onClick={onOpenSettings}
            title={falOk ? 'FAL.AI Connected' : 'FAL.AI Key Required'}
            aria-label="Account and Cloud Status"
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: falOk ? 'var(--sx-success)' : 'var(--sx-warn)',
                display: 'inline-block',
              }}
            />
          </button>
        </div>
      </div>
    </header>
  );
}
