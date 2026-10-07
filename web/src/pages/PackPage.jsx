import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import ExploreTile, { formatCompactCount } from '../components/explore/ExploreTile.jsx';
import { DensityToggle, Segmented, gridClassName, useGridDensity } from '../components/explore/ExploreChrome.jsx';
import { CommentIcon, LikeIcon, ViewIcon } from '../components/icons/index.jsx';
import PackCover from '../components/packs/PackCover.jsx';
import ReelsPlayer from '../components/ui/ReelsPlayer.jsx';
import { Button, Dropdown } from '../components/ui/controls.jsx';
import { EmptyState } from '../components/ui/primitives.jsx';
import { ExploreGridSkeleton } from '../components/ui/Skeleton.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';
import { clientId, useMessaging } from '../hooks/MessagingContext.jsx';
import { formatDuration, formatResolution, packRuntime } from '../utils/mediaFormat.js';
import { REPORT_REASONS } from '../utils/messageFormat.js';

const VISIBILITY_OPTIONS = [
  { label: 'PUBLIC · DISCOVERABLE', value: 'public' },
  { label: 'UNLISTED · LINK ONLY', value: 'unlisted' },
];

const VIEW_KEY = 'sx.pack.view';
const VIEW_OPTIONS = [
  { label: 'LIST', value: 'list' },
  { label: 'GALLERY', value: 'gallery' },
];
const DETAILS_LIMIT = 500;
const MIN_PUBLISH = 3;

export function usePackView() {
  const [view, setViewState] = useState(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'gallery' ? 'gallery' : 'list';
    } catch {
      return 'list';
    }
  });
  const setView = useCallback((next) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* storage unavailable — the choice just won't persist */
    }
  }, []);
  return [view, setView];
}

/** Small modal: Escape and backdrop close it, focus moves in and returns to the opener. */
function Dialog({ title, onClose, busy = false, children }) {
  const panelRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector('select, textarea, input, button:not([data-dialog-close])');
    (first || panel)?.focus();
    return () => {
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div className="sx-pk-modal" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="sx-pk-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef} tabIndex={-1}>
        <header>
          <h2 id={titleId}>{title}</h2>
          <button type="button" data-dialog-close onClick={onClose} disabled={busy} aria-label="Close dialog">×</button>
        </header>
        {children}
      </div>
    </div>
  );
}

function ReelThumb({ post }) {
  const src = post?.poster_url || (post?.media_type === 'image' ? post.preview_url || post.url : '');
  return src
    ? <img src={src} alt="" loading="lazy" draggable="false" />
    : <span className="sx-pk-thumb-empty" aria-hidden="true">▦</span>;
}

function ReelRow({ item, index, pack, onPlay }) {
  const number = String(index + 1).padStart(2, '0');
  const post = item.post;
  if (!item.available || !post) {
    return (
      <li>
        <button type="button" className="sx-pk-row sx-pk-row--gone" disabled>
          <span className="sx-pk-row-num">{number}</span>
          <span className="sx-pk-thumb"><ReelThumb post={null} /></span>
          <span className="sx-pk-row-copy">
            <strong>Reel unavailable</strong>
            <small>REMOVED OR HIDDEN</small>
          </span>
          <span className="sx-pk-row-go">UNAVAILABLE</span>
        </button>
      </li>
    );
  }
  const owner = post.creator?.username || pack.creator?.username || 'creator';
  const place = [post.location?.city, post.location?.country].filter(Boolean).join(', ');
  const comments = post.comments_count ?? 0;
  const resolution = formatResolution(post.width, post.height);
  const duration = post.media_type === 'image' ? '' : formatDuration(post.duration_ms);
  return (
    <li>
      <button type="button" className="sx-pk-row" onClick={() => onPlay(index)} aria-label={`Play ${post.title || 'untitled reel'}, reel ${index + 1}`}>
        <span className="sx-pk-row-num">{number}</span>
        <span className="sx-pk-thumb">
          <ReelThumb post={post} />
          <span className="sx-pk-thumb-play" aria-hidden="true">▶</span>
        </span>
        <span className="sx-pk-row-copy">
          <strong>{post.title || post.filename || 'Untitled reel'}</strong>
          <small>
            <span>@{owner}</span>
            {post.media_type === 'image' ? <span className="sx-pk-chip">IMAGE</span> : null}
            {resolution ? <span className="sx-pk-chip">{resolution}</span> : null}
            {duration ? <span className="sx-pk-chip" aria-label={'Runtime ' + duration}>{duration}</span> : null}
            {place ? <span className="sx-pk-chip">{place}</span> : null}
          </small>
        </span>
        <span className="sx-pk-row-stats">
          <span aria-label={(post.likes || 0) + ' likes'}><LikeIcon filled={!!post.liked_by_me} />{formatCompactCount(post.likes)}</span>
          <span aria-label={(post.views || 0) + ' views'}><ViewIcon />{formatCompactCount(post.views)}</span>
          <span aria-label={comments + ' comments'}><CommentIcon />{formatCompactCount(comments)}</span>
        </span>
        <span className="sx-pk-row-go" aria-hidden="true">PLAY ▶</span>
      </button>
    </li>
  );
}

export default function PackPage() {
  const { packId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const messaging = useMessaging();
  const [view, setView] = usePackView();
  const [density, setDensity] = useGridDensity();
  const [pack, setPack] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [dialog, setDialog] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [reportReason, setReportReason] = useState('spam');
  const [reportDetails, setReportDetails] = useState('');
  const loadSeq = useRef(0);
  const playing = searchParams.get('play') === '1';
  const rawRequestedItem = Number(searchParams.get('item'));
  const requestedItem = Number.isFinite(rawRequestedItem) ? Math.max(0, Math.trunc(rawRequestedItem)) : 0;
  const restart = searchParams.get('restart') === '1';

  const load = useCallback(async ({ recordOpen = true } = {}) => {
    const seq = ++loadSeq.current;
    // Silent reloads (after a failed action or closing the player) must not wipe the message explaining why.
    if (recordOpen) setError('');
    try {
      const result = await api.get('/api/packs/' + encodeURIComponent(packId));
      if (seq !== loadSeq.current) return;
      setPack(result.pack);
      if (recordOpen) {
        api.post('/api/events', {
          event_type: 'pack_open',
          pack_id: result.pack.id,
          source: 'pack_detail',
          client_event_id: clientId('pack-open'),
        }).catch(() => {});
      }
    } catch (requestError) {
      if (seq !== loadSeq.current) return;
      setPack(null);
      setError(requestError.message || 'This Reel Pack is unavailable.');
    }
  }, [packId]);

  useEffect(() => {
    setPack(null);
    setNotice('');
    setDialog('');
    load();
    return () => { loadSeq.current += 1; };
  }, [load]);

  const items = pack?.items || [];

  const openPlayer = ({ item = null, forceRestart = false } = {}) => {
    const next = new URLSearchParams(searchParams);
    next.set('play', '1');
    if (item === null) next.delete('item');
    else next.set('item', String(item));
    if (forceRestart) next.set('restart', '1');
    else next.delete('restart');
    setSearchParams(next);
  };

  const closePlayer = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('play');
    next.delete('item');
    next.delete('restart');
    setSearchParams(next);
    load({ recordOpen: false });
  };

  const requireAccount = () => {
    if (user) return true;
    navigate('/login?next=' + encodeURIComponent('/packs/' + pack.id));
    return false;
  };

  const toggleLike = async () => {
    if (!pack || !requireAccount()) return;
    setBusy('like');
    setError('');
    try {
      const path = `/api/packs/${encodeURIComponent(pack.id)}/like`;
      const result = pack.liked_by_me ? await api.delete(path) : await api.put(path);
      setPack((current) => ({
        ...current,
        likes: result.likes,
        liked_by_me: result.liked_by_me,
        viewer_state: { ...current.viewer_state, liked: result.liked_by_me },
      }));
    } catch (requestError) {
      setError(requestError.message || 'Could not update your like.');
    } finally {
      setBusy('');
    }
  };

  const toggleSave = async () => {
    if (!pack || !requireAccount()) return;
    setBusy('save');
    setError('');
    try {
      const result = pack.saved_by_me
        ? await api.delete(`/api/packs/${encodeURIComponent(pack.id)}/save`)
        : await api.put(`/api/packs/${encodeURIComponent(pack.id)}/save`);
      setPack((current) => ({
        ...current,
        saved_by_me: result.saved,
        saves: result.saves,
        viewer_state: { ...current.viewer_state, saved: result.saved },
      }));
    } catch (requestError) {
      setError(requestError.message || 'Could not update this saved pack.');
    } finally {
      setBusy('');
    }
  };

  const openReport = () => {
    if (!requireAccount()) return;
    setReportReason('spam');
    setReportDetails('');
    setDialogError('');
    setDialog('report');
  };

  const submitReport = async (event) => {
    event.preventDefault();
    setBusy('report');
    setDialogError('');
    try {
      await api.post('/api/reports', {
        target_type: 'pack',
        target_id: pack.id,
        reason: reportReason,
        details: reportDetails.trim(),
      });
      setDialog('');
      setError('');
      setNotice('Report submitted. Thank you — our moderators will review it.');
    } catch (requestError) {
      setDialogError(requestError.message || 'Could not report this Reel Pack.');
    } finally {
      setBusy('');
    }
  };

  const patchPack = async (action, body, failure) => {
    setBusy(action);
    setError('');
    setNotice('');
    try {
      const result = await api.patch(`/api/packs/${encodeURIComponent(pack.id)}`, {
        ...body,
        expected_revision: pack.revision,
      });
      setPack((current) => ({ ...current, ...result.pack }));
    } catch (requestError) {
      setError(requestError.message || failure);
      load({ recordOpen: false });
    } finally {
      setBusy('');
    }
  };

  const changeVisibility = (visibility) => {
    if (visibility === pack.visibility) return;
    patchPack('visibility', { visibility }, 'Could not update this collection visibility.');
  };

  const postStatusChange = async (action, path, failure, success) => {
    setBusy(action);
    setError('');
    setNotice('');
    try {
      const result = await api.post(`/api/packs/${encodeURIComponent(pack.id)}/${path}`, {
        expected_revision: pack.revision,
      });
      setPack(result.pack);
      setNotice(success);
    } catch (requestError) {
      setError(requestError.message || failure);
      await load({ recordOpen: false });
    } finally {
      setBusy('');
    }
  };

  const publishPack = () => {
    if ((pack.playable_count ?? 0) < MIN_PUBLISH) return;
    postStatusChange('publish', 'publish', 'Could not publish this collection.', 'Collection published.');
  };

  const unpublishPack = () => postStatusChange(
    'unpublish',
    'unpublish',
    'Could not move this collection back to draft.',
    'Moved back to draft. It is hidden from everyone but you.',
  );

  const deletePack = async () => {
    setBusy('delete');
    setDialogError('');
    try {
      const query = '?expected_revision=' + encodeURIComponent(String(pack.revision));
      await api.delete('/api/packs/' + encodeURIComponent(pack.id) + query, { expected_revision: pack.revision });
      navigate('/profile/' + encodeURIComponent(pack.creator?.username || user?.username || '') + '?tab=packs');
    } catch (requestError) {
      setDialogError(requestError.message || 'Could not delete this Reel Pack.');
      setBusy('');
    }
  };

  if (error && !pack) {
    return <EmptyState title="REEL PACK UNAVAILABLE" text={error} hint={packId} />;
  }
  if (!pack) return <ExploreGridSkeleton label="Loading Reel Pack" />;

  if (playing) {
    const playableTotal = Math.max(0, Number(pack.playable_count ?? items.filter((item) => item.available).length ?? 0));
    const clampedIndex = items.length ? Math.min(requestedItem, items.length - 1) : 0;
    return (
      <div className="sx-pack-player-page sx-wide-page">
        <div className="sx-pack-player-toolbar">
          <Button onClick={closePlayer}>← PACK DETAILS</Button>
          <strong>▦ {pack.title}</strong>
          <span>{playableTotal} AVAILABLE</span>
        </div>
        <ReelsPlayer
          params={{ pack_id: pack.id, restart }}
          initialIndex={clampedIndex}
          revealOnLoad
          revealAlign
        />
      </div>
    );
  }

  const isOwner = !!pack.viewer_state?.can_edit;
  const isDraft = pack.status === 'draft';
  const playable = pack.playable_count ?? 0;
  const resumeItemId = pack.progress?.current_item_id || null;
  const resumeIndexById = resumeItemId ? items.findIndex((item) => item.id === resumeItemId) : -1;
  const resumeIndex = resumeIndexById >= 0 ? resumeIndexById : (pack.progress?.item_index || 0);
  const hasResume = pack.progress?.phase === 'playing' && !!resumeItemId && resumeIndexById >= 0;
  const place = [pack.location?.city, pack.location?.country].filter(Boolean).join(', ');
  const status = isDraft ? 'DRAFT' : (pack.visibility || 'public').toUpperCase();
  const updated = pack.updated_at ? new Date(pack.updated_at) : null;
  const playItem = (index) => openPlayer({ item: index, forceRestart: true });
  const liked = !!pack.liked_by_me;
  const runtime = packRuntime(items);
  const stats = [
    ['REELS', pack.reel_count ?? items.length],
    ['AVAILABLE', playable],
    ['LIKES', formatCompactCount(pack.likes)],
    ['VIEWS', formatCompactCount(pack.views)],
    ['COMMENTS', formatCompactCount(pack.comments)],
    ['SAVES', formatCompactCount(pack.saves)],
  ];

  return (
    <div className="sx-pk sx-wide-page">
      {error ? (
        <div className="sx-error-box" role="alert">
          <span>{error}</span>
          <Button onClick={() => setError('')}>DISMISS</Button>
        </div>
      ) : null}
      {notice ? <div className="sx-pk-notice" role="status">{notice}</div> : null}

      <div className="sx-pk-grid">
        <section className="sx-pk-side" aria-label="Pack details">
          <button
            type="button"
            className="sx-pk-cover"
            onClick={() => openPlayer({ item: hasResume ? resumeIndex : 0 })}
            disabled={playable <= 0}
            aria-label={(hasResume ? 'Resume ' : 'Play ') + (pack.title || 'collection')}
          >
            <PackCover pack={pack} decorative />
            {playable > 0 ? <span className="sx-pk-play">{hasResume ? '▶ RESUME' : '▶ PLAY COLLECTION'}</span> : null}
          </button>

          <div className="sx-pk-meta">
            <div className="sx-pk-kinds">
              <span className="sx-pk-kind">▦ {isDraft ? 'COLLECTION' : 'REEL PACK'}</span>
              <span className={'sx-pk-status' + (isDraft ? ' sx-pk-status--draft' : '')}>{status}</span>
            </div>
            <h1>{pack.title}</h1>
            <div className="sx-pk-creator">
              <span>CURATED BY</span>{' '}
              <Link to={'/profile/' + encodeURIComponent(pack.creator?.username || '')}>@{pack.creator?.username || 'creator'}</Link>
            </div>
            <p>{pack.description || 'An ordered collection of reels.'}</p>
            {place ? <span className="sx-pack-location">{place}</span> : null}
            {pack.tags?.length ? (
              <div className="sx-pk-tags">
                {pack.tags.map((tag) => <Link key={tag} to={'/explore?search=' + encodeURIComponent('#' + tag)}>#{tag}</Link>)}
              </div>
            ) : null}
            {pack.needs_repair ? (
              <div className="sx-pack-repair" role="status">This pack is hidden from discovery until it has at least three available reels.</div>
            ) : null}
          </div>

          <dl className="sx-pk-stats" aria-label="Pack statistics">
            {stats.map(([label, value]) => (
              <div key={label}>
                <dd>{value}</dd>
                <dt>{label}</dt>
              </div>
            ))}
          </dl>

          <div className="sx-pk-actions">
            <button
              type="button"
              className={'sx-pk-act' + (liked ? ' sx-pk-act--on' : '')}
              aria-pressed={liked}
              disabled={busy === 'like'}
              onClick={toggleLike}
            >
              <LikeIcon filled={liked} />{liked ? 'LIKED' : 'LIKE'}
            </button>
            <button
              type="button"
              className={'sx-pk-act' + (pack.saved_by_me ? ' sx-pk-act--on' : '')}
              aria-pressed={!!pack.saved_by_me}
              disabled={busy === 'save'}
              onClick={toggleSave}
            >
              {pack.saved_by_me ? 'SAVED PACK' : 'SAVE PACK'}
            </button>
            <button type="button" className="sx-pk-act" onClick={() => messaging.openShare({ kind: 'pack', id: pack.id, title: pack.title })}>
              SHARE PACK
            </button>
            {hasResume ? (
              <button type="button" className="sx-pk-act" onClick={() => openPlayer({ item: 0, forceRestart: true })}>START OVER</button>
            ) : null}
            {!isOwner ? (
              <button type="button" className="sx-pk-act sx-pk-act--quiet" onClick={openReport}>REPORT</button>
            ) : null}
          </div>

          {isOwner ? (
            <section className="sx-pk-owner" aria-label="Owner controls">
              <header>
                <h2>OWNER CONTROLS</h2>
                <span>REV {pack.revision}</span>
              </header>
              <div className="sx-pk-owner-row">
                {isDraft ? (
                  <>
                    <span className="sx-pk-owner-hint" title={playable < MIN_PUBLISH ? 'Publishing needs at least 3 available reels' : undefined}>
                      {playable < MIN_PUBLISH ? `${playable}/${MIN_PUBLISH} AVAILABLE` : `${playable}/${pack.reel_count ?? 0} READY`}
                    </span>
                    <Button
                      primary
                      loading={busy === 'publish'}
                      disabled={busy !== '' || playable < MIN_PUBLISH}
                      onClick={publishPack}
                    >
                      PUBLISH COLLECTION
                    </Button>
                  </>
                ) : (
                  <Button loading={busy === 'unpublish'} disabled={busy !== ''} onClick={unpublishPack}>
                    MOVE TO DRAFT
                  </Button>
                )}
                <Dropdown
                  label="VISIBILITY"
                  value={pack.visibility || 'public'}
                  options={VISIBILITY_OPTIONS}
                  onChange={changeVisibility}
                />
              </div>
              <div className="sx-pk-owner-row">
                <Button disabled={busy !== ''} onClick={() => navigate('/packs/' + encodeURIComponent(pack.id) + '/edit')}>EDIT PACK</Button>
                <Button
                  className="sx-pk-danger"
                  disabled={busy !== ''}
                  onClick={() => { setDialogError(''); setDialog('delete'); }}
                >
                  DELETE
                </Button>
              </div>
            </section>
          ) : null}
        </section>

        <section className="sx-pk-main" aria-labelledby="sx-pk-list-title">
          <div className="sx-pk-list-head">
            <div>
              <h2 id="sx-pk-list-title">PACK LIST</h2>
              <span>{items.length} {items.length === 1 ? 'REEL' : 'REELS'} · SELECT ANY AVAILABLE REEL TO START THERE</span>
            </div>
            <div className="sx-pk-view-ctl">
              <Segmented options={VIEW_OPTIONS} value={view} onChange={setView} ariaLabel="Pack view" />
              {view === 'gallery' ? <DensityToggle value={density} onChange={setDensity} /> : null}
            </div>
          </div>

          {!items.length ? (
            <p className="sx-pk-empty" role="status">
              This pack has no reels yet.{isOwner ? ' Use EDIT PACK to add some.' : ''}
            </p>
          ) : view === 'gallery' ? (
            <div className={gridClassName(density) + ' sx-pk-gallery'} aria-label="Reels in this pack">
              {items.map((item, index) => (
                item.available && item.post ? (
                  <ExploreTile
                    key={item.id}
                    video={item.post}
                    orderLabel={String(index + 1).padStart(2, '0')}
                    onOpen={() => playItem(index)}
                    onShare={(post) => messaging.openShare({ ...post, kind: 'reel' })}
                  />
                ) : (
                  <div key={item.id} className="sx-pk-gone" role="img" aria-label={`Reel ${index + 1} is unavailable`}>
                    <span>▦</span>
                    <small>REMOVED OR HIDDEN</small>
                  </div>
                )
              ))}
            </div>
          ) : (
            <ol className="sx-pk-list">
              {items.map((item, index) => (
                <ReelRow key={item.id} item={item} index={index} pack={pack} onPlay={playItem} />
              ))}
            </ol>
          )}

          <footer className="sx-pk-foot">
            <span>{playable} OF {pack.reel_count ?? items.length} REELS AVAILABLE</span>
            {runtime.known ? (
              <span>TOTAL RUNTIME: <strong>{formatDuration(runtime.ms)}{runtime.complete ? '' : '+'}</strong></span>
            ) : null}
            {updated && !Number.isNaN(updated.getTime()) ? <span>UPDATED {updated.toLocaleDateString()}</span> : null}
          </footer>
        </section>
      </div>

      {dialog === 'report' ? (
        <Dialog title="REPORT REEL PACK" onClose={() => setDialog('')} busy={busy === 'report'}>
          <form onSubmit={submitReport}>
            <label>
              <span>REASON</span>
              <select aria-label="Report reason" value={reportReason} onChange={(event) => setReportReason(event.target.value)}>
                {REPORT_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>DETAILS (OPTIONAL)</span>
              <textarea
                aria-label="Report details"
                value={reportDetails}
                maxLength={DETAILS_LIMIT}
                rows={4}
                onChange={(event) => setReportDetails(event.target.value)}
              />
              <small>{reportDetails.length}/{DETAILS_LIMIT}</small>
            </label>
            {dialogError ? <div className="sx-pk-dialog-error" role="alert">{dialogError}</div> : null}
            <div className="sx-pk-dialog-actions">
              <Button onClick={() => setDialog('')} disabled={busy === 'report'}>CANCEL</Button>
              <Button primary type="submit" loading={busy === 'report'}>SUBMIT REPORT</Button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {dialog === 'delete' ? (
        <Dialog title="DELETE THIS REEL PACK?" onClose={() => setDialog('')} busy={busy === 'delete'}>
          <p>Existing links and messages will show it as unavailable. Your reels themselves are not deleted.</p>
          {dialogError ? <div className="sx-pk-dialog-error" role="alert">{dialogError}</div> : null}
          <div className="sx-pk-dialog-actions">
            <Button onClick={() => setDialog('')} disabled={busy === 'delete'}>CANCEL</Button>
            <Button className="sx-pk-danger" loading={busy === 'delete'} onClick={deletePack}>DELETE PACK</Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
