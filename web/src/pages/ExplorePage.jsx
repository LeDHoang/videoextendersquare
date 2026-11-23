import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { EmptyState, Mono } from '../components/ui/primitives.jsx';
import { Button, Dropdown, Pills } from '../components/ui/controls.jsx';
import {
  ChipRow,
  DensityToggle,
  ExploreHeader,
  HeaderButton,
  StatStrip,
  TabGroup,
  Toolbar,
  gridClassName,
  useGridDensity,
} from '../components/explore/ExploreChrome.jsx';
import { ExploreGridSkeleton } from '../components/ui/Skeleton.jsx';
import ExploreTile, { locationKey } from '../components/explore/ExploreTile.jsx';
import { LocationIcon } from '../components/icons/index.jsx';
import PackTile from '../components/packs/PackTile.jsx';
import useExplorePreviews from '../hooks/useExplorePreviews.js';
import { useMessaging } from '../hooks/MessagingContext.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';
import { useConfigContext } from '../hooks/ConfigContext.jsx';
import { FORMAT_FILTER_LABELS } from '../utils/mediaFormat.js';
import useMasonry from '../hooks/useMasonry.js';
import { tileAspect } from '../utils/aspect.js';

const CODEC_DEFAULT = 'HEVC 2K (Raw Master)';
const CODEC_OPTS = [
  { label: FORMAT_FILTER_LABELS.hevc, value: CODEC_DEFAULT },
  { label: FORMAT_FILTER_LABELS.h264, value: 'H264 (Browser/VR)' },
  { label: FORMAT_FILTER_LABELS.all, value: 'ALL CODECS' },
];
const CONTENT_OPTS = [
  { label: 'ALL', value: 'all' },
  { label: 'REELS', value: 'reels' },
  { label: 'PACKS', value: 'packs' },
];
const PACK_PAGE_SIZE = 24;
// /api/reels comes in pages of this many reels; LOAD MORE REELS fetches the next.
const REEL_PAGE_SIZE = 48;
const TRENDING_TAGS = 8;
const TRENDING_PLACES = 4;

// Loads the next page once the load-more row nears the viewport. The observer is rebuilt per page key, so a
// short page that leaves the row in view still asks for the one after; a failed load keeps the key, so it
// waits for the button instead of retrying in a loop. Without IntersectionObserver the button is the only way.
function useAutoLoadMore(pageKey, onLoad) {
  // A callback ref: the row can mount a render after the page key changes (the grid fills in an effect).
  const [el, setEl] = useState(null);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  useEffect(() => {
    if (pageKey == null || !el || typeof IntersectionObserver !== 'function') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadRef.current();
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [pageKey, el]);
  return setEl;
}

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
  // Beta: the folder/codec filters and rescan stay with admins.
  const isAdmin = user?.role === 'admin';
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
  // Phones lead with the grid: stats, tags and filters sit behind a FILTER toggle (CSS shows them on wider screens).
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [packData, setPackData] = useState(null);
  const [packLoadingMore, setPackLoadingMore] = useState(false);
  const [reelsLoadingMore, setReelsLoadingMore] = useState(false);
  // The page being fetched, so the observer and the button never ask for the same page twice at once.
  const reelsFetchingRef = useRef(null);
  const packsFetchingRef = useRef(null);
  const [packError, setPackError] = useState('');
  const [folder, setFolder] = useState('ALL FOLDERS');
  const [codec, setCodec] = useState(CODEC_DEFAULT);
  const [search, setSearch] = useState(routeSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(routeSearch);
  const [refreshKey, setRefreshKey] = useState(0);
  const [density, setDensity] = useGridDensity();
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
    setReelsLoadingMore(false);
    setPackData(null);
    setPackLoadingMore(false);
    setPackError('');
    Promise.all([
      api.get('/api/reels', {
        folder,
        codec: codecParam,
        search: debouncedSearch,
        sort: 'for_you',
        refresh: refreshKey > 0,
        limit: REEL_PAGE_SIZE,
        packs: packDiscoveryEnabled,
      }).catch(() => ({ total: 0, count: 0, folders: [], videos: [], next_cursor: null })),
      packDiscoveryEnabled
        ? api.get('/api/packs', {
            search: debouncedSearch,
            offset: 0,
            // ALL takes its packs from /api/reels; there this call only gives the total.
            limit: contentType === 'packs' ? PACK_PAGE_SIZE : 1,
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

  // MOST TRENDING: the tags and places used by the most reels in the current
  // result set, so the chips always lead to a non-empty destination page.
  const trendingChips = useMemo(() => {
    const counts = new Map();
    const bump = (id, entry) => {
      const row = counts.get(id) || { ...entry, count: 0 };
      row.count += 1;
      counts.set(id, row);
    };
    for (const video of data?.videos || []) {
      const seenTags = new Set();
      for (const raw of video.tags || []) {
        const slug = String(raw || '').replace(/^#+/, '').trim().toLowerCase();
        if (!slug || seenTags.has(slug)) continue;
        seenTags.add(slug);
        bump('tag:' + slug, {
          to: '/explore/tag/' + encodeURIComponent(slug),
          label: slug,
          prefix: '#',
          hint: 'Tag',
        });
      }
      const key = locationKey(video.location?.city, video.location?.country);
      if (key) {
        bump('loc:' + key, {
          to: '/explore/location/' + encodeURIComponent(key),
          label: [video.location.city, video.location.country].filter(Boolean).join(', '),
          prefix: <LocationIcon className="sx-xh-chip-pin" />,
          hint: 'Place',
        });
      }
    }
    // Tags are used far more often than places, so rank each kind separately
    // and interleave (2 tags : 1 place) to keep both visible in the row.
    const ranked = (prefix, limit) => [...counts.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([, a], [, b]) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, limit)
      .map(([key, row]) => ({ key, ...row }));
    const tags = ranked('tag:', TRENDING_TAGS);
    const places = ranked('loc:', TRENDING_PLACES);
    const mixed = [];
    for (let i = 0; tags.length > i * 2 || places.length > i; i += 1) {
      mixed.push(...tags.slice(i * 2, i * 2 + 2), ...places.slice(i, i + 1));
    }
    return mixed;
  }, [data]);

  const setType = (value) => {
    setContentType(value);
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('type');
    else next.set('type', value);
    setSearchParams(next, { replace: true });
  };

  const openReel = (video) => {
    // A posted reel opens by its post id, so the link is short and names no
    // storage path; Reels already defaults folder, codec and sort. A file with
    // no post (admin library) still opens by its path.
    if (video.post_id) {
      const query = new URLSearchParams({ post: video.post_id });
      if (folder !== 'ALL FOLDERS') query.set('folder', folder);
      if (codecParam !== 'hevc') query.set('codec', codecParam);
      if (debouncedSearch) query.set('search', debouncedSearch);
      navigate('/reels?' + query.toString());
      return;
    }
    const query = new URLSearchParams({
      folder,
      codec: codecParam,
      sort: 'for_you',
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
    setData((current) => current && ({
      ...current,
      packs: (current.packs || []).map((pack) => pack.id === updated.id ? { ...updated, slot: pack.slot } : pack),
    }));
  };

  const loadMoreReels = async () => {
    const cursor = data?.next_cursor;
    if (!cursor || reelsFetchingRef.current === cursor) return;
    reelsFetchingRef.current = cursor;
    setReelsLoadingMore(true);
    try {
      const next = await api.get('/api/reels', {
        folder,
        codec: codecParam,
        search: debouncedSearch,
        sort: 'for_you',
        limit: REEL_PAGE_SIZE,
        packs: packDiscoveryEnabled,
        cursor,
      });
      setData((current) => {
        if (current?.next_cursor !== cursor) return current;
        const seen = new Set(current.videos.map((video) => video.path));
        return {
          ...current,
          next_cursor: next.next_cursor,
          videos: [...current.videos, ...(next.videos || []).filter((video) => !seen.has(video.path))],
          packs: [...(current.packs || []), ...(next.packs || []).filter((pack) => !(current.packs || []).some((row) => row.id === pack.id))],
        };
      });
    } catch {
      /* Keep the loaded reels; LOAD MORE REELS stays to retry. */
    } finally {
      if (reelsFetchingRef.current === cursor) reelsFetchingRef.current = null;
      setReelsLoadingMore(false);
    }
  };

  const loadMorePacks = async () => {
    const nextOffset = packData?.next_offset;
    if (contentType !== 'packs' || nextOffset == null || packsFetchingRef.current === nextOffset) return;
    packsFetchingRef.current = nextOffset;
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
      if (packsFetchingRef.current === nextOffset) packsFetchingRef.current = null;
      setPackLoadingMore(false);
    }
  };

  // PACKS lists packs alone; ALL places each ranked pack before the reel at its slot.
  const packs = contentType === 'packs' ? packData?.items || [] : data?.packs || [];
  const reelsVisible = contentType !== 'packs';
  const packsVisible = packDiscoveryEnabled && contentType !== 'reels';
  const loading = data === null || (packDiscoveryEnabled && packData === null);
  const empty = (!reelsVisible || !order.length) && (!packsVisible || !packs.length);
  const tiles = [];
  if (packsVisible && reelsVisible) {
    let next = 0;
    order.forEach((video, index) => {
      while (next < packs.length && packs[next].slot <= index) tiles.push(packs[next++]);
      tiles.push(video);
    });
    tiles.push(...packs.slice(next));
  } else {
    tiles.push(...(packsVisible ? packs : order));
  }
  const reelCount = data ? data.count ?? order.length : null;
  const reelsAutoRef = useAutoLoadMore(!loading && reelsVisible ? data?.next_cursor ?? null : null, loadMoreReels);
  const packsAutoRef = useAutoLoadMore(!loading && contentType === 'packs' ? packData?.next_offset ?? null : null, loadMorePacks);
  const masonryRef = useMasonry(tiles.map((tile) => (tile.path ? { key: tile.path, aspect: tileAspect(tile) } : { key: 'pack:' + tile.id, aspect: 1 })), density);

  return (
    <div className="sx-wide-page">
      <ExploreHeader
        title="EXPLORE"
        actions={(
          <>
            {user && packCreationEnabled ? (
              <HeaderButton primary icon="+" onClick={() => navigate('/packs/new')}>CREATE PACK</HeaderButton>
            ) : null}
            {contentType !== 'packs' ? (
              <HeaderButton icon="⇄" onClick={() => setOrder((current) => shuffled(current))} title="Re-randomize gallery order">
                SHUFFLE
              </HeaderButton>
            ) : null}
            <button
              type="button"
              className="sx-xh-btn sx-explore-filter-toggle"
              aria-expanded={filtersOpen}
              aria-controls="sx-explore-filters"
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <span className="sx-xh-btn-icon" aria-hidden="true">{filtersOpen ? '▴' : '▾'}</span>
              <span>FILTER</span>
            </button>
          </>
        )}
      />
      <div id="sx-explore-filters" className={'sx-explore-filters' + (filtersOpen ? ' sx-open' : '')}>
      <StatStrip
        stats={[
          { label: 'TOTAL REELS', value: data ? reelCount : '—' },
          ...(packDiscoveryEnabled ? [{ label: 'CURATED PACKS', value: packData ? packData.total : '—' }] : []),
          ...(isAdmin ? [{ label: 'FOLDERS', value: data ? (data.folders || []).length : '—' }] : []),
        ]}
      />

      {contentType !== 'packs' ? (
        <ChipRow
          label="MOST TRENDING:"
          chips={trendingChips.map((chip) => ({
            ...chip,
            hint: chip.hint + ' · ' + chip.count + ' post' + (chip.count === 1 ? '' : 's'),
          }))}
        />
      ) : null}

      <Toolbar
        filters={(
          <>
            {contentType !== 'packs' && isAdmin ? (
              <>
                <div style={{ flex: '1 1 150px', minWidth: 0, maxWidth: 260 }}>
                  <Dropdown value={folder} options={folderOptions} onChange={setFolder} placeholder="Target folder…" />
                </div>
                <Pills options={CODEC_OPTS} value={codec} onChange={setCodec} ariaLabel="Format" />
              </>
            ) : null}
            <div style={{ flex: '2 1 200px', minWidth: 0, position: 'relative' }}>
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
            {isAdmin ? <Button onClick={() => setRefreshKey((key) => key + 1)} title="Refresh discovery">↻</Button> : null}
          </>
        )}
      >
        <TabGroup
          tabs={contentOptions.map((row) => ({
            label: row.label,
            value: row.value,
            count: !data ? null
              : row.value === 'reels' ? reelCount
              : row.value === 'packs' ? (packData ? packData.total : null)
              : reelCount + (packDiscoveryEnabled ? packData?.total ?? 0 : 0),
          }))}
          value={contentType}
          onChange={setType}
          ariaLabel="Content type"
        />
        <div className="sx-xh-ctl-group">
          <DensityToggle value={density} onChange={setDensity} />
        </div>
      </Toolbar>
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
          hint={debouncedSearch ? 'Searched for “' + debouncedSearch + '”' : ''}
        />
      ) : (
        <>
          {packsVisible || reelsVisible ? (
            <div ref={masonryRef} className={gridClassName(density)} aria-label="Explore results">
              {tiles.map((tile) => (tile.path ? (
                <ExploreTile key={tile.path} video={tile} onOpen={openReel} onShare={(item) => messaging.openShare({ ...item, kind: 'reel' })} />
              ) : (
                <PackTile
                  key={tile.id}
                  pack={tile}
                  onOpen={(item) => navigate('/packs/' + encodeURIComponent(item.id) + '?play=1')}
                  onShare={(target) => messaging.openShare(target)}
                  onChanged={updatePack}
                  source="explore"
                />
              )))}
            </div>
          ) : null}
          {reelsVisible && data?.next_cursor ? (
            <div ref={reelsAutoRef} className="sx-profile-load-more">
              <Button loading={reelsLoadingMore} disabled={reelsLoadingMore} onClick={loadMoreReels}>
                LOAD MORE REELS
              </Button>
            </div>
          ) : null}
          {contentType === 'packs' && packData?.next_offset != null ? (
            <div ref={packsAutoRef} className="sx-profile-load-more">
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
