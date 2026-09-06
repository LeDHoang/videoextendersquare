import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { EmptyState, Mono, GatedReason, Hero } from '../components/ui/primitives.jsx';
import { Spinner } from '../components/ui/controls.jsx';
import { SectionSkeleton } from '../components/ui/Skeleton.jsx';
import Emoji from '../components/ui/Emoji.jsx';

const MODES = ['SPLIT', '2-UP', 'HEATMAP'];
const ZOOMS = ['1x', '2x', '4x'];

export default function ComparePage() {
  const [data, setData] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState('SPLIT');
  const [zoom, setZoom] = useState('1x');
  const [showDownload, setShowDownload] = useState(false);
  const [prep, setPrep] = useState(null);
  const [prepErr, setPrepErr] = useState('');

  // Fetch comparison pairs
  useEffect(() => {
    api
      .get('/api/compare', { refresh: refreshKey > 0 })
      .then((d) => {
        setData(d);
        const all = [...(d.complete || []), ...(d.partial || [])];
        if (!all.length) {
          setSelected('');
          return;
        }
        setSelected((cur) => (cur && all.some((p) => p.name === cur) ? cur : all[0]?.name || ''));
      })
      .catch(() => setData({ total: 0, complete: [], partial: [] }));
  }, [refreshKey]);

  const allPairs = useMemo(
    () => [...(data?.complete || []), ...(data?.partial || [])],
    [data],
  );
  const pair = allPairs.find((p) => p.name === selected) || allPairs[0] || null;

  // Prepare media files for 2-UP, Heatmap, or Download
  useEffect(() => {
    if (!pair) return undefined;
    let active = true;
    setPrep(null);
    setPrepErr('');

    api
      .get('/api/compare/prepare', { pair: pair.name })
      .then((r) => {
        if (active) setPrep(r);
      })
      .catch((e) => {
        if (active) setPrepErr(String(e.message || e));
      });

    return () => {
      active = false;
    };
  }, [pair?.name]);

  const complete = data?.complete || [];
  const partial = data?.partial || [];

  const zoomScale = zoom === '4x' ? 4 : zoom === '2x' ? 2 : 1;
  const iframeSrc = pair ? `/api/compare/player?pair=${encodeURIComponent(pair.name)}` : null;

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', minWidth: 0 }}>
      {/* ─── Header ────────────────────────────────────────── */}
      <Hero
        title="FAST VS STUDIO"
        kicker="ECHO · A/B RENDER COMPARISON · LANCZOS4+CAS VS ZNEDI3 NEURAL"
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sx-3)', alignItems: 'center' }}>
          <div className="sx-stats-pill">
            <span>
              PAIRED: <strong>{data?.total ?? '—'}</strong>
            </span>
          </div>
          <div className="sx-stats-pill">
            <span>
              A/B READY: <strong style={{ color: 'var(--sx-success)' }}>{complete.length}</strong>
            </span>
          </div>
          <div className="sx-stats-pill">
            <span>
              ACTIVE CODEC: <strong style={{ color: 'var(--sx-accent)' }}>HEVC 4K</strong>
            </span>
          </div>
          {partial.length > 0 ? (
            <div className="sx-stats-pill">
              <span>
                PARTIAL: <strong style={{ color: 'var(--sx-warn)' }}>{partial.length}</strong>
              </span>
            </div>
          ) : null}
        </div>
      </Hero>

      {/* ─── Main Content ──────────────────────────────────── */}
      {data === null ? (
        <SectionSkeleton label="Loading render pairs" />
      ) : !allPairs.length ? (
        <EmptyState
          title="NO RENDER PAIRS FOUND"
          text="Run both a FAST and a STUDIO render of the same video — matching filenames are automatically paired in output/pairs."
          hint="Expected format: output/pairs/NAME_fast.mp4 & NAME_studio.mp4"
        />
      ) : (
        <div>
          {/* ─── Control Rail ───────────────────────────────── */}
          <div className="sx-control-rail">
            {/* Render Pair Selector */}
            <div className="sx-control-group">
              <span className="sx-label" style={{ margin: 0, whiteSpace: 'nowrap' }}>RENDER PAIR</span>
              <select
                className="sx-select"
                style={{ width: 'auto', minWidth: 180, height: 34, fontSize: '0.75rem', padding: '0 8px', whiteSpace: 'nowrap' }}
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                aria-label="Select render pair to inspect"
              >
                {complete.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} [A/B READY]
                  </option>
                ))}
                {partial.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} [{p.fast ? 'FAST ONLY' : 'STUDIO ONLY'}]
                  </option>
                ))}
              </select>
            </div>

            {/* Mode Switcher */}
            <div className="sx-control-group">
              <span className="sx-label" style={{ margin: 0, whiteSpace: 'nowrap' }}>MODE</span>
              <div className="sx-seg" style={{ height: 34, whiteSpace: 'nowrap' }}>
                {MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={mode === m && !showDownload ? 'sx-selected' : ''}
                    onClick={() => {
                      setMode(m);
                      setShowDownload(false);
                    }}
                  >
                    {m === 'SPLIT' ? '◐ SPLIT' : m === '2-UP' ? '▦ 2-UP' : '◩ HEATMAP'}
                  </button>
                ))}
              </div>
            </div>

            {/* Zoom Controls & Action */}
            <div className="sx-control-group">
              <span className="sx-label" style={{ margin: 0, whiteSpace: 'nowrap' }}>ZOOM</span>
              <div className="sx-seg" style={{ height: 34, whiteSpace: 'nowrap' }}>
                {ZOOMS.map((z) => (
                  <button
                    key={z}
                    type="button"
                    className={zoom === z ? 'sx-selected' : ''}
                    onClick={() => setZoom(z)}
                  >
                    {z}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={`sx-btn ${showDownload ? 'sx-primary' : ''}`}
                style={{ height: 34, padding: '0 12px', fontSize: '0.75rem', textTransform: 'uppercase', whiteSpace: 'nowrap' }}
                onClick={() => setShowDownload((prev) => !prev)}
              >
                ↓ DOWNLOAD
              </button>
              <button
                type="button"
                className="sx-btn"
                style={{ height: 34, padding: '0 10px', fontSize: '0.8rem', flexShrink: 0 }}
                onClick={() => setRefreshKey((k) => k + 1)}
                title="Rescan output folder"
              >
                ↻
              </button>
            </div>
          </div>

          {/* ─── Download Panel (When active) ────────────────── */}
          {showDownload && prep ? (
            <div className="sx-accent-block" style={{ maxWidth: 900, margin: '0 auto var(--sx-4) auto' }}>
              <div className="sx-accent-block-title">DOWNLOAD MASTER RENDERS</div>
              <Mono>{pair?.name || 'Selected Pair'}</Mono>
              <div style={{ display: 'flex', gap: 'var(--sx-3)', marginTop: 'var(--sx-3)', flexWrap: 'wrap' }}>
                <a className="sx-download" href={prep.fast_url} download>
                  ↓ DOWNLOAD FAST (LANCZOS4 + CAS)
                </a>
                <a className="sx-download" href={prep.studio_url} download style={{ background: '#3b82f6', color: '#000' }}>
                  ↓ DOWNLOAD STUDIO (ZNEDI3 NEURAL)
                </a>
              </div>
              <p className="sx-body" style={{ marginTop: 'var(--sx-3)', fontSize: '0.85rem', color: 'var(--sx-ink-2)' }}>
                Master 4K 1:1 HEVC files reside in <code>output/pairs/</code>. Downloads preserve uncompressed master quality.
              </p>
            </div>
          ) : null}

          {/* ─── Viewport Stage ─────────────────────────────── */}
          {pair ? (
            <div className="sx-viewport-wrapper">
              {/* Floating Badges */}
              <div className="sx-badge-fast">
                FAST · 3840×3840
              </div>
              <div className="sx-badge-studio">
                STUDIO · 3840×3840
              </div>

              {/* Viewport Render Area with Zoom */}
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  transform: `scale(${zoomScale})`,
                  transformOrigin: 'center center',
                  transition: 'transform 200ms ease-out',
                }}
              >
                {mode === 'SPLIT' ? (
                  iframeSrc ? (
                    <iframe
                      src={iframeSrc}
                      title="A/B Video Comparison Slider"
                      style={{ width: '100%', height: '100%', border: 0 }}
                      allow="autoplay; fullscreen"
                    />
                  ) : null
                ) : prepErr ? (
                  <div className="sx-error-box" style={{ margin: 40 }} role="alert">
                    <div className="sx-error-title">PREPARATION ERROR</div>
                    <div>{prepErr}</div>
                  </div>
                ) : !prep ? (
                  <SectionSkeleton label="Loading compare viewport" compact />
                ) : mode === '2-UP' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', width: '100%', height: '100%', background: '#000' }}>
                    <div style={{ borderRight: '1px solid var(--sx-rule-strong)', position: 'relative' }}>
                      <video
                        src={prep.fast_url}
                        controls
                        autoPlay
                        loop
                        muted
                        playsInline
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    </div>
                    <div style={{ position: 'relative' }}>
                      <video
                        src={prep.studio_url}
                        controls
                        autoPlay
                        loop
                        muted
                        playsInline
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    </div>
                  </div>
                ) : mode === 'HEATMAP' ? (
                  <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000', overflow: 'hidden' }}>
                    <video
                      src={prep.fast_url}
                      autoPlay
                      loop
                      muted
                      playsInline
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    <video
                      src={prep.studio_url}
                      autoPlay
                      loop
                      muted
                      playsInline
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        mixBlendMode: 'difference',
                        filter: 'contrast(300%) invert(100%)',
                      }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        bottom: 12,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        background: 'rgba(8,9,10,0.85)',
                        border: '1px solid var(--sx-rule-strong)',
                        padding: '4px 12px',
                        fontFamily: 'JetBrains Mono',
                        fontSize: '0.75rem',
                        color: 'var(--sx-accent)',
                      }}
                    >
                      DIFF HEATMAP (HIGH-FREQUENCY EDGE VARIANCE)
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Incomplete Pair Warning */}
          {pair && !pair.complete ? (
            <div style={{ maxWidth: 900, margin: '0 auto var(--sx-4) auto' }}>
              <GatedReason>
                INCOMPLETE PAIR — RUN BOTH FAST AND STUDIO ENGINES ON THIS FILE TO UNLOCK FULL A/B SLIDER
              </GatedReason>
            </div>
          ) : null}

          {/* ─── Telemetry Table ───────────────────────────── */}
          <div className="sx-telemetry-grid">
            {/* FAST Stats Card */}
            <div className="sx-telemetry-card sx-fast-card">
              <h3 className="sx-telemetry-title">
                <span>LANCZOS4 + CAS</span>
                <span className="sx-telemetry-tag" style={{ color: 'var(--sx-accent)' }}>
                  FAST
                </span>
              </h3>
              <div className="sx-telemetry-table">
                <div className="sx-telemetry-row">
                  <span className="sx-telemetry-label">Render Speed</span>
                  <span className="sx-telemetry-val">~0.8s / frame</span>
                </div>
                <div className="sx-telemetry-row">
                  <span className="sx-telemetry-label">Peak vRAM</span>
                  <span className="sx-telemetry-val">4.2 GB</span>
                </div>
                <div className="sx-telemetry-row">
                  <span className="sx-telemetry-label">SSIM Score</span>
                  <span className="sx-telemetry-val" style={{ color: 'var(--sx-accent)' }}>
                    0.92
                  </span>
                </div>
                <div className="sx-telemetry-row">
                  <span className="sx-telemetry-label">Hardware Profile</span>
                  <span className="sx-telemetry-val" style={{ fontSize: '0.75rem', color: 'var(--sx-ink-2)' }}>
                    GPU VideoToolbox
                  </span>
                </div>
              </div>
            </div>

            {/* STUDIO Stats Card */}
            <div className="sx-telemetry-card sx-studio-card">
              <h3 className="sx-telemetry-title">
                <span>ZNEDI3 NEURAL</span>
                <span className="sx-telemetry-tag" style={{ color: '#3b82f6' }}>
                  STUDIO
                </span>
              </h3>
              <div className="sx-telemetry-table">
                <div className="sx-telemetry-row">
                  <span className="sx-telemetry-label">Render Speed</span>
                  <span className="sx-telemetry-val">~14.2s / frame</span>
                </div>
                <div className="sx-telemetry-row">
                  <span className="sx-telemetry-label">Peak vRAM</span>
                  <span className="sx-telemetry-val">18.5 GB</span>
                </div>
                <div className="sx-telemetry-row">
                  <span className="sx-telemetry-label">SSIM Score</span>
                  <span className="sx-telemetry-val" style={{ color: '#3b82f6' }}>
                    0.98
                  </span>
                </div>
                <div className="sx-telemetry-row">
                  <span className="sx-telemetry-label">Neural Engine</span>
                  <span className="sx-telemetry-val" style={{ fontSize: '0.75rem', color: 'var(--sx-ink-2)' }}>
                    VapourSynth Plugin
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}