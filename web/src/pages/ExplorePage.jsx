import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { Hero, EmptyState, Mono } from '../components/ui/primitives.jsx';
import { Button, Dropdown, Pills } from '../components/ui/controls.jsx';
import { ExploreGridSkeleton } from '../components/ui/Skeleton.jsx';
import ExploreTile from '../components/explore/ExploreTile.jsx';
import PackTile from '../components/packs/PackTile.jsx';
import useExplorePreviews from '../hooks/useExplorePreviews.js';
import { useMessaging } from '../hooks/MessagingContext.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';
import { useConfigContext } from '../hooks/ConfigContext.jsx';

const CODEC_DEFAULT = 'HEVC 4K (Raw Master)';
const CODEC_OPTS = [
  { label: CODEC_DEFAULT, value: CODEC_DEFAULT },
  { label: 'H264 (Browser/VR)', value: 'H264 (Browser/VR)' },
  { label: 'ALL CODECS', value: 'ALL CODECS' },
];
const CONTENT_OPTS = [
  { label: 'ALL', value: 'all' },
  { label: 'REELS', value: 'reels' },
  { label: 'PACKS', value: 'packs' },
];
const PACK_PAGE_SIZE = 24;
const PACK_ALL_LIMIT = 12;

function shuffled(items) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

export default function ExplorePage() {
  const navigate = useNavigate();
  const messaging = useMessaging();
  const { user } = useAuth();
  const { config } = useConfigContext();
  const packFeatures = config?.features?.reel_packs;
  const packDiscoveryEnabled = packFeatures?.discovery !== false;
  const packCreationEnabled = packFeatures?.creation !== false;
  const contentOptions = packDiscoveryEnabled ? CONTENT_OPTS : CONTENT_OPTS.filter((row) => row.value !== 'packs');
  const [searchParams, setSearchParams] = useSearchParams();
  const routeSearch = searchParams.get('search') || '';
  const requestedType = searchParams.get('type') || 'all';
  const [contentType, setContentType] = useState(CONTENT_OPTS.some((row) => row.value === requestedType) ? requestedType : 'all');
  const [data, setData] = useState(null);
  const [packData, setPackData] = useState(null);
  const [packLoadingMore, setPackLoadingMore] = useState(false);
  const [packError, setPackError] = useState('');
  const [folder, setFolder] = useState('ALL FOLDERS');
  const [codec, setCodec] = useState(CODEC_DEFAULT);
  const [search, setSearch] = useState(routeSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(routeSearch);
  const [refreshKey, setRefreshKey] = useState(0);
  const { items: order, setItems: setOrder, previewMessage } = useExplorePreviews(data?.videos);

  useEffect(() => {
    setSearch(routeSearch);
    setDebouncedSearch(routeSearch);
  }, [routeSearch]);

  useEffect(() => {
    if (CONTENT_OPTS.some((row) => row.value === requestedType) && requestedType !== contentType) {
      setContentType(requestedType);
    }
  }, [requestedType]);

  useEffect(() => {
    if (packDiscoveryEnabled || contentType !== 'packs') return;
    setContentType('reels');
    const next = new URLSearchParams(searchParams);
    next.set('type', 'reels');
    setSearchParams(next, { replace: true });
  }, [contentType, packDiscoveryEnabled, searchParams, setSearchParams]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const codecParam =
    codec === 'ALL CODECS' ? 'all' : codec === 'H264 (Browser/VR)' ? 'h264' : 'hevc';

  useEffect(() => {
    let alive = true;
    setData(null);
    setPackData(null);
    setPackLoadingMore(false);
    setPackError('');
    Promise.all([
      api.get('/api/reels', {
        folder,
        codec: codecParam,
        search: debouncedSearch,
        sort: 'shuffle',
        refresh: refreshKey > 0,
      }).catch(() => ({ total: 0, count: 0, folders: [], videos: [] })),
      packDiscoveryEnabled
        ? api.get('/api/packs', {
            search: debouncedSearch,
            offset: 0,
            limit: contentType === 'packs' ? PACK_PAGE_SIZE : PACK_ALL_LIMIT,
          }).catch((requestError) => {
            if (alive) setPackError(String(requestError.message || requestError));
            return { total: 0, items: [], next_offset: null };
          })
        : Promise.resolve({ total: 0, items: [] }),
    ]).then(([reels, packs]) => {
      if (!alive) return;
      setData(reels);
      setPackData(packs);
      if (!(reels.folders || []).includes(folder) && folder !== 'ALL FOLDERS') {
        setFolder('ALL FOLDERS');
      }
    });
    return () => { alive = false; };
  }, [folder, codecParam, debouncedSearch, refreshKey, contentType, packDiscoveryEnabled]);

  const folderOptions = useMemo(
    () => [
      { label: 'ALL FOLDERS', value: 'ALL FOLDERS' },
      ...(data?.folders || []).map((name) => ({ label: name, value: name })),
    ],
    [data],
  );

  const setType = (value) => {
    setContentType(value);
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('type');
    else next.set('type', value);
    setSearchParams(next, { replace: true });
  };

  const openReel = (video) => {
    const query = new URLSearchParams({
      folder,
      codec: codecParam,
      sort: 'shuffle',
      play: video.path,
    });
    if (debouncedSearch) query.set('search', debouncedSearch);
    navigate('/reels?' + query.toString());
  };

  const updatePack = (updated) => {
    setPackData((current) => ({
      ...(current || {}),
      items: (current?.items || []).map((pack) => pack.id === updated.id ? updated : pack),
    }));
  };

  const loadMorePacks = async () => {
    const nextOffset = packData?.next_offset;
    if (contentType !== 'packs' || nextOffset == null || packLoadingMore) return;
    setPackLoadingMore(true);
    setPackError('');
    try {
      const next = await api.get('/api/packs', {
        search: debouncedSearch,
        offset: nextOffset,
        limit: PACK_PAGE_SIZE,
      });
      setPackData((current) => ({
        ...next,
        items: [...(current?.items || []), ...(next.items || [])],
      }));
    } catch (requestError) {
      setPackError(String(requestError.message || requestError));
    } finally {
      setPackLoadingMore(false);
    }
  };

  const packs = packData?.items || [];
  const reelsVisible = contentType !== 'packs';
  const packsVisible = packDiscoveryEnabled && contentType !== 'reels';
  const loading = data === null || (packDiscoveryEnabled && packData === null);
  const empty = (!reelsVisible || !order.length) && (!packsVisible || !packs.length);

  return (
    <div>
      <Hero title="EXPLORE" kicker={packDiscoveryEnabled ? 'ECHO · REELS AND AUTHORED REEL PACKS' : 'ECHO · REELS'}>
        <div className="sx-stats-pill">
          <span>REELS: <strong>{data ? order.length : '—'}</strong></span>
          {packDiscoveryEnabled ? <span>PACKS: <strong>{packData ? packData.total : '—'}</strong></span> : null}
          <span>FOLDERS: <strong>{data ? (data.folders || []).length : '—'}</strong></span>
          <span>CODEC: <strong>{codecParam.toUpperCase()}</strong></span>
        </div>
      </Hero>

      <div className="sx-control-rail-stacked">
        <div className="sx-control-rail-row">
          <div className="sx-control-group" style={{ flex: 1, flexWrap: 'wrap' }}>
            <Pills options={contentOptions} value={contentType} onChange={setType} ariaLabel="Content type" />
            {contentType !== 'packs' ? (
              <>
                <div style={{ flex: '1 1 150px', minWidth: 0 }}>
                  <Dropdown value={folder} options={folderOptions} onChange={setFolder} placeholder="Target folder…" />
                </div>
                <Pills options={CODEC_OPTS} value={codec} onChange={setCodec} ariaLabel="Codec" />
              </>
            ) : null}
            <div style={{ flex: '2 1 160px', minWidth: 0, position: 'relative' }}>
              <input
                className="sx-input"
                style={{ paddingRight: search ? '28px' : undefined }}
                placeholder="Search titles, creators, places, or tags…"
                aria-label="Search titles, creators, places, or tags"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search ? (
                <button type="button" className="sx-search-clear" onClick={() => setSearch('')} aria-label="Clear search filter">✕</button>
              ) : null}
            </div>
            {contentType !== 'packs' ? (
              <Button onClick={() => setOrder((current) => shuffled(current))} title="Re-randomize gallery order">⇄ SHUFFLE</Button>
            ) : null}
            <Button onClick={() => setRefreshKey((key) => key + 1)} title="Refresh discovery">↻</Button>
            {user && packCreationEnabled ? <Button primary onClick={() => navigate('/packs/new')}>+ CREATE PACK</Button> : null}
          </div>
        </div>
      </div>

      {previewMessage && reelsVisible ? <Mono>{previewMessage}</Mono> : null}
      {packError && packsVisible ? (
        <div className="sx-error-box" role="alert">
          <span>{'PACK DISCOVERY ERROR · ' + packError}</span>
          <Button onClick={() => setRefreshKey((key) => key + 1)}>RETRY</Button>
        </div>
      ) : null}

      {loading ? (
        <ExploreGridSkeleton label="Loading explore gallery" />
      ) : empty ? (
        <EmptyState
          title="NO CONTENT MATCHES CURRENT FILTERS"
          text="Try another title, creator, place, or tag, or publish new reels and packs."
          hint={'search="' + debouncedSearch + '"'}
        />
      ) : (
        <>
          {packsVisible && !packs.length && !packError ? (
            <p className="sx-mono" role="status">No Reel Packs match this filter yet — try another search or publish a collection.</p>
          ) : null}
          {packsVisible || reelsVisible ? (
            <div className="sx-explore-grid" aria-label="Explore results">
              {packsVisible ? packs.map((pack) => (
                <PackTile
                  key={pack.id}
                  pack={pack}
                  onOpen={(item) => navigate('/packs/' + encodeURIComponent(item.id) + '?play=1')}
                  onShare={(target) => messaging.openShare(target)}
                  onChanged={updatePack}
                  source="explore"
                />
              )) : null}
              {reelsVisible ? order.map((video) => (
                <ExploreTile key={video.path} video={video} onOpen={openReel} onShare={(item) => messaging.openShare({ ...item, kind: 'reel' })} />
              )) : null}
            </div>
          ) : null}
          {contentType === 'packs' && packData?.next_offset != null ? (
            <div className="sx-profile-load-more">
              <Button loading={packLoadingMore} disabled={packLoadingMore} onClick={loadMorePacks}>
                LOAD MORE PACKS
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
