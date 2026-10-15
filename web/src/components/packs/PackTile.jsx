import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { clientId } from '../../hooks/MessagingContext.jsx';
import { formatCompactCount, locationKey } from '../explore/ExploreTile.jsx';
import { LocationIcon, LikeIcon, ViewIcon, CommentIcon } from '../icons/index.jsx';

export function packCoverMembers(pack) {
  return (pack?.cover_items || []).map((entry) => entry?.post || entry).filter(Boolean);
}

function posterFor(post) {
  if (!post) return '';
  if (post.media_type === 'image') return post.poster_url || post.preview_url || post.url || '';
  return post.poster_url || post.preview_url || '';
}

function clipFor(post) {
  if (!post || post.media_type === 'image') return '';
  return post.preview_url || post.url || '';
}

export default function PackTile({ pack, onOpen, onShare, onChanged, ownerActions = false, source = 'pack_tile' }) {
  const navigate = useNavigate();
  const tileRef = useRef(null);
  const videoRef = useRef(null);
  const failedClipsRef = useRef(new Set());
  const [armed, setArmed] = useState(false);
  const [visible, setVisible] = useState(false);
  const [clipIndex, setClipIndex] = useState(0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const members = packCoverMembers(pack);
  const clips = members.map(clipFor).filter(Boolean);
  const poster = posterFor(members[0]) || pack?.cover_url || '';
  const reducedMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    const node = tileRef.current;
    if (!node || !pack?.id) return undefined;
    let sent = false;
    const record = () => {
      if (sent) return;
      sent = true;
      api.post('/api/events', {
        event_type: 'pack_impression',
        pack_id: pack.id,
        source,
        client_event_id: clientId('pack-impression'),
      }).catch(() => {});
    };
    const nearIO = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setArmed(true);
        nearIO.disconnect();
      }
    }, { rootMargin: '800px', threshold: 0 });
    const visIO = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    }, { rootMargin: '0px', threshold: 0.25 });
    const impIO = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        record();
        impIO.disconnect();
      }
    }, { threshold: 0.35 });
    nearIO.observe(node);
    visIO.observe(node);
    impIO.observe(node);
    return () => {
      nearIO.disconnect();
      visIO.disconnect();
      impIO.disconnect();
    };
  }, [pack?.id, source]);

  const clipsKey = clips.join('|');
  useEffect(() => {
    // Fresh pack data (edit, refresh) makes dead members playable again.
    failedClipsRef.current = new Set();
    setFailed(false);
  }, [clipsKey, pack?.revision]);

  useEffect(() => {
    if (!visible || !armed || reducedMotion || failed || clips.length <= 1) return undefined;
    const timer = setTimeout(() => setClipIndex((current) => current + 1), 3400);
    return () => clearTimeout(timer);
  }, [visible, armed, clipIndex, clips.length, failed, reducedMotion]);

  const activeClip = clips.length ? clips[clipIndex % clips.length] : '';
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !activeClip) return;
    if (visible && !reducedMotion) {
      vid.play().catch(() => {
        /* Autoplay throttling retries on the next visibility/clip event. */
      });
    } else if (!vid.paused) {
      vid.pause();
    }
  }, [visible, activeClip, reducedMotion]);

  const handleOpen = () => {
    if (pack?.id) onOpen?.(pack);
  };

  const place = [pack?.location?.city, pack?.location?.country].filter(Boolean).join(', ');
  const placeKey = locationKey(pack?.location?.city, pack?.location?.country);
  const commentCount = pack?.comments ?? 0;
  const canEdit = ownerActions && pack?.viewer_state?.can_edit;

  return (
    <article
      ref={tileRef}
      role="button"
      tabIndex={0}
      className={'sx-explore-tile sx-pack-tile--reel' + (ready || !activeClip ? '' : ' sx-skel')}
      onClick={handleOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleOpen();
        }
      }}
      title={[pack?.title, place ? 'Location: ' + place : '', 'Reel Pack'].filter(Boolean).join(' — ')}
      aria-label={`Open Reel Pack: ${pack?.title}, ${pack?.reel_count ?? members.length} reels, by ${pack?.creator?.username || 'creator'}`}
    >
      <span className="sx-pack-cover-stack" aria-hidden="true" />
      {poster ? (
        <img
          src={poster}
          className="sx-explore-poster"
          alt=""
          loading="lazy"
          draggable="false"
          onLoad={() => setReady(true)}
          onError={() => setReady(true)}
        />
      ) : null}
      {activeClip && !failed ? (
        <video
          ref={videoRef}
          className="sx-explore-video"
          src={activeClip}
          muted
          loop
          playsInline
          preload={armed ? 'auto' : 'none'}
          disablePictureInPicture
          onLoadedData={() => setReady(true)}
          onError={() => {
            // One dead member must not kill the whole cover: advance to the
            // next playable clip, and only fall back to the poster once every
            // clip has failed (wrap back around to a visited source).
            if (failedClipsRef.current.has(activeClip)) {
              setFailed(true);
            } else {
              failedClipsRef.current.add(activeClip);
              setClipIndex((current) => current + 1);
            }
            setReady(true);
          }}
        />
      ) : null}

      {pack?.creator ? (
        <button
          type="button"
          className="sx-explore-creator"
          onClick={(event) => {
            event.stopPropagation();
            navigate('/profile/' + encodeURIComponent(pack.creator.username));
          }}
          title={'Open @' + pack.creator.username}
        >
          {pack.creator.avatar_url ? (
            <img src={pack.creator.avatar_url} alt="" />
          ) : (
            <span style={{ backgroundColor: pack.creator.avatar_color }}>
              {(pack.creator.display_name || pack.creator.username).slice(0, 1).toUpperCase()}
            </span>
          )}
          <strong>@{pack.creator.username}</strong>
        </button>
      ) : null}

      {canEdit ? (
        <span className="sx-explore-owner-actions">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              navigate(`/packs/${encodeURIComponent(pack.id)}/edit`);
            }}
            aria-label={'Edit ' + (pack.title || 'collection')}
          >
            EDIT
          </button>
        </span>
      ) : null}

      {onShare ? (
        <span className="sx-explore-share">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onShare({ kind: 'pack', id: pack.id, title: pack.title });
            }}
            aria-label={'Share ' + (pack.title || 'collection')}
          >
            SHARE
          </button>
        </span>
      ) : null}

      {pack?.title ? (
        <span className="sx-explore-title" title={pack.title}>
          {pack.title}
        </span>
      ) : null}
      {!canEdit ? (
        <span className="sx-explore-kind">▦ REEL PACK{pack?.reel_count ? ' · ' + pack.reel_count : ''}</span>
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
      {pack?.needs_repair ? (
        <span className="sx-pack-warning sx-pack-tile-warning" role="status">
          NEEDS REPAIR · HIDDEN FROM DISCOVERY
        </span>
      ) : null}
      <span className="sx-explore-stats">
        <span aria-label={(pack?.likes || 0) + ' likes'}>
          <LikeIcon filled={!!pack?.liked_by_me} />
          {formatCompactCount(pack?.likes)}
        </span>
        <span aria-label={(pack?.views || 0) + ' views'}>
          <ViewIcon />
          {formatCompactCount(pack?.views)}
        </span>
        {commentCount ? (
          <span aria-label={commentCount + ' comments'}>
            <CommentIcon />
            {formatCompactCount(commentCount)}
          </span>
        ) : null}
      </span>
    </article>
  );
}
