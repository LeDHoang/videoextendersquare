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
  const postId = target?.post_id || target?.id;
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
    if (!postId) return undefined;
    let alive = true;
    setMetadata(null);
    setQrUrl('');
    setStatus('');
    setSelected([]);
    setDelivery([]);
    setBatchId(clientId('share'));
    api.get(`/api/posts/${encodeURIComponent(postId)}/share`)
      .then(async (value) => {
        if (!alive) return;
        setMetadata(value);
        setQrUrl(await QRCode.toDataURL(value.canonical_url, { width: 320, margin: 2, errorCorrectionLevel: 'M' }));
      })
      .catch((error) => alive && setStatus(error.message || 'Could not prepare sharing.'));
    setTimeout(() => closeRef.current?.focus(), 0);
    return () => { alive = false; };
  }, [postId]);

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
    try {
      await navigator.clipboard.writeText(metadata.canonical_url);
      setStatus('Link copied.');
    } catch {
      window.prompt('Copy this reel link:', metadata.canonical_url);
    }
  };

  const nativeShare = async () => {
    if (!navigator.share) return copyLink();
    try {
      await navigator.share({ title: metadata.title, text: metadata.share_text, url: metadata.canonical_url });
    } catch (error) {
      if (error.name !== 'AbortError') setStatus('Native sharing was unavailable.');
    }
  };

  const toggleRecipient = (username) => {
    setSelected((current) => current.includes(username)
      ? current.filter((item) => item !== username)
      : current.length < 10 ? [...current, username] : current);
  };

  const sendToRecipients = async (usernames = selected) => {
    if (!user) {
      try {
        sessionStorage.setItem('echo:resume-share', JSON.stringify({ post_id: postId, created_at: Date.now() }));
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
      const response = await api.post('/api/messages/share-reel', {
        post_id: postId,
        usernames,
        note,
        client_id: batchId,
      });
      setDelivery((current) => {
        const retained = current.filter((row) => !usernames.includes(row.username));
        return [...retained, ...(response.results || [])];
      });
      setStatus(`${response.succeeded} delivered${response.failed ? ` · ${response.failed} failed` : ''}.`);
      await messaging.refreshAll();
    } catch (error) {
      setStatus(error.message || 'Could not share reel.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="sx-modal-backdrop sx-share-backdrop" role="presentation" onMouseDown={messaging.closeShare}>
      <section className="sx-share-dialog" role="dialog" aria-modal="true" aria-labelledby="sx-share-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><small>SHARE REEL</small><strong id="sx-share-title">{metadata?.title || target.title || 'Preparing link…'}</strong></div>
          <button ref={closeRef} type="button" onClick={messaging.closeShare} aria-label="Close share dialog">×</button>
        </header>

        <div className="sx-share-link-row">
          <input readOnly value={metadata?.canonical_url || ''} aria-label="Canonical reel link" />
          <button type="button" onClick={copyLink} disabled={!metadata}>COPY</button>
          <button type="button" onClick={nativeShare} disabled={!metadata}>{navigator.share ? 'SHARE' : 'COPY'}</button>
        </div>

        <div className="sx-share-grid">
          <div className="sx-share-qr">
            {qrUrl ? <img src={qrUrl} alt="QR code for the reel link" /> : <div>GENERATING QR…</div>}
            {qrUrl ? <a href={qrUrl} download={`echo-reel-${postId}.png`}>DOWNLOAD PNG</a> : null}
          </div>

          <div className="sx-share-recipients">
            <strong>SEND IN ECHO <span>{selected.length}/10</span></strong>
            {!user ? (
              <button type="button" onClick={() => sendToRecipients([])}>SIGN IN TO MESSAGE</button>
            ) : (
              <>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search people…" />
                <div className="sx-share-people">
                  {results.map((person) => (
                    <button type="button" key={person.id} className={selected.includes(person.username) ? 'sx-active' : ''} onClick={() => toggleRecipient(person.username)}>
                      <span>@{person.username}</span><small>{selected.includes(person.username) ? 'SELECTED' : person.display_name}</small>
                    </button>
                  ))}
                </div>
                <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="Optional note…" />
                <button type="button" onClick={() => sendToRecipients()} disabled={!selected.length || sending}>{sending ? 'SENDING…' : `SEND TO ${selected.length || 0}`}</button>
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
