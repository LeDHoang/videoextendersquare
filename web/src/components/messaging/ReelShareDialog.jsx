import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../../api/client.js';
import { useAuth } from '../../hooks/AuthContext.jsx';
import { clientId, useMessaging } from '../../hooks/MessagingContext.jsx';

export default function ReelShareDialog() {
  const { user } = useAuth();
  const messaging = useMessaging();
  const navigate = useNavigate();
  const location = useLocation();
  const closeRef = useRef(null);
  const target = messaging.shareTarget;
  // Require an explicit pack kind — reel payloads in pack playback context may
  // carry a pack_id without being a pack share.
  const kind = target?.kind === 'pack' ? 'pack' : 'reel';
  const targetId = kind === 'pack' ? (target?.pack_id || target?.id) : (target?.post_id || target?.id);
  const [metadata, setMetadata] = useState(null);
  const [qrUrl, setQrUrl] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState([]);
  const [note, setNote] = useState('');
  const [delivery, setDelivery] = useState([]);
  const [sending, setSending] = useState(false);
  const [batchId, setBatchId] = useState(() => clientId('share'));

  useEffect(() => {
    if (!targetId) return undefined;
    let alive = true;
    setMetadata(null);
    setQrUrl('');
    setStatus('');
    setSelected([]);
    setDelivery([]);
    setBatchId(clientId('share'));
    const metadataPath = kind === 'pack'
      ? `/api/packs/${encodeURIComponent(targetId)}/share`
      : `/api/posts/${encodeURIComponent(targetId)}/share`;
    api.get(metadataPath)
      .then(async (value) => {
        if (!alive) return;
        setMetadata(value);
        setQrUrl(await QRCode.toDataURL(value.canonical_url, { width: 320, margin: 2, errorCorrectionLevel: 'M' }));
      })
      .catch((error) => alive && setStatus(error.message || 'Could not prepare sharing.'));
    const timer = setTimeout(() => closeRef.current?.focus(), 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [kind, targetId]);

  useEffect(() => {
    if (!target) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') messaging.closeShare();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [messaging, target]);

  useEffect(() => {
    if (!user || !query.trim()) {
      setResults([]);
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api.get('/api/search/suggestions', { q: query, limit: 10 })
        .then((value) => {
          if (alive) setResults((value.users || []).filter((person) => !person.is_me && person.account_type === 'real'));
        })
        .catch(() => alive && setResults([]));
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, user]);

  if (!target) return null;

  const copyLink = async () => {
    if (!metadata?.canonical_url) return;
    try {
      await navigator.clipboard.writeText(metadata.canonical_url);
      setStatus('Link copied.');
    } catch {
      window.prompt(`Copy this ${kind === 'pack' ? 'Reel Pack' : 'reel'} link:`, metadata.canonical_url);
    }
  };

  const nativeShare = async () => {
    if (!metadata?.canonical_url) return;
    if (!navigator.share) return copyLink();
    try {
      await navigator.share({ title: metadata.title, text: metadata.share_text, url: metadata.canonical_url });
    } catch (error) {
      if (error.name !== 'AbortError') setStatus('Native sharing was unavailable.');
    }
  };

  const toggleRecipient = (username) => {
    setSelected((current) => {
      if (current.includes(username)) return current.filter((item) => item !== username);
      if (current.length >= 10) {
        setStatus('Up to 10 recipients per share.');
        return current;
      }
      return [...current, username];
    });
  };

  const sendToRecipients = async (usernames = selected) => {
    if (!user) {
      try {
        sessionStorage.setItem('echo:resume-share', JSON.stringify({
          kind,
          target_id: targetId,
          created_at: Date.now(),
        }));
      } catch {
        // Authentication can continue without persistence.
      }
      navigate('/login?next=' + encodeURIComponent(location.pathname + location.search));
      return;
    }
    if (!usernames.length) return;
    setSending(true);
    setStatus('');
    try {
      const response = await api.post('/api/messages/share-content', {
        kind,
        target_id: targetId,
        usernames,
        note,
        client_id: batchId,
      });
      setDelivery((current) => {
        const retained = current.filter((row) => !usernames.includes(row.username));
        return [...retained, ...(response.results || [])];
      });
      setStatus(`${response.succeeded} delivered${response.failed ? ` · ${response.failed} failed` : ''}.`);
      if (!response.failed) setBatchId(clientId('share'));
      await messaging.refreshAll();
    } catch (error) {
      setStatus(error.message || `Could not share this ${kind === 'pack' ? 'Reel Pack' : 'reel'}.`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="sx-modal-backdrop sx-share-backdrop" role="presentation" onClick={messaging.closeShare}>
      <section className="sx-share-dialog" role="dialog" aria-modal="true" aria-labelledby="sx-share-title" onClick={(event) => event.stopPropagation()}>
        <header>
          <div><small>{kind === 'pack' ? 'SHARE REEL PACK' : 'SHARE REEL'}</small><strong id="sx-share-title">{metadata?.title || target.title || 'Preparing link…'}</strong></div>
          <button ref={closeRef} type="button" onClick={messaging.closeShare} aria-label="Close share dialog">×</button>
        </header>

        {kind === 'pack' && metadata ? (
          <div className="sx-share-pack-preview" role="status" aria-label={`Reel Pack preview: ${metadata.title}`}>
            <span aria-hidden="true">▦</span>
            <span>REEL PACK · {metadata.playable_count ?? metadata.reel_count ?? 0} AVAILABLE{(metadata.playable_count ?? metadata.reel_count ?? 0) === 1 ? '' : 'S'}</span>
            {metadata.creator?.username ? <span>@{metadata.creator.username}</span> : null}
            {metadata.needs_repair ? <span>HIDDEN FROM DISCOVERY UNTIL REPAIRED</span> : null}
          </div>
        ) : null}

        <div className="sx-share-link-row">
          <input readOnly value={metadata?.canonical_url || ''} aria-label={`Canonical ${kind === 'pack' ? 'Reel Pack' : 'reel'} link`} placeholder={metadata ? undefined : 'Preparing link…'} />
          <button type="button" onClick={copyLink} disabled={!metadata}>COPY</button>
          <button type="button" onClick={nativeShare} disabled={!metadata}>{navigator.share ? 'SHARE' : 'COPY'}</button>
        </div>

        <div className="sx-share-grid">
          <div className="sx-share-qr">
            {qrUrl ? <img src={qrUrl} alt={`QR code for the ${kind === 'pack' ? 'Reel Pack' : 'reel'} link`} /> : <div>GENERATING QR…</div>}
            {qrUrl ? <a href={qrUrl} download={`echo-${kind}-${targetId}.png`}>DOWNLOAD PNG</a> : null}
          </div>

          <div className="sx-share-recipients">
            <strong>SEND IN ECHO <span>{selected.length}/10</span></strong>
            {!user ? (
              <button type="button" onClick={() => sendToRecipients([])}>SIGN IN TO MESSAGE</button>
            ) : (
              <>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search people…" aria-label="Search people to share with" />
                <div className="sx-share-people">
                  {results.map((person) => (
                    <button type="button" key={person.id} className={selected.includes(person.username) ? 'sx-active' : ''} onClick={() => toggleRecipient(person.username)} aria-pressed={selected.includes(person.username)}>
                      <span>@{person.username}</span><small>{selected.includes(person.username) ? 'SELECTED' : person.display_name}</small>
                    </button>
                  ))}
                  {!results.length && query.trim() ? <small>No matching people.</small> : null}
                </div>
                <label className="sx-share-note-label" htmlFor="sx-share-note">Optional note</label>
                <textarea id="sx-share-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="Optional note…" />
                <button type="button" onClick={() => sendToRecipients()} disabled={!selected.length || sending || !metadata}>{sending ? 'SENDING…' : `SEND TO ${selected.length || 0}`}</button>
              </>
            )}
          </div>
        </div>

        {delivery.length ? (
          <div className="sx-share-delivery" aria-live="polite">
            {delivery.map((row) => (
              <div key={row.username}><span>@{row.username}</span><strong className={row.ok ? 'sx-ok' : 'sx-fail'}>{row.ok ? 'DELIVERED' : row.message}</strong>{!row.ok ? <button type="button" onClick={() => sendToRecipients([row.username])}>RETRY</button> : null}</div>
            ))}
          </div>
        ) : null}
        {status ? <p className="sx-share-status" role="status">{status}</p> : null}
      </section>
    </div>
  );
}
