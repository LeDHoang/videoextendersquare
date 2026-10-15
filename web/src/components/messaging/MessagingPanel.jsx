import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../hooks/AuthContext.jsx';
import { clientId, useMessaging } from '../../hooks/MessagingContext.jsx';
import {
  REPORT_REASONS,
  clockTime,
  dayKey,
  dayLabel,
  lastMessagePreview,
  listTime,
  matchesConversation,
} from '../../utils/messageFormat.js';
import PackCover from '../packs/PackCover.jsx';

const TEXT_LIMIT = 2000;
const COUNTER_FROM = 1600;
const REPORT_DETAILS_LIMIT = 500;

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
    if (!message.post) {
      return (
        <div className="sx-message-reel-card">
          <span>Reel unavailable</span>
          {message.content?.text ? <p>{message.content.text}</p> : null}
        </div>
      );
    }
    const post = message.post;
    const isImage = post.media_type === 'image';
    const src = post.preview_url || post.url;
    const link = `/reels?post=${encodeURIComponent(post.id)}`;
    const fileStem = (post.path || '').split('/').pop()?.replace(/\.[^.]+$/, '') || '';
    const reelName = post.title || fileStem || 'Shared reel';
    return (
      <div className="sx-message-reel-card">
        <Link to={link} className="sx-message-reel-preview" aria-label={`Open reel ${post.title || ''}`}>
          {isImage ? (
            <img src={src} alt={post.title || 'Shared reel'} loading="lazy" />
          ) : (
            <video
              src={src}
              poster={post.poster_url || undefined}
              muted
              loop
              playsInline
              autoPlay
              preload="metadata"
              disablePictureInPicture
            />
          )}
          <span className="sx-message-reel-play" aria-hidden="true">▶</span>
        </Link>
        <Link to={link} className="sx-message-reel-meta">
          <strong title={reelName}>{reelName}</strong>
          <span>@{post.creator?.username || 'creator'}</span>
        </Link>
        {message.content?.text ? <p>{message.content.text}</p> : null}
      </div>
    );
  }
  if (message.kind === 'pack') {
    if (!message.pack) {
      return (
        <div className="sx-message-pack-card sx-message-pack-card--unavailable">
          <span>▦ REEL PACK</span>
          <strong>Reel Pack unavailable</strong>
          <small>This collection was removed or you no longer have access.</small>
          {message.content?.text ? <p>{message.content.text}</p> : null}
        </div>
      );
    }
    const pack = message.pack;
    const link = `/packs/${encodeURIComponent(pack.id)}`;
    const recordOpen = () => {
      api.post('/api/events', {
        event_type: 'pack_message_open',
        pack_id: pack.id,
        source: 'messages',
        client_event_id: clientId('pack-message-open'),
        context: { message_id: message.id },
      }).catch(() => {});
    };
    return (
      <div className="sx-message-pack-card">
        <Link to={link} className="sx-message-pack-preview" aria-label={`Open Reel Pack ${pack.title}`} onClick={recordOpen}>
          <PackCover pack={pack} decorative />
        </Link>
        <div className="sx-message-pack-meta">
          <span>▦ REEL PACK</span>
          <Link to={link} onClick={recordOpen}><strong>{pack.title}</strong></Link>
          <small>CURATED BY @{pack.creator?.username || 'creator'} · {pack.reel_count} REELS</small>
          <Link to={link} className="sx-message-pack-open" onClick={recordOpen}>OPEN PACK</Link>
        </div>
        {message.content?.text ? <p>{message.content.text}</p> : null}
      </div>
    );
  }
  return <span>{message.content?.emote || message.content?.text || message.text}</span>;
}

function ConversationList({ rows, selectedId, onSelect, empty, viewerId }) {
  if (!rows.length) return <div className="sx-message-empty">{empty}</div>;
  return rows.map((conversation) => (
    <button
      type="button"
      key={conversation.id}
      className={`sx-conversation-row ${selectedId === conversation.id ? 'sx-active' : ''} ${conversation.unread_count ? 'sx-unread' : ''}`}
      aria-current={selectedId === conversation.id ? 'true' : undefined}
      onClick={() => onSelect(conversation.id)}
    >
      <Avatar user={conversation.participant} />
      <span className="sx-conversation-copy">
        <span className="sx-conversation-top">
          <strong>{conversation.participant.display_name || `@${conversation.participant.username}`}</strong>
          <time>{listTime(conversation.last_message?.created_at || conversation.updated_at)}</time>
        </span>
        <small>{lastMessagePreview(conversation, viewerId)}</small>
      </span>
      {conversation.unread_count ? <span className="sx-message-badge" aria-label={`${conversation.unread_count} unread`}>{conversation.unread_count}</span> : null}
    </button>
  ));
}

function notice(selected, pendingOutgoingRequest) {
  if (!selected) return '';
  if (selected.blocked) return 'Messaging is unavailable — one of you has blocked the other.';
  if (selected.state === 'declined') return 'This message request was declined.';
  if (pendingOutgoingRequest) return `Waiting for @${selected.participant.username} to accept your request.`;
  if (selected.participant?.status && selected.participant.status !== 'active') return 'This account is no longer available.';
  if (selected.can_message === false) return 'You can no longer reply in this conversation.';
  return '';
}

export default function MessagingPanel({ compact = false, onConversationRoute }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const messaging = useMessaging();
  const [box, setBox] = useState('inbox');
  const [filter, setFilter] = useState('');
  const [newMessage, setNewMessage] = useState(false);
  const [userQuery, setUserQuery] = useState('');
  const [userResults, setUserResults] = useState([]);
  const [userSearch, setUserSearch] = useState('idle');
  const [gifOpen, setGifOpen] = useState(false);
  const [gifQuery, setGifQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [gifBusy, setGifBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [localNotice, setLocalNotice] = useState('');
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [reportTarget, setReportTarget] = useState(null);
  const [reportForm, setReportForm] = useState({ reason: 'spam', details: '' });
  const [actionBusy, setActionBusy] = useState('');
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [listError, setListError] = useState('');
  const historyRef = useRef(null);
  const composerRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const lastSeenRef = useRef({ key: '', last: '', open: false });
  const focusComposerRef = useRef(false);
  // scrollHeight/scrollTop before older messages prepend, so the view can be pinned after render.
  const restoreScrollRef = useRef(null);

  const rows = box === 'requests' ? messaging.requests : messaging.inbox;
  const visibleRows = useMemo(() => rows.filter((row) => matchesConversation(row, filter)), [rows, filter]);
  const selected = useMemo(
    () => [...messaging.inbox, ...messaging.requests].find((item) => item.id === messaging.selectedId) || null,
    [messaging.inbox, messaging.requests, messaging.selectedId],
  );
  const messageKey = messaging.selectedId || (messaging.composeUsername ? `user:${messaging.composeUsername}` : '');
  const history = messaging.messages[messageKey] || [];
  const lastMessageId = history[history.length - 1]?.id || '';
  const threadOpen = Boolean(selected || messaging.composeUsername);
  const pendingOutgoingRequest = selected?.state === 'pending' && selected.requester_id === user?.id && selected.last_message;
  const composeBlockedReason = notice(selected, pendingOutgoingRequest);
  const boxCursor = messaging.boxCursors?.[box] || null;
  const boxLoading = Boolean(messaging.boxLoadingMore?.[box]);
  const historyCursor = messaging.historyCursors[messaging.selectedId] || null;
  const draftLength = messaging.draft.length;
  const error = localError || messaging.error;

  // A short list/thread that doesn't overflow can't be scrolled, so keep paging
  // until it does (or runs out), otherwise scroll-to-load would never fire.
  useEffect(() => {
    const node = historyRef.current;
    if (node && historyCursor && !loadingEarlier && node.clientHeight > 0 && node.scrollHeight <= node.clientHeight + 1) loadEarlier();
  }, [history.length, historyCursor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Older messages prepended: keep the reader on the message they were looking at.
  useLayoutEffect(() => {
    const node = historyRef.current;
    const saved = restoreScrollRef.current;
    if (!node || saved === null) return;
    restoreScrollRef.current = null;
    node.scrollTop = saved.top + (node.scrollHeight - saved.height);
  }, [history.length]);

  // Follow new messages only when the reader is already at the bottom (or just
  // opened the thread, or the thread pane just became visible); never yank them
  // away from older messages they loaded.
  useLayoutEffect(() => {
    const node = historyRef.current;
    if (!node) return;
    const previous = lastSeenRef.current;
    const opened = previous.key !== messageKey || !previous.open;
    const mine = history[history.length - 1]?.sender_id === user?.id;
    if (opened || (previous.last !== lastMessageId && (stickToBottomRef.current || mine))) {
      node.scrollTop = node.scrollHeight;
      stickToBottomRef.current = true;
    }
    lastSeenRef.current = { key: messageKey, last: lastMessageId, open: threadOpen };
  }, [messageKey, lastMessageId, threadOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the open conversation between boxes (e.g. an accepted request moves
  // from Requests to Inbox) so the list never shows an empty box beside it.
  useEffect(() => {
    if (selected) setBox(selected.is_request ? 'requests' : 'inbox');
  }, [selected?.id, selected?.is_request]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setConfirmBlock(false);
    setConfirmDeleteId('');
    setReportTarget(null);
    setGifOpen(false);
    setLocalError('');
    setLocalNotice('');
  }, [messageKey]);

  useEffect(() => {
    if (focusComposerRef.current && threadOpen) {
      focusComposerRef.current = false;
      composerRef.current?.focus();
    }
  });

  // A pending "message @user" for someone you already talk to opens that
  // conversation (with its history) instead of an empty compose view.
  useEffect(() => {
    if (!messaging.composeUsername) return;
    const existing = [...messaging.inbox, ...messaging.requests].find(
      (item) => item.participant?.username?.toLowerCase() === messaging.composeUsername.toLowerCase(),
    );
    if (existing) {
      messaging.selectConversation(existing.id, { dock: compact });
      onConversationRoute?.(existing.id);
    }
  }, [messaging.composeUsername, messaging.inbox, messaging.requests]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!newMessage || !userQuery.trim()) {
      setUserResults([]);
      setUserSearch('idle');
      return undefined;
    }
    let alive = true;
    setUserSearch('loading');
    const timer = setTimeout(() => {
      api.get('/api/search/suggestions', { q: userQuery, limit: 8 })
        .then((result) => {
          if (!alive) return;
          setUserResults((result.users || []).filter((person) => !person.is_me && person.account_type === 'real'));
          setUserSearch('done');
        })
        .catch(() => {
          if (!alive) return;
          setUserResults([]);
          setUserSearch('error');
        });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [newMessage, userQuery]);

  const dismissError = () => {
    setLocalError('');
    messaging.setError?.('');
  };

  const select = (conversationId) => {
    focusComposerRef.current = true;
    messaging.selectConversation(conversationId, { dock: compact });
    setNewMessage(false);
    onConversationRoute?.(conversationId);
  };

  const closeThread = () => {
    messaging.selectConversation(null);
    onConversationRoute?.(null);
  };

  const chooseUser = (username) => {
    focusComposerRef.current = true;
    messaging.composeTo(username, { dock: compact });
    setNewMessage(false);
    setUserQuery('');
    if (!compact) navigate(`/messages?user=${encodeURIComponent(username)}`);
  };

  const submit = async (event) => {
    event.preventDefault();
    const text = messaging.draft.trim();
    if (!text || messaging.busy || composeBlockedReason) return;
    try {
      const result = await messaging.send({ kind: 'text', text });
      const conversationId = result.conversation?.id || messaging.selectedId;
      if (!compact && conversationId) onConversationRoute?.(conversationId);
    } catch {
      // Shared state renders the request error; the draft is kept for a retry.
    }
  };

  const sendEmote = async (emote, picker) => {
    if (picker) picker.open = false;
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

  const submitReport = async (event) => {
    event.preventDefault();
    if (!reportTarget || actionBusy) return;
    setActionBusy('report');
    setLocalError('');
    try {
      await api.post('/api/reports', {
        target_type: 'message',
        target_id: reportTarget.id,
        reason: reportForm.reason,
        details: reportForm.details.trim(),
      });
      setReportTarget(null);
      setReportForm({ reason: 'spam', details: '' });
      setLocalNotice('Report submitted. Thank you — our moderators will review it.');
    } catch (requestError) {
      setLocalError(requestError.message || 'Could not report message.');
    } finally {
      setActionBusy('');
    }
  };

  const confirmBlockParticipant = async () => {
    if (!selected || actionBusy) return;
    setActionBusy('block');
    setLocalError('');
    try {
      await api.put(`/api/users/${encodeURIComponent(selected.participant.username)}/block`);
      setConfirmBlock(false);
      closeThread();
      await messaging.refreshAll();
    } catch (requestError) {
      setLocalError(requestError.message || 'Could not block this user.');
    } finally {
      setActionBusy('');
    }
  };

  const decide = async (decision) => {
    if (!selected || actionBusy) return;
    setActionBusy(decision);
    setLocalError('');
    try {
      await messaging.decideRequest(selected.id, decision);
      if (decision === 'decline') closeThread();
    } catch (requestError) {
      setLocalError(requestError.message || `Could not ${decision} this request.`);
    } finally {
      setActionBusy('');
    }
  };

  const removeMessage = async (message) => {
    if (actionBusy) return;
    setActionBusy('delete');
    setLocalError('');
    try {
      await messaging.deleteMessage(message.id, message.conversation_id);
      setConfirmDeleteId('');
    } catch (requestError) {
      setLocalError(requestError.message || 'Could not delete this message.');
    } finally {
      setActionBusy('');
    }
  };

  const loadEarlier = async () => {
    const node = historyRef.current;
    if (loadingEarlier || !historyCursor) return;
    stickToBottomRef.current = false;
    restoreScrollRef.current = node ? { height: node.scrollHeight, top: node.scrollTop } : null;
    setLoadingEarlier(true);
    try {
      await messaging.loadConversation(messaging.selectedId, { before: historyCursor });
    } catch (requestError) {
      restoreScrollRef.current = null;
      setLocalError(requestError.message || 'Could not load earlier messages.');
    } finally {
      setLoadingEarlier(false);
    }
  };

  // Older conversations: the button (full page) and scrolling to the end of the
  // list (page and dock) both land here.
  const loadMoreConversations = async () => {
    if (!boxCursor || boxLoading || !messaging.loadMoreBox) return;
    setListError('');
    try {
      await messaging.loadMoreBox(box);
    } catch (requestError) {
      setListError(requestError.message || 'Could not load more conversations.');
    }
  };

  const onListScroll = (event) => {
    const node = event.currentTarget;
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 120) loadMoreConversations();
  };

  const onHistoryScroll = (event) => {
    const node = event.currentTarget;
    stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 160;
    if (node.scrollTop < 80 && historyCursor && !loadingEarlier) loadEarlier();
  };

  const personLabel = selected?.participant.display_name || '';

  return (
    <section className={`sx-messaging-panel ${compact ? 'sx-messaging-panel--compact' : ''}`} data-pane={threadOpen ? 'thread' : 'list'}>
      <aside className="sx-message-sidebar" aria-label="Conversations">
        <div className="sx-message-tabs" role="tablist" aria-label="Message boxes">
          <button type="button" role="tab" aria-selected={box === 'inbox'} className={box === 'inbox' ? 'sx-active' : ''} onClick={() => setBox('inbox')}>
            INBOX {messaging.unread.inbox ? <span>{messaging.unread.inbox}</span> : null}
          </button>
          <button type="button" role="tab" aria-selected={box === 'requests'} className={box === 'requests' ? 'sx-active' : ''} onClick={() => setBox('requests')}>
            REQUESTS {messaging.unread.requests ? <span>{messaging.unread.requests}</span> : null}
          </button>
        </div>
        <button type="button" className="sx-message-new" aria-expanded={newMessage} onClick={() => setNewMessage((value) => !value)}>
          <b aria-hidden="true">{newMessage ? '×' : '+'}</b> NEW MESSAGE
        </button>
        {newMessage ? (
          <div className="sx-message-user-search">
            <input
              value={userQuery}
              onChange={(event) => setUserQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') setNewMessage(false); }}
              placeholder="Search username…"
              aria-label="Search people to message"
              autoFocus
            />
            {userSearch === 'loading' ? <div className="sx-message-hint" role="status">SEARCHING…</div> : null}
            {userSearch === 'error' ? <div className="sx-message-hint" role="alert">SEARCH FAILED — TRY AGAIN</div> : null}
            {userSearch === 'done' && !userResults.length ? <div className="sx-message-hint">NO MATCHING PEOPLE</div> : null}
            {userResults.map((person) => (
              <button type="button" key={person.id} onClick={() => chooseUser(person.username)}>
                <Avatar user={person} /><span><strong>@{person.username}</strong><small>{person.display_name}</small></span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="sx-message-filter">
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="FILTER CONVERSATIONS…"
            aria-label="Filter conversations"
          />
        </div>
        <div className="sx-conversation-list" onScroll={onListScroll}>
          <ConversationList
            rows={visibleRows}
            selectedId={messaging.selectedId}
            onSelect={select}
            viewerId={user?.id}
            empty={filter.trim()
              ? 'No conversations match your filter.'
              : box === 'requests' ? 'No message requests.' : 'No conversations yet.'}
          />
          {boxCursor && !compact ? (
            <button type="button" className="sx-message-more" onClick={loadMoreConversations} disabled={boxLoading}>
              {boxLoading ? 'LOADING…' : 'LOAD MORE'}
            </button>
          ) : null}
          {boxLoading && compact ? <div className="sx-message-hint" role="status">LOADING…</div> : null}
          {listError ? <div className="sx-message-hint" role="alert">{listError}</div> : null}
        </div>
        <div className="sx-message-side-foot">
          <span>{rows.length}{boxCursor ? '+' : ''} {box === 'requests' ? 'REQUEST' : 'CONVERSATION'}{rows.length === 1 && !boxCursor ? '' : 'S'}</span>
        </div>
      </aside>

      <div className="sx-message-thread">
        {threadOpen ? (
          <>
            <header className="sx-message-thread-head">
              <button type="button" className="sx-message-back" onClick={closeThread} aria-label="Back to conversations">←</button>
              {selected ? <Avatar user={selected.participant} /> : null}
              <div className="sx-message-thread-id">
                <strong>@{selected?.participant.username || messaging.composeUsername}</strong>
                <small>{selected?.state === 'pending' ? 'MESSAGE REQUEST' : personLabel ? personLabel.toUpperCase() : 'DIRECT MESSAGE'}</small>
              </div>
              {selected ? (
                <div className="sx-message-thread-actions">
                  <Link to={`/profile/${encodeURIComponent(selected.participant.username)}`}>PROFILE</Link>
                  <button type="button" className="sx-danger" onClick={() => setConfirmBlock((value) => !value)} aria-expanded={confirmBlock}>BLOCK</button>
                </div>
              ) : null}
            </header>

            {confirmBlock && selected ? (
              <div className="sx-message-confirm" role="alertdialog" aria-label="Confirm block">
                <span>Block @{selected.participant.username}? You will no longer be able to message or follow each other.</span>
                <button type="button" onClick={() => setConfirmBlock(false)} disabled={actionBusy === 'block'}>CANCEL</button>
                <button type="button" className="sx-danger" onClick={confirmBlockParticipant} disabled={actionBusy === 'block'}>
                  {actionBusy === 'block' ? 'BLOCKING…' : 'BLOCK'}
                </button>
              </div>
            ) : null}

            {selected?.is_request ? (
              <div className="sx-message-request-actions">
                <span>{selected.participant.display_name || `@${selected.participant.username}`} wants to message you. Accept to continue the conversation.</span>
                <button type="button" onClick={() => decide('decline')} disabled={Boolean(actionBusy)}>DECLINE</button>
                <button type="button" onClick={() => decide('accept')} disabled={Boolean(actionBusy)}>ACCEPT</button>
              </div>
            ) : null}

            <div className="sx-message-history" ref={historyRef} onScroll={onHistoryScroll} role="log" aria-live="polite" aria-label="Messages">
              {historyCursor ? (
                compact ? (
                  loadingEarlier ? <div className="sx-message-hint" role="status">LOADING EARLIER…</div> : null
                ) : (
                  <button type="button" className="sx-message-load" onClick={loadEarlier} disabled={loadingEarlier}>
                    {loadingEarlier ? 'LOADING…' : 'LOAD EARLIER'}
                  </button>
                )
              ) : null}
              {!history.length ? <div className="sx-message-empty">Start the conversation.</div> : null}
              {history.map((message, index) => {
                const mine = message.sender_id === user?.id;
                const newDay = dayKey(message.created_at) !== dayKey(history[index - 1]?.created_at);
                return (
                  <div className="sx-message-row" key={message.id}>
                    {newDay && message.created_at ? <div className="sx-message-day" role="separator"><span>{dayLabel(message.created_at)}</span></div> : null}
                    <article className={`sx-message-bubble ${mine ? 'sx-mine' : ''} ${message.pending ? 'sx-pending' : ''} ${['reel', 'pack'].includes(message.kind) ? 'sx-message-bubble--reel' : ''}`}>
                      <MessageContent message={message} />
                      <footer>
                        <time>{clockTime(message.created_at)}</time>
                        {message.pending ? <span>SENDING…</span> : null}
                        {mine && message.read_by_recipient ? <span>READ</span> : null}
                        {message.can_delete ? (
                          confirmDeleteId === message.id ? (
                            <>
                              <button type="button" className="sx-danger" disabled={actionBusy === 'delete'} onClick={() => removeMessage(message)}>CONFIRM DELETE</button>
                              <button type="button" onClick={() => setConfirmDeleteId('')}>CANCEL</button>
                            </>
                          ) : <button type="button" onClick={() => setConfirmDeleteId(message.id)}>DELETE</button>
                        ) : null}
                        {message.can_report ? <button type="button" onClick={() => { setReportTarget(message); setLocalNotice(''); }}>REPORT</button> : null}
                      </footer>
                    </article>
                  </div>
                );
              })}
            </div>

            {reportTarget ? (
              <form className="sx-message-report" onSubmit={submitReport} aria-label="Report message">
                <div className="sx-message-report-head">
                  <strong>REPORT MESSAGE</strong>
                  <button type="button" onClick={() => setReportTarget(null)} aria-label="Cancel report">×</button>
                </div>
                <label>
                  <span>REASON</span>
                  <select value={reportForm.reason} onChange={(event) => setReportForm((current) => ({ ...current, reason: event.target.value }))}>
                    {REPORT_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label>
                  <span>DETAILS (OPTIONAL)</span>
                  <textarea
                    value={reportForm.details}
                    maxLength={REPORT_DETAILS_LIMIT}
                    rows={2}
                    onChange={(event) => setReportForm((current) => ({ ...current, details: event.target.value }))}
                  />
                </label>
                <div className="sx-message-report-actions">
                  <button type="button" onClick={() => setReportTarget(null)}>CANCEL</button>
                  <button type="submit" className="sx-primary" disabled={actionBusy === 'report'}>{actionBusy === 'report' ? 'SENDING…' : 'SUBMIT REPORT'}</button>
                </div>
              </form>
            ) : null}

            {composeBlockedReason ? (
              <div className="sx-message-pending-note" role="status">{composeBlockedReason}</div>
            ) : (
              <form className="sx-message-composer" onSubmit={submit}>
                <textarea
                  ref={composerRef}
                  value={messaging.draft}
                  onChange={(event) => messaging.setDraft(event.target.value)}
                  maxLength={TEXT_LIMIT}
                  rows={2}
                  placeholder={`Write a message to @${selected?.participant.username || messaging.composeUsername}…`}
                  aria-label="Message"
                  onKeyDown={(event) => {
                    // Enter sends; Shift+Enter inserts a newline; Enter while an
                    // IME is composing must not send.
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) submit(event);
                  }}
                />
                <div className="sx-message-compose-actions">
                  <div className="sx-message-compose-tools">
                    <details className="sx-emote-picker">
                      <summary aria-label="Choose an emote">☺</summary>
                      <div>{(messaging.capabilities?.curated_emotes || []).map((emote) => (
                        <button type="button" key={emote} onClick={(event) => sendEmote(emote, event.currentTarget.closest('details'))}>{emote}</button>
                      ))}</div>
                    </details>
                    <button
                      type="button"
                      className="sx-message-gif-btn"
                      aria-expanded={gifOpen}
                      onClick={() => setGifOpen((value) => !value)}
                      disabled={!messaging.capabilities?.gifs?.available}
                      title={messaging.capabilities?.gifs?.available ? 'Send a GIF' : 'GIFs are not configured on this server'}
                    >GIF</button>
                  </div>
                  <div className="sx-message-compose-send">
                    {draftLength >= COUNTER_FROM ? (
                      <span className={`sx-message-counter ${draftLength >= TEXT_LIMIT - 100 ? 'sx-warn' : ''}`} aria-live="polite">
                        {draftLength.toLocaleString()} / {TEXT_LIMIT.toLocaleString()}
                      </span>
                    ) : <span className="sx-message-hint-keys">↵ SEND · ⇧↵ NEW LINE</span>}
                    <button type="submit" className="sx-primary" disabled={messaging.busy || !messaging.draft.trim()}>{messaging.busy ? 'SENDING…' : 'SEND ↵'}</button>
                  </div>
                </div>
              </form>
            )}

            {gifOpen ? (
              <div className="sx-gif-picker">
                <form onSubmit={searchGifs}>
                  <input value={gifQuery} onChange={(event) => setGifQuery(event.target.value)} placeholder="Search Tenor…" aria-label="Search GIFs" autoFocus />
                  <button type="submit" disabled={gifBusy}>{gifBusy ? '…' : 'SEARCH'}</button>
                </form>
                <div>{gifs.map((gif) => <button type="button" key={gif.id + gif.url} onClick={() => sendGif(gif)}><img src={gif.preview_url} alt={gif.title} /></button>)}</div>
                <small>Powered by Tenor</small>
              </div>
            ) : null}
          </>
        ) : (
          <div className="sx-message-thread-placeholder">
            <strong>NO CONVERSATION SELECTED</strong>
            <span>Pick a conversation from the list or start a new message.</span>
          </div>
        )}
        {localNotice ? <div className="sx-message-notice" role="status">{localNotice}</div> : null}
        {error ? (
          <div className="sx-message-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={dismissError} aria-label="Dismiss error">×</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
