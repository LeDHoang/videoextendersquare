import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LocationIcon, LikeIcon, ViewIcon, CommentIcon } from '../icons/index.jsx';
import { formatClock, formatDuration, imagePostLabel, stereoCropClass, stereoLayout } from '../../utils/mediaFormat.js';

export function formatCompactCount(value) {
  const count = Number(value) || 0;
  if (count >= 1000000) return parseFloat((count / 1000000).toFixed(1)) + 'M';
  if (count >= 1000) return parseFloat((count / 1000).toFixed(1)) + 'K';
  return String(count);
}

export function locationKey(city, country) {
  const slug = (value) => String(value || '').toLowerCase().replace(/[^\w]+|_+/g, '-').replace(/^-+|-+$/g, '');
  const citySlug = slug(city);
  const countrySlug = slug(country);
  if (!citySlug) return '';
  return citySlug + (countrySlug ? '--' + countrySlug : '');
}

// Browsers throttle parallel media loads, so a screenful of tiles asking at once delays the ones in view.
// Nearby tiles queue here; a tile that scrolls into view jumps to the front.
const MAX_CONCURRENT_LOADS = 4;
const LOAD_SLOT_TIMEOUT_MS = 8000;
const waitingLoads = [];
let runningLoads = 0;

function pumpLoads() {
  while (runningLoads < MAX_CONCURRENT_LOADS && waitingLoads.length) {
    const job = waitingLoads.shift();
    job.started = true;
    runningLoads += 1;
    job.timer = setTimeout(job.release, LOAD_SLOT_TIMEOUT_MS);
    job.start();
  }
}

function queueVideoLoad(start, urgent) {
  const job = { start, started: false, done: false, timer: null };
  const dequeue = () => {
    const index = waitingLoads.indexOf(job);
    if (index >= 0) waitingLoads.splice(index, 1);
  };
  job.release = () => {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    if (job.started) runningLoads -= 1;
    else dequeue();
    pumpLoads();
  };
  job.prioritize = () => {
    if (job.started || job.done) return;
    dequeue();
    waitingLoads.unshift(job);
    pumpLoads();
  };
  if (urgent) waitingLoads.unshift(job);
  else waitingLoads.push(job);
  pumpLoads();
  return job;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* orderLabel (e.g. "01") adds a top-right badge with the reel's runtime, which counts down while it autoplays. */
export default function ExploreTile({ video, onOpen, contextTag = '', onEdit, onDelete, onShare, orderLabel = '' }) {
  const navigate = useNavigate();
  const isImage = video.media_type === 'image';
  const wrapRef = useRef(null);
  const videoRef = useRef(null);
  const [src, setSrc] = useState(null);
  const [preload, setPreload] = useState('metadata');
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [remaining, setRemaining] = useState(null);
  const visibleRef = useRef(false);
  const loadJobRef = useRef(null);

  // Play only while the tile is on screen and the <video> actually has a source. The visibility callback can
  // fire before React has put `src` on the element (play() then rejects and nothing retries), and a
  // preview -> original fallback reloads the element, so this is also called once media is ready.
  const tryPlay = () => {
    const vid = videoRef.current;
    if (prefersReducedMotion()) return;
    if (!vid || !visibleRef.current || !vid.paused || !vid.getAttribute('src')) return;
    vid.play().catch(() => {
      /* Still throttled by the browser: the next canplay / visibility event retries. */
    });
  };

  useEffect(() => {
    if (isImage) return undefined;
    const el = wrapRef.current;
    const vid = videoRef.current;
    if (!el || !vid) return undefined;
    let nearArmed = false;
    // Under reduced motion a tile with a poster shows only that; one without loads metadata for its first frame.
    const still = prefersReducedMotion();
    const wantsLoad = !still || !video.poster_url;

    const requestSource = (urgent) => {
      if (!wantsLoad) return;
      if (loadJobRef.current) {
        if (urgent) loadJobRef.current.prioritize();
        return;
      }
      loadJobRef.current = queueVideoLoad(() => setSrc((current) => current || video.preview_url || video.url), urgent);
    };

    const nearIO = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !nearArmed) {
          nearArmed = true;
          requestSource(false);
          nearIO.disconnect();
        }
      },
      { rootMargin: '300px', threshold: 0 },
    );

    const visIO = new IntersectionObserver(
      (entries) => {
        const visible = entries[0]?.isIntersecting;
        visibleRef.current = !!visible;
        if (visible && !still) {
          requestSource(true);
          setPreload('auto');
          tryPlay();
        } else if (visible) {
          requestSource(true);
        } else if (!vid.paused) {
          vid.pause();
        }
      },
      { rootMargin: '0px', threshold: 0.25 },
    );

    nearIO.observe(el);
    visIO.observe(el);
    return () => {
      visibleRef.current = false;
      if (loadJobRef.current) loadJobRef.current.release();
      loadJobRef.current = null;
      nearIO.disconnect();
      visIO.disconnect();
      if (!vid.paused) vid.pause();
    };
  }, [isImage, video.preview_url, video.url]);

  // A new source (first assignment or the fallback to the original file) needs a fresh play() once it renders.
  useEffect(() => {
    tryPlay();
  }, [src]);

  // Whole seconds left in the playing preview; the state only changes when the shown second does.
  const syncRemaining = (event) => {
    const el = event.currentTarget;
    if (Number.isFinite(el.duration) && el.duration > 0) {
      setRemaining(Math.max(0, Math.round(el.duration - el.currentTime)));
    }
  };

  const commentCount = video.comments_count ?? video.comments?.length ?? 0;
  const place = [video.location?.city, video.location?.country].filter(Boolean).join(', ');
  const placeKey = locationKey(video.location?.city, video.location?.country);
  const tagHint = (video.tags || []).map((tag) => '#' + tag).join(' ');
  const label = video.title || video.filename || video.path?.split('/').pop() || 'Untitled reel';
  // 3D posts carry a "3D" tag next to the kind/context badge.
  const badge = [contextTag ? '#' + contextTag : imagePostLabel(video), stereoLayout(video) !== 'mono' ? '3D' : '']
    .filter(Boolean)
    .join(' · ');
  const crop = stereoCropClass(video);
  const withCrop = (name) => (crop ? `${name} ${crop}` : name);
  const runtime = isImage ? '' : remaining !== null ? formatClock(remaining) : formatDuration(video.duration_ms);

  return (
    <article
      ref={wrapRef}
      role="button"
      tabIndex={0}
      className={'sx-explore-tile' + (ready ? '' : ' sx-skel')}
      onClick={() => onOpen(video)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(video);
        }
      }}
      title={[label, place ? 'Location: ' + place : '', tagHint].filter(Boolean).join(' — ')}
      aria-label={'Open ' + label + (stereoLayout(video) !== 'mono' ? ' (3D)' : '') + ' in Reels player'}
    >
      {isImage ? (
        <img
          src={video.poster_url || video.preview_url || video.url}
          className={withCrop('sx-explore-image')}
          alt={label}
          loading="lazy"
          draggable="false"
          onLoad={() => setReady(true)}
          onError={() => setReady(true)}
        />
      ) : (
        <>
          {video.poster_url ? (
            <img
              src={video.poster_url}
              className={withCrop('sx-explore-poster')}
              alt=""
              loading="lazy"
              draggable="false"
              onLoad={() => setReady(true)}
              onError={() => setReady(true)}
            />
          ) : null}
          {failed ? (
            <div className="sx-explore-fallback">
              ▶
              <span>{video.filename}</span>
            </div>
          ) : (
            <video
              ref={videoRef}
              className={withCrop('sx-explore-video')}
              src={src}
              muted
              loop
              playsInline
              preload={preload}
              disablePictureInPicture
              onLoadedData={() => {
                setReady(true);
                loadJobRef.current?.release();
              }}
              onCanPlay={tryPlay}
              onLoadedMetadata={(event) => {
                syncRemaining(event);
                loadJobRef.current?.release();
              }}
              onTimeUpdate={syncRemaining}
              onError={() => {
                loadJobRef.current?.release();
                if (src !== video.url) setSrc(video.url);
                else {
                  setFailed(true);
                  setReady(true);
                }
              }}
            />
          )}
        </>
      )}

      {video.creator ? (
        <button
          type="button"
          className="sx-explore-creator"
          onClick={(event) => {
            event.stopPropagation();
            navigate('/profile/' + video.creator.username);
          }}
          title={'Open @' + video.creator.username}
        >
          {video.creator.avatar_url ? <img src={video.creator.avatar_url} alt="" /> : <span style={{ backgroundColor: video.creator.avatar_color }}>{(video.creator.display_name || video.creator.username).slice(0, 1).toUpperCase()}</span>}
          <strong>@{video.creator.username}</strong>
        </button>
      ) : null}
      {onEdit || onDelete ? (
        <span className="sx-explore-owner-actions">
          {onEdit ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onEdit(video);
              }}
              aria-label={'Edit ' + label}
            >
              EDIT
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(video);
              }}
              aria-label={'Delete ' + label}
            >
              DELETE
            </button>
          ) : null}
        </span>
      ) : null}
      {onShare ? (
        <span className="sx-explore-share">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onShare(video);
            }}
            aria-label={'Share ' + label}
          >
            SHARE
          </button>
        </span>
      ) : null}
      {video.title ? (
        <span className="sx-explore-title" title={video.title}>
          {video.title}
        </span>
      ) : null}
      {/* Both chips sit top-right, so a pack tile folds the kind into its order chip. */}
      {badge && !orderLabel ? <span className="sx-explore-kind">{badge}</span> : null}
      {orderLabel ? (
        <span className="sx-explore-order" aria-hidden="true">
          {[orderLabel, badge, runtime].filter(Boolean).join(' · ')}
        </span>
      ) : null}
      {place ? (
        placeKey ? (
          <button
            type="button"
            className="sx-explore-loc sx-explore-loc-link"
            title={place + ' — open location feed'}
            onClick={(event) => {
              event.stopPropagation();
              navigate('/explore/location/' + encodeURIComponent(placeKey));
            }}
          >
            <LocationIcon />
            {place}
          </button>
        ) : (
          <span className="sx-explore-loc" title={place}>
            <LocationIcon />
            {place}
          </span>
        )
      ) : null}
      <span className="sx-explore-stats">
        <span aria-label={(video.likes || 0) + ' likes'}>
          <LikeIcon filled={!!video.liked_by_me} />
          {formatCompactCount(video.likes)}
        </span>
        <span aria-label={(video.views || 0) + ' views'}>
          <ViewIcon />
          {formatCompactCount(video.views)}
        </span>
        {commentCount ? (
          <span aria-label={commentCount + ' comments'}>
            <CommentIcon />
            {commentCount}
          </span>
        ) : null}
      </span>
    </article>
  );
}
