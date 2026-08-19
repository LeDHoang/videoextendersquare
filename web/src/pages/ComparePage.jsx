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
      <Hero title="FAST vs STUDIO" kicker="A/B RENDER COMPARISON · LANCZOS4+CAS vs ZNEDI3" />

      <SpecRow
        cells={[
          ['PAIRS', String(data?.total ?? '—'), ''],
          ['COMPLETE', String(complete.length), 'A/B READY'],
          ['PARTIAL', String(partial.length), 'MISSING SIDE'],
        ]}
      />

      <Section num={1} title="Select Pair" active={data !== null}>
        {data === null ? (
          <Spinner />
        ) : !allPairs.length ? (
          <EmptyState
            title="NO PAIRS YET"
            text="Run a FAST and a STUDIO render of the same video — matching filenames are paired automatically in output/pairs."
            hint="output/pairs/NAME_fast.mp4 · NAME_studio.mp4"
          />
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 320px' }}>
                <Dropdown
                  label="PAIR"
                  value={selected}
                  onChange={setSelected}
                  placeholder="— SELECT PAIR —"
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
              <div style={{ flex: '1 1 320px' }}>
                <div className="sx-label">VIEW</div>
                <Segmented options={VIEWS} value={view} onChange={setView} />
              </div>
              <Button onClick={() => setRefreshKey((k) => k + 1)}>↻ Rescan</Button>
            </div>

            {pair ? (
              <div style={{ marginTop: 12 }}>
                {view === '◐ SLIDER' ? (
                  <iframe className="sx-frame" title="compare-player" src={iframe || undefined} allow="autoplay; fullscreen" />
                ) : prepErr ? (
                  <div className="sx-error-box">
                    <div className="sx-error-title">ERROR</div>
                    <div>{prepErr}</div>
                  </div>
                ) : !prep ? (
                  <Spinner />
                ) : prep.mode === 'download' ? (
                  <div>
                    <Eyebrow>DOWNLOAD RENDERS</Eyebrow>
                    <Mono>{prep.fast_url}</Mono>
                    <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                      <a className="sx-download" href={prep.fast_url} download>
                        ↓ FAST · LANCZOS4 + CAS
                      </a>
                      <a className="sx-download" href={prep.studio_url} download>
                        ↓ STUDIO · ZNEDI3
                      </a>
                    </div>
                    <div className="sx-body" style={{ marginTop: 12 }}>
                      Master files live in output/pairs/. Download works for H.264 + HEVC; HEVC masters are not
                      browser-playable, so below are the H.264 proxies when present.
                    </div>
                  </div>
                ) : (
                  <div>
                    <Eyebrow>2-UP COMPARISON — FAST vs STUDIO</Eyebrow>
                    <div className="sx-cols sx-cols-2">
                      <div>
                        <div className="sx-eyebrow">FAST · LANCZOS4 + CAS</div>
                        <video className="sx-video" src={prep.fast_url} controls playsInline />
                      </div>
                      <div>
                        <div className="sx-eyebrow">STUDIO · ZNEDI3</div>
                        <video className="sx-video" src={prep.studio_url} controls playsInline />
                      </div>
                    </div>
                  </div>
                )}
                {pair.complete ? null : <GatedReason>INCOMPLETE PAIR — RE-RUN BOTH ENGINES TO ENABLE FULL A/B COMPARISON</GatedReason>}
              </div>
            ) : null}
          </>
        )}
      </Section>
    </div>
  );
}