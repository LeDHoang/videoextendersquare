import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { AccentBlock } from './primitives.jsx';

// Live requirements / cost / input-output panel for a CUSTOM(...) model.
// Pulls the model's real pricing + input/output schema from fal.ai via
// GET /api/config/model-info (cached hourly server-side) so the user can see
// what the pipeline will send, what comes back, and what it likely costs
// before spending money on an unlisted endpoint.
//
// When `onArgs` is provided the panel also becomes the editor for the model's
// settable inputs: enum dropdowns for output shape (aspect ratio, resolution)
// driven by the live schema, plus a JSON box for any other flat model args.
// It reports `{ args, ok, error }` up; the page submits `args` as
// custom_*_args. Only flat string/number/boolean pairs are sent — media URLs
// always come from the pipeline's own CDN upload.
const RESOLUTION_LIKE = ['resolution', 'target_resolution', 'output_resolution'];
const PIPELINE_PROVIDED = ['video_url', 'image_url', 'prompt'];

export default function CustomModelPanel({ model, kind = 'upscale', entry, onArgs }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [drop, setDrop] = useState({});
  const [touched, setTouched] = useState({});
  const [extraText, setExtraText] = useState('');
  const seededFor = useRef('');
  const lastSent = useRef('');

  const editable = typeof onArgs === 'function';

  useEffect(() => {
    if (!model) return undefined;
    let alive = true;
    setLoading(true);
    setError('');
    api
      .get('/api/config/model-info', { model, kind })
      .then((d) => alive && setInfo(d))
      .catch((e) => alive && setError(e.message || 'lookup failed'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [model, kind]);

  // Fresh editor state per model.
  useEffect(() => {
    setDrop({});
    setTouched({});
    setExtraText('');
    seededFor.current = '';
  }, [model]);

  const inputs = info?.inputs || [];
  const aspectField = inputs.find((r) => r.name === 'aspect_ratio') || null;
  const resField = inputs.find((r) => RESOLUTION_LIKE.includes(r.name)) || null;

  // Seed dropdowns from schema defaults once per model (user edits win).
  useEffect(() => {
    if (!editable || !info?.found || seededFor.current === model) return;
    seededFor.current = model;
    const next = {};
    for (const f of [aspectField, resField]) {
      if (f && f.default !== '' && (f.options || []).includes(f.default)) next[f.name] = f.default;
    }
    if (Object.keys(next).length) {
      setDrop((d) => ({ ...next, ...d }));
    }
  }, [editable, info, model, aspectField, resField]);

  const composed = useMemo(() => {
    let extra = {};
    let extraErr = '';
    if (extraText.trim()) {
      try {
        const parsed = JSON.parse(extraText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          extraErr = 'Additional args must be a JSON object, e.g. {"duration": 5}';
        } else {
          extra = parsed;
        }
      } catch {
        extraErr = 'Additional args is not valid JSON';
      }
    }
    const args = { ...extra, ...drop };
    const missing = (info?.found ? inputs.filter((r) => r.required) : [])
      .map((r) => r.name)
      .filter((n) => !PIPELINE_PROVIDED.includes(n) && args[n] === undefined);
    const err = extraErr || (missing.length ? `Required by model but not set: ${missing.join(', ')}` : '');
    return { args, ok: !err, error: err };
  }, [drop, extraText, info, inputs]);

  // Report up (guarded — onArgs triggers parent setState).
  useEffect(() => {
    if (!editable) return;
    const key = JSON.stringify(composed);
    if (lastSent.current !== key) {
      lastSent.current = key;
      onArgs(composed);
    }
  }, [editable, composed, onArgs]);

  const setArg = (name, val) => {
    setDrop((d) => ({ ...d, [name]: val }));
    setTouched((t) => ({ ...t, [name]: true }));
  };

  const renderField = (f, label) => {
    if (!f) return null;
    const opts = f.options || [];
    const val = drop[f.name] ?? '';
    return (
      <div>
        <label className="sx-label" htmlFor={`custom-${kind}-${f.name}`}>
          {label} ({f.name}){f.required ? ' *' : ''}
        </label>
        {opts.length ? (
          <select
            id={`custom-${kind}-${f.name}`}
            className="sx-select"
            value={val}
            onChange={(e) => setArg(f.name, e.target.value)}
          >
            <option value="">{f.required && !touched[f.name] ? '— PICK REQUIRED —' : '— MODEL DEFAULT —'}</option>
            {opts.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={`custom-${kind}-${f.name}`}
            className="sx-input"
            type="text"
            placeholder={f.default !== '' ? `Model default: ${f.default}` : f.type}
            value={val}
            onChange={(e) => setArg(f.name, e.target.value)}
          />
        )}
      </div>
    );
  };

  const slotInput = kind.startsWith('image') ? 'image_url' : 'video_url';
  const compat = info?.compatibility;
  const mismatch =
    info?.found && compat && slotInput === 'video_url'
      ? !compat.has_video_url
      : info?.found && compat && slotInput === 'image_url'
        ? !compat.has_image_url
        : false;

  const required = inputs.filter((r) => r.required);
  const optional = inputs.filter((r) => !r.required);
  const sentKeys = Object.keys(composed.args);

  return (
    <div className="sx-cost-panel" style={{ borderStyle: 'dashed' }}>
      <div className="sx-cost-head">
        <span className="sx-cost-title">
          {entry?.label || 'CUSTOM MODEL'} — MODEL INFO (LIVE FROM FAL.AI)
        </span>
        <span className="sx-cost-total" style={{ fontSize: '0.72rem', wordBreak: 'break-all' }}>
          {model}
        </span>
      </div>
      <div className="sx-cost-body">
        <div>
          • <b>Requirements:</b>{' '}
          {entry?.requirements || 'FAL_KEY set; source media uploaded to fal.ai CDN by the pipeline.'}
        </div>
        {entry?.cost_note ? (
          <div>
            • <b>Cost basis:</b> {entry.cost_note}
          </div>
        ) : null}
        {entry?.expects ? (
          <div>
            • <b>Pipeline sends:</b> {entry.expects}
          </div>
        ) : null}

        {loading ? <div>• ○ Pulling live schema + pricing from fal.ai…</div> : null}
        {error && !loading ? (
          <div>
            • <b>Live lookup failed:</b> {error} — showing estimates only. Check the id in
            MODEL ENDPOINTS and retry.
          </div>
        ) : null}

        {info && !loading ? (
          <>
            {info.found ? (
              <>
                {info.display_name ? (
                  <div>
                    • <b>fal.ai:</b> {info.display_name}
                    {info.category ? ` (${info.category})` : ''}
                    {info.description ? ` — ${info.description}` : ''}
                  </div>
                ) : null}
                {info.pricing ? (
                  <div>
                    • <b>Live pricing:</b> {info.pricing}
                  </div>
                ) : (
                  <div>• <b>Live pricing:</b> not published — see the playground link below.</div>
                )}
                {required.length ? (
                  <div>
                    • <b>Required inputs:</b>{' '}
                    {required
                      .map((r) => `${r.name} (${r.type}${r.default ? `, default ${r.default}` : ''})`)
                      .join(' · ')}
                  </div>
                ) : null}
                {optional.length ? (
                  <div>
                    • <b>Optional inputs:</b>{' '}
                    {optional
                      .slice(0, 12)
                      .map((r) => `${r.name} (${r.type}${r.default ? `, default ${r.default}` : ''})`)
                      .join(' · ')}
                    {optional.length > 12 ? ` · +${optional.length - 12} more` : ''}
                  </div>
                ) : null}
                {info.outputs?.length ? (
                  <div>
                    • <b>Expected outputs:</b>{' '}
                    {info.outputs.map((r) => `${r.name} (${r.type})`).join(' · ')}
                  </div>
                ) : null}
                {compat?.note ? (
                  <div>
                    • <b>Slot check:</b> {compat.note}
                  </div>
                ) : null}
                {info.playground_url ? (
                  <div>
                    • <b>Playground:</b>{' '}
                    <a href={info.playground_url} target="_blank" rel="noreferrer">
                      {info.playground_url}
                    </a>
                  </div>
                ) : null}
                <div className="sx-monospace-sm" style={{ fontSize: '0.7rem', opacity: 0.8 }}>
                  • <b>Source:</b> pulled live from fal.ai
                  {info.fetched_at
                    ? ` at ${new Date(info.fetched_at * 1000).toLocaleString()}${info.from_cache ? ' (server cache, refreshes hourly)' : ''}`
                    : ''}
                  . fal.ai may change its public schema endpoints without notice — if this panel
                  disagrees with the playground, the playground wins. Verify up-to-date
                  inputs/pricing at{' '}
                  <a href={info.playground_url || `https://fal.ai/models/${model}`} target="_blank" rel="noreferrer">
                    playground
                  </a>{' '}
                  ·{' '}
                  <a href="https://fal.ai/pricing" target="_blank" rel="noreferrer">
                    fal.ai/pricing
                  </a>
                  .
                </div>
              </>
            ) : (
              <>
                <div>
                  • <b>Not found on fal.ai:</b> {info.error || 'unknown id'} — the render will
                  likely fail. Verify the id on fal.ai/models.
                </div>
                <div className="sx-monospace-sm" style={{ fontSize: '0.7rem', opacity: 0.8 }}>
                  • Live lookup unavailable (fal.ai may have changed its public schema endpoints,
                  or the id is wrong) — values shown are pipeline estimates only. Check the
                  up-to-date schema/pricing at{' '}
                  <a href={`https://fal.ai/models/${model}`} target="_blank" rel="noreferrer">
                    fal.ai/models/{model}
                  </a>{' '}
                  ·{' '}
                  <a href="https://fal.ai/pricing" target="_blank" rel="noreferrer">
                    fal.ai/pricing
                  </a>
                  .
                </div>
              </>
            )}
          </>
        ) : null}
      </div>

      {editable && info?.found ? (
        <div style={{ marginTop: 'var(--sx-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sx-3)' }}>
          <div className="sx-cols sx-cols-2">
            {renderField(aspectField, 'ASPECT RATIO')}
            {renderField(resField, 'RESOLUTION')}
          </div>
          <div>
            <label className="sx-label" htmlFor={`custom-${kind}-extra`}>
              ADDITIONAL MODEL ARGS (JSON — OPTIONAL)
            </label>
            <textarea
              id={`custom-${kind}-extra`}
              className="sx-textarea"
              rows={2}
              placeholder='{"duration": 5}'
              value={extraText}
              onChange={(e) => setExtraText(e.target.value)}
            />
            <div className="sx-monospace-sm" style={{ fontSize: '0.72rem', marginTop: 2 }}>
              Flat key/value pairs only (string / number / boolean). Media URLs always come from
              your upload — setting them here has no effect.
            </div>
          </div>
          {composed.error ? (
            <div className="sx-monospace-sm" style={{ color: 'var(--sx-danger)', fontSize: '0.75rem' }}>
              ⚠ {composed.error} — render is blocked until this is fixed.
            </div>
          ) : (
            <div className="sx-monospace-sm" style={{ fontSize: '0.72rem' }}>
              Will send{sentKeys.length ? '' : ' (defaults only)'}: {sentKeys.length ? sentKeys.map((k) => `${k}=${JSON.stringify(composed.args[k])}`).join(' · ') : '—'}
            </div>
          )}
        </div>
      ) : null}

      {mismatch ? (
        <div style={{ marginTop: 'var(--sx-2)' }}>
          <AccentBlock
            tone="warn"
            title={`SCHEMA MISMATCH — NO ${slotInput.toUpperCase()} INPUT`}
            lines={[
              `This model has no '${slotInput}' input, but the pipeline always sends one. The job will very likely be rejected by fal.ai.`,
              'Pick a stock model, or use a custom model whose inputs include ' + slotInput + '.',
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}
