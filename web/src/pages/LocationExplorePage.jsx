import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import ExploreTile, { formatCompactCount } from '../components/explore/ExploreTile.jsx';
import PackTile from '../components/packs/PackTile.jsx';
import { Button, Pills } from '../components/ui/controls.jsx';
import { EmptyState, Hero, Mono } from '../components/ui/primitives.jsx';
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

function readableKey(value) {
  return String(value || '').trim().toLowerCase();
}

function shuffled(items) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

export default function LocationExplorePage() {
  const messaging = useMessaging();
  const { config } = useConfigContext();
  const packDiscoveryEnabled = config?.features?.reel_packs?.discovery !== false;
  const { key: routeKey = '' } = useParams();
  const navigate = useNavigate();
  const requestedKey = readableKey(routeKey);
  const [sort, setSort] = useState('trending');
  const [codec, setCodec] = useState('hevc');
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
      .get('/api/reels/locations/' + encodeURIComponent(requestedKey), {
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
          location: { name: requestedKey, slug: requestedKey, reel_count: 0, views: 0, likes: 0 },
          related_locations: [],
          videos: [],
          count: 0,
        });
      });

    return () => {
      alive = false;
    };
  }, [requestedKey, codec, sort, refreshKey]);

  useEffect(() => {
    let alive = true;
    setPackData(null);
    setPackError('');
    if (!packDiscoveryEnabled) {
      setPackData({ items: [], total: 0, next_offset: null });
      return () => { alive = false; };
    }
    api.get('/api/packs', { location: requestedKey, offset: 0, limit: 12 })
      .then((response) => {
        if (alive) setPackData(response);
      })
      .catch((requestError) => {
        if (!alive) return;
        setPackError(String(requestError.message || requestError));
        setPackData({ items: [], total: 0, next_offset: null });
      });
    return () => { alive = false; };
  }, [packDiscoveryEnabled, requestedKey, refreshKey]);

  const location = data?.location;
  const displayName = (location?.name || requestedKey).toUpperCase();
  const locationSlug = location?.slug || requestedKey;
  const relatedLocations = data?.related_locations || [];
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
      location: locationSlug,
      play: video.path,
    });
    navigate('/reels?' + query.toString());
  };

  const playLocationFeed = () => {
    if (!videos.length) return;
    openReel(videos[0]);
  };

  return (
    <div className="sx-tag-page">
      <nav className="sx-tag-breadcrumb" aria-label="Explore breadcrumb">
        <Link to="/explore">EXPLORE</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{displayName}</span>
      </nav>

      <Hero
        title={displayName}
        kicker="LOCATION EXPLORE · EXACT CITY MATCH · RELATED BY COUNTRY AND DISTANCE"
      >
        <div className="sx-stats-pill">
          <span>REELS: <strong>{data ? videos.length : '—'}</strong></span>
          {packDiscoveryEnabled ? <span>PACKS: <strong>{packData ? packData.total : '—'}</strong></span> : null}
          <span>VIEWS: <strong>{location ? formatCompactCount(location.views) : '—'}</strong></span>
          <span>LIKES: <strong>{location ? formatCompactCount(location.likes) : '—'}</strong></span>
          <span>RELATED: <strong>{data ? relatedLocations.length : '—'}</strong></span>
        </div>
      </Hero>

      <section className="sx-tag-overview" aria-labelledby="location-overview-title">
        <div>
          <div className="sx-eyebrow" id="location-overview-title">DISCOVERY SIGNAL</div>
          <p className="sx-tag-description">
            Showing media shot in <strong>{displayName}</strong>. Related places are ranked by same
            country first, then physical distance, creating a transparent baseline for future
            recommendation ranking.
          </p>
        </div>
        <div className="sx-tag-overview-actions">
          <Button primary disabled={!videos.length} onClick={playLocationFeed}>
            ▶ PLAY LOCATION FEED
          </Button>
          <Button onClick={() => setRefreshKey((key) => key + 1)} title="Rescan reel metadata and shuffle feed order">
            ↻ SHUFFLE
          </Button>
        </div>
      </section>

      {relatedLocations.length ? (
        <section className="sx-related-tags" aria-labelledby="related-locations-title">
          <div className="sx-related-tags-head">
            <span className="sx-eyebrow" id="related-locations-title">RELATED PLACES</span>
            <span>{'SAME COUNTRY FIRST, THEN CLOSEST ' + videos.length + ' MATCHING REEL' + (videos.length === 1 ? '' : 'S')}</span>
          </div>
          <div className="sx-related-tags-list">
            {relatedLocations.map((related) => (
              <Link
                key={related.slug}
                to={'/explore/location/' + encodeURIComponent(related.slug)}
                className="sx-related-tag"
              >
                <span>{related.name}</span>
                <small>
                  {related.same_country ? 'SAME COUNTRY' : ''}
                  {related.same_country && related.distance_km != null ? ' · ' : ''}
                  {related.distance_km != null ? '≈' + related.distance_km + ' KM' : ''}
                  {!related.same_country && related.distance_km == null ? related.reel_count + ' REELS' : ''}
                </small>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <div className="sx-control-rail-stacked sx-tag-controls">
        <div className="sx-control-rail-row">
          <div className="sx-control-group sx-tag-control-group">
            <div>
              <div className="sx-control-caption">RANK</div>
              <Pills options={SORT_OPTIONS} value={sort} onChange={setSort} />
            </div>
            <div>
              <div className="sx-control-caption">PLAYBACK SOURCE</div>
              <Pills options={CODEC_OPTIONS} value={codec} onChange={setCodec} />
            </div>
          </div>
        </div>
      </div>

      {previewMessage ? <Mono>{previewMessage}</Mono> : null}
      {error ? <Mono>{'LOCATION FEED ERROR · ' + error}</Mono> : null}
      {packError ? (
        <div className="sx-error-box" role="alert">
          <span>{'PACK DISCOVERY ERROR · ' + packError}</span>
          <Button onClick={() => setRefreshKey((key) => key + 1)}>RETRY</Button>
        </div>
      ) : null}

      {data === null || (packDiscoveryEnabled && packData === null) ? (
        <ExploreGridSkeleton label={'Loading ' + displayName + ' reels and packs'} />
      ) : !videos.length && !packs.length ? (
        <EmptyState
          title={'NO CONTENT FROM ' + displayName}
          text="This place exists as a valid destination, but no current reels or Reel Packs use it. Try a related place from above."
          hint="Location matching is exact on city and country."
        />
      ) : (
        <>
          {packs.length ? (
            <section className="sx-pack-explore-section" aria-labelledby="sx-location-pack-title">
              <div className="sx-pack-section-head">
                <div><span>CURATED IN {displayName}</span><h2 id="sx-location-pack-title">REEL PACKS</h2></div>
                {packData?.next_offset != null ? (
                  <Button onClick={() => navigate('/explore?type=packs&search=' + encodeURIComponent(displayName))}>VIEW ALL PACKS</Button>
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
                    source="location_explore"
                  />
                ))}
              </div>
            </section>
          ) : null}
          {videos.length ? (
            <>
              <div className="sx-tag-grid-heading">
                <h2>{sort === 'trending' ? 'TOP REELS' : 'LOCATION REELS'}</h2>
                <span>{videos.length + ' RESULT' + (videos.length === 1 ? '' : 'S')}</span>
              </div>
              <div className="sx-explore-grid">
                {videos.map((video) => (
                  <ExploreTile
                    key={video.path}
                    video={video}
                    onOpen={openReel}
                    onShare={(item) => messaging.openShare(item)}
                  />
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
