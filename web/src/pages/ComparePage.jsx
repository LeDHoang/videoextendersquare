import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { Hero, Section, SpecRow, EmptyState, Eyebrow, GatedReason, Mono } from '../components/ui/primitives.jsx';
import { Button, Spinner, Segmented, Dropdown } from '../components/ui/controls.jsx';

const VIEWS = ['◐ SLIDER', '▦ 2-UP', '↓ DOWNLOAD'];

export default function ComparePage() {
  const [data, setData] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState('');
  const [view, setView] = useState('◐ SLIDER');
  const [iframe, setIframe] = useState(null);
  const [prep, setPrep] = useState(null);
  const [prepErr, setPrepErr] = useState('');

  useEffect(() => {
    api
      .get('/api/compare', { refresh: refreshKey > 0 })
      .then((d) => {
        setData(d);
        const all = [...(d.complete || []), ...(d.partial || [])];
        if (!all.length) return;
        setSelected((cur) => (cur && all.some((p) => p.name === cur) ? cur : all[0].name));
      })
      .catch(() => setData({ total: 0, complete: [], partial: [] }));
  }, [refreshKey]);

  const allPairs = useMemo(
    () => [...(data?.complete || []), ...(data?.partial || [])],
    [data],
  );
  const pair = allPairs.find((p) => p.name === selected);

  useEffect(() => {
    if (!pair) return;
    setPrep(null);
    setPrepErr('');
    if (view === '◐ SLIDER') {
      setIframe(`/api/compare/player?pair=${encodeURIComponent(pair.name)}`);
    } else if (view === '▦ 2-UP') {
      setIframe(null);
      api.get('/api/compare/prepare', { pair: pair.name }).then(setPrep).catch((e) => setPrepErr(String(e.message || e)));
    } else {
      setIframe(null);
      api.get('/api/compare/prepare', { pair: pair.name })
        .then((r) => setPrep({ ...r, mode: 'download' }))
        .catch((e) => setPrepErr(String(e.message || e)));
    }
  }, [pair, view]);

  const complete = data?.complete || [];
  const partial = data?.partial || [];

  return (
    <div>
      <div className="sx-compact-header">
        <div>
          <h1 className="sx-compact-title">FAST vs STUDIO</h1>
          <div className="sx-compact-kicker">
            ECHO · A/B RENDER COMPARISON · LANCZOS4+CAS vs ZNEDI3 NEURAL
          </div>
        </div>
        <div className="sx-stats-pill">
          <span>PAIRED: <strong>{data?.total ?? '—'}</strong></span>
          <span>A/B READY: <strong style={{ color: 'var(--sx-success)' }}>{complete.length}</strong></span>
          <span>PARTIAL: <strong style={{ color: partial.length ? 'var(--sx-warn)' : 'var(--sx-ink-3)' }}>{partial.length}</strong></span>
        </div>
      </div>

      <div>
        {data === null ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Spinner />
            <span className="sx-mono">SCANNING OUTPUT DIRECTORY FOR RENDER PAIRS…</span>
          </div>
        ) : !allPairs.length ? (
          <EmptyState
            title="NO RENDER PAIRS FOUND"
            text="Run both a FAST and a STUDIO render of the same video — matching filenames are automatically paired in output/pairs."
            hint="Expected format: output/pairs/NAME_fast.mp4 & NAME_studio.mp4"
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sx-4)' }}>
            <div style={{ display: 'flex', gap: 'var(--sx-4)', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <div style={{ flex: '1 1 320px' }}>
                <Dropdown
                  label="RENDER PAIR"
                  value={selected}
                  onChange={setSelected}
                  placeholder="— SELECT PAIR TO INSPECT —"
                  options={[
                    ...complete.map((p) => ({
                      value: p.name,
                      label: p.name,
                      tag: 'A/B READY',
                    })),
                    ...partial.map((p) => ({
                      value: p.name,
                      label: p.name,
                      tag: p.fast ? 'FAST ONLY' : 'STUDIO ONLY',
                    })),
                  ]}
                />
              </div>
              <div style={{ flex: '0 0 auto' }}>
                <div className="sx-label">COMPARISON MODE</div>
                <Segmented options={VIEWS} value={view} onChange={setView} ariaLabel="Comparison Mode" />
              </div>
              <Button onClick={() => setRefreshKey((k) => k + 1)}>↻ Rescan Pairs</Button>
            </div>

            {pair ? (
              <div style={{ marginTop: 'var(--sx-2)' }}>
                {view === '◐ SLIDER' ? (
                  <iframe
                    className="sx-frame"
                    title="A/B Video Slider Comparison"
                    src={iframe || undefined}
                    allow="autoplay; fullscreen"
                  />
                ) : prepErr ? (
                  <div className="sx-error-box" role="alert">
                    <div className="sx-error-title">PREPARATION ERROR</div>
                    <div>{prepErr}</div>
                  </div>
                ) : !prep ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20 }}>
                    <Spinner />
                    <span className="sx-mono">PREPARING MEDIA FOR 2-UP COMPARISON…</span>
                  </div>
                ) : prep.mode === 'download' ? (
                  <div className="sx-accent-block">
                    <div className="sx-accent-block-title">DOWNLOAD MASTER RENDERS</div>
                    <Mono>{prep.fast_url}</Mono>
                    <div style={{ display: 'flex', gap: 'var(--sx-3)', marginTop: 'var(--sx-3)', flexWrap: 'wrap' }}>
                      <a className="sx-download" href={prep.fast_url} download>
                        ↓ DOWNLOAD FAST · LANCZOS4 + CAS
                      </a>
                      <a className="sx-download" href={prep.studio_url} download>
                        ↓ DOWNLOAD STUDIO · ZNEDI3
                      </a>
                    </div>
                    <p className="sx-body" style={{ marginTop: 'var(--sx-3)', fontSize: '0.85rem' }}>
                      Master 4K 1:1 files reside in <code>output/pairs/</code>. Downloads preserve original HEVC master quality.
                    </p>
                  </div>
                ) : (
                  <div>
                    <Eyebrow>2-UP SIDE-BY-SIDE COMPARISON</Eyebrow>
                    <div className="sx-cols sx-cols-2" style={{ marginTop: 'var(--sx-2)' }}>
                      <div className="sx-pair-card">
                        <div className="sx-eyebrow" style={{ color: 'var(--sx-accent)' }}>FAST · LANCZOS4 + CAS</div>
                        <video className="sx-video" src={prep.fast_url} controls playsInline aria-label="Fast render video" />
                      </div>
                      <div className="sx-pair-card">
                        <div className="sx-eyebrow" style={{ color: 'var(--sx-info-hi)' }}>STUDIO · ZNEDI3</div>
                        <video className="sx-video" src={prep.studio_url} controls playsInline aria-label="Studio render video" />
                      </div>
                    </div>
                  </div>
                )}
                {!pair.complete ? (
                  <GatedReason>INCOMPLETE PAIR — RUN BOTH ENGINES ON THIS FILE TO UNLOCK FULL A/B SLIDER</GatedReason>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}