import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../hooks/AuthContext.jsx';
import { useMessaging } from '../../hooks/MessagingContext.jsx';

function Avatar({ user }) {
  const label = (user?.display_name || user?.username || '?').trim();
  return (
    <span className="sx-message-avatar" style={{ backgroundColor: user?.avatar_color || 'var(--sx-accent)' }}>
      {user?.avatar_url ? <img src={user.avatar_url} alt="" /> : label.slice(0, 2).toUpperCase()}
    </span>
  );
}

function MessageContent({ message }) {
  if (message.deleted) return <em>Message deleted</em>;
  if (message.encryption_unavailable) return <em>{message.text}</em>;
  if (message.kind === 'gif') {
    return <img className="sx-message-gif" src={message.content?.url} alt={message.content?.title || 'Shared GIF'} />;
  }
  if (message.kind === 'reel') {
    return (
      <div className="sx-message-reel-card">
        {message.post ? (
          <Link to={`/reels?post=${encodeURIComponent(message.post.id)}`}>
            <strong>{message.post.title || 'Shared reel'}</strong>
            <span>@{message.post.creator?.username || 'creator'}</span>
          </Link>
        ) : (
          <span>Reel unavailable</span>
        )}
        {message.content?.text ? <p>{message.content.text}</p> : null}
      </div>
    );
  }
  return <span>{message.content?.emote || message.content?.text || message.text}</span>;
}

function ConversationList({ rows, selectedId, onSelect, empty }) {
  if (!rows.length) return <div className="sx-message-empty">{empty}</div>;
  return rows.map((conversation) => (
    <button
      type="button"
      key={conversation.id}
      className={`sx-conversation-row ${selectedId === conversation.id ? 'sx-active' : ''}`}
      onClick={() => onSelect(conversation.id)}
    >
      <Avatar user={conversation.participant} />
      <span className="sx-conversation-copy">
        <strong>{conversation.participant.display_name || `@${conversation.participant.username}`}</strong>
        <small>{conversation.last_message?.deleted ? 'Message deleted' : conversation.last_message?.text || conversation.last_message?.kind || 'New conversation'}</small>
      </span>
      {conversation.unread_count ? <span className="sx-message-badge">{conversation.unread_count}</span> : null}
    </button>
  ));
}

export default function MessagingPanel({ compact = false, onConversationRoute }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const messaging = useMessaging();
  const [box, setBox] = useState('inbox');
  const [newMessage, setNewMessage] = useState(false);
  const [userQuery, setUserQuery] = useState('');
  const [userResults, setUserResults] = useState([]);
  const [gifOpen, setGifOpen] = useState(false);
  const [gifQuery, setGifQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [gifBusy, setGifBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const historyRef = useRef(null);
  const rows = box === 'requests' ? messaging.requests : messaging.inbox;
  const selected = useMemo(
    () => [...messaging.inbox, ...messaging.requests].find((item) => item.id === messaging.selectedId) || null,
    [messaging.inbox, messaging.requests, messaging.selectedId],
  );
  const messageKey = messaging.selectedId || (messaging.composeUsername ? `user:${messaging.composeUsername}` : '');
  const history = messaging.messages[messageKey] || [];
  const pendingOutgoingRequest = selected?.state === 'pending' && selected.requester_id === user?.id && selected.last_message;

  useEffect(() => {
    const node = historyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [history.length, messaging.selectedId]);

  useEffect(() => {
    if (!newMessage || !userQuery.trim()) {
      setUserResults([]);
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api.get('/api/search/suggestions', { q: userQuery, limit: 8 })
        .then((result) => {
          if (alive) setUserResults((result.users || []).filter((person) => !person.is_me && person.account_type === 'real'));
        })
        .catch(() => alive && setUserResults([]));
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [newMessage, userQuery]);

  const select = (conversationId) => {
    messaging.selectConversation(conversationId, { dock: compact });
    setNewMessage(false);
    onConversationRoute?.(conversationId);
  };

  const chooseUser = (username) => {
    messaging.composeTo(username, { dock: compact });
    setNewMessage(false);
    setUserQuery('');
    if (!compact) navigate(`/messages?user=${encodeURIComponent(username)}`);
  };

  const submit = async (event) => {
    event.preventDefault();
    const text = messaging.draft.trim();
    if (!text) return;
    try {
      const result = await messaging.send({ kind: 'text', text });
      const conversationId = result.conversation?.id || messaging.selectedId;
      if (!compact && conversationId) onConversationRoute?.(conversationId);
    } catch {
      // Shared state renders the request error.
    }
  };

  const sendEmote = async (emote) => {
    try {
      await messaging.send({ kind: 'emote', emote });
    } catch {
      // Shared state renders the request error.
    }
  };

  const searchGifs = async (event) => {
    event.preventDefault();
    if (!gifQuery.trim()) return;
    setGifBusy(true);
    setLocalError('');
    try {
      const result = await api.get('/api/messages/gifs/search', { q: gifQuery, limit: 18 });
      setGifs(result.results || []);
    } catch (requestError) {
      setGifs([]);
      setLocalError(requestError.message || 'GIF search is unavailable.');
    } finally {
      setGifBusy(false);
    }
  };

  const sendGif = async (gif) => {
    try {
      await messaging.send({
        kind: 'gif',
        gif_url: gif.url,
        gif_preview_url: gif.preview_url,
        gif_title: gif.title,
      });
      setGifOpen(false);
    } catch {
      // Shared state renders the request error.
    }
  };

  const reportMessage = async (message) => {
    const reason = window.prompt('Report reason: spam, harassment, hate, sexual, violence, impersonation, privacy, or other');
    if (!reason) return;
    const details = window.prompt('Optional details') || '';
    try {
      await api.post('/api/reports', { target_type: 'message', target_id: message.id, reason, details });
      window.alert('Report submitted.');
    } catch (requestError) {
      setLocalError(requestError.message || 'Could not report message.');
    }
  };

  const blockParticipant = async () => {
    if (!selected || !window.confirm(`Block @${selected.participant.username}?`)) return;
    try {
      await api.put(`/api/users/${encodeURIComponent(selected.participant.username)}/block`);
      messaging.selectConversation(null);
      await messaging.refreshAll();
    } catch (requestError) {
      setLocalError(requestError.message || 'Could not block this user.');
    }
  };

  return (
    <section className={`sx-messaging-panel ${compact ? 'sx-messaging-panel--compact' : ''}`}>
      <aside className="sx-message-sidebar">
        <div className="sx-message-tabs" role="tablist" aria-label="Message boxes">
          <button type="button" className={box === 'inbox' ? 'sx-active' : ''} onClick={() => setBox('inbox')}>
            INBOX {messaging.unread.inbox ? <span>{messaging.unread.inbox}</span> : null}
          </button>
          <button type="button" className={box === 'requests' ? 'sx-active' : ''} onClick={() => setBox('requests')}>
            REQUESTS {messaging.unread.requests ? <span>{messaging.unread.requests}</span> : null}
          </button>
        </div>
        <button type="button" className="sx-message-new" onClick={() => setNewMessage((value) => !value)}>+ NEW MESSAGE</button>
        {newMessage ? (
          <div className="sx-message-user-search">
            <input value={userQuery} onChange={(event) => setUserQuery(event.target.value)} placeholder="Search username…" autoFocus />
            {userResults.map((person) => (
              <button type="button" key={person.id} onClick={() => chooseUser(person.username)}>
                <Avatar user={person} /><span><strong>@{person.username}</strong><small>{person.display_name}</small></span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="sx-conversation-list">
          <ConversationList
            rows={rows}
            selectedId={messaging.selectedId}
            onSelect={select}
            empty={box === 'requests' ? 'No message requests.' : 'No conversations yet.'}
          />
        </div>
      </aside>

      <div className="sx-message-thread">
        {selected || messaging.composeUsername ? (
          <>
            <header className="sx-message-thread-head">
              <div>
                <strong>@{selected?.participant.username || messaging.composeUsername}</strong>
                <small>{selected?.state === 'pending' ? 'MESSAGE REQUEST' : 'DIRECT MESSAGE'}</small>
              </div>
              {selected ? (
                <div>
                  <Link to={`/profile/${encodeURIComponent(selected.participant.username)}`}>PROFILE</Link>
                  <button type="button" onClick={blockParticipant}>BLOCK</button>
                </div>
              ) : null}
            </header>

            {selected?.is_request ? (
              <div className="sx-message-request-actions">
                <span>Accept this request to continue the conversation.</span>
                <button type="button" onClick={() => messaging.decideRequest(selected.id, 'decline')}>DECLINE</button>
                <button type="button" onClick={() => messaging.decideRequest(selected.id, 'accept')}>ACCEPT</button>
              </div>
            ) : null}

            <div className="sx-message-history" ref={historyRef} aria-live="polite">
              {messaging.historyCursors[messaging.selectedId] ? (
                <button type="button" className="sx-message-load" onClick={() => messaging.loadConversation(messaging.selectedId, { before: messaging.historyCursors[messaging.selectedId] })}>
                  LOAD EARLIER
                </button>
              ) : null}
              {!history.length ? <div className="sx-message-empty">Start the conversation.</div> : null}
              {history.map((message) => {
                const mine = message.sender_id === user?.id;
                return (
                  <article key={message.id} className={`sx-message-bubble ${mine ? 'sx-mine' : ''} ${message.pending ? 'sx-pending' : ''}`}>
                    <MessageContent message={message} />
                    <footer>
                      <time>{message.created_at ? new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</time>
                      {mine && message.read_by_recipient ? <span>READ</span> : null}
                      {message.can_delete ? <button type="button" onClick={() => messaging.deleteMessage(message.id, message.conversation_id)}>DELETE</button> : null}
                      {message.can_report ? <button type="button" onClick={() => reportMessage(message)}>REPORT</button> : null}
                    </footer>
                  </article>
                );
              })}
            </div>

            {pendingOutgoingRequest ? (
              <div className="sx-message-pending-note">Waiting for @{selected.participant.username} to accept your request.</div>
            ) : (
              <form className="sx-message-composer" onSubmit={submit}>
                <textarea
                  value={messaging.draft}
                  onChange={(event) => messaging.setDraft(event.target.value)}
                  maxLength={2000}
                  placeholder="Write a message…"
                  aria-label="Message"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) submit(event);
                  }}
                />
                <div className="sx-message-compose-actions">
                  <details className="sx-emote-picker">
                    <summary aria-label="Choose an emote">☺</summary>
                    <div>{(messaging.capabilities?.curated_emotes || []).map((emote) => <button type="button" key={emote} onClick={() => sendEmote(emote)}>{emote}</button>)}</div>
                  </details>
                  <button type="button" onClick={() => setGifOpen((value) => !value)} disabled={!messaging.capabilities?.gifs?.available}>GIF</button>
                  <button type="submit" disabled={messaging.busy || !messaging.draft.trim()}>{messaging.busy ? 'SENDING…' : 'SEND'}</button>
                </div>
              </form>
            )}

            {gifOpen ? (
              <div className="sx-gif-picker">
                <form onSubmit={searchGifs}><input value={gifQuery} onChange={(event) => setGifQuery(event.target.value)} placeholder="Search Tenor…" /><button>{gifBusy ? '…' : 'SEARCH'}</button></form>
                <div>{gifs.map((gif) => <button type="button" key={gif.id + gif.url} onClick={() => sendGif(gif)}><img src={gif.preview_url} alt={gif.title} /></button>)}</div>
                <small>Powered by Tenor</small>
              </div>
            ) : null}
          </>
        ) : (
          <div className="sx-message-thread-placeholder">Select a conversation or start a new message.</div>
        )}
        {localError || messaging.error ? <div className="sx-message-error" role="alert">{localError || messaging.error}</div> : null}
      </div>
    </section>
  );
}
