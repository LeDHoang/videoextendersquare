import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../hooks/AuthContext.jsx';
import { useWallet } from '../../hooks/WalletContext.jsx';
import { NavLink, Link } from 'react-router-dom';
import { Button, Field } from '../ui/controls.jsx';
import { hideDevTools } from '../../utils/devTools.js';
import { AnimatedEchoLogo } from '../icons/AnimatedEchoLogo.jsx';
import { IndustrialCreditsIcon } from '../icons/index.jsx';
import { SIDEBAR_NAV } from './nav.js';
import { useTheme } from '../../theme.js';

const MODEL_FIELDS = [
  { key: 'outpaint_vid', label: 'VIDEO OUTPAINT' },
  { key: 'upscale_vid', label: 'VIDEO UPSCALE (FAL)' },
  { key: 'outpaint_img', label: 'IMAGE OUTPAINT' },
  { key: 'upscale_img', label: 'IMAGE UPSCALE (FAL)' },
];

const FOCUSABLE = 'a[href], button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

export default function Sidebar({ health, config, setModels, isOpen, onClose }) {
  const showDevTools = !hideDevTools();
  const { user } = useAuth();
  const { wallet, falKey } = useWallet();
  const [theme, setTheme] = useTheme();
  const [modelDraft, setModelDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [modelMsg, setModelMsg] = useState('');
  const [modelErr, setModelErr] = useState('');
  const asideRef = useRef(null);

  // Close drawer on Escape
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Below 900px the drawer overlays the page: move focus in, keep Tab inside it, and hand focus back on close.
  useEffect(() => {
    if (!isOpen || !window.matchMedia?.('(max-width: 900px)').matches) return undefined;
    const opener = document.activeElement;
    // Everything the backdrop covers leaves the tab order and the accessibility tree while the drawer is open.
    // The header stays live: it sits above the backdrop and its menu button closes the drawer.
    const behind = Array.from(document.querySelectorAll('.sx-main, .sx-footer, .sx-message-launcher, .sx-message-dock'));
    behind.forEach((el) => { el.inert = true; });
    asideRef.current?.querySelector('.sx-sidebar-close-btn')?.focus();
    const onTab = (e) => {
      if (e.key !== 'Tab' || !asideRef.current) return;
      const stops = Array.from(asideRef.current.querySelectorAll(FOCUSABLE));
      if (!stops.length) return;
      const active = document.activeElement;
      const inside = asideRef.current.contains(active);
      if (e.shiftKey && (active === stops[0] || !inside)) {
        e.preventDefault();
        stops[stops.length - 1].focus();
      } else if (!e.shiftKey && (active === stops[stops.length - 1] || !inside)) {
        e.preventDefault();
        stops[0].focus();
      }
    };
    window.addEventListener('keydown', onTab);
    return () => {
      window.removeEventListener('keydown', onTab);
      behind.forEach((el) => { el.inert = false; });
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
  }, [isOpen]);

  const probes = health?.probes || {};
  const fal = health?.fal_key || {};
  const modelDefaults = config?.models || {};

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
    <aside ref={asideRef} className={`sx-sidebar ${isOpen ? 'sx-open' : ''}`} aria-label="Sidebar Controls">
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
        <Link to="/reels" className="sx-sidebar-brand-block" onClick={() => onClose?.()} title="ECHO Home" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
          <div className="sx-sidebar-hero-row">
            <AnimatedEchoLogo className="sx-sidebar-hero-logo" title="ECHO Logo" />
            <h2 className="sx-sidebar-hero-title">ECHO</h2>
          </div>
          {showDevTools ? <div className="sx-sidebar-hero-sub">TELEMETRY / V2.0</div> : null}
        </Link>
      </div>

      {/* ─── 2x2 Navigation Grid ────────────────────────────── */}
      <nav className="sx-sidebar-nav-grid" aria-label="Main App Navigation">
        {SIDEBAR_NAV.filter((item) => !item.adminOnly || user?.role === 'admin').map(({ to, label, Icon }) => (
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

      {/* ─── Colour Theme ─────────────────────────────────── */}
      <div className="sx-sidebar-theme">
        <span className="sx-sidebar-card-title">APPEARANCE</span>
        <button
          type="button"
          role="switch"
          aria-checked={theme === 'dark'}
          aria-label="Dark theme"
          className="sx-horizon"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          <span className="sx-horizon-stars" aria-hidden="true" />
          <span className="sx-horizon-sun" aria-hidden="true" />
          <span className="sx-horizon-moon" aria-hidden="true" />
          <span className="sx-horizon-label sx-horizon-day" aria-hidden="true">DAY</span>
          <span className="sx-horizon-label sx-horizon-night" aria-hidden="true">NIGHT</span>
        </button>
      </div>

      {/* ─── Account Billing Module ───────────────────────── */}
      <div className="sx-sidebar-card sx-sidebar-billing-card">
        <div className="sx-sidebar-card-head">
          <span className="sx-sidebar-card-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ color: 'var(--sx-accent)', verticalAlign: '-2px', marginRight: 6 }}>
              <path d="M13 2L4 14h6l-1 8 9-12h-6z" />
            </svg>
            ECHO CREDITS & KEY
          </span>
          <div className="sx-sidebar-status-pill">
            <span
              className={`sx-status-dot ${
                !user
                  ? 'sx-dot-offline'
                  : (wallet?.available_credits ?? 0) > 0 || falKey?.configured
                    ? 'sx-dot-online'
                    : 'sx-dot-warning'
              }`}
            />
            <span className="sx-sidebar-status-text">
              {!user
                ? 'GUEST'
                : (wallet?.available_credits ?? 0) > 0
                  ? 'ACTIVE'
                  : falKey?.configured
                    ? 'BYOK ACTIVE'
                    : '0 CREDITS'}
            </span>
          </div>
        </div>

        {/* Hero Credits Stat Box */}
        <div className="sx-sidebar-credits-hero">
          <div className="sx-sidebar-credits-left">
            <div className="sx-sidebar-credits-icon-wrap" aria-hidden="true">
              <IndustrialCreditsIcon className="sx-sidebar-icon-svg" />
            </div>
            <div className="sx-sidebar-credits-meta">
              <span className="sx-sidebar-credits-label">AVAILABLE</span>
              <span className="sx-sidebar-credits-sub">
                {user ? '$0.01 / CREDIT' : 'SIGN IN TO USE'}
              </span>
            </div>
          </div>
          <div className="sx-sidebar-credits-right">
            <span
              className={`sx-sidebar-credits-num ${
                user && (wallet?.available_credits ?? 0) > 0 ? 'sx-sidebar-credits-num--accent' : ''
              }`}
            >
              {user ? (wallet?.available_credits ?? 0).toLocaleString() : '—'}
            </span>
            <span className="sx-sidebar-credits-unit">CREDITS</span>
          </div>
        </div>

        {/* Personal FAL Key (BYOK) Status */}
        <div className="sx-sidebar-key-row">
          <span className="sx-sidebar-key-label">
            <span style={{ opacity: 0.65 }}>BYOK</span> FAL KEY
          </span>
          {falKey?.configured ? (
            <span
              className="sx-sidebar-key-badge sx-sidebar-key-badge--configured"
              title={`Personal key active (${falKey.hint || 'CONFIGURED'})`}
            >
              <span>✓</span> {falKey.hint || 'CONFIGURED'}
            </span>
          ) : (
            <span
              className="sx-sidebar-key-badge sx-sidebar-key-badge--none"
              title="Using shared platform credits pool"
            >
              SHARED POOL
            </span>
          )}
        </div>

        {/* Action Button */}
        <Link
          className="sx-sidebar-billing-btn"
          to={user ? '/wallet' : '/login?next=%2Fwallet'}
          onClick={() => onClose?.()}
        >
          <span>{user ? 'MANAGE CREDITS / KEY' : 'SIGN IN TO TOP UP'}</span>
          <span className="sx-btn-arrow" aria-hidden="true">↗</span>
        </Link>
      </div>

      {/* ─── System Probes Module ───────────────────────────── */}
      {showDevTools ? (
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
                <div key={p.id} className="sx-body" style={{ marginBottom: 8, fontSize: 'var(--sx-t-eyebrow)' }}>
                  <b style={{ color: 'var(--sx-ink)' }}>{p.label}</b> — {p.detail}
                  <div style={{ color: 'var(--sx-warn)', fontSize: 'var(--sx-t-eyebrow)', marginTop: 2 }}>
                    {p.fix}
                  </div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
      ) : null}

      {/* ─── Model Endpoints Customizer ─────────────────────── */}
      {user?.role === 'admin' ? (
      <details className="sx-sidebar-card sx-expander">
        <summary className="sx-sidebar-card-title" style={{ cursor: 'pointer', outline: 'none' }}>
          ▸ MODEL ENDPOINTS
        </summary>
        <div className="sx-expander-body" style={{ marginTop: 12 }}>
          <div className="sx-monospace-sm" style={{ marginBottom: 8 }}>
            Optional fal.ai id per slot — blank = stock. E.g. luma/agent/ray/v3.2/reframe
          </div>
          {MODEL_FIELDS.map(({ key, label }) => {
            const current = modelDraft[key] ?? modelDefaults[key] ?? '';
            const customLabel = customLabelFor((modelDefaults[key] || '').trim());
            return (
              <Field key={key} label={`${label}${customLabel ? ` · ${customLabel}` : ''}`}>
                <input
                  className="sx-input"
                  style={{ fontSize: 'var(--sx-t-eyebrow)', padding: '6px 10px' }}
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
            <div className="sx-monospace-sm" style={{ color: 'var(--sx-danger)' }}>
              {modelErr}
            </div>
          ) : null}
          {modelMsg ? (
            <div className="sx-monospace-sm" style={{ color: 'var(--sx-accent)' }}>
              {modelMsg}
            </div>
          ) : null}
          <div className="sx-sidebar-btn-grid" style={{ marginTop: 12 }}>
            <Button size="md" onClick={resetModels} disabled={saving}>
              RESET
            </Button>
            <Button variant="primary" size="md" onClick={saveModels} disabled={saving}>
              {saving ? 'SAVING…' : 'SAVE'}
            </Button>
          </div>
        </div>
      </details>
      ) : null}

      {/* ─── Telemetry Bottom Bar ───────────────────────────── */}
      {showDevTools ? (
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
      ) : null}
    </aside>
  );
}
