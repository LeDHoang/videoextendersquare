import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { Hero, EmptyState, Mono } from '../components/ui/primitives.jsx';
import { Button, Dropdown, Pills } from '../components/ui/controls.jsx';
import { LocationIcon, LikeIcon, ViewIcon, CommentIcon } from '../components/icons/index.jsx';
import StudioLoading from '../components/ui/StudioLoading.jsx';

const PREVIEW_BATCH = 24;
const CODEC_DEFAULT = 'HEVC 4K (Raw Master)';
const CODEC_OPTS = [
  { label: CODEC_DEFAULT, value: CODEC_DEFAULT },
  { label: 'H264 (Browser/VR)', value: 'H264 (Browser/VR)' },
  { label: 'ALL CODECS', value: 'ALL CODECS' },
];

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Compact engagement counts (1250 -> "1.2K"), mirrors the player helper.
function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return `${parseFloat((n / 1000000).toFixed(1))}M`;
  if (n >= 1000) return `${parseFloat((n / 1000).toFixed(1))}K`;
  return String(n);
}

function ExploreTile({ video, onOpen }) {
  const wrapRef = useRef(null);
  const videoRef = useRef(null);
  const [src, setSrc] = useState(null);
  const [preload, setPreload] = useState('metadata');
  const [failed, setFailed] = useState(false);

  // Two-tier loading priority:
  //  - NEAR (within 800px of viewport): set src with preload="metadata" —
  //    cheap header fetch only, deprioritised bandwidth.
  //  - VISIBLE (actually in view): full preload + play immediately.
  //  - FAR (beyond 800px): poster thumbnail only, zero video traffic.
  useEffect(() => {
    const el = wrapRef.current;
    const vid = videoRef.current;
    if (!el || !vid) return undefined;
    let nearArmed = false;

    const nearIO = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !nearArmed) {
          nearArmed = true;
          setSrc(video.preview_url || video.url);
          nearIO.disconnect();
        }
      },
      { rootMargin: '800px', threshold: 0 },
    );

    const visIO = new IntersectionObserver(
      (entries) => {
        const vis = entries[0]?.isIntersecting;
        if (vis) {
          // Visible tiles win: ensure src, upgrade to full preload, play.
          setSrc((cur) => cur || video.preview_url || video.url);
          setPreload('auto');
          if (vid.paused) {
            vid.play().catch(() => {
              /* browser throttled autoplay; retries on next scroll event */
            });
          }
        } else if (!vid.paused) {
          vid.pause();
        }
      },
      { rootMargin: '0px', threshold: 0.25 },
    );
    nearIO.observe(el);
    visIO.observe(el);
    return () => {
      nearIO.disconnect();
      visIO.disconnect();
      if (!vid.paused) vid.pause();
    };
  }, [video.preview_url, video.url]);

  const commentCount = video.comments?.length || 0;
  const city = video.location?.city || '';
  const county = video.location?.county || '';
  const place = [city, county].filter(Boolean).join(', ');
  const tagHint = (video.tags || []).map((t) => `#${t}`).join(' ');
  const liked = !!video.liked_by_me;

  return (
    <button
      ref={wrapRef}
      type="button"
      className="sx-explore-tile"
      onClick={() => onOpen(video)}
      title={[video.filename, place ? `📍 ${place}` : '', tagHint].filter(Boolean).join(' — ')}
      aria-label={`Open ${video.filename} in Reels player`}
    >
      {/* Poster paints instantly (~tens of KB); the preview video loads over
          it only when the tile scrolls into view. */}
      {video.poster_url ? (
        <img src={video.poster_url} className="sx-explore-poster" alt="" loading="lazy" draggable="false" />
      ) : null}
      {failed ? (
        <div className="sx-explore-fallback">▶<span>{video.filename}</span></div>
      ) : (
        <video
          ref={videoRef}
          className="sx-explore-video"
          src={src}
          muted
          loop
          playsInline
          preload={preload}
          disablePictureInPicture
          onError={() => {
            // Preview missing/failed → fall back to the full stream once.
            if (src !== video.url) setSrc(video.url);
            else setFailed(true);
          }}
        />
      )}
      <span className="sx-explore-badge" aria-hidden="true">▶</span>
      {city ? (
        <span className="sx-explore-loc" title={place}>
          <LocationIcon />
          {city}
        </span>
      ) : null}
      <span className="sx-explore-stats">
        <span aria-label={`${video.likes || 0} likes`}>
          <LikeIcon filled={liked} />
          {fmtCount(video.likes)}
        </span>
        <span aria-label={`${video.views || 0} views`}>
          <ViewIcon />
          {fmtCount(video.views)}
        </span>
        {commentCount ? (
          <span aria-label={`${commentCount} comments`}>
            <CommentIcon />
            {commentCount}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export default function ExplorePage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [folder, setFolder] = useState('ALL FOLDERS');
  const [codec, setCodec] = useState(CODEC_DEFAULT);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [order, setOrder] = useState([]); // randomized video list
  const [previewMsg, setPreviewMsg] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch a freshly server-shuffled gallery on filter/refresh change.
  const codecParam =
    codec === 'ALL CODECS' ? 'all' : codec === 'H264 (Browser/VR)' ? 'h264' : 'hevc';

  useEffect(() => {
    let alive = true;
    setData(null);
    setPreviewMsg('');
    api
      .get('/api/reels', {
        folder,
        codec: codecParam,
        search: debouncedSearch,
        sort: 'shuffle',
        refresh: refreshKey > 0,
      })
      .then((r) => {
        if (!alive) return;
        setData(r);
        if (!r.folders.includes(folder) && folder !== 'ALL FOLDERS') {
          setFolder('ALL FOLDERS');
        }
        setOrder(r.videos || []);
        // Lazily generate lightweight previews + posters for tiles missing
        // them. Posters land ~10x faster, so the grid paints instantly and
        // each tile upgrades to video as its transcode finishes.
        const missing = (r.videos || []).filter((v) => !v.preview_url || !v.poster_url).map((v) => v.path);
        if (missing.length) {
          setPreviewMsg(`LOADING PREVIEWS… 0/${missing.length}`);
          (async () => {
            let done = 0;
            for (let i = 0; i < missing.length; i += PREVIEW_BATCH) {
              const batch = missing.slice(i, i + PREVIEW_BATCH);
              try {
                const res = await api.post('/api/reels/explore-preview', batch);
                const gen = res.generated || {};
                const posters = res.posters || {};
                if ((Object.keys(gen).length || Object.keys(posters).length) && alive) {
                  setOrder((prev) => prev.map((v) => {
                    const g = gen[v.path];
                    const p = posters[v.path];
                    if (!g && !p) return v;
                    return {
                      ...v,
                      ...(g ? { preview_url: g } : {}),
                      ...(p ? { poster_url: p } : {}),
                    };
                  }));
                }
              } catch {
                /* keep poster/stream fallback for this batch */
              }
              done += batch.length;
              if (alive) setPreviewMsg(`LOADING PREVIEWS… ${Math.min(done, missing.length)}/${missing.length}`);
            }
            if (alive) setPreviewMsg('');
          })();
        }
      })
      .catch(() => {
        if (alive) {
          setData({ total: 0, count: 0, folders: [], videos: [] });
          setOrder([]);
        }
      });
    return () => {
      alive = false;
    };
  }, [folder, codecParam, debouncedSearch, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const folderOpts = useMemo(
    () => [
      { label: 'ALL FOLDERS', value: 'ALL FOLDERS' },
      ...(data?.folders || []).map((f) => ({ label: f, value: f })),
    ],
    [data],
  );

  const openReel = (video) => {
    const q = new URLSearchParams({
      folder,
      codec: codecParam,
      sort: 'shuffle',
      play: video.path,
    });
    if (debouncedSearch) q.set('search', debouncedSearch);
    navigate(`/reels?${q.toString()}`);
  };

  return (
    <div>
      <Hero title="EXPLORE" kicker="ECHO · RANDOMIZED REELS GALLERY · TAP ANY TILE TO PLAY">
        <div className="sx-stats-pill">
          <span>REELS: <strong>{order.length || data?.count || '—'}</strong></span>
          <span>FOLDERS: <strong>{(data?.folders || []).length || '—'}</strong></span>
          <span>ORDER: <strong>RANDOMIZED</strong></span>
          <span>CODEC: <strong>{codecParam.toUpperCase()}</strong></span>
        </div>
      </Hero>

      <div className="sx-control-rail-stacked">
        <div className="sx-control-rail-row">
          <div className="sx-control-group" style={{ flex: 1, flexWrap: 'wrap' }}>
            <div style={{ width: '180px', flexShrink: 0 }}>
              <Dropdown
                value={folder}
                options={folderOpts}
                onChange={setFolder}
                placeholder="Target folder…"
              />
            </div>
            <Pills options={CODEC_OPTS} value={codec} onChange={setCodec} />
            <div style={{ flex: 1, minWidth: '160px', position: 'relative' }}>
              <input
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
            <Button onClick={() => setOrder((prev) => shuffled(prev))} title="Re-randomize gallery order">
              ⇄ SHUFFLE
            </Button>
            <Button onClick={() => setRefreshKey((k) => k + 1)} title="Rescan video library">
              ↻
            </Button>
          </div>
        </div>
      </div>

      {previewMsg ? <Mono>{previewMsg}</Mono> : null}

      {data === null ? (
        <StudioLoading title="EXPLORE" subtitle="SHUFFLING REELS…" />
      ) : !order.length ? (
        <EmptyState
          title="NO REELS MATCH CURRENT FILTERS"
          text="Try adjusting the folder or search query — or render new videos from the Video page."
          hint={`folder="${folder}" search="${debouncedSearch}"`}
        />
      ) : (
        <div className="sx-explore-grid">
          {order.map((v) => (
            <ExploreTile key={v.path} video={v} onOpen={openReel} />
          ))}
        </div>
      )}
    </div>
  );
}
