import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { Hero, Section, EmptyState, SpecRow, GatedReason, Mono } from '../components/ui/primitives.jsx';
import { Pills, Button, Dropdown } from '../components/ui/controls.jsx';
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
      <Hero title="Reels / VR Player" kicker="OUTPUT BROWSER · VR PLAYER · H.264 PROXIES" />

      <SpecRow
        cells={[
          ['FILES', String(data?.count ?? '—'), `of ${String(data?.total ?? '—')} total`],
          ['FOLDERS', String((folders || []).length), ''],
          ['CODEVIEW', codecParam.toUpperCase(), ''],
          ['PLAYBACK', needsProxy ? `${needsProxy} NEED PROXY` : 'ALL OK', ''],
        ]}
      />

      <Section num={1} title="Filter Library" active>
        <div className="sx-cols sx-cols-2">
          <div>
            <div className="sx-label">FOLDER</div>
            <Pills options={folderOpts} value={folder} onChange={setFolder} />
          </div>
          <div>
            <div className="sx-label">CODEC</div>
            <Pills options={CODEC_OPTS} value={codec} onChange={setCodec} />
          </div>
        </div>

        <div className="sx-cols sx-cols-2">
          <div>
            <div className="sx-label">SEARCH</div>
            <input
              ref={searchRef}
              className="sx-input"
              placeholder="Filter filenames…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div>
            <div className="sx-label">SORT</div>
            <Pills options={SORTS} value={sort} onChange={setSort} />
          </div>
        </div>

        <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button onClick={() => setRefreshKey((k) => k + 1)}>↻ Rescan</Button>
          <Button onClick={() => setShowTunnel((s) => !s)}>▸ TUNNEL URL</Button>
          <Button primary disabled={proxyBusy || !needsProxy} onClick={generateProxy}>
            {proxyBusy ? 'Generating…' : `▶ GENERATE ${needsProxy} H.264 PROXY(IES)`}
          </Button>
        </div>
        {proxyMsg ? <Mono>{proxyMsg}</Mono> : null}

        {showTunnel ? (
          <div style={{ marginTop: 8 }}>
            <div className="sx-label">QUEST HTTPS TUNNEL (https://… — pasted into the player's tunnel box)</div>
            <input className="sx-input" placeholder="https://your-tunnel.dev" value={tunnel} onChange={(e) => setTunnel(e.target.value)} />
          </div>
        ) : null}
      </Section>

      <Section num={2} title="Library" active={data !== null}>
        {data === null ? (
          <div className="sx-mono">SCANNING OUTPUT…</div>
        ) : videos.length === 0 ? (
          <EmptyState
            title="NO VIDEOS MATCH"
            text="Adjust the folder, codec, or search — or generate renders from the Image/Video pages."
            hint={`folder=${folder} codec=${codecParam} search="${debouncedSearch}"`}
          />
        ) : (
          <>
            <div className="sx-label">MATCHING VIDEOS ({videos.length})</div>
            <Dropdown
              label=""
              value={videoOpts[0]?.value ?? ''}
              options={videoOpts}
              onChange={() => {}}
              placeholder={`${videos.length} video(s) — inspect the library (player below plays all)`}
            />
            <div className="sx-body" style={{ marginTop: 8 }}>
              {needsProxy ? `${needsProxy} of these need an H.264 proxy for browser playback — use the generate button above.` : 'All files are browser-playable in this codec view.'}
            </div>
          </>
        )}
      </Section>

      <Section num={3} title="Player" active={videos.length > 0}>
        {!videos.length ? (
          <EmptyState title="AWAITING VIDEOS" text="The player appears here once at least one video matches the filters above." />
        ) : (
          <>
            <ReelsPlayer params={playerParams} />
            {videos.some((v) => v.tunnel_url) ? (
              <GatedReason>TUNNEL ACTIVE — QUEST WILL USE THE PROXIED URL</GatedReason>
            ) : null}
          </>
        )}
      </Section>
    </div>
  );
}