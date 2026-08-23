import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import Emoji from '../ui/Emoji.jsx';
import { Button, Field } from '../ui/controls.jsx';
import {
  IndustrialImageIcon,
  IndustrialVideoIcon,
  IndustrialCompareIcon,
  IndustrialReelsIcon,
} from '../ui/StitchIcons.jsx';

const NAV_ITEMS = [
  { to: '/image', label: 'Image', Icon: IndustrialImageIcon },
  { to: '/video', label: 'Video', Icon: IndustrialVideoIcon },
  { to: '/compare', label: 'Compare', Icon: IndustrialCompareIcon },
  { to: '/reels', label: 'Reels/VR', Icon: IndustrialReelsIcon },
];

export default function Sidebar({ health, config, setFalKey, setModels, isOpen, onClose }) {
  const [keyVal, setKeyVal] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [keyMsg, setKeyMsg] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [modelDraft, setModelDraft] = useState({});
  const [saving, setSaving] = useState(false);

  // Close drawer on Escape
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const probes = health?.probes || {};
  const fal = health?.fal_key || {};
  const modelDefaults = config?.models || {};

  const saveKey = async () => {
    setKeyMsg('');
    setKeySaving(true);
    try {
      const res = await setFalKey(keyVal);
      setKeyMsg(res.fal_key_set ? '✓ KEY SAVED' : 'KEY REMOVED');
      setKeyVal('');
      health?.refresh?.();
    } catch (e) {
      setKeyMsg(String(e.message || e));
    } finally {
      setKeySaving(false);
    }
  };

  const clearKey = async () => {
    await setFalKey('');
    health?.refresh?.();
    setKeyMsg('KEY CLEARED');
  };

  const saveModels = async () => {
    setSaving(true);
    try {
      await setModels(modelDraft);
    } finally {
      setSaving(false);
    }
  };

  const probeList = Object.values(probes);
  const okCount = probeList.filter((p) => p.ok).length;
  const degraded = probeList.filter((p) => !p.ok);

  return (
    <aside className={`sx-sidebar ${isOpen ? 'sx-open' : ''}`} aria-label="Sidebar Controls">
      {/* ─── Command Center Header ──────────────────────────── */}
      <div className="sx-sidebar-header">
        {isOpen ? (
          <button
            type="button"
            className="sx-sidebar-close-btn"
            onClick={onClose}
            aria-label="Close Settings Drawer"
            title="Close Settings"
          >
            ✕
          </button>
        ) : null}
        <div className="sx-sidebar-brand-block">
          <h2 className="sx-sidebar-hero-title">ECHO</h2>
          <div className="sx-sidebar-hero-sub">TELEMETRY / V2.0</div>
        </div>
      </div>

      {/* ─── 2x2 Navigation Grid ────────────────────────────── */}
      <nav className="sx-sidebar-nav-grid" aria-label="Main App Navigation">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={() => onClose?.()}
            className={({ isActive }) =>
              `sx-sidebar-nav-card ${isActive ? 'sx-active' : ''}`
            }
          >
            <Icon className="sx-sidebar-icon-svg" />
            <span className="sx-sidebar-nav-label">
              {label}
            </span>
          </NavLink>
        ))}
      </nav>

      {/* ─── FAL.AI Auth Module ─────────────────────────────── */}
      <div className="sx-sidebar-card">
        <div className="sx-sidebar-card-head">
          <span className="sx-sidebar-card-title">FAL.AI AUTH</span>
          <div className="sx-sidebar-status-pill">
            <span
              className={`sx-status-dot ${fal.ok ? 'sx-dot-online' : 'sx-dot-offline'}`}
            />
            <span className="sx-sidebar-status-text">
              {fal.ok ? 'ONLINE' : 'OFFLINE'}
            </span>
          </div>
        </div>

        <div className="sx-sidebar-key-input-wrap">
          <input
            className="sx-input sx-sidebar-key-input"
            type={showKey ? 'text' : 'password'}
            placeholder="Enter FAL key..."
            value={keyVal}
            onChange={(e) => setKeyVal(e.target.value)}
            autoComplete="off"
          />
          <button
            type="button"
            className="sx-sidebar-key-toggle-btn"
            onClick={() => setShowKey((s) => !s)}
            title={showKey ? 'Hide key' : 'Show key'}
            aria-label={showKey ? 'Hide key' : 'Show key'}
          >
            {showKey ? '🔒' : '👁'}
          </button>
        </div>

        {fal.detail ? (
          <div className="sx-sidebar-key-preview">
            <span className="sx-sidebar-key-badge">KEY</span>
            <span className="sx-sidebar-key-val">{fal.detail}</span>
          </div>
        ) : null}

        {keyMsg ? (
          <div className="sx-monospace-sm" style={{ color: 'var(--sx-accent)', fontSize: '0.72rem' }}>
            {keyMsg}
          </div>
        ) : null}

        <div className="sx-sidebar-btn-grid">
          <button
            type="button"
            className="sx-sidebar-btn-secondary"
            onClick={clearKey}
            disabled={!fal.ok && !keyVal}
          >
            CLEAR
          </button>
          <button
            type="button"
            className="sx-sidebar-btn-primary"
            onClick={saveKey}
            disabled={keySaving || !keyVal.trim()}
          >
            {keySaving ? 'SAVING…' : 'SAVE'}
          </button>
        </div>
      </div>

      {/* ─── System Probes Module ───────────────────────────── */}
      <div className="sx-sidebar-card">
        <div className="sx-sidebar-card-head">
          <span className="sx-sidebar-card-title">LIVE STATUS / PROBES</span>
          <span className="sx-sidebar-status-count">
            {okCount}/{probeList.length || '—'} OK
          </span>
        </div>

        <div className="sx-sidebar-status-board">
          {probeList.map((p) => (
            <div key={p.id} className="sx-sidebar-probe-row">
              <span className="sx-sidebar-probe-label">{p.label}</span>
              <span
                className={`sx-sidebar-probe-val ${
                  p.ok ? 'sx-val-ok' : p.severity === 'block' ? 'sx-val-err' : 'sx-val-warn'
                }`}
              >
                {p.detail || (p.ok ? 'OK' : 'FAIL')}
              </span>
            </div>
          ))}
          <div className="sx-sidebar-probe-footer">
            <span className="sx-sidebar-probe-sub">
              {degraded.length === 0 ? '✓ ALL ENGINES OPERATIONAL' : `⚠ ${degraded.length} ISSUE(S)`}
            </span>
          </div>
        </div>

        <button
          type="button"
          className="sx-sidebar-btn-recheck"
          onClick={() => health?.refresh?.()}
        >
          ↻ RECHECK PROBES
        </button>

        {degraded.length > 0 ? (
          <details className="sx-expander" open={false}>
            <summary>▸ {degraded.length} DEGRADED ISSUE(S)</summary>
            <div className="sx-expander-body">
              {degraded.map((p) => (
                <div key={p.id} className="sx-body" style={{ marginBottom: 8, fontSize: '0.8rem' }}>
                  <b style={{ color: 'var(--sx-ink)' }}>{p.label}</b> — {p.detail}
                  <div style={{ color: 'var(--sx-warn)', fontSize: '0.75rem', marginTop: 2 }}>
                    {p.fix}
                  </div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>

      {/* ─── Model Endpoints Customizer ─────────────────────── */}
      <details className="sx-sidebar-card sx-expander">
        <summary className="sx-sidebar-card-title" style={{ cursor: 'pointer', outline: 'none' }}>
          ▸ MODEL ENDPOINTS
        </summary>
        <div className="sx-expander-body" style={{ marginTop: 12 }}>
          {Object.keys(modelDefaults).map((key) => (
            <Field key={key} label={key}>
              <input
                className="sx-input"
                style={{ fontSize: '0.75rem', padding: '6px 10px' }}
                value={modelDraft[key] ?? modelDefaults[key] ?? ''}
                onChange={(e) => setModelDraft((m) => ({ ...m, [key]: e.target.value }))}
              />
            </Field>
          ))}
          <div style={{ marginTop: 12 }}>
            <Button onClick={saveModels} disabled={saving} style={{ width: '100%' }}>
              {saving ? 'Saving…' : 'Save Overrides'}
            </Button>
          </div>
        </div>
      </details>

      {/* ─── Telemetry Bottom Bar ───────────────────────────── */}
      <div className="sx-sidebar-telemetry-bottom">
        <div className="sx-telemetry-col">
          <span className="sx-telemetry-key">PROBES_OK</span>
          <span className="sx-telemetry-val" style={{ color: 'var(--sx-ink)' }}>
            {okCount}/{probeList.length}
          </span>
        </div>
        <div className="sx-telemetry-col">
          <span className="sx-telemetry-key">ENGINE_STATUS</span>
          <span className="sx-telemetry-val" style={{ color: 'var(--sx-accent)' }}>
            {fal.ok ? 'ONLINE' : 'LOCAL'}
          </span>
        </div>
      </div>
    </aside>
  );
}