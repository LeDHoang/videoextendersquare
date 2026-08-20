import { useState, useEffect } from 'react';
import Nav from './Nav.jsx';
import { HealthDot } from '../ui/primitives.jsx';
import { Button, Field } from '../ui/controls.jsx';

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

  const saveModels = async () => {
    setSaving(true);
    try {
      await setModels(modelDraft);
    } finally {
      setSaving(false);
    }
  };

  const degraded = Object.values(probes).filter((p) => !p.ok);

  return (
    <aside className={`sx-sidebar ${isOpen ? 'sx-open' : ''}`} aria-label="Sidebar Controls">
      {/* Brand Identity */}
      <div className="sx-brand">
        <div className="sx-brand-icon">E</div>
        <div className="sx-brand-text">
          <span className="sx-brand-title">ECHO</span>
          <span className="sx-brand-tag">4K EXTENDER · v2.0</span>
        </div>
        {isOpen ? (
          <button
            type="button"
            className="sx-btn"
            style={{ marginLeft: 'auto', padding: '4px 8px', fontSize: '0.9rem' }}
            onClick={onClose}
            aria-label="Close Settings Drawer"
          >
            ✕
          </button>
        ) : null}
      </div>

      {/* Main Navigation */}
      <Nav onSelect={() => onClose?.()} />

      {/* FAL.AI API Key Section */}
      <div style={{ marginTop: 'var(--sx-3)' }}>
        <div className="sx-eyebrow">FAL.AI CLOUD KEY</div>
        <Field label="API KEY">
          <div style={{ display: 'flex', gap: '4px' }}>
            <input
              className="sx-input"
              type={showKey ? 'text' : 'password'}
              placeholder="fal_…"
              value={keyVal}
              onChange={(e) => setKeyVal(e.target.value)}
              autoComplete="off"
            />
            <button
              type="button"
              className="sx-btn"
              style={{ padding: '0 10px', fontSize: '0.8rem' }}
              onClick={() => setShowKey((s) => !s)}
              title={showKey ? 'Hide key' : 'Show key'}
              aria-label={showKey ? 'Hide key' : 'Show key'}
            >
              {showKey ? '🔒' : '👁'}
            </button>
          </div>
        </Field>

        <div style={{ marginTop: 'var(--sx-2)' }}>
          <HealthDot ok={fal.ok} severity="block" label="KEY" detail={fal.detail || 'not set'} />
        </div>

        {keyMsg ? (
          <div className="sx-monospace-sm" style={{ color: 'var(--sx-accent)', marginTop: 4 }}>
            {keyMsg}
          </div>
        ) : null}

        <div style={{ marginTop: 'var(--sx-2)', display: 'flex', gap: '8px' }}>
          <Button onClick={saveKey} disabled={keySaving || !keyVal.trim()}>
            {keySaving ? 'Saving…' : 'Save Key'}
          </Button>
          {fal.ok ? (
            <Button
              onClick={async () => {
                await setFalKey('');
                health?.refresh?.();
                setKeyMsg('KEY CLEARED');
              }}
              style={{ padding: 'var(--sx-2) var(--sx-3)' }}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      {/* System Health Section */}
      <div style={{ marginTop: 'var(--sx-3)' }}>
        <div className="sx-eyebrow">SYSTEM PROBES</div>
        {Object.values(probes).map((p) => (
          <HealthDot key={p.id} ok={p.ok} severity={p.severity} label={p.label} detail={p.detail} />
        ))}

        <div style={{ marginTop: 'var(--sx-2)' }}>
          <Button onClick={() => health?.refresh?.()}>↻ Recheck Probes</Button>
        </div>

        {degraded.length ? (
          <details className="sx-expander" open={false}>
            <summary>▸ {degraded.length} DEGRADED ISSUE(S)</summary>
            <div className="sx-expander-body">
              {degraded.map((p) => (
                <div key={p.id} className="sx-body" style={{ marginBottom: 10 }}>
                  <b style={{ color: 'var(--sx-ink)' }}>{p.label}</b> — {p.detail}
                  <div style={{ color: 'var(--sx-warn)', fontSize: '0.78rem', marginTop: 2 }}>{p.fix}</div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>

      {/* Model Endpoints Customizer */}
      <details className="sx-expander" style={{ marginTop: 'auto' }}>
        <summary>▸ MODEL ENDPOINTS</summary>
        <div className="sx-expander-body">
          {Object.keys(modelDefaults).map((key) => (
            <Field key={key} label={key}>
              <input
                className="sx-input"
                value={modelDraft[key] ?? modelDefaults[key] ?? ''}
                onChange={(e) => setModelDraft((m) => ({ ...m, [key]: e.target.value }))}
              />
            </Field>
          ))}
          <div style={{ marginTop: 'var(--sx-3)' }}>
            <Button onClick={saveModels} disabled={saving}>
              {saving ? 'Saving…' : 'Save Overrides'}
            </Button>
          </div>
        </div>
      </details>
    </aside>
  );
}