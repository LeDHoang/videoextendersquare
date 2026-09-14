import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../hooks/AuthContext.jsx';
import { clientId } from '../../hooks/MessagingContext.jsx';
import PackCover from './PackCover.jsx';

export default function PackTile({ pack, onOpen, onShare, onChanged, ownerActions = false, source = 'pack_tile' }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const tileRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const location = [pack.location?.city, pack.location?.country].filter(Boolean).join(', ');

  useEffect(() => {
    const node = tileRef.current;
    if (!node || !pack.id) return undefined;
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
    if (typeof IntersectionObserver === 'undefined') {
      record();
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        record();
        observer.disconnect();
      }
    }, { threshold: 0.35 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [pack.id, source]);

  const toggleSave = async (event) => {
    event.stopPropagation();
    if (!user) {
      navigate('/login?next=' + encodeURIComponent('/packs/' + pack.id));
      return;
    }
    if (saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const result = pack.saved_by_me
        ? await api.delete(`/api/packs/${encodeURIComponent(pack.id)}/save`)
        : await api.put(`/api/packs/${encodeURIComponent(pack.id)}/save`);
      onChanged?.({ ...pack, saved_by_me: result.saved, saves: result.saves });
    } catch (requestError) {
      setSaveError(requestError.message || 'Could not save this pack.');
    } finally {
      setSaving(false);
    }
  };

  const openPack = () => {
    if (pack?.id) onOpen?.(pack);
  };

  return (
    <article
      ref={tileRef}
      className="sx-pack-tile"
      role="group"
      aria-label={`Reel Pack: ${pack.title}, ${pack.reel_count} reels, by ${pack.creator?.username || 'creator'}`}
    >
      <button type="button" className="sx-pack-tile-open" onClick={openPack} aria-label={`Open Reel Pack ${pack.title}`}>
        <PackCover pack={pack} decorative />
      </button>
      <div className="sx-pack-tile-copy">
        <div className="sx-pack-tile-kicker">
          <span aria-hidden="true">▦</span>
          <span>REEL PACK</span>
          <span>{pack.reel_count} REELS</span>
        </div>
        <strong title={pack.title}>{pack.title}</strong>
        <button
          type="button"
          className="sx-pack-tile-creator"
          onClick={(event) => {
            event.stopPropagation();
            const username = pack.creator?.username || '';
            if (username) navigate('/profile/' + encodeURIComponent(username));
          }}
          disabled={!pack.creator?.username}
        >
          @{pack.creator?.username || 'creator'}
        </button>
        {location ? <small>{location}</small> : null}
        {pack.needs_repair ? <span className="sx-pack-warning" role="status">NEEDS REPAIR · HIDDEN FROM DISCOVERY</span> : null}
        {saveError ? <span className="sx-pack-warning" role="alert">{saveError}</span> : null}
      </div>
      <div className="sx-pack-tile-actions">
        <button type="button" onClick={openPack}>
          OPEN PACK
        </button>
        <button type="button" disabled={saving} onClick={toggleSave} aria-pressed={!!pack.saved_by_me}>
          {pack.saved_by_me ? 'SAVED' : 'SAVE PACK'}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onShare?.({ kind: 'pack', id: pack.id, title: pack.title });
          }}
        >
          SHARE
        </button>
        {ownerActions && pack.viewer_state?.can_edit ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              navigate(`/packs/${encodeURIComponent(pack.id)}/edit`);
            }}
          >
            EDIT
          </button>
        ) : null}
      </div>
    </article>
  );
}
