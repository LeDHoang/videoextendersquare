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
      <div className="sx-compact-header">
        <div>
          <h1 className="sx-compact-title">REELS / VR PLAYER</h1>
          <div className="sx-compact-kicker">
            ECHO · 1:1 SQUARE · VR HEADSET BROWSER · H.264 PROXIES
          </div>
        </div>
        <div className="sx-stats-pill">
          <span>VIDEOS: <strong>{data?.count ?? '—'}</strong> of {data?.total ?? '—'}</span>
          <span>FOLDERS: <strong>{(folders || []).length}</strong></span>
          <span>CODEC: <strong>{codecParam.toUpperCase()}</strong></span>
          <span>STATUS: <strong style={{ color: needsProxy ? 'var(--sx-warn)' : 'var(--sx-success)' }}>{needsProxy ? `${needsProxy} NEED PROXY` : 'READY'}</strong></span>
        </div>
      </div>

      {/* Toolbar */}
      <div className="sx-toolbar">
        <div className="sx-toolbar-group">
          <div style={{ width: '160px' }}>
            <Dropdown
              value={folder}
              options={folderOpts}
              onChange={setFolder}
              placeholder="Target folder…"
            />
          </div>
          <Pills options={CODEC_OPTS} value={codec} onChange={setCodec} />
          <div style={{ width: '150px', position: 'relative' }}>
            <input
              ref={searchRef}
              className="sx-input"
              style={{ paddingRight: search ? '28px' : undefined }}
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search ? (
              <button
                type="button"
                className="sx-search-clear"
                onClick={() => setSearch('')}
                aria-label="Clear search filter"
              >
                ✕
              </button>
            ) : null}
          </div>
          <div style={{ width: '120px' }}>
            <Dropdown
              value={sort}
              options={SORTS}
              onChange={setSort}
              placeholder="Sort by…"
            />
          </div>
        </div>
        <div className="sx-toolbar-group">
          <Button onClick={() => setRefreshKey((k) => k + 1)}>↻</Button>
          <Button onClick={() => setShowTunnel((s) => !s)}>
            {showTunnel ? '▾ Hide Tools' : '▸ Quest & Tools'}
          </Button>
          {needsProxy ? (
            <Button
              primary
              disabled={proxyBusy}
              loading={proxyBusy}
              onClick={generateProxy}
            >
              {proxyBusy ? '…' : `▶ Proxy (${needsProxy})`}
            </Button>
          ) : null}
        </div>
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

      {/* Player Mount */}
      {data === null ? (
        <div className="sx-mono">SCANNING OUTPUT MEDIA REPOSITORY…</div>
      ) : !videos.length ? (
        <EmptyState
          title="NO VIDEOS MATCH CURRENT FILTERS"
          text="Try adjusting the folder, codec filter, or search query — or render new videos from the Video page."
          hint={`folder="${folder}" codec="${codecParam}" search="${debouncedSearch}"`}
        />
      ) : (
        <div>
          <ReelsPlayer params={playerParams} />
          {videos.some((v) => v.tunnel_url) ? (
            <GatedReason>TUNNEL ACTIVE — META QUEST WILL STREAM DIRECTLY OVER SECURE PROXY</GatedReason>
          ) : null}
        </div>
      )}

      {videos.length > 0 ? (
        <Section num={2} title="Video Playlist" active>
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
        </Section>
      ) : null}
    </div>
  );
}