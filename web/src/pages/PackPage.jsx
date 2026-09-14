import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import PackCover from '../components/packs/PackCover.jsx';
import ReelsPlayer from '../components/ui/ReelsPlayer.jsx';
import { Button, Dropdown } from '../components/ui/controls.jsx';
import { EmptyState, Hero } from '../components/ui/primitives.jsx';
import { ExploreGridSkeleton } from '../components/ui/Skeleton.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';
import { clientId, useMessaging } from '../hooks/MessagingContext.jsx';

const VISIBILITY_OPTIONS = [
  { label: 'PUBLIC · DISCOVERABLE', value: 'public' },
  { label: 'UNLISTED · LINK ONLY', value: 'unlisted' },
];

export default function PackPage() {
  const { packId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const messaging = useMessaging();
  const [pack, setPack] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const playing = searchParams.get('play') === '1';
  const rawRequestedItem = Number(searchParams.get('item'));
  const requestedItem = Number.isFinite(rawRequestedItem) ? Math.max(0, Math.trunc(rawRequestedItem)) : 0;
  const restart = searchParams.get('restart') === '1';

  const load = useCallback(async ({ recordOpen = true } = {}) => {
    setError('');
    try {
      const result = await api.get('/api/packs/' + encodeURIComponent(packId));
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
      setPack(null);
      setError(requestError.message || 'This Reel Pack is unavailable.');
    }
  }, [packId]);

  useEffect(() => {
    load();
  }, [load]);

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

  const toggleSave = async () => {
    if (!pack) return;
    if (!user) {
      navigate('/login?next=' + encodeURIComponent('/packs/' + pack.id));
      return;
    }
    setBusy('save');
    try {
      const result = pack.saved_by_me
        ? await api.delete(`/api/packs/${encodeURIComponent(pack.id)}/save`)
        : await api.put(`/api/packs/${encodeURIComponent(pack.id)}/save`);
      setPack((current) => ({ ...current, saved_by_me: result.saved, saves: result.saves }));
    } catch (requestError) {
      setError(requestError.message || 'Could not update this saved pack.');
    } finally {
      setBusy('');
    }
  };

  const reportPack = async () => {
    if (!user) {
      navigate('/login?next=' + encodeURIComponent('/packs/' + pack.id));
      return;
    }
    const reason = window.prompt('Report reason: spam, harassment, hate, sexual, violence, impersonation, privacy, or other');
    if (!reason) return;
    const details = window.prompt('Optional details') || '';
    try {
      await api.post('/api/reports', { target_type: 'pack', target_id: pack.id, reason, details });
      window.alert('Report submitted. Thank you.');
    } catch (requestError) {
      setError(requestError.message || 'Could not report this Reel Pack.');
    }
  };

  const changeVisibility = async (visibility) => {
    setBusy('visibility');
    try {
      const result = await api.patch(`/api/packs/${encodeURIComponent(pack.id)}`, {
        visibility,
        expected_revision: pack.revision,
      });
      setPack((current) => ({ ...current, ...result.pack }));
    } catch (requestError) {
      setError(requestError.message || 'Could not update this collection visibility.');
      load({ recordOpen: false });
    } finally {
      setBusy('');
    }
  };

  const publishPack = async () => {
    if ((pack.playable_count ?? 0) < 3) return;
    setBusy('publish');
    try {
      const result = await api.post(`/api/packs/${encodeURIComponent(pack.id)}/publish`, {
        expected_revision: pack.revision,
      });
      setPack(result.pack);
    } catch (requestError) {
      setError(requestError.message || 'Could not publish this collection.');
      await load({ recordOpen: false });
    } finally {
      setBusy('');
    }
  };

  const deletePack = async () => {
    if (!window.confirm('Delete this Reel Pack? Existing links and messages will show it as unavailable.')) return;
    setBusy('delete');
    try {
      const query = '?expected_revision=' + encodeURIComponent(String(pack.revision));
      await api.delete('/api/packs/' + encodeURIComponent(pack.id) + query, { expected_revision: pack.revision });
      navigate('/profile/' + encodeURIComponent(pack.creator?.username || user?.username || '') + '?tab=packs');
    } catch (requestError) {
      setError(requestError.message || 'Could not delete this Reel Pack.');
      setBusy('');
    }
  };

  if (error && !pack) {
    return <EmptyState title="REEL PACK UNAVAILABLE" text={error} hint={packId} />;
  }
  if (!pack) return <ExploreGridSkeleton label="Loading Reel Pack" />;

  if (playing) {
    const playableTotal = Math.max(0, Number(pack.playable_count ?? pack.items?.filter((item) => item.available).length ?? 0));
    const clampedIndex = pack.items?.length ? Math.min(requestedItem, pack.items.length - 1) : 0;
    return (
      <div className="sx-pack-player-page">
        <div className="sx-pack-player-toolbar">
          <Button onClick={closePlayer}>← PACK DETAILS</Button>
          <strong>▦ {pack.title}</strong>
          <span>{playableTotal} AVAILABLE</span>
        </div>
        <ReelsPlayer
          params={{ pack_id: pack.id, restart }}
          initialIndex={clampedIndex}
        />
      </div>
    );
  }

  const isDraft = pack.status === 'draft';
  const resumeItemId = pack.progress?.current_item_id || null;
  const resumeIndexById = resumeItemId ? pack.items?.findIndex((item) => item.id === resumeItemId) : -1;
  const resumeIndex = resumeIndexById >= 0 ? resumeIndexById : (pack.progress?.item_index || 0);
  const hasResume = pack.progress?.phase === 'playing' && !!resumeItemId && resumeIndexById >= 0;

  return (
    <div className="sx-pack-page">
      <Hero title={pack.title} kicker="REEL PACK · AUTHORED PLAYBACK · FINITE SEQUENCE" />
      {error ? <div className="sx-error-box" role="alert">{error}</div> : null}
      <section className="sx-pack-hero">
        <button
          type="button"
          className="sx-pack-hero-cover"
          onClick={() => openPlayer({ item: hasResume ? resumeIndex : 0 })}
          disabled={(pack.playable_count ?? 0) <= 0}
          aria-label={'Play ' + (pack.title || 'collection')}
        >
          <PackCover pack={pack} className="sx-pack-cover--hero" />
          <span className="sx-pack-hero-play">{hasResume ? '▶ RESUME' : '▶ PLAY COLLECTION'}</span>
        </button>
        <div className="sx-pack-hero-copy">
          <span className="sx-pack-label">▦ {isDraft ? 'COLLECTION · DRAFT' : 'REEL PACK'}</span>
          <h2>{pack.title}</h2>
          <span className="sx-pack-curated">
            CURATED BY{' '}
            <Link to={'/profile/' + encodeURIComponent(pack.creator?.username || '')}>
              @{pack.creator?.username || 'creator'}
            </Link>
          </span>
          <p>{pack.description || 'An ordered collection of reels.'}</p>
          <div className="sx-pack-facts">
            <span>{pack.reel_count} REELS</span>
            <span>{pack.playable_count} AVAILABLE</span>
            <span>{(pack.visibility || 'public').toUpperCase()}</span>
            <span>REV {pack.revision}</span>
            <span>{pack.likes ?? 0} LIKES</span>
            <span>{pack.views ?? 0} VIEWS</span>
            <span>{pack.comments ?? 0} COMMENTS</span>
          </div>
          {[pack.location?.city, pack.location?.country].filter(Boolean).length ? (
            <span className="sx-pack-location">
              {[pack.location?.city, pack.location?.country].filter(Boolean).join(', ')}
            </span>
          ) : null}
          {pack.tags?.length ? (
            <div className="sx-pack-tags">
              {pack.tags.map((tag) => <Link key={tag} to={'/explore?search=' + encodeURIComponent('#' + tag)}>#{tag}</Link>)}
            </div>
          ) : null}
          {pack.needs_repair ? (
            <div className="sx-pack-repair" role="status">This pack is hidden from discovery until it has at least three available reels.</div>
          ) : null}
          <div className="sx-pack-actions">
            <Button loading={busy === 'save'} disabled={busy === 'save'} onClick={toggleSave}>
              {pack.saved_by_me ? 'SAVED PACK' : 'SAVE PACK'}
            </Button>
            <Button onClick={() => messaging.openShare({ kind: 'pack', id: pack.id, title: pack.title })}>SHARE PACK</Button>
            {pack.viewer_state?.can_edit && isDraft ? (
              <>
                <span
                  className="sx-pack-publish-hint"
                  title={(pack.playable_count ?? 0) < 3 ? 'Publishing needs at least 3 available reels' : undefined}
                >
                  {(pack.playable_count ?? 0) < 3
                    ? `${pack.playable_count ?? 0}/3 AVAILABLE`
                    : `${pack.playable_count ?? 0}/${pack.reel_count ?? 0} READY`}
                </span>
                <Button
                  primary
                  loading={busy === 'publish'}
                  disabled={busy === 'publish' || busy === 'visibility' || (pack.playable_count ?? 0) < 3}
                  onClick={publishPack}
                >
                  PUBLISH COLLECTION
                </Button>
                <Dropdown
                  value={pack.visibility || 'public'}
                  options={VISIBILITY_OPTIONS}
                  onChange={changeVisibility}
                />
              </>
            ) : null}
            {pack.viewer_state?.can_edit ? (
              <>
                <Button onClick={() => navigate('/packs/' + encodeURIComponent(pack.id) + '/edit')}>EDIT PACK</Button>
                <Button loading={busy === 'delete'} disabled={busy === 'delete'} onClick={deletePack}>DELETE</Button>
              </>
            ) : <Button onClick={reportPack}>REPORT PACK</Button>}
          </div>
        </div>
      </section>

      <section className="sx-pack-tracklist" aria-labelledby="sx-pack-tracklist-title">
        <div className="sx-pack-tracklist-head">
          <h2 id="sx-pack-tracklist-title">PACK ORDER</h2>
          <span>SELECT ANY AVAILABLE REEL TO START THERE</span>
        </div>
        {pack.items.map((item, index) => (
          <button
            type="button"
            key={item.id}
            className="sx-pack-track"
            disabled={!item.available}
            onClick={() => openPlayer({ item: index, forceRestart: true })}
          >
            <span className="sx-pack-track-number">{String(index + 1).padStart(2, '0')}</span>
            {item.post?.poster_url || (item.post?.media_type === 'image' && (item.post.preview_url || item.post.url)) ? (
              <img src={item.post.poster_url || item.post.preview_url || item.post.url} alt="" loading="lazy" />
            ) : <span className="sx-pack-track-placeholder">▦</span>}
            <span className="sx-pack-track-copy">
              <strong>{item.post?.title || 'Reel unavailable'}</strong>
              <small>{item.available ? `@${item.post.creator?.username || pack.creator?.username || 'creator'}` : 'REMOVED OR HIDDEN'}</small>
            </span>
            <span>{item.available ? 'PLAY' : 'UNAVAILABLE'}</span>
          </button>
        ))}
      </section>
    </div>
  );
}
