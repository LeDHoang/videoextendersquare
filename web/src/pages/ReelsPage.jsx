import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { Hero, Section, EmptyState, SpecRow, GatedReason, Mono, AccentBlock } from '../components/ui/primitives.jsx';
import { Pills, Button, Dropdown, Field } from '../components/ui/controls.jsx';
import ReelsPlayer from '../components/ui/ReelsPlayer.jsx';

const SORTS = [
  { label: 'NEWEST', value: 'newest' },
  { label: 'OLDEST', value: 'oldest' },
  { label: 'A→Z', value: 'alphabetical' },
  { label: 'SHUFFLE', value: 'shuffle' },
];
const CODEC_DEFAULT = 'HEVC 4K (Raw Master)';
const CODEC_OPTS = [
  { label: CODEC_DEFAULT, value: CODEC_DEFAULT },
  { label: 'H264 (Browser/VR)', value: 'H264 (Browser/VR)' },
  { label: 'ALL CODECS', value: 'ALL CODECS' },
];

export default function ReelsPage() {
  const [data, setData] = useState(null);
  const [folder, setFolder] = useState('testpipeline');
  const [codec, setCodec] = useState(CODEC_DEFAULT);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [tunnel, setTunnel] = useState('');
  const [showTunnel, setShowTunnel] = useState(false);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyMsg, setProxyMsg] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const codecParam =
    codec === 'ALL CODECS' ? 'all' : codec === 'H264 (Browser/VR)' ? 'h264' : 'hevc';

  useEffect(() => {
    api
      .get('/api/reels', {
        folder,
        codec: codecParam,
        search: debouncedSearch,
        sort,
        refresh: refreshKey > 0,
      })
      .then((r) => {
        setData(r);
        if (!r.folders.includes(folder)) {
          setFolder(r.folders.includes('testpipeline') ? 'testpipeline' : r.folders[0] || 'ALL FOLDERS');
        }
      })
      .catch(() => setData({ total: 0, count: 0, folders: [], videos: [] }));
  }, [folder, codecParam, debouncedSearch, sort, refreshKey]);

  const videos = data?.videos || [];
  const playerParams = {
    folder,
    codec: codecParam,
    search: debouncedSearch,
    sort,
    ...(tunnel ? { tunnel } : {}),
  };
  const videoOpts = videos.map((v) => ({
    value: v.path,
    label: v.filename,
    tag: `${v.size} · ${v.codec} · ${v.is_proxy ? 'PROXY' : 'MASTER'}`,
  }));

  const generateProxy = async () => {
    setProxyBusy(true);
    setProxyMsg('');
    try {
      const r = await api.post('/api/reels/proxy', videos.map((v) => v.path));
      const n = r.generated.length;
      setProxyMsg(
        n
          ? `✓ ${n} H.264 PROXY(IES) GENERATED${r.failed.length ? ` — ${r.failed.length} failed` : ''}`
          : `NO PROXIES GENERATED${r.failed.length ? ` — ${r.failed.length} failed` : ''}`,
      );
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setProxyMsg(String(e.message || e));
    } finally {
      setProxyBusy(false);
    }
  };

  const folders = data?.folders || [];
  const folderOpts = [{ label: 'ALL FOLDERS', value: 'ALL FOLDERS' }, ...folders.map((f) => ({ label: f, value: f }))];
  const needsProxy = videos.filter((v) => codecParam !== 'hevc' && !v.is_proxy && v.codec !== 'H264').length;

  return (
    <div>
      <Hero title="Reels / VR Player" kicker="LIBRARY BROWSER · 1:1 SQUARE · VR HEADSET PLAYER · H.264 PROXIES" />

      <SpecRow
        cells={[
          ['VIDEO FILES', String(data?.count ?? '—'), `of ${String(data?.total ?? '—')} in library`],
          ['FOLDERS', String((folders || []).length), 'OUTPUT DIRECTORIES'],
          ['CODEC VIEW', codecParam.toUpperCase(), codecParam === 'hevc' ? 'RAW MASTER' : 'BROWSER READY'],
          ['PLAYBACK READY', needsProxy ? `${needsProxy} NEED PROXY` : 'ALL COMPATIBLE', ''],
        ]}
      />

      <Section num={1} title="Filter Library" active>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sx-4)' }}>
          <div className="sx-cols sx-cols-2">
            <div>
              <div className="sx-label">TARGET FOLDER</div>
              <Pills options={folderOpts} value={folder} onChange={setFolder} />
            </div>
            <div>
              <div className="sx-label">CODEC FILTER</div>
              <Pills options={CODEC_OPTS} value={codec} onChange={setCodec} />
            </div>
          </div>

          <div className="sx-cols sx-cols-2">
            <Field label="SEARCH FILENAMES">
              <div style={{ display: 'flex', gap: '4px' }}>
                <input
                  ref={searchRef}
                  className="sx-input"
                  placeholder="Filter by keyword / filename…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search ? (
                  <button
                    type="button"
                    className="sx-btn"
                    style={{ padding: '0 12px' }}
                    onClick={() => setSearch('')}
                    aria-label="Clear search filter"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            </Field>
            <div>
              <div className="sx-label">SORT ORDER</div>
              <Pills options={SORTS} value={sort} onChange={setSort} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 'var(--sx-3)', flexWrap: 'wrap', alignItems: 'center' }}>
            <Button onClick={() => setRefreshKey((k) => k + 1)}>↻ Rescan Library</Button>
            <Button onClick={() => setShowTunnel((s) => !s)}>
              {showTunnel ? '▾ HIDE TUNNEL' : '▸ QUEST HTTPS TUNNEL'}
            </Button>
            <Button
              primary
              disabled={proxyBusy || !needsProxy}
              loading={proxyBusy}
              onClick={generateProxy}
            >
              {proxyBusy ? 'Generating H.264 Proxies…' : `▶ GENERATE ${needsProxy || ''} H.264 PROXY(IES)`}
            </Button>
          </div>

          {proxyMsg ? <Mono>{proxyMsg}</Mono> : null}

          {showTunnel ? (
            <AccentBlock
              title="META QUEST 3 / VR HTTPS TUNNEL"
              lines={[
                'To view 4K Square reels in Meta Quest 3 Browser over Wi-Fi, pass your secure HTTPS tunnel URL below.',
              ]}
              code={['npx localtunnel --port 8000', '# or: ngrok http 8000']}
            >
              <div style={{ marginTop: 'var(--sx-3)' }}>
                <Field label="TUNNEL URL (e.g. https://your-tunnel.loca.lt)">
                  <input
                    className="sx-input"
                    placeholder="https://your-tunnel.dev"
                    value={tunnel}
                    onChange={(e) => setTunnel(e.target.value)}
                  />
                </Field>
              </div>
            </AccentBlock>
          ) : null}
        </div>
      </Section>

      <Section num={2} title="Video Library" active={data !== null}>
        {data === null ? (
          <div className="sx-mono">SCANNING OUTPUT MEDIA REPOSITORY…</div>
        ) : videos.length === 0 ? (
          <EmptyState
            title="NO VIDEOS MATCH CURRENT FILTERS"
            text="Try adjusting the folder, codec filter, or search query — or render new videos from the Video page."
            hint={`folder="${folder}" codec="${codecParam}" search="${debouncedSearch}"`}
          />
        ) : (
          <div>
            <Dropdown
              label={`MATCHING PLAYLIST (${videos.length} VIDEOS)`}
              value={videoOpts[0]?.value ?? ''}
              options={videoOpts}
              onChange={() => {}}
              placeholder={`${videos.length} video(s) in playlist — inspect files`}
            />
            <p className="sx-body" style={{ marginTop: 'var(--sx-2)', fontSize: '0.85rem' }}>
              {needsProxy
                ? `⚠ ${needsProxy} video(s) in this list require an H.264 proxy for inline browser playback.`
                : '✓ All files are compatible with standard HTML5 browser & VR playback.'}
            </p>
          </div>
        )}
      </Section>

      <Section num={3} title="VR & Inline Reels Player" active={videos.length > 0}>
        {!videos.length ? (
          <EmptyState
            title="AWAITING VIDEO PLAYLIST"
            text="The Reels player will automatically mount once videos match your active filter criteria."
          />
        ) : (
          <div>
            <ReelsPlayer params={playerParams} />
            {videos.some((v) => v.tunnel_url) ? (
              <GatedReason>TUNNEL ACTIVE — META QUEST WILL STREAM DIRECTLY OVER SECURE PROXY</GatedReason>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  );
}