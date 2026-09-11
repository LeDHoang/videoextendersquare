import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { Hero, EmptyState, Mono } from '../components/ui/primitives.jsx';
import { Button, Dropdown, Pills } from '../components/ui/controls.jsx';
import { ExploreGridSkeleton } from '../components/ui/Skeleton.jsx';
import ExploreTile from '../components/explore/ExploreTile.jsx';
import useExplorePreviews from '../hooks/useExplorePreviews.js';
import { useMessaging } from '../hooks/MessagingContext.jsx';

const CODEC_DEFAULT = 'HEVC 4K (Raw Master)';
const CODEC_OPTS = [
  { label: CODEC_DEFAULT, value: CODEC_DEFAULT },
  { label: 'H264 (Browser/VR)', value: 'H264 (Browser/VR)' },
  { label: 'ALL CODECS', value: 'ALL CODECS' },
];

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
  const [searchParams] = useSearchParams();
  const routeSearch = searchParams.get('search') || '';
  const [data, setData] = useState(null);
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
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const codecParam =
    codec === 'ALL CODECS' ? 'all' : codec === 'H264 (Browser/VR)' ? 'h264' : 'hevc';

  useEffect(() => {
    let alive = true;
    setData(null);
    api
      .get('/api/reels', {
        folder,
        codec: codecParam,
        search: debouncedSearch,
        sort: 'shuffle',
        refresh: refreshKey > 0,
      })
      .then((response) => {
        if (!alive) return;
        setData(response);
        if (!response.folders.includes(folder) && folder !== 'ALL FOLDERS') {
          setFolder('ALL FOLDERS');
        }
      })
      .catch(() => {
        if (alive) setData({ total: 0, count: 0, folders: [], videos: [] });
      });
    return () => {
      alive = false;
    };
  }, [folder, codecParam, debouncedSearch, refreshKey]);

  const folderOptions = useMemo(
    () => [
      { label: 'ALL FOLDERS', value: 'ALL FOLDERS' },
      ...(data?.folders || []).map((name) => ({ label: name, value: name })),
    ],
    [data],
  );

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

  return (
    <div>
      <Hero title="EXPLORE" kicker="ECHO · RANDOMIZED REELS GALLERY · TAP ANY TILE TO PLAY">
        <div className="sx-stats-pill">
          <span>REELS: <strong>{data ? order.length : '—'}</strong></span>
          <span>FOLDERS: <strong>{data ? (data.folders || []).length : '—'}</strong></span>
          <span>ORDER: <strong>RANDOMIZED</strong></span>
          <span>CODEC: <strong>{codecParam.toUpperCase()}</strong></span>
        </div>
      </Hero>

      <div className="sx-control-rail-stacked">
        <div className="sx-control-rail-row">
          <div className="sx-control-group" style={{ flex: 1, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 150px', minWidth: 0 }}>
              <Dropdown
                value={folder}
                options={folderOptions}
                onChange={setFolder}
                placeholder="Target folder…"
              />
            </div>
            <Pills options={CODEC_OPTS} value={codec} onChange={setCodec} />
            <div style={{ flex: '2 1 160px', minWidth: 0, position: 'relative' }}>
              <input
                className="sx-input"
                style={{ paddingRight: search ? '28px' : undefined }}
                placeholder="Search titles, creators, places, or tags…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
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
            <Button onClick={() => setOrder((current) => shuffled(current))} title="Re-randomize gallery order">
              ⇄ SHUFFLE
            </Button>
            <Button onClick={() => setRefreshKey((key) => key + 1)} title="Rescan video library">
              ↻
            </Button>
          </div>
        </div>
      </div>

      {previewMessage ? <Mono>{previewMessage}</Mono> : null}

      {data === null ? (
        <ExploreGridSkeleton label="Loading explore gallery" />
      ) : !order.length ? (
        <EmptyState
          title="NO REELS MATCH CURRENT FILTERS"
          text="Try another title, creator, place, or tag, or render new media from the Video page."
          hint={'folder="' + folder + '" search="' + debouncedSearch + '"'}
        />
      ) : (
        <div className="sx-explore-grid">
          {order.map((video) => (
            <ExploreTile key={video.path} video={video} onOpen={openReel} onShare={(item) => messaging.openShare(item)} />
          ))}
        </div>
      )}
    </div>
  );
}
