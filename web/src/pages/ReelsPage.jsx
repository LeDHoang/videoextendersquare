import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { Hero, Section, EmptyState, SpecRow, GatedReason, Mono, AccentBlock } from '../components/ui/primitives.jsx';
import { Pills, Button, Dropdown, Field } from '../components/ui/controls.jsx';
import ReelsPlayer from '../components/ui/ReelsPlayer.jsx';
import StudioLoading from '../components/ui/StudioLoading.jsx';

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
  // Deep-link support (Explore → Reels): ?folder&codec(h264|hevc|all)
  // &search&sort&play=<video path> preselects filters and starts the
  // player at that exact reel. `deepPlay` is consumed (cleared) as soon as
  // the user touches any filter so later refetches start at index 0.
  const [searchParams] = useSearchParams();
  const paramSort = searchParams.get('sort');
  const paramCodec = (searchParams.get('codec') || '').toLowerCase();
  const [data, setData] = useState(null);
  const [folder, setFolder] = useState(searchParams.get('folder') || 'testpipeline');
  const [codec, setCodec] = useState(
    paramCodec === 'h264' ? 'H264 (Browser/VR)' : paramCodec === 'all' ? 'ALL CODECS' : CODEC_DEFAULT,
  );
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [sort, setSort] = useState(
    ['newest', 'oldest', 'alphabetical', 'shuffle'].includes(paramSort) ? paramSort : 'newest',
  );
  const [deepPlay, setDeepPlay] = useState(() => searchParams.get('play'));

  // Re-sync when navigating Explore → Reels while already mounted (same
  // route, new query string — state initializers above don't re-run).
  useEffect(() => {
    const play = searchParams.get('play');
    if (play) {
      const f = searchParams.get('folder');
      if (f) setFolder(f);
      const c = (searchParams.get('codec') || '').toLowerCase();
      setCodec(c === 'h264' ? 'H264 (Browser/VR)' : c === 'all' ? 'ALL CODECS' : CODEC_DEFAULT);
      setSearch(searchParams.get('search') || '');
      const s = searchParams.get('sort');
      if (['newest', 'oldest', 'alphabetical', 'shuffle'].includes(s)) setSort(s);
      setDeepPlay(play);
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const [tunnel, setTunnel] = useState('');
  const [showTunnel, setShowTunnel] = useState(false);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyMsg, setProxyMsg] = useState('');
  const [spatJob, setSpatJob] = useState(null);
  const [spatMsg, setSpatMsg] = useState('');
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
        if (folder !== 'ALL FOLDERS' && !r.folders.includes(folder)) {
          setFolder(r.folders.includes('testpipeline') ? 'testpipeline' : r.folders[0] || 'ALL FOLDERS');
        }
      })
      .catch(() => setData({ total: 0, count: 0, folders: [], videos: [] }));
  }, [folder, codecParam, debouncedSearch, sort, refreshKey]);

  const videos = data?.videos || [];
  const deepIndex = deepPlay ? videos.findIndex((v) => v.path === deepPlay) : -1;
  const initialIndex = deepIndex >= 0 ? deepIndex : 0;
  const playerParams = {
    folder,
    codec: codecParam,
    search: debouncedSearch,
    sort,
    ...(tunnel ? { tunnel } : {}),
  };
  const videoOpts = videos.map((v) => ({
    value: v.path,
    label: v.title || v.filename,
    tag: `${v.size} · ${v.codec} · ${v.media_type === 'image' ? 'IMAGE' : v.is_proxy ? 'PROXY' : 'MASTER'}`,
  }));

  const generateProxy = async () => {
    setProxyBusy(true);
    setProxyMsg('');
    try {
      const r = await api.post('/api/reels/proxy', videos.filter((v) => v.media_type !== 'image').map((v) => v.path));
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
  const has3d = folders.includes('testpipeline-3d');

  const spatialize = async () => {
    if (spatJob) return;
    setSpatMsg('QUEUING LOCAL SPATIALIZATION…');
    try {
      const r = await api.post('/api/reels/spatialize', {});
      setSpatJob(r.job_id);
      setSpatMsg(`SPATIALIZING ${r.queued.length} CLIP(S) — DEPTH + STEREO WARP (LOCAL)…`);
    } catch (e) {
      setSpatMsg(`✗ ${String(e.message || e)}`);
    }
  };

  useEffect(() => {
    if (!spatJob) return undefined;
    const t = setInterval(async () => {
      try {
        const r = await api.get(`/api/reels/spatialize/jobs/${spatJob}`);
        if (r.messages?.length) setSpatMsg(r.messages[r.messages.length - 1]);
        if (r.status === 'complete') {
          clearInterval(t);
          setSpatJob(null);
          const n = r.result?.generated?.length || 0;
          const f = r.result?.failed?.length || 0;
          setSpatMsg(`✓ ${n} SBS MASTER(S) IN testpipeline-3d${f ? ` — ${f} failed` : ''}`);
          setRefreshKey((k) => k + 1);
        } else if (r.status === 'failed') {
          clearInterval(t);
          setSpatJob(null);
          setSpatMsg(`✗ SPATIALIZATION FAILED: ${r.error?.[0] || 'unknown error'}`);
        }
      } catch {
        /* transient poll error — keep polling */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [spatJob]);

  const folderOpts = [{ label: 'ALL FOLDERS', value: 'ALL FOLDERS' }, ...folders.map((f) => ({ label: f, value: f }))];
  const needsProxy = videos.filter((v) => v.media_type !== 'image' && codecParam !== 'hevc' && !v.is_proxy && v.codec !== 'H264').length;

  return (
    <div>
      <Hero title="REELS / VR PLAYER" kicker="ECHO · 1:1 SQUARE · VR HEADSET BROWSER · H.264 PROXIES">
        <div className="sx-stats-pill">
          <span>ITEMS: <strong>{data?.count ?? '—'}</strong> of {data?.total ?? '—'}</span>
          <span>FOLDERS: <strong>{(folders || []).length}</strong></span>
          <span>CODEC: <strong>{codecParam.toUpperCase()}</strong></span>
          <span>STATUS: <strong style={{ color: needsProxy ? 'var(--sx-warn)' : 'var(--sx-success)' }}>{needsProxy ? `${needsProxy} NEED PROXY` : 'READY'}</strong></span>
        </div>
      </Hero>

      {/* ─── Control Section (2 Rows: Filters + Utilities) ── */}
      <div className="sx-control-rail-stacked">
        {/* Row 1: Filters (Folder, Codec, Search, Sort) */}
        <div className="sx-control-rail-row">
          <div className="sx-control-group" style={{ flex: 1, flexWrap: 'wrap' }}>
            <div style={{ width: '180px', flexShrink: 0 }}>
              <Dropdown
                value={folder}
                options={folderOpts}
                onChange={(v) => { setDeepPlay(null); setFolder(v); }}
                placeholder="Target folder…"
              />
            </div>
            <Pills options={CODEC_OPTS} value={codec} onChange={(v) => { setDeepPlay(null); setCodec(v); }} />
            <div style={{ flex: 1, minWidth: '160px', position: 'relative' }}>
              <input
                ref={searchRef}
                className="sx-input"
                style={{ paddingRight: search ? '28px' : undefined }}
                placeholder="Search…"
                value={search}
                onChange={(e) => { setDeepPlay(null); setSearch(e.target.value); }}
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
            <div style={{ width: '140px', flexShrink: 0 }}>
              <Dropdown
                value={sort}
                options={SORTS}
                onChange={(v) => { setDeepPlay(null); setSort(v); }}
                placeholder="Sort by…"
              />
            </div>
          </div>
        </div>

        {/* Row 2: Actions & Utilities (Reset, Quest & Tools, Proxy, Spatialize) */}
        <div className="sx-control-rail-row">
          <div className="sx-control-group">
            <Button onClick={() => setRefreshKey((k) => k + 1)} title="Rescan video library">
              ↻
            </Button>
            <Button
              primary={showTunnel}
              onClick={() => setShowTunnel((s) => !s)}
            >
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
            {folder === 'testpipeline' && !has3d ? (
              <Button disabled={!!spatJob} loading={!!spatJob} onClick={spatialize}>
                🥽 Spatialize (2D→3D)
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {proxyMsg ? <Mono>{proxyMsg}</Mono> : null}
      {spatMsg ? <Mono>{spatMsg}</Mono> : null}

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
        <StudioLoading title="REELS" subtitle="AWAITING SEQUENCE INITIATION…" />
      ) : !videos.length ? (
        <EmptyState
          title="NO VIDEOS MATCH CURRENT FILTERS"
          text="Try adjusting the folder, codec filter, or search query — or render new videos from the Video page."
          hint={`folder="${folder}" codec="${codecParam}" search="${debouncedSearch}"`}
        />
      ) : (
        <div>
          {deepIndex >= 0 ? (
            <Mono>OPENED FROM EXPLORE — PLAYING {videos[deepIndex]?.filename} ({deepIndex + 1}/{videos.length})</Mono>
          ) : null}
          <ReelsPlayer params={playerParams} initialIndex={initialIndex} />
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