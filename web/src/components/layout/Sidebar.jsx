import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { Field } from '../ui/controls.jsx';
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

const MODEL_FIELDS = [
  { key: 'outpaint_vid', label: 'VIDEO OUTPAINT' },
  { key: 'upscale_vid', label: 'VIDEO UPSCALE (FAL)' },
  { key: 'outpaint_img', label: 'IMAGE OUTPAINT' },
  { key: 'upscale_img', label: 'IMAGE UPSCALE (FAL)' },
];

export default function Sidebar({ health, config, setFalKey, setModels, isOpen, onClose }) {
  const [keyVal, setKeyVal] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [keyMsg, setKeyMsg] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [modelDraft, setModelDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [modelMsg, setModelMsg] = useState('');
  const [modelErr, setModelErr] = useState('');

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
    setModelErr('');
    setModelMsg('');
    // Validate: every non-empty id must look like owner/name.
    for (const { key, label } of MODEL_FIELDS) {
      const v = (modelDraft[key] ?? modelDefaults[key] ?? '').trim();
      if (v && !v.includes('/')) {
        setModelErr(`${label}: expected a fal.ai id like owner/model-name (got "${v}")`);
        return;
      }
    }
    setSaving(true);
    try {
      const updates = Object.fromEntries(
        MODEL_FIELDS.map(({ key }) => [key, (modelDraft[key] ?? modelDefaults[key] ?? '').trim()]),
      );
      const res = await setModels(updates);
      const saved = res?.models || {};
      const customs = MODEL_FIELDS.filter(({ key }) => {
        const val = saved[key] || '';
        return val && (saved.video_outpaint_catalog || []).concat(
          saved.video_upscale_catalog || [], saved.image_upscale_catalog || [],
        ).some((e) => e.is_custom && e.model === val);
      });
      setModelDraft({});
      setModelMsg(
        customs.length
          ? `✓ SAVED — ${customs.map(({ label }) => label).join(', ')} now show CUSTOM buttons in the extenders (open MODEL INFO there for live pricing/schema).`
          : '✓ SAVED — extender model lists updated.',
      );
    } catch (e) {
      setModelErr(String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  const resetModels = async () => {
    setModelErr('');
    setModelMsg('');
    setSaving(true);
    try {
      await setModels(Object.fromEntries(MODEL_FIELDS.map(({ key }) => [key, ''])));
      setModelDraft({});
      setModelMsg('✓ RESET — all four slots back to stock models.');
    } catch (e) {
      setModelErr(String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  const allCatalogs = (modelDefaults.video_outpaint_catalog || []).concat(
    modelDefaults.video_upscale_catalog || [],
    modelDefaults.image_upscale_catalog || [],
  );
  const customLabelFor = (val) =>
    (allCatalogs.find((e) => e.is_custom && e.model === val) || {}).label || '';

  const probeList = Object.values(probes);
  const okCount = probeList.filter((p) => p.ok).length;
  const degraded = probeList.filter((p) => !p.ok);
  // Same severity priority as the header ENG pill: all ok → green; a blocking
  // probe down or half+ down → red; 1–2 degraded → yellow.
  const probesCritical = degraded.some((p) => p.severity === 'block');
  const probesColor =
    degraded.length === 0
      ? 'var(--sx-success)'
      : probesCritical || degraded.length * 2 >= probeList.length
        ? 'var(--sx-danger)'
        : 'var(--sx-warn)';
  const refreshing = health?.refreshing ?? false;
  const probing = !health || !health.probes;
  const refreshedAt = health?.refreshed_at;
  const fromCache = health?.from_cache;
  const refreshedLabel = refreshedAt
    ? `UPDATED ${new Date(refreshedAt * 1000).toLocaleTimeString()}${fromCache ? ' · CACHED' : ' · LIVE'}`
    : null;

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
          <div className="sx-sidebar-hero-row">
            <img src="/logo.svg" alt="ECHO Logo" className="sx-sidebar-hero-logo" />
            <h2 className="sx-sidebar-hero-title">ECHO</h2>
          </div>
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
          <span className="sx-sidebar-card-title">LIVE STATUS / ENG PROBES</span>
          <span className="sx-sidebar-status-count" style={{ color: probing ? undefined : probesColor }}>
            {probing ? 'PROBING…' : `${okCount}/${probeList.length || '—'} OK`}
          </span>
        </div>

        <div className="sx-sidebar-status-board">
          {probing ? (
            <div className="sx-sidebar-probe-row">
              <span className="sx-sidebar-probe-label">ENVIRONMENT</span>
              <span className="sx-sidebar-probe-val sx-val-warn">PROBING…</span>
            </div>
          ) : probeList.length === 0 ? (
            <div className="sx-sidebar-probe-row">
              <span className="sx-sidebar-probe-label">BACKEND</span>
              <span className="sx-sidebar-probe-val sx-val-err">UNREACHABLE</span>
            </div>
          ) : (
            probeList.map((p) => (
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
            ))
          )}
          <div className="sx-sidebar-probe-footer">
            <span className="sx-sidebar-probe-sub">
              {probing
                ? '○ PROBING ENVIRONMENT…'
                : probeList.length === 0
                  ? '⚠ HEALTH ENDPOINT UNREACHABLE'
                  : degraded.length === 0
                    ? '✓ ALL ENGINES OPERATIONAL'
                    : `⚠ ${degraded.length} ISSUE(S)`}
            </span>
            {refreshedLabel ? (
              <span
                className="sx-sidebar-probe-sub"
                style={{ display: 'block', marginTop: 2, opacity: 0.7 }}
              >
                {refreshing ? '↻ RE-PROBING NOW…' : refreshedLabel}
              </span>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          className="sx-sidebar-btn-recheck"
          onClick={() => health?.refresh?.()}
          disabled={refreshing || probing}
        >
          {refreshing ? '↻ RE-PROBING…' : '↻ RECHECK PROBES'}
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
          <div className="sx-monospace-sm" style={{ fontSize: '0.72rem', marginBottom: 8 }}>
            Optional fal.ai id per slot — blank = stock. E.g. luma/agent/ray/v3.2/reframe
          </div>
          {MODEL_FIELDS.map(({ key, label }) => {
            const current = modelDraft[key] ?? modelDefaults[key] ?? '';
            const customLabel = customLabelFor((modelDefaults[key] || '').trim());
            return (
              <Field key={key} label={`${label}${customLabel ? ` · ${customLabel}` : ''}`}>
                <input
                  className="sx-input"
                  style={{ fontSize: '0.75rem', padding: '6px 10px' }}
                  placeholder={modelDefaults[key] || ''}
                  value={current}
                  onChange={(e) => {
                    setModelDraft((m) => ({ ...m, [key]: e.target.value }));
                    setModelMsg('');
                    setModelErr('');
                  }}
                  autoComplete="off"
                  spellCheck="false"
                />
              </Field>
            );
          })}
          {modelErr ? (
            <div className="sx-monospace-sm" style={{ color: 'var(--sx-danger)', fontSize: '0.72rem' }}>
              {modelErr}
            </div>
          ) : null}
          {modelMsg ? (
            <div className="sx-monospace-sm" style={{ color: 'var(--sx-accent)', fontSize: '0.72rem' }}>
              {modelMsg}
            </div>
          ) : null}
          <div className="sx-sidebar-btn-grid" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="sx-sidebar-btn-secondary"
              onClick={resetModels}
              disabled={saving}
            >
              RESET
            </button>
            <button
              type="button"
              className="sx-sidebar-btn-primary"
              onClick={saveModels}
              disabled={saving}
            >
              {saving ? 'SAVING…' : 'SAVE'}
            </button>
          </div>
        </div>
      </details>

      {/* ─── Telemetry Bottom Bar ───────────────────────────── */}
      <div className="sx-sidebar-telemetry-bottom">
        <div className="sx-telemetry-col">
          <span className="sx-telemetry-key">PROBES_OK</span>
          <span className="sx-telemetry-val" style={{ color: 'var(--sx-ink)' }}>
            {probing ? '…' : `${okCount}/${probeList.length}`}
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