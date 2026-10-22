import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import ExploreTile, { formatCompactCount } from '../components/explore/ExploreTile.jsx';
import PackTile from '../components/packs/PackTile.jsx';
import {
  ChipRow,
  DensityToggle,
  ExploreHeader,
  HeaderButton,
  Segmented,
  StatStrip,
  TabGroup,
  Toolbar,
  gridClassName,
  useGridDensity,
} from '../components/explore/ExploreChrome.jsx';
import { Button } from '../components/ui/controls.jsx';
import { EmptyState, Mono } from '../components/ui/primitives.jsx';
import { ExploreGridSkeleton } from '../components/ui/Skeleton.jsx';
import useExplorePreviews from '../hooks/useExplorePreviews.js';
import { useMessaging } from '../hooks/MessagingContext.jsx';
import { useConfigContext } from '../hooks/ConfigContext.jsx';

const SORT_OPTIONS = [
  { label: 'TOP', value: 'trending' },
  { label: 'NEWEST', value: 'newest' },
  { label: 'MOST VIEWED', value: 'views' },
  { label: 'MOST LIKED', value: 'likes' },
];

const CODEC_OPTIONS = [
  { label: 'HEVC MASTER', value: 'hevc' },
  { label: 'H264 / VR', value: 'h264' },
  { label: 'ALL CODECS', value: 'all' },
];

function readableTag(value) {
  return String(value || '')
    .replace(/^#+/, '')
    .trim()
    .toLowerCase();
}

function shuffled(items) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

export default function TagExplorePage() {
  const messaging = useMessaging();
  const { config } = useConfigContext();
  const packDiscoveryEnabled = config?.features?.reel_packs?.discovery !== false;
  const { tag: routeTag = '' } = useParams();
  const navigate = useNavigate();
  const requestedTag = readableTag(routeTag);
  const [sort, setSort] = useState('trending');
  const [codec, setCodec] = useState('hevc');
  const [contentType, setContentType] = useState('all');
  const [density, setDensity] = useGridDensity();
  const [refreshKey, setRefreshKey] = useState(0);
  const [data, setData] = useState(null);
  const [packData, setPackData] = useState(null);
  const [error, setError] = useState('');
  const [packError, setPackError] = useState('');
  const { items: videos, previewMessage } = useExplorePreviews(data?.videos);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');

    api
      .get('/api/reels/tags/' + encodeURIComponent(requestedTag), {
        codec,
        sort,
        refresh: refreshKey > 0,
      })
      .then((response) => {
        if (!alive) return;
        // REFRESH rescans and re-randomizes the feed order, mirroring the
        // main explore page's SHUFFLE button (Fisher-Yates over the payload).
        const shuffleOnRefresh = refreshKey > 0 && Array.isArray(response?.videos);
        setData(shuffleOnRefresh ? { ...response, videos: shuffled(response.videos) } : response);
      })
      .catch((requestError) => {
        if (!alive) return;
        setError(String(requestError.message || requestError));
        setData({
          tag: { name: requestedTag, slug: requestedTag, reel_count: 0, views: 0, likes: 0 },
          related_tags: [],
          videos: [],
          count: 0,
        });
      });

    return () => {
      alive = false;
    };
  }, [requestedTag, codec, sort, refreshKey]);

  useEffect(() => {
    let alive = true;
    setPackData(null);
    setPackError('');
    if (!packDiscoveryEnabled) {
      setPackData({ items: [], total: 0, next_offset: null });
      return () => { alive = false; };
    }
    api.get('/api/packs', { tag: requestedTag, offset: 0, limit: 12 })
      .then((response) => {
        if (alive) setPackData(response);
      })
      .catch((requestError) => {
        if (!alive) return;
        setPackError(String(requestError.message || requestError));
        setPackData({ items: [], total: 0, next_offset: null });
      });
    return () => { alive = false; };
  }, [packDiscoveryEnabled, requestedTag, refreshKey]);

  const tag = data?.tag;
  const displayTag = tag?.name || requestedTag;
  const tagSlug = tag?.slug || requestedTag;
  const relatedTags = data?.related_tags || [];
  const packs = packData?.items || [];

  const updatePack = (updated) => {
    setPackData((current) => ({
      ...(current || {}),
      items: (current?.items || []).map((pack) => pack.id === updated.id ? updated : pack),
    }));
  };

  const openReel = (video) => {
    const query = new URLSearchParams({
      folder: 'ALL FOLDERS',
      codec,
      sort,
      tag: tagSlug,
      play: video.path,
    });
    navigate('/reels?' + query.toString());
  };

  const playTagFeed = () => {
    if (!videos.length) return;
    openReel(videos[0]);
  };

  const reelsVisible = contentType !== 'packs';
  const packsVisible = packDiscoveryEnabled && contentType !== 'reels';
  const loading = data === null || (packDiscoveryEnabled && packData === null);
  const tabs = [
    { label: 'ALL', value: 'all', count: data ? videos.length + (packDiscoveryEnabled ? packData?.total ?? 0 : 0) : null },
    { label: 'REELS', value: 'reels', count: data ? videos.length : null },
    ...(packDiscoveryEnabled ? [{ label: 'PACKS', value: 'packs', count: packData ? packData.total : null }] : []),
  ];
  const stats = [
    { label: 'TOTAL REELS', value: data ? videos.length : '—' },
    ...(packDiscoveryEnabled ? [{ label: 'CURATED PACKS', value: packData ? packData.total : '—' }] : []),
    { label: 'VIEWS', value: tag ? formatCompactCount(tag.views) : '—', accent: true },
    { label: 'LIKES', value: tag ? formatCompactCount(tag.likes) : '—' },
    { label: 'RELATED TAGS', value: data ? relatedTags.length : '—' },
  ];

  return (
    <div className="sx-tag-page sx-wide-page">
      <nav className="sx-tag-breadcrumb" aria-label="Explore breadcrumb">
        <Link to="/explore">EXPLORE</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">#{displayTag}</span>
      </nav>

      <ExploreHeader
        prefix="#"
        title={displayTag}
        kicker="TAG EXPLORE · EXACT MATCH FEED · RELATED BY SHARED REEL TAGS"
        actions={(
          <>
            <HeaderButton primary icon="▶" disabled={!videos.length} onClick={playTagFeed}>
              PLAY TAG FEED
            </HeaderButton>
            <HeaderButton
              icon="↻"
              onClick={() => setRefreshKey((key) => key + 1)}
              title="Rescan reel metadata and shuffle feed order"
            >
              SHUFFLE
            </HeaderButton>
          </>
        )}
      />
      <StatStrip stats={stats} />
      <ChipRow
        label="CO-OCCURRING TAGS:"
        chips={relatedTags.map((related) => ({
          key: related.slug,
          to: '/explore/tag/' + encodeURIComponent(related.slug),
          label: related.name,
          count: related.shared_reels,
          hint: related.shared_reels + ' shared reel' + (related.shared_reels === 1 ? '' : 's'),
        }))}
      />

      <Toolbar>
        <TabGroup tabs={tabs} value={contentType} onChange={setContentType} ariaLabel="Content type" />
        <div className="sx-xh-ctl-group">
          <Segmented label="RANK:" options={SORT_OPTIONS} value={sort} onChange={setSort} />
          <Segmented label="SOURCE:" options={CODEC_OPTIONS} value={codec} onChange={setCodec} />
          <DensityToggle value={density} onChange={setDensity} />
        </div>
      </Toolbar>

      {previewMessage ? <Mono>{previewMessage}</Mono> : null}
      {error ? <div className="sx-error-box" role="alert">{'TAG FEED ERROR · ' + error}</div> : null}
      {packError ? (
        <div className="sx-error-box" role="alert">
          <span>{'PACK DISCOVERY ERROR · ' + packError}</span>
          <Button onClick={() => setRefreshKey((key) => key + 1)}>RETRY</Button>
        </div>
      ) : null}

      {loading ? (
        <ExploreGridSkeleton label={'Loading #' + displayTag + ' reels and packs'} />
      ) : !videos.length && !packs.length ? (
        <EmptyState
          title={'NO CONTENT TAGGED #' + displayTag.toUpperCase()}
          text="This tag exists as a valid destination, but no current reels or Reel Packs use it. Try a related search from the header."
          hint="Tag matching is exact after case and punctuation normalization."
        />
      ) : (
        <>
          {packsVisible && packs.length ? (
            <section className="sx-pack-explore-section" aria-labelledby="sx-tag-pack-title">
              <div className="sx-pack-section-head">
                <div><span>CURATED FOR #{displayTag.toUpperCase()}</span><h2 id="sx-tag-pack-title">REEL PACKS</h2></div>
                {packData?.next_offset != null ? (
                  <Button onClick={() => navigate('/explore?type=packs&search=' + encodeURIComponent('#' + displayTag))}>VIEW ALL PACKS</Button>
                ) : null}
              </div>
              <div className="sx-pack-grid">
                {packs.map((pack) => (
                  <PackTile
                    key={pack.id}
                    pack={pack}
                    onOpen={(item) => navigate('/packs/' + encodeURIComponent(item.id) + '?play=1')}
                    onShare={(target) => messaging.openShare(target)}
                    onChanged={updatePack}
                    source="tag_explore"
                  />
                ))}
              </div>
            </section>
          ) : null}
          {reelsVisible && videos.length ? (
            <>
              <div className="sx-tag-grid-heading">
                <h2>{sort === 'trending' ? 'TOP REELS' : 'TAG REELS'}</h2>
                <span>{videos.length + ' RESULT' + (videos.length === 1 ? '' : 'S')}</span>
              </div>
              <div className={gridClassName(density)}>
                {videos.map((video) => (
                  <ExploreTile
                    key={video.path}
                    video={video}
                    contextTag={displayTag}
                    onOpen={openReel}
                    onShare={(item) => messaging.openShare(item)}
                  />
                ))}
              </div>
            </>
          ) : null}
          {(!reelsVisible || !videos.length) && (!packsVisible || !packs.length) ? (
            <p className="sx-mono" role="status">
              {contentType === 'packs' ? 'No Reel Packs use this tag yet.' : 'No reels match this view.'}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
