import { useState, useEffect, useRef } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useHealthContext } from '../../hooks/HealthContext.jsx';

export default function HeaderBar({ onToggleSidebar, hidden = false }) {
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
      } else if (q.includes('upload') || q.includes('post') || q.includes('share') || q.includes('publish')) {
        navigate('/upload');
      } else if (q.includes('explor') || q.includes('galler') || q.includes('browse')) {
        navigate('/explore');
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
  const okCount = probes.filter((p) => p.ok).length;
  const missing = probes.filter((p) => !p.ok);
  // Severity priority: all ok → green; a blocking (render-gating) probe down
  // or half+ down → red; anything else (1–2 degraded) → yellow.
  const critical = missing.some((p) => p.severity === 'block');
  const engColor = !probes.length
    ? 'var(--sx-ink)'
    : missing.length === 0
      ? 'var(--sx-success)'
      : critical || missing.length * 2 >= probes.length
        ? 'var(--sx-danger)'
        : 'var(--sx-warn)';
  const falMissing = health?.fal_key == null;
  const falOk = health?.fal_key?.ok;
  const sys = health?.system || {};
  const memVal =
    sys.total_gb != null && sys.used_gb != null
      ? `${sys.used_gb}/${sys.total_gb}GB`
      : sys.total_gb != null
        ? `${sys.total_gb}GB`
        : '—';

  return (
    <header
      className={`sx-top-bar ${hidden ? 'sx-top-bar--hidden' : ''}`}
      aria-hidden={hidden ? 'true' : undefined}
      style={hidden ? { pointerEvents: 'none' } : undefined}
    >
      {/* ─── Left: Sidebar Toggle, Branding & Routes ─────── */}
      <div className="sx-top-left">
        <button
          type="button"
          className="sx-icon-btn"
          onClick={onToggleSidebar}
          title="Open/Close Sidebar"
          aria-label="Toggle Sidebar"
        >
          <span style={{ fontSize: '1.14rem', lineHeight: 1 }}>☰</span>
        </button>
        <NavLink to="/reels" className="sx-top-brand" title="ECHO 4K Engine">
          <img src="/logo.svg" alt="ECHO Logo" className="sx-top-logo" />
          <span>ECHO</span>
        </NavLink>

        <nav className="sx-top-nav" aria-label="Global Routes">
          <NavLink
            to="/reels"
            className={({ isActive }) => `sx-top-link ${isActive ? 'sx-active' : ''}`}
          >
            REELS/VR
          </NavLink>
          <NavLink
            to="/explore"
            className={({ isActive }) => `sx-top-link ${isActive ? 'sx-active' : ''}`}
          >
            EXPLORE
          </NavLink>
          <NavLink
            to="/upload"
            className={({ isActive }) => `sx-top-link ${isActive ? 'sx-active' : ''}`}
          >
            UPLOAD
          </NavLink>
          <NavLink
            to="/compare"
            className={({ isActive }) => `sx-top-link ${isActive ? 'sx-active' : ''}`}
          >
            COMPARE
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
            <span className="sx-tel-k">FAL</span>
            <span
              className="sx-tel-v"
              style={{ color: falMissing ? 'var(--sx-ink)' : falOk ? 'var(--sx-success)' : 'var(--sx-danger)' }}
            >
              {falMissing ? '…' : falOk ? 'AUTHED' : 'UNAUTHED'}
            </span>
          </div>
          <div className="sx-telemetry-item">
            <span className="sx-tel-k">ENG</span>
            <span
              className="sx-tel-v"
              style={{ color: engColor }}
            >
              {probes.length ? `${okCount}/${probes.length} OK` : '…'}
            </span>
          </div>
          <div className="sx-telemetry-item" title={sys.gpu || undefined}>
            <span className="sx-tel-k">{sys.label || 'VRAM'}</span>
            <span className="sx-tel-v">{memVal}</span>
          </div>
        </div>

        {/* Primary Action Button — opens the Upload page */}
        <button
          type="button"
          className="sx-top-action-btn"
          onClick={() => {
            if (location.pathname !== '/upload') navigate('/upload');
          }}
          title="Open the Upload page"
        >
          UPLOAD
        </button>
      </div>
    </header>
  );
}
