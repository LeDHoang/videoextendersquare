import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import ExploreTile, { formatCompactCount } from '../components/explore/ExploreTile.jsx';
import { Button, Pills } from '../components/ui/controls.jsx';
import { EmptyState, Hero, Mono } from '../components/ui/primitives.jsx';
import { ExploreGridSkeleton } from '../components/ui/Skeleton.jsx';
import useExplorePreviews from '../hooks/useExplorePreviews.js';

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
  const { tag: routeTag = '' } = useParams();
  const navigate = useNavigate();
  const requestedTag = readableTag(routeTag);
  const [sort, setSort] = useState('trending');
  const [codec, setCodec] = useState('hevc');
  const [refreshKey, setRefreshKey] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
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

  const tag = data?.tag;
  const displayTag = tag?.name || requestedTag;
  const tagSlug = tag?.slug || requestedTag;
  const relatedTags = data?.related_tags || [];

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

  return (
    <div className="sx-tag-page">
      <nav className="sx-tag-breadcrumb" aria-label="Explore breadcrumb">
        <Link to="/explore">EXPLORE</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">#{displayTag}</span>
      </nav>

      <Hero
        title={'#' + displayTag}
        kicker="TAG EXPLORE · EXACT MATCH FEED · RELATED BY SHARED REEL TAGS"
      >
        <div className="sx-stats-pill">
          <span>REELS: <strong>{data ? videos.length : '—'}</strong></span>
          <span>VIEWS: <strong>{tag ? formatCompactCount(tag.views) : '—'}</strong></span>
          <span>LIKES: <strong>{tag ? formatCompactCount(tag.likes) : '—'}</strong></span>
          <span>RELATED: <strong>{data ? relatedTags.length : '—'}</strong></span>
        </div>
      </Hero>

      <section className="sx-tag-overview" aria-labelledby="tag-overview-title">
        <div>
          <div className="sx-eyebrow" id="tag-overview-title">DISCOVERY SIGNAL</div>
          <p className="sx-tag-description">
            Showing media explicitly tagged <strong>#{displayTag}</strong>. Related tags are ranked by how often
            they appear on the same reels, creating a transparent baseline for future recommendation ranking.
          </p>
        </div>
        <div className="sx-tag-overview-actions">
          <Button primary disabled={!videos.length} onClick={playTagFeed}>
            ▶ PLAY TAG FEED
          </Button>
          <Button onClick={() => setRefreshKey((key) => key + 1)} title="Rescan reel metadata and shuffle feed order">
            ↻ SHUFFLE
          </Button>
        </div>
      </section>

      {relatedTags.length ? (
        <section className="sx-related-tags" aria-labelledby="related-tags-title">
          <div className="sx-related-tags-head">
            <span className="sx-eyebrow" id="related-tags-title">RELATED TAGS</span>
            <span>{'CO-OCCURRENCE FROM ' + videos.length + ' MATCHING REEL' + (videos.length === 1 ? '' : 'S')}</span>
          </div>
          <div className="sx-related-tags-list">
            {relatedTags.map((related) => (
              <Link
                key={related.slug}
                to={'/explore/tag/' + encodeURIComponent(related.slug)}
                className="sx-related-tag"
              >
                <span>{'#' + related.name}</span>
                <small>{related.shared_reels + ' SHARED'}</small>
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
      {error ? <Mono>{'TAG FEED ERROR · ' + error}</Mono> : null}

      {data === null ? (
        <ExploreGridSkeleton label={'Loading #' + displayTag + ' reels'} />
      ) : !videos.length ? (
        <EmptyState
          title={'NO REELS TAGGED #' + displayTag.toUpperCase()}
          text="This tag exists as a valid destination, but no current media uses it. Try a related search from the header."
          hint="Tag matching is exact after case and punctuation normalization."
        />
      ) : (
        <>
          <div className="sx-tag-grid-heading">
            <h2>{sort === 'trending' ? 'TOP REELS' : 'TAG REELS'}</h2>
            <span>{videos.length + ' RESULT' + (videos.length === 1 ? '' : 'S')}</span>
          </div>
          <div className="sx-explore-grid">
            {videos.map((video) => (
              <ExploreTile
                key={video.path}
                video={video}
                contextTag={displayTag}
                onOpen={openReel}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
