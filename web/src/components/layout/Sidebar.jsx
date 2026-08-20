import { useState } from 'react';
import Nav from './Nav.jsx';
import { HealthDot } from '../ui/primitives.jsx';
import { Button, Field } from '../ui/controls.jsx';

// setFalKey/setModels come from useConfig() (lifted to AppShell) so this
// writes through the same config state everything else reads — previously
// Sidebar called api.put(...) directly, bypassing useConfig's state and
// letting the two copies of "the fal key is set" desync.
export default function Sidebar({ health, config, setFalKey, setModels }) {
  const [keyVal, setKeyVal] = useState('');
  const [keyMsg, setKeyMsg] = useState('');
  const [modelDraft, setModelDraft] = useState({});
  const [saving, setSaving] = useState(false);

  const probes = health?.probes || {};
  const fal = health?.fal_key || {};
  const modelDefaults = config?.models || {};

  const saveKey = async () => {
    setKeyMsg('');
    try {
      const res = await setFalKey(keyVal);
      setKeyMsg(res.fal_key_set ? 'KEY SET' : 'KEY REMOVED');
      setKeyVal('');
      health?.refresh?.();
    } catch (e) {
      setKeyMsg(String(e.message || e));
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
    <aside className="sx-sidebar">
      <Nav />
      <div className="sx-eyebrow">FAL.AI KEY</div>
      <Field label="FAL.AI API KEY">
        <input
          className="sx-input"
          type="password"
          placeholder="fal_…"
          value={keyVal}
          onChange={(e) => setKeyVal(e.target.value)}
        />
      </Field>
      <HealthDot ok={fal.ok} severity="block" label="KEY" detail={fal.detail || 'not set'} />
      {keyMsg ? <div className="sx-monospace-sm" style={{ color: 'var(--sx-accent)', marginTop: 4 }}>{keyMsg}</div> : null}
      <div style={{ marginTop: 8 }}>
        <Button onClick={saveKey}>Save Key</Button>
      </div>

      <div className="sx-eyebrow">SYSTEM</div>
      {Object.values(probes).map((p) => (
        <HealthDot key={p.id} ok={p.ok} severity={p.severity} label={p.label} detail={p.detail} />
      ))}

      <div style={{ marginTop: 8 }}>
        <Button onClick={() => health?.refresh?.()}>↻ Recheck</Button>
      </div>

      {degraded.length ? (
        <details className="sx-expander" open={false}>
          <summary>▸ {degraded.length} ISSUE(S)</summary>
          <div className="sx-expander-body">
            {degraded.map((p) => (
              <div key={p.id} className="sx-body" style={{ marginBottom: 8 }}>
                <b>{p.label}</b> — {p.detail}
                <div style={{ color: 'var(--sx-ink-3)', fontSize: '0.8rem' }}>{p.fix}</div>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <details className="sx-expander">
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
          <div style={{ marginTop: 8 }}>
            <Button onClick={saveModels} disabled={saving}>
              {saving ? 'Saving…' : 'Save Models'}
            </Button>
          </div>
        </div>
      </details>
    </aside>
  );
}